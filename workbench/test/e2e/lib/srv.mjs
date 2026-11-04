// S27 e2e · 起真实桥：node workbench/server.ts（不 mock、不用 4399），临时 STATE + 4487 端口。
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const NODE = process.env.NODE_BIN || process.execPath;
export const E2E_PORT = Number(process.env.AICA_E2E_PORT ?? 4487);

const HERE = dirname(fileURLToPath(import.meta.url));   // workbench/test/e2e/lib

/** 端口是否可用：先自己 bind 一次再放掉（别人占着就直接判 busy，不去连别人的服务） */
export function portFree(port) {
  return new Promise((resolveFree) => {
    const s = createNetServer();
    s.once("error", () => resolveFree(false));
    s.once("listening", () => s.close(() => resolveFree(true)));
    s.listen(port, "127.0.0.1");
  });
}

export function repoRoot() {
  return resolve(HERE, "..", "..", "..", "..");
}

export function serverEntry() {
  return resolve(HERE, "..", "..", "..", "server.ts");
}

export function cliEntry() {
  return resolve(HERE, "..", "..", "..", "..", "src", "cli.ts");
}

async function waitReady(base, timeoutMs) {
  const t0 = Date.now();
  let lastErr = null;
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`${base}/api/v1/view`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return true;
    } catch (e) { lastErr = e; }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server 未就绪（${timeoutMs}ms）：${String(lastErr?.message ?? lastErr)}`);
}

/**
 * 起桥。首选 4487；端口被占（Windows 上 TIME_WAIT 也会拒绝 bind）就顺延 4488..4510。
 * 顺延不是妥协：**绝不测别人的服务** —— 起好后核对 expectRuns，对不上就换下一个端口。
 * @param {{stateDir:string, port?:number, timeoutMs?:number, expectRuns?:number}} o
 * @returns {Promise<{base:string, port:number, proc:import("node:child_process").ChildProcess, stop:()=>Promise<void>, output:()=>string, stderr:()=>string}>}
 */
export async function startServer(o) {
  const entry = serverEntry();
  if (!existsSync(entry)) throw new Error(`找不到 server 入口：${entry}`);
  const preferred = o.port ?? E2E_PORT;
  const ports = [preferred];
  for (let i = 1; i <= 12; i++) ports.push(preferred + i);
  const failures = [];
  for (const port of ports) {
    try {
      return await startOn(port);
    } catch (e) {
      failures.push(`${port}: ${String(e?.message ?? e).split("\n")[0]}`);
      if (!/EADDRINUSE|already in use|已被占用|换端口|runs 对不上|server 未就绪/.test(String(e?.message ?? e))) throw e;
    }
  }
  throw new Error(`PORT_BUSY: ${preferred}..${preferred + 12} 都不可用：${failures.slice(0, 4).join(" / ")}`);

  async function startOn(port) {
    let out = "", err = "";
    const proc = spawn(NODE, [entry], {
      env: { ...process.env, WB_PORT: String(port), AICA_STATE: o.stateDir },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    proc.stdout.on("data", (b) => { out += b.toString(); });
    proc.stderr.on("data", (b) => { err += b.toString(); });
    const base = `http://127.0.0.1:${port}`;
    const stop = async () => {
      if (proc.exitCode !== null) return;
      proc.kill();
      const exited = await new Promise((r) => {
        const t = setTimeout(() => r(false), 3000);
        proc.once("exit", () => { clearTimeout(t); r(true); });
      });
      if (!exited) {
        try {
          if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
          else proc.kill("SIGKILL");
        } catch { /* 已经在退出中 */ }
      }
    };
    try {
      // 换端口重试时不用等满 20s：首个端口给足，后续给 8s
      await waitReady(base, port === preferred ? (o.timeoutMs ?? 20000) : 8000);
    } catch (e) {
      await stop();
      const logs = `${out}\n${err}`;
      if (/EADDRINUSE|EACCES/.test(logs)) throw new Error(`EADDRINUSE: ${port} 已被占用（换端口）`);
      throw new Error(`${e.message}\n--- stdout ---\n${out}\n--- stderr ---\n${err}`);
    }
    if (typeof o.expectRuns === "number") {
      try {
        const v = await getJson(`${base}/api/v1/view`);
        const n = (v.json?.runs ?? []).length;
        if (n !== o.expectRuns) {
          await stop();
          throw new Error(`runs 对不上：端口 ${port} 上跑的不是本测试的 STATE（期望 ${o.expectRuns}，实际 ${n}），换端口`);
        }
      } catch (e) {
        if (String(e?.message ?? e).startsWith("runs 对不上")) throw e;
        await stop();
        throw e;
      }
    }
    return { base, port, proc, stop, output: () => out, stderr: () => err };
  }
}

export async function getJson(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON 由调用方判断 */ }
  return { status: r.status, json, text };
}

/** POST JSON → {status, json, text}（不抛：4xx/5xx 交给断言判断） */
export async function postJson(url, body) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(20000),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 同上 */ }
  return { status: r.status, json, text };
}

export async function waitFor(fn, { timeoutMs = 15000, intervalMs = 100, label = "condition" } = {}) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeoutMs) {
    try {
      const v = await fn();
      if (v) return v;
      last = v;
    } catch (e) { last = e; }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor 超时：${label}（${timeoutMs}ms，最后值 ${JSON.stringify(last)}）`);
}



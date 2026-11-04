// S27 e2e · 故障注入器。只用 fs + 进程原语，不 import 产品代码：
// 这样它们既能被测试进程用，也能被 lib/scenario.mjs 子进程用，而不会把 AICA_STATE 的模块级常量搅在一起。
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, openSync, closeSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function pidAlive(pid) {
  if (!(pid > 0)) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e?.code === "EPERM"; }
}

export async function waitDead(pid, timeoutMs = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (!pidAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return !pidAlive(pid);
}

/** 杀进程树：与产品 abortWorker 同一手法（win32 taskkill /T /F，其它 SIGKILL） */
export function killTree(pid) {
  if (!(pid > 0)) return false;
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 15000, stdio: "ignore" });
    } else {
      process.kill(pid, "SIGKILL");
    }
    return true;
  } catch {
    try { process.kill(pid, "SIGKILL"); return true; } catch { return false; }
  }
}

export function readWorkerFile(nodeDir) {
  const f = join(nodeDir, "worker.json");
  try { return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null; } catch { return null; }
}

/** 注入器 1：killWorker —— 只杀租约里那个 worker 进程，租约文件留在原地（模拟 daemon 崩了但 worker 也死了） */
export async function killWorker(nodeDir) {
  const w = readWorkerFile(nodeDir);
  if (!w) return { applied: false, reason: "worker.json 不存在" };
  const killed = killTree(w.pid);
  const dead = await waitDead(w.pid);
  return { applied: true, pid: w.pid, killed, dead, worker: w };
}

/** 注入器 2：killDaemon —— 按 STATE/daemon.pid 心跳文件杀守护进程，心跳文件故意不删（模拟硬死） */
export async function killDaemon(stateDir) {
  const f = join(stateDir, "daemon.pid");
  if (!existsSync(f)) return { applied: false, reason: "daemon.pid 不存在" };
  const raw = readFileSync(f, "utf8").trim();
  const pid = Number(raw.split(/\s+/)[0]);
  if (!(pid > 0)) return { applied: false, reason: `daemon.pid 内容不可解析：${raw.slice(0, 40)}` };
  const killed = killTree(pid);
  const dead = await waitDead(pid);
  return { applied: true, pid, killed, dead, heartbeat: raw };
}

/**
 * 注入器 3：truncateEvents —— 把 events.jsonl 从中间截断（模拟断电/被杀时写了半行）。
 * @param {string} file
 * @param {{fraction?: number}} opts 保留比例，默认 0.7（不会正好落在行边界上就更好）
 */
export function truncateEvents(file, opts = {}) {
  if (!existsSync(file)) return { applied: false, reason: "events.jsonl 不存在" };
  const before = readFileSync(file, "utf8");
  if (!before.length) return { applied: false, reason: "events.jsonl 是空文件" };
  const fraction = opts.fraction ?? 0.7;
  const keep = Math.max(1, Math.floor(before.length * fraction));
  // 故意切在行中间：留半行 JSON，模拟写到一半被打断
  const cut = before.slice(0, keep);
  writeFileSync(file, cut, "utf8");
  return { applied: true, bytes_before: before.length, bytes_after: Buffer.byteLength(cut, "utf8"), partial_tail: !cut.endsWith("\n") };
}

/** 注入器 4：badGateAns —— 写一个"不合协议"的 gate-ans（未知决策 / 坏 JSON），验证 fail-closed 不被静默当同意 */
export function badGateAns(nodeDir, payload = '{"decision":"hack","feedback":"注入：非法决策"}') {
  const f = join(nodeDir, "gate-ans.json");
  writeFileSync(f, payload, "utf8");
  const st = statSync(f);
  return { applied: true, file: f, bytes: st.size, mtimeMs: st.mtimeMs };
}

/**
 * 注入器 5：diskReadonly —— 把一个文件变成只读（跨平台：chmod 0o444；Windows 再补 attrib +R）。
 * 用"文件只读"而不是"整盘 ACL"：无需管理员权限，失败面可判定；返回 applied=false 时测试必须 skip 而不是假装通过。
 */
export function diskReadonly(file) {
  if (!existsSync(file)) return { applied: false, reason: "目标文件不存在" };
  try {
    chmodSync(file, 0o444);
    if (process.platform === "win32") {
      execFileSync("attrib", ["+R", file], { windowsHide: true, stdio: "ignore", timeout: 10000 });
    }
    return { applied: true, file };
  } catch (e) {
    return { applied: false, reason: String(e?.message ?? e) };
  }
}

export function diskWritable(file) {
  try {
    if (process.platform === "win32") execFileSync("attrib", ["-R", file], { windowsHide: true, stdio: "ignore", timeout: 10000 });
    chmodSync(file, 0o666);
    return true;
  } catch { return false; }
}

/** 探测"是否真的写不进去"：返回 ok=true 表示只读生效（写入失败） */
export function probeUnwritable(file) {
  try {
    const fd = openSync(file, "a");
    closeSync(fd);
    return false;
  } catch {
    return true;
  }
}

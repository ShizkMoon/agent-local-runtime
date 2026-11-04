// S27 e2e · 子进程场景运行器：每个场景一份临时 AICA_STATE，场景结束后可清理。
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const NODE = process.env.NODE_BIN || process.execPath;

export function newState(prefix = "aica-e2e-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * @param {string} name 场景名（见 lib/scenario.mjs）
 * @param {{state?:string, timeoutMs?:number}} o
 * @returns {Promise<{result:any, stdout:string, stderr:string, code:number|null, state:string, cleanup:()=>void}>}
 */
export async function runScenario(name, o = {}) {
  const state = o.state ?? newState(`aica-e2e-${name}-`);
  const file = join(HERE, "scenario.mjs");
  const proc = spawn(NODE, [file, name], {
    env: { ...process.env, AICA_STATE: state },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let out = "", err = "";
  proc.stdout.on("data", (b) => { out += b.toString(); });
  proc.stderr.on("data", (b) => { err += b.toString(); });
  const timeoutMs = o.timeoutMs ?? 120000;
  const code = await new Promise((resolve) => {
    const t = setTimeout(() => { try { proc.kill(); } catch {} resolve(-1); }, timeoutMs);
    proc.once("exit", (c) => { clearTimeout(t); resolve(c); });
    proc.once("error", () => { clearTimeout(t); resolve(-1); });
  });
  const line = out.split("\n").find((l) => l.startsWith("__RESULT__"));
  let result = null;
  if (line) {
    try { result = JSON.parse(line.slice("__RESULT__".length)); } catch { /* 解析失败由断言兜底 */ }
  }
  const cleanup = () => { try { rmSync(state, { recursive: true, force: true }); } catch { /* 临时目录清不掉不影响断言 */ } };
  return { result, stdout: out, stderr: err, code, state, cleanup };
}

// ar daemon：用户会话常驻宿主，消费派发意图、拉起与回收 Worker 进程
// 会话边界原因：Session 0 服务碰不到桌面，agent-desktop/ego 只能在交互会话工作
import { spawn, execFileSync } from "node:child_process";
import { appendFileSync, existsSync, openSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { pendingNodes, appendEvent, readResult, writeResult, RUNS_DIR, STATE } from "./runs.ts";
import type { SpecEnvelope } from "./envelope.ts";

const POLL_MS = Number(process.env.AR_POLL_MS ?? 2000);
const MAX_WORKERS = Number(process.env.AR_MAX_WORKERS ?? 2);
const AICA_PI = process.env.AICA_PI_PKG ?? fileURLToPath(new URL("../aica-pi", import.meta.url));
const AR_CLI = fileURLToPath(new URL("./cli.ts", import.meta.url));
const DEFAULT_PI_MODEL = "opencode-pool/deepseek-v4.1-flash";
const INDEX = join(RUNS_DIR, "index.jsonl");
const running = new Set<string>();

// 协议工具恒授（不写 result 就回收不了节点）；敏感工具须 spec.tools 显式声明
const PROTOCOL_TOOLS = ["ev_done", "ev_fail", "ev_gate"];
const DEFAULT_PI_TOOLS = [
  "read", "write", "edit", "bash", "powershell", "ls", "find", "grep",
  ...PROTOCOL_TOOLS, "kn_recall", "ar_read",
];

function indexLog(rec: Record<string, unknown>): void {
  try { appendFileSync(INDEX, JSON.stringify({ ts: new Date().toISOString(), ...rec }) + "\n"); } catch { /* 目录未建也不阻塞 */ }
}

/** 守护进程环境常缺持久化的 User 变量（如 OPENCODE_POOL_KEY）：启动时把 HKCU\Environment 缺项并入 */
function syncUserEnv(): void {
  if (process.platform !== "win32") return;
  try {
    const out = execFileSync("reg.exe", ["query", "HKCU\\Environment"], { encoding: "utf8", windowsHide: true, timeout: 10_000 });
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/^\s*(\S+)\s+REG_(?:SZ|EXPAND_SZ)\s+(.*)$/);
      if (!m || process.env[m[1]] !== undefined) continue;
      // REG_EXPAND_SZ 里的 %VAR% 用当前环境就地展开（如 TEMP=%USERPROFILE%\...）
      process.env[m[1]] = m[2].replace(/%([^%]+)%/g, (_, n) => process.env[n] ?? `%${n}%`);
    }
  } catch { /* 注册表读不到就用现有 env */ }
}

/** pi 的真实入口：npm 全局包 dist/bundle/cli.js；用 node 直接跑，绕开 pi.cmd 对 PATH/shell 的依赖 */
function resolvePiCli(): string {
  const candidates = [
    process.env.AICA_PI_CLI,
    process.env.APPDATA && join(process.env.APPDATA, "npm", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js"),
    process.env.PREFIX && join(process.env.PREFIX, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js"),
  ].filter((c): c is string => !!c);
  for (const c of candidates) if (existsSync(c)) return c;
  throw new Error(`pi-coding-agent bundle cli.js not found (tried ${candidates.join(", ")}); set AICA_PI_CLI`);
}

/** 节点工具面：spec.tools 为授予全集 + 协议工具；未声明则给内置执行面 + 只读环工具（不授 ar_dispatch/桌面/浏览器） */
function toolAllowlist(spec: SpecEnvelope): string[] {
  if (spec.tools?.length) return [...new Set([...spec.tools, ...PROTOCOL_TOOLS])];
  return DEFAULT_PI_TOOLS;
}

/** user message = 变量部分（worker.md 规则走 --append-system-prompt 保证前缀稳定可缓存）；resumed = waiting 回复后恢复拉起 */
function userMessage(spec: SpecEnvelope, resumed = false): string {
  const lines = [spec.goal, "", "## 节点上下文"];
  lines.push(`- node_id: ${spec.id}`);
  if (spec.accept?.length) lines.push("- accept:", ...spec.accept.map((a) => `  - ${a}`));
  if (spec.inputs?.length) lines.push("- inputs:", ...spec.inputs.map((i) => `  - ${i.ref}`));
  if (spec.already_known?.length) lines.push("- already_known:", ...spec.already_known.map((k) => `  - ${k}`));
  if (spec.budget?.depth_left !== undefined) lines.push(`- depth_left: ${spec.budget.depth_left}`);
  lines.push("- artifacts 目录: artifacts/（相对当前工作目录；大输出落盘回 ref）");
  lines.push("- 结束时必须调用 ev_done（成功）或 ev_fail（失败），否则按退出码兜底");
  if (spec.reply?.length) {
    lines.push("", "## 人工回复");
    for (const r of spec.reply) lines.push(`- [${r.ts}] ${r.text}`);
    if (resumed) lines.push("- [恢复] 此前你已提问，人工回复见上");
  }
  return lines.join("\n");
}

/** Worker 拉起命令：按 spec.agent 选 launcher */
function launcher(spec: SpecEnvelope, resumed = false): { file: string; args: string[]; desc: string } {
  const agent = spec.agent ?? "pi";
  switch (agent) {
    case "pi": {
      const cli = resolvePiCli();
      const profile = spec.profile === "orchestrator" ? "orchestrator" : "worker";
      const model = spec.model ?? process.env.AICA_PI_MODEL ?? DEFAULT_PI_MODEL;
      const args = [
        cli,
        "-p", "--mode", "json", "--no-session",
        // 封闭 worker：只加载显式 -e 扩展，关掉技能/模板/MCP/上下文文件发现
        "--no-extensions", "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-mcp",
        "--model", model,
        "--append-system-prompt", join(AICA_PI, "prompts", `${profile}.md`),
        "--tools", toolAllowlist(spec).join(","),
        "-e", join(AICA_PI, "extensions", "events.ts"),
        "-e", join(AICA_PI, "extensions", "tools.ts"),
        "--", userMessage(spec, resumed),
      ];
      return { file: process.execPath, args, desc: `node ${cli} -p ... [${agent}/${profile} ${model}]` };
    }
    case "claude":
      return { file: "claude", args: ["-p", spec.goal, "--output-format", "json"], desc: "claude -p" };
    case "codex":
      return { file: "codex", args: ["exec", spec.goal, "--json"], desc: "codex exec" };
    default:
      return { file: agent, args: [spec.goal], desc: `${agent} <goal>` };
  }
}

/** Worker env：补 nodejs/npm 目录进 PATH（daemon 的 PATH 可能没有），并注入节点上下文 */
function workerEnv(rootId: string, path: string): NodeJS.ProcessEnv {
  // AICA_STATE 给已解析的绝对路径（不是透传）：worker 的孙进程（ar done 等）cwd 在节点目录，相对路径会写错位置
  const env = { ...process.env, AR_ROOT_ID: rootId, AR_NODE_PATH: path, AR_CLI, AICA_STATE: STATE };
  const prepend = [
    join(process.env.ProgramFiles ?? "C:\\Program Files", "nodejs"),
    process.env.APPDATA ? join(process.env.APPDATA, "npm") : undefined,
    // .local/bin 放用户级 .cmd 包装（agent-desktop.cmd/ar.cmd）：孙进程经 shell 调用时可达
    process.env.USERPROFILE ? join(process.env.USERPROFILE, ".local", "bin") : undefined,
  ].filter((p): p is string => !!p && existsSync(p));
  const key = Object.keys(env).find((k) => k.toLowerCase() === "path") ?? "PATH";
  env[key] = [...prepend, env[key] ?? ""].join(";");
  return env;
}

function spawnWorker(rootId: string, path: string, spec: SpecEnvelope, resumed = false): void {
  const dir = join(RUNS_DIR, rootId, "nodes", path);
  running.add(spec.id);
  let file: string, args: string[], desc: string;
  try {
    ({ file, args, desc } = launcher(spec, resumed));
  } catch (e) {
    running.delete(spec.id);
    appendEvent(rootId, path, { kind: "exit", data: { code: -1, error: `launcher: ${String(e)}` } });
    writeResult(rootId, path, { status: "failed", summary: `Worker 拉起失败：${String(e)}` });
    return;
  }
  appendEvent(rootId, path, { kind: "spawn", data: { cmd: desc, agent: spec.agent ?? "pi" } });
  const log = openSync(join(dir, "stdout.log"), "a");
  let settled = false;
  const finish = (code: number | null, err?: unknown): void => {
    if (settled) return;
    settled = true;
    running.delete(spec.id);
    appendEvent(rootId, path, { kind: "exit", data: { code, ...(err ? { error: String(err) } : {}) } });
    // Worker 应自己写 result.json；没写则按退出码兜底
    if (!readResult(rootId, path)) {
      writeResult(rootId, path, {
        status: code === 0 ? "done" : "failed",
        summary: code === 0 ? "Worker 正常退出（未写执行摘要）" : `Worker 退出码 ${code}${err ? `：${String(err)}` : ""}`,
      });
    }
  };
  try {
    const child = spawn(file, args, { cwd: dir, stdio: ["ignore", log, log], env: workerEnv(rootId, path), windowsHide: true });
    child.on("exit", (code) => finish(code));
    child.on("error", (e) => finish(-1, e));
  } catch (e) {
    finish(-1, e);
  }
}

export interface DaemonOptions {
  once?: boolean;        // 跑空队列即退出（冒烟/CI 用）
  timeoutMs?: number;    // 0 = 不限
}

export async function daemonLoop(opts: DaemonOptions = {}): Promise<void> {
  syncUserEnv();
  const started = Date.now();
  indexLog({ event: "daemon_start", once: !!opts.once, pid: process.pid });
  for (;;) {
    try {
      for (const { rootId, path, spec, resumed } of pendingNodes()) {
        if (running.size >= MAX_WORKERS || running.has(spec.id)) continue;
        spawnWorker(rootId, path, spec, !!resumed);
      }
      if (opts.once && running.size === 0 && pendingNodes().length === 0) break;
    } catch (e) {
      indexLog({ event: "daemon_error", error: String(e) });
    }
    if (opts.timeoutMs && Date.now() - started > opts.timeoutMs) {
      indexLog({ event: "daemon_timeout", timeout_ms: opts.timeoutMs, running: [...running] });
      throw new Error(`ar daemon: timeout ${opts.timeoutMs}ms (still running: ${[...running].join(", ") || "none"})`);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  indexLog({ event: "daemon_stop", once: !!opts.once });
}

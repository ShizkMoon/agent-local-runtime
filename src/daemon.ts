// ar daemon：用户会话常驻宿主，消费派发意图、拉起与回收 Worker 进程
// 会话边界原因：Session 0 服务碰不到桌面，agent-desktop/ego 只能在交互会话工作
import { spawn, execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, mkdirSync, copyFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { pendingNodes, appendEvent, readResult, writeResult, patchResult, writeSpec, writeWorker, clearWorker, abortWorker, nodeDir, RUNS_DIR, STATE } from "./runs.ts";
import { tapStdout, readUsage, usageTokens, type UsageLedger } from "./transcribe.ts";
import type { SpecEnvelope } from "./envelope.ts";

const POLL_MS = Number(process.env.AR_POLL_MS ?? 2000);
const MAX_WORKERS = Number(process.env.AR_MAX_WORKERS ?? 2);
const AICA_PI = process.env.AICA_PI_PKG ?? fileURLToPath(new URL("../aica-pi", import.meta.url));
const AR_CLI = fileURLToPath(new URL("./cli.ts", import.meta.url));
const DEFAULT_PI_MODEL = "opencode-pool/deepseek-v4.1-flash";
const INDEX = join(RUNS_DIR, "index.jsonl");
const running = new Set<string>();

// 协议工具恒授（不写 result 就回收不了节点）；敏感工具须 spec.tools 显式声明
// ev_wait/ev_todo 同列：join 收口与清单投影都是节点自控协议，不属于执行能力
const PROTOCOL_TOOLS = ["ev_done", "ev_fail", "ev_gate", "ev_wait", "ev_todo"];
const DEFAULT_PI_TOOLS = [
  "read", "write", "edit", "bash", "powershell", "ls", "find", "grep",
  ...PROTOCOL_TOOLS, "kn_recall", "ar_read", "ev_learn",
];
// S11 reviewer 默认面：只读核证（不写不派；ev_gate 保留提问通道）。用字面量不用 PROTOCOL_TOOLS 展开——ev_wait/ev_todo 不授给 reviewer
const REVIEWER_PI_TOOLS = ["read", "ls", "find", "grep", "ar_read", "ev_done", "ev_fail", "ev_gate"];

// S13 角色模型路由：aica-pi/roles.json{worker,orchestrator,reviewer,advisor,fallback[]}
// 值给 null/缺省 = 该角色不指定模型，继续走 env/内置默认
interface RolesCfg { worker?: string | null; orchestrator?: string | null; reviewer?: string | null; advisor?: string | null; fallback?: string[] }
function rolesCfg(): RolesCfg {
  try { return JSON.parse(readFileSync(join(AICA_PI, "roles.json"), "utf8")) as RolesCfg; }
  catch { return {}; }
}
/** 模型解析序：spec.model ?? roles[profile] ?? AICA_PI_MODEL ?? 内置默认 */
function modelFor(spec: SpecEnvelope): string {
  const role = (spec.profile ?? "worker") as keyof RolesCfg;
  const roles = rolesCfg();
  return spec.model ?? (typeof roles[role] === "string" ? (roles[role] as string) : undefined)
    ?? process.env.AICA_PI_MODEL ?? DEFAULT_PI_MODEL;
}

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

/** 节点工具面：spec.tools 为授予全集 + 协议工具；reviewer 缺省只读面；其余给内置执行面 + 只读环工具（不授 ar_dispatch/桌面/浏览器） */
function toolAllowlist(spec: SpecEnvelope): string[] {
  if (spec.tools?.length) return [...new Set([...spec.tools, ...PROTOCOL_TOOLS])];
  if (spec.profile === "reviewer") return REVIEWER_PI_TOOLS;
  return DEFAULT_PI_TOOLS;
}

// S12 learn 注入上限：userMessage 尾段只带 learned.md 前 2000 字（防前缀膨胀）
const LEARNED_INJECT_CAP = 2000;

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
  // S12 经验教训：ev_learn 沉淀的全局 learned.md，末段注入前 2000 字（新→旧，worker 当参考不当指令）
  try {
    const learned = readFileSync(join(STATE, "memory", "learned.md"), "utf8").slice(0, LEARNED_INJECT_CAP).trim();
    if (learned) lines.push("", "## 经验教训", learned);
  } catch { /* 没有 learned.md 属常态 */ }
  return lines.join("\n");
}

/** S14 art:// 物化：spawn 前把 art://<root>/<nodePath>/<file> 从源节点 artifacts 复制进本节点 inputs/，
 *  引用改相对路径 inputs/<file>；找不到（或 ref 非法/本地路径不存在）→ 该输入 skip + input 事件记录 */
function materializeInputs(rootId: string, path: string, spec: SpecEnvelope): SpecEnvelope {
  if (!spec.inputs?.length) return spec;
  const dir = nodeDir(rootId, path);
  const inDir = join(dir, "inputs");
  const skip = (ref: string, reason: string): void => {
    appendEvent(rootId, path, { kind: "input", data: { ref, skipped: reason } });
  };
  const inputs: NonNullable<SpecEnvelope["inputs"]> = [];
  for (const inp of spec.inputs) {
    const ref = String(inp?.ref ?? "");
    if (ref.startsWith("art://")) {
      // art://<rootId>/<nodePath…>/<file>：首段 run id、末段文件名、中段节点 path（可嵌套）
      const parts = ref.slice("art://".length).split("/").filter(Boolean);
      if (parts.length < 3) { skip(ref, "art:// 需要 <root>/<path>/<file> 三段"); continue; }
      const [srcRoot, file] = [parts[0], parts[parts.length - 1]];
      const srcPath = parts.slice(1, -1).join("/");
      if (file === "." || file === "..") { skip(ref, "非法文件名"); continue; }
      const src = join(RUNS_DIR, srcRoot, "nodes", srcPath, "artifacts", file);
      if (!existsSync(src)) { skip(ref, `源文件不存在 ${src}`); continue; }
      mkdirSync(inDir, { recursive: true });
      copyFileSync(src, join(inDir, file));
      inputs.push({ ...inp, ref: `inputs/${file}` });
      continue;
    }
    // 非 art:// 按本地路径处理：存在性校验，缺失跳过不阻塞拉起
    if (!existsSync(ref)) { skip(ref, "路径不存在"); continue; }
    inputs.push(inp);
  }
  return { ...spec, inputs };
}

/** Worker 拉起命令：按 spec.agent 选 launcher。dir = 节点目录（session 挂其下，恢复拉起继承上下文） */
function launcher(spec: SpecEnvelope, resumed = false, dir?: string): { file: string; args: string[]; desc: string } {
  const agent = spec.agent ?? "pi";
  switch (agent) {
    case "pi": {
      const cli = resolvePiCli();
      // S11 profile→prompt 映射：reviewer 用 reviewer.md；advisor 暂无专属 prompt 回落 worker.md
      const profile = spec.profile === "orchestrator" || spec.profile === "reviewer" ? spec.profile : "worker";
      const model = modelFor(spec);
      const args = [
        cli,
        "-p", "--mode", "json",
        // 节点级持久 session：人工回复/多轮重拉都继承完整上下文（不再每次失忆重开）
        ...(dir ? ["--session-dir", join(dir, "session"), "--session-id", "aica"] : ["--no-session"]),
        // 封闭 worker：只加载显式 -e 扩展，关掉技能/模板/MCP/上下文文件发现
        "--no-extensions", "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-mcp",
        "--model", model,
        "--append-system-prompt", join(AICA_PI, "prompts", `${profile}.md`),
        "--tools", toolAllowlist(spec).join(","),
        "-e", join(AICA_PI, "extensions", "events.ts"),
        "-e", join(AICA_PI, "extensions", "tools.ts"),
        "-e", join(AICA_PI, "extensions", "gate.ts"),
        // S14 skills 显式挂载：--no-skills 下 --skill <path> 仍会加载（pi cli.md:202）
        ...(spec.skills ?? []).flatMap((s) => ["--skill", join(AICA_PI, "skills", String(s))]),
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

/** S13 节点落定一行通知：STATE/notify.log 供外部 watcher（toast/IM 桥）tail */
function notifyLog(rootId: string, path: string, spec: SpecEnvelope): void {
  try {
    const r = readResult(rootId, path);
    appendFileSync(join(STATE, "notify.log"),
      `${new Date().toISOString()} ${spec.id} ${r?.status ?? "?"} ${String(r?.summary ?? "").split("\n")[0]}\n`);
  } catch { /* 通知通道失败不阻塞回收 */ }
}

/** S15 hooks 骨架（G37）：节点落定后跑 <aica-pi>/hooks/node_settled.mjs —— 只认 aica-pi 包内目录。
 *  契约：node <hook> <node_dir>，stdin 喂 {spec,result}，5s 超时；
 *  stdout JSON 若有 dispatch:[{path,goal,agent?,profile?,accept?}] → 逐个 writeSpec（parent=本节点 id） */
function runNodeSettledHook(rootId: string, path: string, spec: SpecEnvelope): void {
  const hook = join(AICA_PI, "hooks", "node_settled.mjs");
  if (!existsSync(hook)) return;
  const dir = nodeDir(rootId, path);
  const result = readResult(rootId, path);
  let out = "";
  try {
    out = execFileSync(process.execPath, [hook, dir], {
      input: JSON.stringify({ spec, result }),
      encoding: "utf8", timeout: 5_000, windowsHide: true,
    });
  } catch (e) {
    appendEvent(rootId, path, { kind: "hook", data: { hook: "node_settled", error: String(e).slice(0, 300) } });
    return;
  }
  let parsed: { dispatch?: { path?: unknown; goal?: unknown; agent?: unknown; profile?: unknown; accept?: unknown }[] };
  try { parsed = JSON.parse(out.trim() || "{}"); }
  catch { appendEvent(rootId, path, { kind: "hook", data: { hook: "node_settled", error: "stdout 非 JSON", out: out.slice(0, 300) } }); return; }
  const disp = Array.isArray(parsed?.dispatch) ? parsed.dispatch : [];
  if (disp.length) appendEvent(rootId, path, { kind: "hook", data: { hook: "node_settled", dispatch: disp.length } });
  for (const d of disp) {
    const dpath = String(d?.path ?? ""), goal = String(d?.goal ?? "");
    // path 防逃逸：拒绝绝对路径与 .. 段；hook 输出仍不可全信
    if (!dpath || !goal || dpath.includes("..") || /^([a-zA-Z]:[\\/]|[\\/])/.test(dpath)) continue;
    try {
      writeSpec(rootId, dpath, {
        type: "assign",
        agent: typeof d.agent === "string" ? d.agent : "pi",
        profile: typeof d.profile === "string" ? (d.profile as SpecEnvelope["profile"]) : undefined,
        goal,
        accept: Array.isArray(d.accept) && d.accept.length ? d.accept.map(String) : ["输出一句话执行摘要"],
        parent: spec.id,
        budget: { depth_left: Math.max(0, (spec.budget?.depth_left ?? 1) - 1) },
      });
      appendEvent(rootId, path, { kind: "hook_dispatch", data: { path: dpath, goal: goal.slice(0, 120) } });
    } catch (e) {
      appendEvent(rootId, path, { kind: "hook", data: { hook: "node_settled", dispatch_error: String(e).slice(0, 200) } });
    }
  }
}

// S20：tokens 预算 —— 在 turn 边界判定（usage.json 刚落账时），超限即中止并留下证据。
// 依赖以参数注入：测试可以塞 fake append/abort/patch 断言"事件写了、abort 被调用"。
export interface BudgetDeps {
  append: (rec: { kind: string; data: Record<string, unknown> }) => void;
  abort: (summary: string) => void;
  /** 落盘 result.reason（ResultEnvelope 类型还没这个字段，S20 先按宽松形状写） */
  patch: (p: { reason?: string; summary?: string }) => void;
}

/** @returns "no-budget" 未配预算 / "ok" 未超 / "exceeded" 已超并已中止 */
export function enforceTokenBudget(
  budget: { tokens?: number } | null | undefined,
  spent: number,
  deps: BudgetDeps,
): "no-budget" | "ok" | "exceeded" {
  const limit = Number(budget?.tokens);
  if (!Number.isFinite(limit) || limit <= 0) return "no-budget";   // 未配置 = 不拦（不由 0 触发）
  if (spent <= limit) return "ok";
  deps.append({ kind: "budget", data: { limit, spent } });
  deps.abort(`budget exceeded：已用 ${spent} / 上限 ${limit} tokens（turn 边界中止）`);
  deps.patch({ reason: "budget exceeded" });
  return "exceeded";
}

function spawnWorker(rootId: string, path: string, spec: SpecEnvelope, resumed = false, retried = false): void {
  const dir = nodeDir(rootId, path);
  running.add(spec.id);
  const mspec = materializeInputs(rootId, path, spec);   // S14：art:// 先物化，userMessage 见 inputs/<file>
  let file: string, args: string[], desc: string;
  try {
    ({ file, args, desc } = launcher(mspec, resumed, dir));
  } catch (e) {
    running.delete(spec.id);
    appendEvent(rootId, path, { kind: "exit", data: { code: -1, error: `launcher: ${String(e)}` } });
    writeResult(rootId, path, { status: "failed", summary: `Worker 拉起失败：${String(e)}` });
    return;
  }
  appendEvent(rootId, path, { kind: "spawn", data: { cmd: desc, agent: spec.agent ?? "pi", tools: toolAllowlist(mspec).join(",") } });
  const t0 = Date.now();
  let settled = false;
  let killTimer: NodeJS.Timeout | undefined;
  // S6 spent 兜底：worker 没报 spent 就用转写器累计的 usage.json 回填；挂在 close（stdout 已 flush 落账）而非 exit
  // S20：账本 total 优先（usageTokens 内部：tokens 字段 → total.in+out+cache 回落），对外 spent 形状不变
  const backfillSpent = (): void => {
    try {
      const r = readResult(rootId, path);
      if (!r || r.spent) return;
      const tokens = usageTokens(readUsage(dir));
      if (!tokens) return;
      patchResult(rootId, path, { spent: { tokens, minutes: +((Date.now() - t0) / 60_000).toFixed(1) } });
    } catch { /* 无 usage.json / 读失败就跳过 */ }
  };
  const finish = (code: number | null, err?: unknown): void => {
    if (settled) return;
    settled = true;
    if (killTimer) { clearTimeout(killTimer); killTimer = undefined; }
    clearWorker(rootId, path);            // worker.json 租约到期：锁释放
    running.delete(spec.id);
    appendEvent(rootId, path, { kind: "exit", data: { code, ...(err ? { error: String(err) } : {}) } });
    // S13 fallback：拉起即失败/异常退出且无 result → 换 roles.fallback[0] 重试一次（模型不可达的典型兜底）
    const fb = rolesCfg().fallback?.[0];
    const spawnFailed = !!err || (code !== 0 && !readResult(rootId, path));
    if (!retried && spawnFailed && (spec.agent ?? "pi") === "pi" && fb && fb !== modelFor(spec)) {
      appendEvent(rootId, path, { kind: "retry", data: { reason: "spawn failed", model: fb } });
      spawnWorker(rootId, path, { ...spec, model: fb }, resumed, true);
      return;
    }
    // Worker 应自己写 result.json；没写则按退出码兜底（writeResult 幂等：abort/超时先写者不覆写）
    if (!readResult(rootId, path)) {
      writeResult(rootId, path, {
        status: code === 0 ? "done" : "failed",
        summary: code === 0 ? "Worker 正常退出（未写执行摘要）"
          : `Worker 异常退出（code ${code}）${err ? `：${String(err)}` : ""}——详见节点 events.jsonl`,
      });
    }
    notifyLog(rootId, path, spec);            // S13：一行通知供外部 watcher
    runNodeSettledHook(rootId, path, spec);   // S15：节点落定 hook（可派后续 spec）
  };
  try {
    const child = spawn(file, args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"], env: workerEnv(rootId, path), windowsHide: true });
    // S20 tokens 预算：turn 边界（usage.json 刚落账）判定，超限 → budget 事件 + abort（result.summary/reason 记 budget exceeded）
    let budgetHit = false;
    const guardBudget = (ledger: UsageLedger): void => {
      if (budgetHit) return;
      const res = enforceTokenBudget(spec.budget, usageTokens(ledger), {
        append: (rec) => appendEvent(rootId, path, rec),
        abort: (summary) => { budgetHit = true; abortWorker(rootId, path, summary); },
        patch: (p) => { patchResult(rootId, path, p); },
      });
      if (res === "exceeded") indexLog({ event: "budget_exceeded", root_id: rootId, node: spec.id, spent: usageTokens(ledger), limit: spec.budget?.tokens });
    };
    tapStdout(child, dir, rootId, path, { onTurn: guardBudget });   // stdout → stdout.log 全量 + events.jsonl 增量转写
    // worker.json 租约锁：pendingNodes 见 live 锁即跳过（防 daemon 崩溃重启后重复拉起同一会话）
    writeWorker(rootId, path, { pid: child.pid ?? -1, started_at: new Date().toISOString(), cmd: desc });
    // budget.minutes 超时：到点走同 abort 路径（taskkill 树 + 幂等 failed result），summary 记 timeout
    const mins = spec.budget?.minutes;
    if (typeof mins === "number" && mins > 0) {
      killTimer = setTimeout(() => abortWorker(rootId, path, "timeout"), mins * 60_000);
      killTimer.unref();
    }
    child.on("exit", (code) => finish(code));
    child.on("error", (e) => finish(-1, e));
    child.on("close", backfillSpent);
  } catch (e) {
    finish(-1, e);
  }
}

export interface DaemonOptions {
  once?: boolean;        // 跑空队列即退出（冒烟/CI 用）
  timeoutMs?: number;    // 0 = 不限
}

const PIDFILE = join(STATE, "daemon.pid");
const heartbeat = (): void => { try { writeFileSync(PIDFILE, `${process.pid} ${Date.now()}`); } catch { /* 写不进也照常跑 */ } };

export async function daemonLoop(opts: DaemonOptions = {}): Promise<void> {
  syncUserEnv();
  const started = Date.now();
  indexLog({ event: "daemon_start", once: !!opts.once, pid: process.pid });
  try {
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
    heartbeat();
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  } finally {
    try { unlinkSync(PIDFILE); } catch { /* 无 pidfile 也正常退出 */ }
  }
  indexLog({ event: "daemon_stop", once: !!opts.once });
}

// ar daemon：用户会话常驻宿主，消费派发意图、拉起与回收 Worker 进程
// 会话边界原因：Session 0 服务碰不到桌面，agent-desktop/ego 只能在交互会话工作
import { spawn, execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, mkdirSync, copyFileSync, writeFileSync, unlinkSync, statSync } from "node:fs";
import { join, dirname, isAbsolute, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { pendingNodes, appendEvent, readResult, writeResult, patchResult, writeSpec, writeWorker, clearWorker, abortWorker, nodeDir, RUNS_DIR, STATE, DEFAULT_PARALLEL, writeCheckpoint, readCheckpoint, lastSeq, closeDanglingTools, learnedPath, readEvents } from "./runs.ts";
import { tapStdout, readUsage, usageTokens, type UsageLedger, type UsageTurn } from "./transcribe.ts";
import type { SpecEnvelope } from "./envelope.ts";
import { isProfile } from "./envelope.ts";
import { initMcp, closeAllMcp } from "./mcp.ts";

const POLL_MS = Number(process.env.AR_POLL_MS ?? 2000);
// S22：并发以 run 为单位（run.json.parallel / spec.budget.parallel，默认 2，见 runs.pendingNodes）。
// 这里只保留全局安全阀（跨 run 的进程总数），防止多个 run 同时放行把机器打满。
const GLOBAL_MAX_WORKERS = Number(process.env.AR_MAX_WORKERS ?? Math.max(DEFAULT_PARALLEL * 4, 8));
const AICA_PI = process.env.AICA_PI_PKG ?? fileURLToPath(new URL("../aica-pi", import.meta.url));
const AR_CLI = fileURLToPath(new URL("./cli.ts", import.meta.url));
const DEFAULT_PI_MODEL = "opencode-pool/deepseek-v4.1-flash";
const INDEX = join(RUNS_DIR, "index.jsonl");
const running = new Set<string>();

// 协议工具恒授（不写 result 就回收不了节点）；敏感工具须 spec.tools 显式声明
// ev_wait/ev_todo 同列：join 收口与清单投影都是节点自控协议，不属于执行能力
const PROTOCOL_TOOLS = ["ev_done", "ev_fail", "ev_gate", "ev_wait", "ev_todo", "mcp_call"];
const DEFAULT_PI_TOOLS = [
  "read", "write", "edit", "bash", "powershell", "ls", "find", "grep",
  ...PROTOCOL_TOOLS, "kn_recall", "ar_read", "ev_learn",
  // S22/S28：派子节点与自进化提案属于能力（要过 gate），不是恒授协议
  "spawn", "ev_propose",
  // R5：多文件 unified diff（gate exec 档；read-before-edit 由工具内部强制）
  "apply_patch",
];
// S11 reviewer 默认面：只读核证（不写不派；ev_gate 保留提问通道）。用字面量不用 PROTOCOL_TOOLS 展开——ev_wait/ev_todo 不授给 reviewer
const REVIEWER_PI_TOOLS = ["read", "ls", "find", "grep", "ar_read", "ev_done", "ev_fail", "ev_gate"];
// R3 D5 plan mode：只读规划面（不改文件、不跑命令、不派子节点）；spec.tools 也不放开——plan 档恒只读，防自我提权
export const PLAN_PI_TOOLS = ["read", "ls", "find", "grep", "ar_read", "ev_gate", "ev_done", "ev_fail"];

// S13 角色模型路由：aica-pi/roles.json{worker,orchestrator,reviewer,advisor,fallback[]}
// 值给 null/缺省 = 该角色不指定模型，继续走 env/内置默认
interface RolesCfg { worker?: string | null; orchestrator?: string | null; reviewer?: string | null; advisor?: string | null; fallback?: string[] }
function rolesCfg(): RolesCfg {
  try { return JSON.parse(readFileSync(join(AICA_PI, "roles.json"), "utf8")) as RolesCfg; }
  catch { return {}; }
}
/** 模型解析序：spec.model ?? roles[profile] ?? AICA_PI_MODEL ?? 内置默认 */
export function modelFor(spec: SpecEnvelope): string {
  // R3：plan 档没有专属 roles 条目，沿用 worker 的模型选择（只换工具面与 prompt）
  const role = (spec.profile === "plan" ? "worker" : spec.profile ?? "worker") as keyof RolesCfg;
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

/** 节点工具面：spec.tools 为授予全集 + 协议工具；reviewer 缺省只读面；plan 恒只读；其余给内置执行面 + 只读环工具（不授 ar_dispatch/桌面/浏览器） */
export function toolAllowlist(spec: SpecEnvelope): string[] {
  // R3 D5：plan 档先于 spec.tools —— 只读规划不能被 spec 里的写工具或 bash 提权；工具面就是这 8 个
  if (spec.profile === "plan") return [...PLAN_PI_TOOLS];
  if (spec.tools?.length) return [...new Set([...spec.tools, ...PROTOCOL_TOOLS])];
  if (spec.profile === "reviewer") return REVIEWER_PI_TOOLS;
  return DEFAULT_PI_TOOLS;
}

// S12 learn 注入上限：userMessage 尾段只带 learned.md 前 2000 字（防前缀膨胀）
const LEARNED_INJECT_CAP = 2048;   // 字节（R6 起按 UTF-8 字节计，中文不再被字符数坑）

// R3 B3：@file 引用 —— 单文件 ≤8KB、总量 ≤32KB；缺失注入 [缺失] 标记并交给调用方记 input 事件（不阻塞拉起）
export const AT_REF_FILE_CAP = 8 * 1024;
export const AT_REF_TOTAL_CAP = 32 * 1024;
export interface AtRef {
  ref: string; ok: boolean; bytes: number; truncated?: boolean; denied?: string;
  base?: string;          // 命中的基准标签（repo / node），缺失时是试过的基准
  resolved?: string;      // 命中/被拒的实际路径
}
export interface AtRefBase { label: string; dir: string }

/** @file 守门：.git 与运行时 STATE 不进 prompt（@ 是绕过 gate 的直接读，控制面/别的节点的 gate/result 不能这样泄漏） */
function atRefDenied(abs: string): string | null {
  const norm = abs.replace(/\\/g, "/").toLowerCase();
  if (/(^|\/)\.git(\/|$)/.test(norm)) return ".git 目录";
  const state = String(STATE ?? "").replace(/\\/g, "/").toLowerCase();
  if (state && (norm === state || norm.startsWith(state + "/"))) return "运行时状态目录";
  return null;
}

/** @ref 基准顺序（R3）：AICA_REPO_ROOT → runs 目录向上找到的仓库根（package.json/.git）→ 节点目录。
 *  STATE 放在仓库里（测试/演示）时第二档能定位到仓库根；生产建议显式设 AICA_REPO_ROOT。 */
export function atRefBases(nodeDir: string): AtRefBase[] {
  const out: AtRefBase[] = [];
  const seen = new Set<string>();
  const push = (label: string, dir: string): void => {
    try {
      const d = resolve(dir);
      const k = d.toLowerCase();
      if (seen.has(k)) return;
      seen.add(k);
      out.push({ label, dir: d });
    } catch { /* 非法路径忽略 */ }
  };
  if (process.env.AICA_REPO_ROOT) push("repo", process.env.AICA_REPO_ROOT);
  try {
    let d = RUNS_DIR;
    for (let i = 0; i < 8; i++) {
      const parent = dirname(d);
      if (parent === d) break;
      d = parent;
      if (existsSync(join(d, "package.json")) || existsSync(join(d, ".git"))) { push("repo", d); break; }
    }
  } catch { /* RUNS_DIR 读不到时只保留节点基准 */ }
  push("node", nodeDir);
  return out;
}

/** 从 goal 里抽 @path：行首/空白后起头，遇到空白或中英文标点结束；同一条只注入一次。
 *  相对路径按 bases 顺序试，命中哪个把 label 记在 info.base；绝对路径直接读。 */
export function expandAtRefs(
  goal: string,
  bases: string | AtRefBase[],
  onRef?: (ref: string, info: AtRef) => void,
): { text: string; refs: AtRef[] } {
  const list: AtRefBase[] = typeof bases === "string" ? [{ label: "node", dir: bases }] : bases;
  const refs: AtRef[] = [];
  const blocks: string[] = [];
  const seen = new Set<string>();
  let budget = AT_REF_TOTAL_CAP;
  const emit = (info: AtRef): void => { refs.push(info); onRef?.(info.ref, info); };
  for (const m of String(goal ?? "").matchAll(/(^|[\s(（])@([^\s]+)/g)) {
    const ref = m[2].replace(/[)\]）】,.;:!?，。；：！？]+$/g, "");
    if (!ref || seen.has(ref)) continue;
    seen.add(ref);
    const tried: AtRefBase[] = isAbsolute(ref) ? [{ label: "abs", dir: "" }] : list;
    let hit: { abs: string; base: string } | null = null;
    let denied: { reason: string; abs: string } | null = null;
    for (const b of tried) {
      const abs = isAbsolute(ref) ? ref : join(b.dir, ref);
      const d = atRefDenied(abs);
      if (d) { denied = { reason: d, abs }; break; }   // 守门优先于"其它基准里可能存在"
      try { if (existsSync(abs) && statSync(abs).isFile()) { hit = { abs, base: b.label }; break; } }
      catch { /* 读不到就试下一个基准 */ }
    }
    if (denied) {
      blocks.push(`- [拒绝] ${ref}（${denied.reason}：@ 不读控制面）`);
      emit({ ref, ok: false, bytes: 0, denied: denied.reason, resolved: denied.abs, base: tried[0]?.label });
      continue;
    }
    if (!hit) {
      blocks.push(`- [缺失] ${ref}`);
      emit({ ref, ok: false, bytes: 0, base: tried.map((t) => t.label).join(",") });
      continue;
    }
    let buf: Buffer | null = null;
    try { buf = readFileSync(hit.abs); } catch { buf = null; }
    if (!buf) {
      blocks.push(`- [缺失] ${ref}`);
      emit({ ref, ok: false, bytes: 0, base: hit.base, resolved: hit.abs });
      continue;
    }
    if (budget <= 0) {
      blocks.push(`### ${ref}\n\n…[超出注入总量上限（${AT_REF_TOTAL_CAP} 字节），未注入]`);
      emit({ ref, ok: true, bytes: 0, truncated: true, base: hit.base, resolved: hit.abs });
      continue;
    }
    const take = buf.subarray(0, Math.min(AT_REF_FILE_CAP, budget));
    const truncated = take.length < buf.length;
    budget = Math.max(0, budget - take.length);
    blocks.push(`### ${ref}\n\n\`\`\`\n${take.toString("utf8")}${truncated ? "\n…[已截断：超出注入上限]" : ""}\n\`\`\``);
    emit({ ref, ok: true, bytes: take.length, base: hit.base, resolved: hit.abs, ...(truncated ? { truncated } : {}) });
  }
  if (!refs.length) return { text: "", refs };
  return { text: ["## 引用文件", ...blocks].join("\n\n"), refs };
}

// ---------------------------------------------------------------- R6：上下文压缩
// 触发：daemon 在 turn 边界用 usage 累计判断（默认窗口的 80%，spec.budget.context_tokens 覆盖窗口）。
// 产物：compaction_start / compaction_summary / compaction_end 三事件 + <node>/compaction.json，
//       下一轮 userMessage 注入 `## 上下文压缩`（≤2KB）；最近 3 轮原文保留在 session 里，只摘要更早的轮次。

/** 默认上下文窗口（tokens）；env AICA_CONTEXT_WINDOW 可改默认值 */
export const CONTEXT_WINDOW_DEFAULT = Number(process.env.AICA_CONTEXT_WINDOW ?? 128_000) || 128_000;
export const COMPACT_RATIO = 0.8;
export const COMPACT_KEEP_TURNS = 3;
/** 摘要注入上限（字节） */
export const COMPACT_SUMMARY_CAP = 2048;

export interface CompactionRecord {
  at: string;
  window: number;
  threshold: number;
  before_tokens: number;
  /** 压缩后 tokens 未知就 null（不拿摘要字节数冒充 tokens） */
  after_tokens: number | null;
  /** 被摘要的轮次（更早的那些） */
  turns: number[];
  /** 保留原文的最近轮次 */
  kept: number[];
  summary: string;
}

export function compactionWindow(spec: SpecEnvelope): number {
  const c = Number((spec?.budget as { context_tokens?: number } | undefined)?.context_tokens);
  return Number.isFinite(c) && c > 0 ? Math.floor(c) : CONTEXT_WINDOW_DEFAULT;
}

export function compactionThreshold(window: number): number {
  return Math.floor(window * COMPACT_RATIO);
}

/** 按 turn 事件切分轮次；更早轮次的 assistant 文本压成摘要，最近 keepLast 轮留原文 */
export function buildCompactionSummary(
  events: { kind: string; data?: any }[],
  keepLast = COMPACT_KEEP_TURNS,
): { summary: string; turns: number[]; kept: number[] } {
  const perTurn = new Map<number, string[]>();
  let cur = 0;
  for (const e of events) {
    if (e?.kind === "turn") {
      const i = Number(e.data?.i);
      cur = Number.isFinite(i) && i > 0 ? i : cur + 1;
      continue;
    }
    if (e?.kind === "agent_message" && e.data?.role === "assistant" && typeof e.data?.text === "string" && e.data.text.trim()) {
      const arr = perTurn.get(cur) ?? [];
      arr.push(e.data.text.trim());
      perTurn.set(cur, arr);
    }
  }
  const idx = [...perTurn.keys()].sort((a, b) => a - b);
  const kept = idx.slice(-keepLast);
  const older = idx.slice(0, Math.max(0, idx.length - keepLast));
  const lines = older.map((i) => `- 第 ${i} 轮：${perTurn.get(i)!.join(" ").replace(/\s+/g, " ").slice(0, 160)}`);
  let summary = lines.join("\n");
  if (Buffer.byteLength(summary, "utf8") > COMPACT_SUMMARY_CAP) {
    summary = Buffer.from(summary, "utf8").subarray(0, COMPACT_SUMMARY_CAP).toString("utf8");
  }
  return { summary: summary || "（更早的轮次没有可摘要的文本）", turns: older, kept };
}

export interface CompactionDeps {
  /** usage 累计（daemon 传 usageTokens(ledger)） */
  used: number;
  events: () => { kind: string; data?: any }[];
  append: (rec: { kind: string; data: Record<string, unknown> }) => void;
  write: (rec: CompactionRecord) => void;
}

/** @returns "skipped" 本进程已压过 / "below" 未到阈值 / "compacted" 三事件已写 */
export function maybeCompact(spec: SpecEnvelope, deps: CompactionDeps, already = false): "skipped" | "below" | "compacted" {
  if (already) return "skipped";
  const window = compactionWindow(spec);
  const threshold = compactionThreshold(window);
  if (!(deps.used >= threshold)) return "below";
  const { summary, turns, kept } = buildCompactionSummary(deps.events());
  const rec: CompactionRecord = {
    at: new Date().toISOString(),
    window,
    threshold,
    before_tokens: deps.used,
    after_tokens: null,
    turns,
    kept,
    summary,
  };
  deps.append({ kind: "compaction_start", data: { before_tokens: deps.used, threshold, window } });
  deps.append({ kind: "compaction_summary", data: { turns, kept, bytes: Buffer.byteLength(summary, "utf8"), summary } });
  deps.append({ kind: "compaction_end", data: { before_tokens: deps.used, after_tokens: null, kept } });
  deps.write(rec);
  return "compacted";
}

/** 读节点 compaction.json（下一轮 userMessage 注入用） */
export function readCompaction(dir: string): CompactionRecord | null {
  try {
    const rec = JSON.parse(readFileSync(join(dir, "compaction.json"), "utf8"));
    return rec && typeof rec.summary === "string" ? (rec as CompactionRecord) : null;
  } catch { return null; }
}

// R6：按 UTF-8 字节截断，且不切出半个多字节字符（cap 是字节上限）
export function truncBytes(s: string, cap: number): string {
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= cap) return s;
  let cut = Math.max(0, cap);
  while (cut > 0 && (buf[cut] & 0xc0) === 0x80) cut--;   // 回退到字符边界
  return buf.subarray(0, cut).toString("utf8");
}

// R6：learned.md 按 mtime 缓存（文件没变不重读），按字节截 ≤2KB
let learnedCache: { sig: number; text: string } | null = null;

export function learnedText(): string {
  try {
    const f = learnedPath();
    const sig = statSync(f).mtimeMs;
    if (learnedCache && learnedCache.sig === sig) return learnedCache.text;
    const text = truncBytes(readFileSync(f, "utf8"), LEARNED_INJECT_CAP).trim();
    learnedCache = { sig, text };
    return text;
  } catch {
    return "";
  }
}

// R5：AGENTS.md 项目上下文（≤8KB）——项目根到 cwd 逐级找 AGENTS.md（优先）/CLAUDE.md
export const AGENTS_MD_CAP = 8 * 1024;
export interface AgentsMdInfo { files: string[]; bytes: number; text: string }

/** 项目根：AICA_REPO_ROOT 优先；否则从 cwd 向上找 .git/package.json（≤8 级）；都没有 = cwd */
export function findProjectRoot(cwd: string): string {
  if (process.env.AICA_REPO_ROOT) return resolve(process.env.AICA_REPO_ROOT);
  let d = resolve(cwd);
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(d, ".git")) || existsSync(join(d, "package.json"))) return d;
    const parent = dirname(d);
    if (parent === d) break;
    d = parent;
  }
  return resolve(cwd);
}

/** 读 AGENTS.md：同一目录 AGENTS.md 优先，没有才回落 CLAUDE.md；总字节 ≤8KB（超了截断并标记） */
export function collectAgentsMd(cwd: string, root?: string): AgentsMdInfo {
  const top = root ? resolve(root) : findProjectRoot(cwd);
  const here = resolve(cwd);
  const rel = relative(top, here);
  const dirs: string[] = [];
  if (rel && !rel.startsWith("..") && !isAbsolute(rel)) {
    let d = top;
    dirs.push(d);
    for (const seg of rel.split(/[\\/]/).filter(Boolean)) { d = join(d, seg); dirs.push(d); }
  } else {
    dirs.push(top);
    if (here !== top) dirs.push(here);
  }
  const files: string[] = [];
  let text = "";
  for (const dir of dirs) {
    const hit = ["AGENTS.md", "CLAUDE.md"].map((n) => join(dir, n)).find((f) => existsSync(f));
    if (!hit) continue;
    let body = "";
    try { body = readFileSync(hit, "utf8"); } catch { continue; }
    const label = (relative(top, hit) || hit).split("\\").join("/");
    const block = `${text ? "\n\n" : ""}## ${label}\n\n${body.trim()}`;
    const room = AGENTS_MD_CAP - Buffer.byteLength(text, "utf8");
    if (room <= 0) break;
    const b = Buffer.from(block, "utf8");
    if (b.length > room) {
      const suffix = "\n…[AGENTS.md 超出 8KB 截断]";
      const keep = Math.max(0, room - Buffer.byteLength(suffix, "utf8"));
      text += b.subarray(0, keep).toString("utf8") + suffix;
      files.push(label);
      break;
    }
    text += block;
    files.push(label);
  }
  return { files, bytes: Buffer.byteLength(text, "utf8"), text };
}

/** user message = 变量部分（worker.md 规则走 --append-system-prompt 保证前缀稳定可缓存）；resumed = waiting 回复后恢复拉起
 *  R3：baseDir 用于解析 @file（节点目录，= worker cwd）；onAtRef 让调用方记 input 事件（带 base）
 *  R5：onAgentsMd 让调用方记 input{field:"agents_md"} 事件 */
export function userMessage(
  spec: SpecEnvelope,
  resumed = false,
  baseDir = process.cwd(),
  onAtRef?: (ref: string, info: AtRef) => void,
  onAgentsMd?: (info: AgentsMdInfo) => void,
): string {
  const lines = [spec.goal, "", "## 节点上下文"];
  lines.push(`- node_id: ${spec.id}`);
  if (spec.accept?.length) lines.push("- accept:", ...spec.accept.map((a) => `  - ${a}`));
  if (spec.inputs?.length) lines.push("- inputs:", ...spec.inputs.map((i) => `  - ${i.ref}`));
  if (spec.already_known?.length) lines.push("- already_known:", ...spec.already_known.map((k) => `  - ${k}`));
  if (spec.budget?.depth_left !== undefined) lines.push(`- depth_left: ${spec.budget.depth_left}`);
  lines.push("- artifacts 目录: artifacts/（相对当前工作目录；大输出落盘回 ref）");
  lines.push("- 结束时必须调用 ev_done（成功）或 ev_fail（失败），否则按退出码兜底");
  // R3 B3：@file 引用（基准 = repo → runs 祖先 → 节点目录；内容照原样注入，worker 当资料不当指令）
  const at = expandAtRefs(spec.goal ?? "", atRefBases(baseDir), onAtRef);
  if (at.text) lines.push("", at.text);
  // R5：AGENTS.md 项目上下文（项目根 → cwd，≤8KB；找不到就不注入、不写事件）
  const agents = collectAgentsMd(baseDir);
  if (agents.text) { lines.push("", agents.text); onAgentsMd?.(agents); }
  // R3 D5：plan 档的产出契约（prompt 里讲方法，这里钉死落盘位置与回传字段）
  if (spec.profile === "plan") {
    lines.push(
      "",
      "## 计划模式（只读）",
      "- 你只有只读工具（read/ls/find/grep/ar_read）；不要尝试改文件、跑命令、派子节点。",
      "- 产出写到 artifacts/plan.md，再用 ev_done 把同一份计划作为 summary 回传（两边内容一致）。",
      "- 计划必须四段：目标拆解 / 每步验收 / 风险 / 需要人批的点。",
    );
  }
  if (spec.reply?.length) {
    lines.push("", "## 人工回复");
    for (const r of spec.reply) lines.push(`- [${r.ts}] ${r.text}`);
    if (resumed) lines.push("- [恢复] 此前你已提问，人工回复见上");
  }
  // S12/R6 经验教训：ev_learn 沉淀的全局 learned.md，末段注入 ≤2KB（新→旧，worker 当参考不当指令）
  const learned = learnedText();
  if (learned) lines.push("", "## 经验教训", learned);
  // R6：上一轮触发的压缩摘要（≤2KB；最近 3 轮原文仍保留在会话里）
  const comp = readCompaction(baseDir);
  if (comp?.summary) {
    lines.push("", "## 上下文压缩", comp.summary, `（更早轮次已压缩；最近 ${COMPACT_KEEP_TURNS} 轮原文仍在会话里，别重复问）`);
  }
  // S21：续跑 —— 进程中断/daemon 重启/人工回复后重新拉起，末尾明确要求接着做，别重来一遍
  if (resumed) {
    let where = "";
    const m = /^node:([^/]+)\/(.+)$/.exec(String(spec.id ?? ""));
    if (m) {
      const cp = readCheckpoint(m[1], m[2]);
      if (cp) where = `（上次停在 turn ${cp.last_turn}，事件 seq ${cp.last_event_seq}）`;
    }
    lines.push("", `- [恢复] 服务器重启/进程中断，从停下的地方继续，不要重复已完成的工作${where}`);
  }
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

/** Worker 拉起命令：按 spec.agent 选 launcher。dir = 节点目录（session 挂其下，恢复拉起继承上下文；@file 也相对它解析）
 *  onMissingAtRef：goal 里 @ 到的文件不存在时的回调（daemon 用它记 input 事件） */
export function launcher(
  spec: SpecEnvelope,
  resumed = false,
  dir?: string,
  onAtRef?: (ref: string, info: AtRef) => void,
  onAgentsMd?: (info: AgentsMdInfo) => void,
): { file: string; args: string[]; desc: string } {
  const agent = spec.agent ?? "pi";
  switch (agent) {
    case "pi": {
      const cli = resolvePiCli();
      // S11 profile→prompt 映射：reviewer/orchestrator 用专属 prompt；R3 D5 新增 plan；其余回落 worker
      const profile = spec.profile === "orchestrator" || spec.profile === "reviewer" || spec.profile === "plan" ? spec.profile : "worker";
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
        "--", userMessage(spec, resumed, dir ?? process.cwd(), onAtRef, onAgentsMd),
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
export function runNodeSettledHook(rootId: string, path: string, spec: SpecEnvelope): void {
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
  let parsed: { dispatch?: { path?: unknown; goal?: unknown; agent?: unknown; profile?: unknown; accept?: unknown }[]; proposal?: Record<string, unknown> };
  try { parsed = JSON.parse(out.trim() || "{}"); }
  catch { appendEvent(rootId, path, { kind: "hook", data: { hook: "node_settled", error: "stdout 非 JSON", out: out.slice(0, 300) } }); return; }
  // R3 §9.5：hook 登记的提案 —— 事件是 inbox 类目/时间线的数据源（不新造通知通道）
  if (parsed?.proposal) appendEvent(rootId, path, { kind: "proposal", data: parsed.proposal });
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

/** R3 D5：plan 节点收尾时保证 artifacts/plan.md 存在——worker 没写就用 result.summary 兜底（两边内容一致） */
export function finalizePlanArtifact(rootId: string, path: string, spec: SpecEnvelope): void {
  if (spec.profile !== "plan") return;
  try {
    const r = readResult(rootId, path);
    if (!r || r.status !== "done") return;
    const body = String(r.summary ?? "").trim();
    if (!body) return;
    const f = join(nodeDir(rootId, path), "artifacts", "plan.md");
    if (existsSync(f)) return;
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, body + "\n", "utf8");
  } catch { /* 兜底失败不阻塞收尾 */ }
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

/** R3：profile 闭集兜底 —— 入口已拒非法值；历史 spec / 继承来的非法值按 worker 跑，并留一条 input 警告 */
export function normalizeProfile(rootId: string, path: string, spec: SpecEnvelope): SpecEnvelope {
  if (!spec.profile || isProfile(spec.profile)) return spec;
  appendEvent(rootId, path, { kind: "input", data: { field: "profile", value: String(spec.profile), action: "未知 profile → 按 worker 处理" } });
  return { ...spec, profile: "worker" };
}

function spawnWorker(rootId: string, path: string, spec: SpecEnvelope, resumed = false, retried = false): void {
  const dir = nodeDir(rootId, path);
  spec = normalizeProfile(rootId, path, spec);
  running.add(spec.id);
  // S21：续跑时先把上一轮没收回的 tool_call 补成 aborted 的工具结果（进程中断后它们永远不会返回）
  const dangling = resumed ? closeDanglingTools(rootId, path) : 0;
  const mspec = materializeInputs(rootId, path, spec);   // S14：art:// 先物化，userMessage 见 inputs/<file>
  let file: string, args: string[], desc: string;
  try {
    ({ file, args, desc } = launcher(mspec, resumed, dir, (ref, info) => {
      // R3 B3：@file 命中的基准/缺失/被拒都留 input 事件（复用 S14 skip 语义，不阻塞拉起）
      appendEvent(rootId, path, {
        kind: "input",
        data: info.ok
          ? { ref, base: info.base, bytes: info.bytes, ...(info.truncated ? { truncated: true } : {}) }
          : { ref, skipped: info.denied ?? "@file 缺失", ...(info.base ? { base: info.base } : {}) },
      });
    }, (info) => {
      // R5：AGENTS.md 注入了哪几份、多少字节（找不到时这个回调根本不会被调用）
      appendEvent(rootId, path, { kind: "input", data: { field: "agents_md", files: info.files, bytes: info.bytes } });
    }));
  } catch (e) {
    running.delete(spec.id);
    appendEvent(rootId, path, { kind: "exit", data: { code: -1, error: `launcher: ${String(e)}` } });
    writeResult(rootId, path, { status: "failed", summary: `Worker 拉起失败：${String(e)}` });
    return;
  }
  appendEvent(rootId, path, { kind: "spawn", data: { cmd: desc, agent: spec.agent ?? "pi", tools: toolAllowlist(mspec).join(","), resumed, ...(dangling ? { closed_tools: dangling } : {}) } });
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
    finalizePlanArtifact(rootId, path, spec);  // R3 D5：plan 文本兜底落 artifacts/plan.md
    notifyLog(rootId, path, spec);            // S13：一行通知供外部 watcher
    runNodeSettledHook(rootId, path, spec);   // S15：节点落定 hook（可派后续 spec）
  };
  try {
    const child = spawn(file, args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"], env: workerEnv(rootId, path), windowsHide: true });
    // S20 tokens 预算：turn 边界（usage.json 刚落账）判定，超限 → budget 事件 + abort（result.summary/reason 记 budget exceeded）
    // S21 checkpoint：同一个 turn 边界写 checkpoint.json{last_turn,last_event_seq,at}，续跑时知道停在哪
    let budgetHit = false;
    let compacted = false;
    const onTurn = (ledger: UsageLedger, turn: UsageTurn): void => {
      try { writeCheckpoint(rootId, path, { last_turn: turn.i, last_event_seq: lastSeq(rootId, path), at: new Date().toISOString() }); }
      catch { /* checkpoint 写不进去不阻断 */ }
      if (budgetHit) return;
      const res = enforceTokenBudget(spec.budget, usageTokens(ledger), {
        append: (rec) => appendEvent(rootId, path, rec),
        abort: (summary) => { budgetHit = true; abortWorker(rootId, path, summary); },
        patch: (p) => { patchResult(rootId, path, p); },
      });
      if (res === "exceeded") indexLog({ event: "budget_exceeded", root_id: rootId, node: spec.id, spent: usageTokens(ledger), limit: spec.budget?.tokens });
      // R6：上下文压缩 —— 同一 turn 边界按 usage 累计判阈值，三事件 + compaction.json（下一轮注入摘要）
      if (budgetHit || compacted) return;
      const cr = maybeCompact(spec, {
        used: usageTokens(ledger),
        events: () => readEvents(rootId, path),
        append: (rec) => appendEvent(rootId, path, rec),
        write: (rec) => {
          try { writeFileSync(join(dir, "compaction.json"), JSON.stringify(rec, null, 2) + "\n", "utf8"); }
          catch { /* 写不进 compaction.json 不阻断（事件已留证据） */ }
        },
      });
      if (cr === "compacted") {
        compacted = true;
        indexLog({ event: "compaction", root_id: rootId, node: spec.id, used: usageTokens(ledger) });
      }
    };
    tapStdout(child, dir, rootId, path, { onTurn });   // stdout → stdout.log 全量 + events.jsonl 增量转写
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
  // R4 H2：MCP 网关（fail-closed）——连不上只记事件并跳过该 server，绝不阻塞节点拉起
  try {
    const reg = await initMcp();
    indexLog({ event: "mcp_registry", servers: reg.servers.map((s) => ({ name: s.name, ok: s.ok, tools: s.tools.length })) });
  } catch (e) {
    indexLog({ event: "mcp_unavailable", error: String(e).slice(0, 300) });
  }
  try {
  for (;;) {
    try {
      for (const { rootId, path, spec, resumed } of pendingNodes()) {
        if (running.size >= GLOBAL_MAX_WORKERS || running.has(spec.id)) continue;
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
    try { closeAllMcp(); } catch { /* stdio 子进程清理失败不阻塞退出 */ }
    try { unlinkSync(PIDFILE); } catch { /* 无 pidfile 也正常退出 */ }
  }
  indexLog({ event: "daemon_stop", once: !!opts.once });
}

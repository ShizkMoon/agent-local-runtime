// aica-pi · gate：调用级审批门（PRD v2 S4+S8 → v3 S19 重做）
// 设计：文件态唯一真相 —— spec.json 判定依据、gate-req/gate-ans.json 审批对、grants.json 会话授权、
//   loop.json 循环计数、events.jsonl 审计（approve_ask/approve_decide/loop）。
// API 依据 pi-coding-agent@1.5.0 docs/extensions.md:971-986：
//   pi.on("tool_call", (event, ctx) => ...) —— event.toolName/toolCallId/input；
//   返回 {block:true, reason?, terminate?} 拦截（reason 回给模型 = 注入等效）；
//   handler 抛错 = fail-safe block（extensions.md:3233），故本文件全程不抛。
// spec 定位：AICA_STATE+AR_ROOT_ID+AR_NODE_PATH → runs/<r>/nodes/<p>/（workerEnv 注入，tools.ts 同款）；
//   perm-<session>.json 存在则覆盖 spec.permission（仿 Cindy 热档，每次 tool_call 现读）。
//
// S19 重做的四条（PRD v3 §1.4 M1–M4）：
//   1) 决策闭集 allowed-once|rejected|cancelled|unavailable；应答者缺失/坏值/超时一律 unavailable（fail-closed，
//      不与 rejected 混计）。文案与分类进 approve_decide 事件，审计可分辨「人拒」与「通道坏」。
//   2) 三件套分离 deny / restricted / grant：deny 恒拒不弹窗；restricted（restricted_paths + 控制面）必问且
//      不可 session 记住；grant 记「这次命中的资源」{tool,tier,target} 而不是整个工具名。
//      判定序：critical → deny → rules → restricted → grant → approve（deny 先行，避免为注定失败的调用弹窗）。
//   3) 危险路径硬拒：rm/rmdir 目标归一后命中盘根/盘根直接子目录/家目录/工作目录及其祖先 → 直接 block，
//      任何 permission 档与已有 grant 都无权放行（唯一挡得住 rm -rf ~ 的本地机制）。
//   4) 卡的 opts[] 由服务端（本文件）生成并写进 gate-req.json，前端只渲染不硬编码；always 动作自带
//      「记住什么」文案（scope = 本次命中的资源）。
import { existsSync, readFileSync, writeFileSync, appendFileSync, unlinkSync, readdirSync, statSync } from "node:fs";
import { join, resolve as resolvePath, dirname, parse as parsePath } from "node:path";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";

// 审批超时默认可配：M1 定 2min（v2 是硬编码 5min）；轮询间隔可配只为测试提速
const envNum = (name: string, dflt: number): number => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : dflt;
};
const POLL_MS = envNum("AICA_GATE_POLL_MS", 500);
const APPROVE_TIMEOUT_MS = envNum("AICA_GATE_TIMEOUT_MS", 2 * 60_000);
const LOOP_WARN = 5;                     // 同签名连续 N 次 → 软拦（换方法/求助）
const LOOP_HARD = 15;                    // 同签名连续 N 次 → 硬断 terminate
const LOOP_HARD_AGE_MS = 60 * 60_000;    // 同签名持续 60min → 硬顶
const PREVIEW = 300;

// 协议面工具永不进门：gate 自己要靠 ev_gate 求助；ev_done/ev_fail 不写 result 节点就回收不了
const EXEMPT = new Set(["ev_done", "ev_fail", "ev_gate", "ev_todo", "ev_learn"]);
// 工具三档（对齐 OMP read/write/exec；未登记一律 exec —— 宁严勿宽）
const READ_TOOLS = new Set(["read", "ls", "find", "grep", "ar_read", "kn_recall"]);
const WRITE_TOOLS = new Set(["write", "edit"]);

export type Tier = "read" | "write" | "exec";
export type GateDecision = "allowed-once" | "rejected" | "cancelled" | "unavailable";
/** 决策闭集（唯一真相）：应答者只许写这四个值，写别的 = 坏应答 → unavailable */
export const GATE_DECISIONS: readonly GateDecision[] = ["allowed-once", "rejected", "cancelled", "unavailable"];

export interface GateGrant { tool: string; tier: Tier; target: string; ts?: string }
export interface GateOpt { label: string; decision: GateDecision; scope?: GateGrant; hint?: string }
export interface GateAnswer { decision?: string; feedback?: string; remember?: Partial<GateGrant> | null; by?: string }

interface GateSpec {
  permission?: "supervised" | "edits" | "full";
  approve?: string[];
  deny?: string[];
  deny_paths?: string[];
  restricted_paths?: string[];
  rules?: { pattern: string; message: string }[];
}

export interface Resolution {
  action: "allow" | "ask" | "block";
  /** allow/block 给模型的理由；ask 给卡的「为什么要跑它」一行 */
  reason: string;
  tier: Tier;
  /** 这次命中的资源（grant 的粒度；不是工具名） */
  target: string;
  restricted: boolean;
  hit: "critical" | "deny" | "rule" | "control" | "restricted" | "grant" | "approve" | "tier" | "none";
  pattern?: string;
}

// ---------- 节点目录与文件 ----------

function nodeDir(): string {
  const state = process.env.AICA_STATE;
  const root = process.env.AR_ROOT_ID;
  const path = process.env.AR_NODE_PATH;
  if (state && root && path) return join(state, "runs", root, "nodes", path);
  return process.cwd();   // daemon spawn cwd 也是节点目录，双保险
}
interface GateFiles { dir: string; events: string; spec: string; req: string; ans: string; grants: string; loop: string }
function gateFiles(): GateFiles {
  const dir = nodeDir();
  return {
    dir,
    events: join(dir, "events.jsonl"),
    spec: join(dir, "spec.json"),
    req: join(dir, "gate-req.json"),
    ans: join(dir, "gate-ans.json"),
    grants: join(dir, "grants.json"),
    loop: join(dir, "loop.json"),
  };
}

function emit(kind: string, data: Record<string, unknown>): void {
  try {
    appendFileSync(join(nodeDir(), "events.jsonl"),
      JSON.stringify({ ts: new Date().toISOString(), kind, data }) + "\n", "utf8");
  } catch { /* 事件流失败不得阻塞 worker */ }
}

function preview(v: unknown): string {
  let s: string;
  try { s = typeof v === "string" ? v : JSON.stringify(v); } catch { s = String(v); }
  return s.length > PREVIEW ? s.slice(0, PREVIEW) + "…" : s;
}

function readJson<T>(file: string): T | null {
  try { return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as T) : null; }
  catch { return null; }
}

/** spec 每次现读（reply/热改可即时生效）；perm-*.json 热档覆盖 permission */
function loadSpec(): GateSpec {
  const spec = readJson<GateSpec>(gateFiles().spec) ?? {};
  const perm = loadPermOverride();
  if (perm) spec.permission = perm;
  return spec;
}

/** perm-<session>.json 热档：节点目录下任一 perm-*.json（取最新 mtime），{permission:"..."} 或裸字符串 */
function loadPermOverride(): GateSpec["permission"] | undefined {
  try {
    const dir = nodeDir();
    const files = readdirSync(dir).filter((f) => /^perm-.+\.json$/i.test(f));
    if (!files.length) return undefined;
    files.sort((a, b) => statSync(join(dir, b)).mtimeMs - statSync(join(dir, a)).mtimeMs);
    const raw = JSON.parse(readFileSync(join(dir, files[0]), "utf8"));
    const p = typeof raw === "string" ? raw : raw?.permission ?? raw?.mode;
    return p === "supervised" || p === "edits" || p === "full" ? p : undefined;
  } catch { return undefined; }
}

// ---------- 匹配与解析 ----------

/** 模式匹配：精确名，或 "bash:*" 前缀模式（尾部 * = 前缀通配） */
function matchAny(tool: string, patterns?: string[]): string | null {
  for (const p of patterns ?? []) {
    if (!p) continue;
    if (p === "*") return p;
    if (p.endsWith("*")) { if (tool.startsWith(p.slice(0, -1))) return p; }
    else if (tool === p) return p;
  }
  return null;
}

/** args 递归收集全部字符串值（deny_paths 命中检测用） */
function argStrings(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) argStrings(x, out);
  else if (v && typeof v === "object") for (const x of Object.values(v)) argStrings(x, out);
  return out;
}

/** 工具入参里的命令串（bash/powershell 等）：grant 的资源粒度与 rm 硬拒都靠它 */
export function commandOf(args: unknown): string | null {
  if (!args || typeof args !== "object") return null;
  for (const k of ["command", "cmd", "script"]) {
    const v = (args as Record<string, unknown>)[k];
    if (typeof v === "string" && v.trim()) return v;
  }
  return null;
}

const QUOTED = /"([^"]*)"|'([^']*)'/g;
/** 按引号外的 && || ; | & 换行 切子命令（Claude Code 的"复合命令逐段判"；不追求完整 shell 解析） */
export function splitSubcommands(cmd: string): string[] {
  const out: string[] = [];
  let buf = "";
  let quote = "";
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) {
      buf += c;
      if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'") { quote = c; buf += c; continue; }
    if (c === "&" || c === "|" || c === ";" || c === "\n" || c === "\r") {
      // 允许 && || 的第二个字符一起吞掉
      if ((c === "&" || c === "|") && cmd[i + 1] === c) i++;
      if (buf.trim()) out.push(buf);
      buf = "";
      continue;
    }
    buf += c;
  }
  if (buf.trim()) out.push(buf);
  return out;
}

/** 引号感知的空白切词（保留引号内空格；不处理转义，够用即可） */
export function shellTokens(seg: string): string[] {
  const toks: string[] = [];
  let buf = "";
  let quote = "";
  let has = false;
  for (const c of seg) {
    if (quote) {
      if (c === quote) { quote = ""; has = true; continue; }
      buf += c; has = true; continue;
    }
    if (c === '"' || c === "'") { quote = c; has = true; continue; }
    if (/\s/.test(c)) { if (has) { toks.push(buf); buf = ""; has = false; } continue; }
    buf += c; has = true;
  }
  if (has) toks.push(buf);
  return toks;
}

const PATH_KEY = /path|file|dir|cwd|target|output|root|pattern/i;
const PATH_VAL = /^([a-zA-Z]:[\\/]|\\\\|~[\\/]|\.\.?[\\/]|[^\s"']+[\\/][^\s"']+)/;
const stripQuotes = (s: string): string => s.replace(/^["']|["']$/g, "");

/** 候选路径：命令串里像路径的 token + args 里路径型字段/值（归一后供 deny/restricted/控制面匹配） */
function candidatePaths(args: unknown): string[] {
  const out = new Set<string>();
  const cmd = commandOf(args);
  if (cmd) {
    for (const seg of splitSubcommands(cmd)) {
      for (const t of shellTokens(seg)) {
        const v = stripQuotes(t);
        if (PATH_VAL.test(v) || /(^|[\\/])(spec\.json)$/i.test(v)) out.add(v);
      }
    }
  }
  const walk = (v: unknown, key: string): void => {
    if (typeof v === "string") {
      if (PATH_KEY.test(key) || PATH_VAL.test(v)) out.add(v.length > 200 ? v.slice(0, 200) : v);
    } else if (Array.isArray(v)) v.forEach((x) => walk(x, key));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, k);
  };
  walk(args, "");
  return [...out];
}

/** gate-req.targets：给卡看的路径列表（去重，≤10） */
export function extractTargets(args: unknown): string[] {
  const seen = new Set<string>();
  for (const p of candidatePaths(args)) seen.add(p.length > 200 ? p.slice(0, 200) + "…" : p);
  return [...seen].slice(0, 10);
}

const normPath = (s: string): string => s.replace(/\//g, "\\").replace(/\\{2,}/g, "\\").toLowerCase();
const expandTilde = (s: string): string => {
  const home = homedir();
  if (s === "~") return home;
  if (s.startsWith("~/") || s.startsWith("~\\")) return join(home, s.slice(2));
  return s;
};

function pathSegments(p: string, cwd = process.cwd()): string[] {
  return normPath(expandVars(expandTilde(p), cwd)).split("\\").filter(Boolean);
}

function globSeg(seg: string, pat: string): boolean {
  if (!pat.includes("*")) return seg === pat;
  const rx = new RegExp("^" + pat.split("*").map((x) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
  return rx.test(seg);
}

/**
 * 路径模式命中（deny_paths / restricted_paths）：
 * 模式按 `\` 切段，要求「连续整段」出现在候选路径里（不再做裸子串包含 —— 旧实现 "secrets" 会误伤
 * "mysecrets.md"）；单段模式支持 `*.pem` 这类 glob。
 * 返回命中的原始模式（无命中 → null）。
 */
export function hitPathPatterns(candidates: string[], patterns?: string[], cwd = process.cwd()): string | null {
  const pats = (patterns ?? []).filter(Boolean);
  if (!pats.length) return null;
  for (const raw of pats) {
    const pat = pathSegments(raw, cwd);
    if (!pat.length) continue;
    for (const c of candidates) {
      const seg = pathSegments(c, cwd);
      if (seg.length < pat.length) continue;
      for (let i = 0; i + pat.length <= seg.length; i++) {
        let ok = true;
        for (let j = 0; j < pat.length; j++) {
          if (!globSeg(seg[i + j], pat[j])) { ok = false; break; }
        }
        if (ok) return raw;
      }
    }
  }
  return null;
}

/** 稳定排序 args JSON（对象键递归排序，数组保序）——loop 签名输入 */
function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

/** 工具分档：read < write < exec；未登记 = exec（对齐 OMP 未报 tier 记 exec） */
export function tierOf(tool: string): Tier {
  if (READ_TOOLS.has(tool)) return "read";
  if (WRITE_TOOLS.has(tool)) return "write";
  return "exec";
}

/** 是否进审批：spec.approve 模式命中，或 permission 档要求该 tier 问人工（full=不问；edits=问 exec；supervised=问 write+exec） */
function needsApproval(spec: GateSpec, tool: string): { ask: boolean; hit: "approve" | "tier" | "none"; pattern?: string } {
  const pat = matchAny(tool, spec.approve);
  if (pat) return { ask: true, hit: "approve", pattern: pat };
  const t = tierOf(tool);
  if (spec.permission === "supervised") return { ask: t !== "read", hit: t !== "read" ? "tier" : "none" };
  if (spec.permission === "edits") return { ask: t === "exec", hit: t === "exec" ? "tier" : "none" };
  return { ask: false, hit: "none" };   // "full"/未声明 → 档位不额外问
}

// ---------- 危险路径硬拒（M3） ----------

const RM_HEADS = new Set(["rm", "rmdir", "rd", "del", "erase", "remove-item", "ri"]);
const WRAPPERS = new Set(["timeout", "time", "nice", "nohup", "command", "builtin", "stdbuf", "env"]);
const UNKNOWN_VAR_RM = /^(?:\$\{?[a-z_][\w]*\}?|%\w+%)[\\/]\*$/i;

/** 变量展开：~ $HOME ${HOME} $PWD $(pwd) %USERPROFILE% %CD% $env:HOME … */
function expandVars(raw: string, cwd: string): string {
  const home = homedir();
  return raw
    .replace(/\$\(pwd\)/gi, cwd)
    .replace(/\$\{home\}/gi, home)
    .replace(/\$home\b/gi, home)
    .replace(/\$env:userprofile\b/gi, home)
    .replace(/\$env:home\b/gi, home)
    .replace(/%userprofile%/gi, home)
    .replace(/\$\{pwd\}/gi, cwd)
    .replace(/\$pwd\b/gi, cwd)
    .replace(/%cd%/gi, cwd);
}

/** 去掉 glob/尾分隔符：`~/*`、`C:\x\*`、`"$HOME"/` 都归一到基目录 */
function stripGlob(raw: string): string {
  let s = raw.trim();
  s = s.replace(/[\\/]\*+$/, "");
  s = s.replace(/\*+$/, "");
  if (/^[a-zA-Z]:[\\/]*$/.test(s)) return s.slice(0, 2) + "\\";
  s = s.replace(/[\\/]+$/, "");
  return s;
}

/** 归一后的比较键：绝对（相对 base 解析）、小写、根保留尾分隔符 */
export function criticalKey(p: string, base = process.cwd()): string {
  let abs = p;
  try { abs = resolvePath(base, p); } catch { /* 非法路径按原样 */ }
  let k = normPath(abs);
  if (/^[a-z]:\\$/.test(k)) return k;
  return k.replace(/\\+$/, "");
}

interface CriticalSet { exact: Set<string>; drives: Set<string> }
function criticalSet(cwd: string): CriticalSet {
  const home = homedir();
  const exact = new Set<string>();
  const drives = new Set<string>();
  const addChain = (start: string): void => {
    let cur = criticalKey(start, cwd);
    for (;;) {
      exact.add(cur);
      const d = criticalKey(dirname(cur), cwd);
      if (d === cur) break;
      cur = d;
    }
  };
  addChain(cwd);
  addChain(home);
  for (const p of [cwd, home]) {
    const root = parsePath(resolvePath(p)).root;
    if (root) drives.add(criticalKey(root, cwd));
  }
  return { exact, drives };
}

/** 命中危险目标？盘根 / 盘根直接子目录 / 家目录 / 工作目录及其祖先 */
export function isCriticalTarget(target: string, setIs?: CriticalSet, cwd = process.cwd()): boolean {
  const set = setIs ?? criticalSet(cwd);
  const k = criticalKey(target, cwd);
  if (/^[a-z]:\\$/.test(k)) return true;          // 任何盘根
  if (k === "\\\\") return true;                   // UNC 根
  if (set.drives.has(k)) return true;
  if (set.exact.has(k)) return true;
  const parent = criticalKey(dirname(k), cwd);
  return set.drives.has(parent) || /^[a-z]:\\$/.test(parent);   // 盘根的直接子目录（C:\Windows、C:\Users …）
}

/**
 * rm/rmdir 硬拒：返回命中的原始目标（无命中 → null）。
 * 逐子命令、剥环境变量前缀与包装器，取非 flag 参数为目标；归一（~ / $HOME / .. / 尾 glob）后比对。
 * 这是唯一不被 grant / permission=full 绕过的检查。
 */
export function criticalRmTarget(cmd: string, cwd = process.cwd()): string | null {
  const set = criticalSet(cwd);
  for (const seg of splitSubcommands(cmd)) {
    const toks = shellTokens(seg);
    let i = 0;
    while (i < toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[i])) i++;   // FOO=bar rm -rf / 仍命中
    while (i < toks.length && WRAPPERS.has(toks[i].toLowerCase())) i++;
    const head = (toks[i] ?? "").toLowerCase().replace(/\.exe$/, "");
    if (!RM_HEADS.has(head)) continue;
    for (const rawTok of toks.slice(i + 1)) {
      const tok = stripQuotes(rawTok);
      if (/^--?[A-Za-z]/.test(tok) || /^\/[A-Za-z]+$/.test(tok)) continue;   // -rf / -Recurse / /s /q
      if (UNKNOWN_VAR_RM.test(tok)) return rawTok;      // "$DIR"/* 变量未知：按可能命中盘根处理
      const stripped = stripGlob(expandTilde(expandVars(tok, cwd)));
      // rm -rf / 或 \ ：单个分隔符 = 当前盘根（stripGlob 会把它清空，故先特判）
      const target = /^[\\/]+$/.test(tok)
        ? parsePath(cwd).root
        : (stripped === "" ? cwd : stripped);            // rm -rf * → 按工作目录算
      if (isCriticalTarget(target, set, cwd)) return rawTok;
    }
  }
  return null;
}

// ---------- 控制面（Cindy A3：恒问、不可记住） ----------

function stateRoot(): string {
  const s = process.env.AICA_STATE;
  return s ? resolvePath(s) : "";
}

/**
 * 控制面判定：spec.json、AICA_STATE 下的控制文件、aica-pi/ 包内。
 * 节点目录里的 artifacts/、session/ 是数据面（worker 天天写，不该每次弹窗）；
 * 其余（spec/result/worker/gate/grants/loop/usage/事件、run.json、plan、daemon.pid、memory…）算控制面。
 */
/** 控制面判定。readOnly=true（read/ls/find/grep/ar_read）时 aica-pi/** 放行——
 *  plan/调研要能读运行时源码；写与执行仍恒问。.git/** 与 STATE 控制文件任何档位都拦。 */
export function controlPlaneHit(candidates: string[], cwd = process.cwd(), opts: { readOnly?: boolean } = {}): string | null {
  const state = stateRoot();
  const node = process.env.AICA_STATE && process.env.AR_ROOT_ID && process.env.AR_NODE_PATH
    ? resolvePath(state, "runs", process.env.AR_ROOT_ID, "nodes", process.env.AR_NODE_PATH)
    : "";
  const stateKey = state ? criticalKey(state) : "";
  const nodeKey = node ? criticalKey(node) : "";
  for (const raw of candidates) {
    const cand = stripQuotes(raw);
    const segs = pathSegments(cand, cwd);
    // .git/**：任何档位都拦（配置/凭据/历史，读也不给）
    if (segs.includes(".git")) return raw;
    // aica-pi/**（运行时自身）：写/执行恒问；只读工具放行
    if (segs.includes("aica-pi") && !opts.readOnly) return raw;
    const base = normPath(cand).split("\\").filter(Boolean).pop() ?? "";
    if (!state) {
      // 没有 STATE 时也要拦裸 spec.json（命令里 `cat spec.json`）——按控制面文件处理
      if (base === "spec.json") return raw;
      continue;
    }
    let abs: string;
    try { abs = resolvePath(cwd, expandVars(cand, cwd)); } catch { continue; }
    const key = criticalKey(abs, cwd);
    const mine = !!nodeKey && (key === nodeKey || key.startsWith(nodeKey + "\\"));
    // 裸 spec.json 只有在"只读工具 + 本节点自己的 spec"时才放行
    if (base === "spec.json" && !(opts.readOnly && mine)) return raw;
    // 节点目录本身上下都是数据面（worker 的 cwd；`ls .`/`ls <node>` 不该被当成控制面）
    if (nodeKey && key === nodeKey) continue;
    // 节点目录里的已知控制文件（spec/result/worker/gate*/grants/loop/usage/checkpoint/perm-*）算控制面；
    // 只读工具读自己节点的不拦（spec/result/events 是它自己的输入输出）。
    if (mine) {
      if (opts.readOnly) continue;
      const rel = key.slice(nodeKey.length + 1);
      const leaf = rel.split("\\").pop() ?? "";
      if (/^(spec|result|result\.resolved|worker|gate|gate-req|gate-ans|grants|loop|usage|checkpoint|review-req)\.json$/i.test(leaf)) return raw;
      if (/^perm-.+\.json$/i.test(leaf) || leaf === "events.jsonl") return raw;
      continue;
    }
    if (stateKey && (key === stateKey || key.startsWith(stateKey + "\\"))) return raw;
  }
  return null;
}

// ---------- grants.json（记住的是这次命中的资源） ----------

export function loadGrants(file = gateFiles().grants): GateGrant[] {
  const g = readJson<{ grants?: GateGrant[] }>(file);
  if (!Array.isArray(g?.grants)) return [];   // v2 的 {tools:[...]}（整个工具名）不再授权：宁多问一次
  return g!.grants!.filter((x): x is GateGrant =>
    !!x && typeof x.tool === "string" && typeof x.tier === "string" && typeof x.target === "string");
}

function addGrant(grant: GateGrant): void {
  try {
    const file = gateFiles().grants;
    const list = loadGrants(file);
    if (list.some((g) => g.tool === grant.tool && g.tier === grant.tier && g.target === grant.target)) return;
    list.push({ tool: grant.tool, tier: grant.tier, target: grant.target, ts: new Date().toISOString() });
    writeFileSync(file, JSON.stringify({ v: 2, grants: list, updated: new Date().toISOString() }, null, 2) + "\n", "utf8");
  } catch { /* grant 写失败下次还会问，不致命 */ }
}

const looksPath = (s: string): boolean => /^([a-zA-Z]:[\\/]|\\\\|~[\\/]|\.{1,2}[\\/])/.test(s) || /[\\/]/.test(s);

/** grant 目标比对：命令按整串相等；路径按前缀（目录级）——共用工具名不再放行 */
export function targetMatches(granted: string, actual: string): boolean {
  if (granted === actual) return true;
  if (!looksPath(granted) || !looksPath(actual)) return false;
  const g = normPath(granted).replace(/\\+$/, "");
  const a = normPath(actual).replace(/\\+$/, "");
  return a === g || a.startsWith(g + "\\");
}

function findGrant(grants: GateGrant[], tool: string, tier: Tier, target: string): GateGrant | null {
  for (const g of grants) {
    if (!matchAny(tool, [g.tool])) continue;
    if (g.tier !== tier) continue;
    if (targetMatches(g.target, target)) return g;
  }
  return null;
}

/** 这次调用命中的资源：命令串 / 归一化路径 / args 摘要（grant 的 target 粒度） */
export function resourceTarget(tool: string, args: unknown, cwd = process.cwd()): string {
  const cmd = commandOf(args);
  if (cmd) return cmd.trim().replace(/\s+/g, " ");
  const p = primaryPathArg(args);
  if (p) {
    try { return resolvePath(cwd, expandTilde(stripQuotes(p))); } catch { return p; }
  }
  return `${tool}:${createHash("sha1").update(stableJson(args)).digest("hex").slice(0, 12)}`;
}

/** 主路径参数：优先形似 path/file/dir 的键，其次像路径的值（相对文件名也算，按 cwd 归一） */
function primaryPathArg(args: unknown): string | null {
  let best: string | null = null;
  const walk = (v: unknown, key: string): void => {
    if (best !== null) return;
    if (typeof v === "string") {
      if (PATH_KEY.test(key) || looksPath(v)) best = v;
    } else if (Array.isArray(v)) {
      for (const x of v) walk(x, key);
    } else if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) walk(x, k);
    }
  };
  walk(args, "");
  return best;
}

// ---------- 判定（纯函数，测试直接调） ----------

export function resolveCall(spec: GateSpec, tool: string, args: unknown, grants: GateGrant[], cwd = process.cwd()): Resolution {
  const t = tierOf(tool);
  const target = resourceTarget(tool, args, cwd);
  const cands = candidatePaths(args);
  const base = { tier: t, target, restricted: false } as const;

  // 0) 危险路径硬拒：先于一切规则，任何档位与授权都无权放行
  const cmd = commandOf(args);
  if (cmd) {
    const bad = criticalRmTarget(cmd, cwd);
    if (bad) {
      return { ...base, action: "block", hit: "critical", pattern: bad,
        reason: `critical-path：拒绝删除「${bad}」——目标命中盘根/家目录/工作目录（或盘根直接子目录）。该调用被硬拒，任何权限档与已有授权都无权放行；确需清理请在目标目录内用具体路径。` };
    }
  }

  // 1) deny：恒拒、不弹窗
  const denyPat = matchAny(tool, spec.deny);
  if (denyPat) {
    return { ...base, action: "block", hit: "deny", pattern: denyPat, reason: `denied by spec：工具 ${tool} 在 deny 列表（${denyPat}），不要重试。` };
  }
  const denyPath = hitPathPatterns(cands, spec.deny_paths);
  if (denyPath) {
    return { ...base, action: "block", hit: "deny", pattern: denyPath, reason: `denied by spec：参数路径命中 deny_paths（${denyPath}），该资源禁止访问。` };
  }

  // 2) rules：提示性守门（按子命令逐段测，堵住 && 绕过）
  const argsJson = preview(args);
  const ruleTexts = cmd ? splitSubcommands(cmd) : [];
  for (const r of spec.rules ?? []) {
    if (!r?.pattern) continue;
    try {
      const rx = new RegExp(r.pattern);
      if (rx.test(argsJson) || ruleTexts.some((s) => rx.test(s))) {
        return { ...base, action: "block", hit: "rule", pattern: r.pattern, reason: r.message || "blocked by spec rule" };
      }
    } catch { /* 坏正则跳过该条 */ }
  }

  // 3) restricted：必问且不可记住（控制面 + restricted_paths）；只读工具对 aica-pi/** 放行
  const ctrl = controlPlaneHit(cands, cwd, { readOnly: t === "read" });
  if (ctrl) {
    return { ...base, action: "ask", hit: "control", pattern: ctrl, restricted: true,
      reason: `控制面（${ctrl}）：任何权限档都要人确认，且不能记住。` };
  }
  const restPat = hitPathPatterns(cands, spec.restricted_paths);
  if (restPat) {
    return { ...base, action: "ask", hit: "restricted", pattern: restPat, restricted: true,
      reason: `命中 restricted_paths（${restPat}）：这类资源每次都要人确认，且不能记住。` };
  }

  // 4) grant：只对这次命中的资源生效
  const g = findGrant(grants, tool, t, target);
  if (g) return { ...base, action: "allow", hit: "grant", pattern: g.target, reason: `会话已授权：${g.tool} · ${g.tier} · ${g.target}` };

  // 5) approve：档位/显式规则要求问人
  const na = needsApproval(spec, tool);
  if (na.ask) {
    const why = na.hit === "approve"
      ? `命中 spec.approve（${na.pattern}）：这个工具每次都要人确认。`
      : `permission=${spec.permission ?? "未声明"}：${t} 类工具每次都要人确认。`;
    return { ...base, action: "ask", hit: na.hit, pattern: na.pattern, reason: why };
  }

  return { ...base, action: "allow", hit: "none", reason: "" };
}

// ---------- S8 loop guard ----------

const loops = new Map<string, { n: number; firstTs: number }>();
let lastSig = "";

/** 连续相同签名计数（签名变了即重置；计数落 loop.json 供外部观察，重启=重置） */
function loopCount(sig: string): { n: number; firstTs: number } {
  let e = loops.get(sig);
  if (lastSig === sig && e) e.n += 1;
  else { e = { n: 1, firstTs: Date.now() }; loops.clear(); loops.set(sig, e); }
  lastSig = sig;
  try {
    writeFileSync(gateFiles().loop, JSON.stringify({ sig, n: e.n, first_ts: new Date(e.firstTs).toISOString(), ts: new Date().toISOString() }, null, 2) + "\n", "utf8");
  } catch { /* 计数落盘失败不影响拦截 */ }
  return e;
}

// ---------- 审批问询 ----------

function cleanupGate(): void {
  const f = gateFiles();
  try { unlinkSync(f.ans); } catch { }
  try { unlinkSync(f.req); } catch { }
}

/** 卡上的动作（服务端生成，前端只渲染）：always 的 scope 必须写明记住什么 */
export function buildOpts(tool: string, res: Resolution): GateOpt[] {
  const opts: GateOpt[] = [{ label: "允许一次", decision: "allowed-once" }];
  if (!res.restricted) {
    opts.push({
      label: `记住这类（${tool} · ${res.target}）`,
      decision: "allowed-once",
      scope: { tool, tier: res.tier, target: res.target },
      hint: `本会话不再问同一个资源：${tool} · ${res.tier} · ${res.target}（换命令/换路径仍会问）`,
    });
  }
  opts.push({ label: "拒绝", decision: "rejected" });
  return opts;
}

/** 应答里带回来的 remember 必须与本次 req 的 scope 一致，否则不记（前端伪造 scope 无法放行整个工具） */
function validRemember(res: Resolution, tool: string, rem: GateAnswer["remember"]): GateGrant | null {
  if (res.restricted || !rem || typeof rem !== "object") return null;
  if (rem.tool !== tool || rem.tier !== res.tier || rem.target !== res.target) return null;
  return { tool, tier: res.tier, target: res.target };
}

function normalizeDecision(raw: unknown): GateDecision | null {
  return typeof raw === "string" && (GATE_DECISIONS as readonly string[]).includes(raw) ? (raw as GateDecision) : null;
}

const rejectReason = (tool: string, target: string, feedback?: string): string =>
  (feedback && feedback.trim())
    ? feedback.trim()                      // 人话原样回注（Cindy：reason 进模型上下文，别写 "denied"）
    : `调用被拒绝（${tool} · ${target}）：不要重试同一调用，换方法或 ev_gate 求助。`;

/**
 * 写 gate-req（含服务端生成的 opts）→ 轮询 gate-ans。
 * 返回 block 即拦截；undefined 即放行。决策只有闭集四个值，坏值/坏文件/超时/中止都 fail-closed。
 */
async function askApproval(
  tool: string, callId: string, args: unknown, ctx: any, res: Resolution,
): Promise<{ block: boolean; reason?: string } | undefined> {
  const f = gateFiles();
  try { unlinkSync(f.ans); } catch { }   // 清掉上一轮的残答，防止秒答错配
  const opts = buildOpts(tool, res);
  const req = {
    v: 2, call_id: callId, tool, tier: res.tier, target: res.target,
    restricted: res.restricted, rememberable: opts.some((o) => !!o.scope),
    reason: res.reason, hit: res.hit,
    args, targets: extractTargets(args), opts,
    asked_at: new Date().toISOString(),
  };
  try {
    writeFileSync(f.req, JSON.stringify(req, null, 2) + "\n", "utf8");
  } catch (e) {
    emit("gate_error", { call_id: callId, tool, error: String(e) });
    emit("approve_decide", { call_id: callId, tool, decision: "unavailable", source: "write-error" });
    return { block: true, reason: "审批通道不可用（gate-req 写入失败）：该调用未执行，按未批准处理。" };
  }
  emit("approve_ask", {
    call_id: callId, tool, tier: res.tier, target: res.target, args: preview(args),
    targets: req.targets, reason: res.reason, restricted: res.restricted,
    opts: opts.map((o) => ({ label: o.label, decision: o.decision, scope: o.scope ?? null })),
  });

  const deadline = Date.now() + APPROVE_TIMEOUT_MS;
  const decide = (d: GateDecision, source: string, ans?: GateAnswer): { block: boolean; reason?: string } | undefined => {
    if (d === "allowed-once") {
      const rem = validRemember(res, tool, ans?.remember ?? null);
      if (rem) addGrant(rem);
      emit("approve_decide", {
        call_id: callId, tool, decision: d, source, target: res.target,
        remembered: rem ? { tool: rem.tool, tier: rem.tier, target: rem.target } : null,
        ...(ans?.by ? { by: String(ans.by) } : {}),
      });
      cleanupGate();
      return undefined;
    }
    if (d === "rejected") {
      const reason = rejectReason(tool, res.target, ans?.feedback);
      emit("approve_decide", { call_id: callId, tool, decision: d, source, target: res.target, feedback: ans?.feedback ?? null, reason });
      cleanupGate();
      return { block: true, reason };
    }
    if (d === "cancelled") {
      emit("approve_decide", { call_id: callId, tool, decision: d, source, target: res.target });
      cleanupGate();
      return { block: true, reason: "审批已取消：该调用未执行。" };
    }
    // unavailable：通道坏/坏值/超时 —— 与「人拒绝」分开记账
    emit("approve_decide", { call_id: callId, tool, decision: "unavailable", source, target: res.target });
    cleanupGate();
    return { block: true, reason: "审批通道不可用（未应答/超时/坏应答）：该调用未执行，按未批准处理；需要人决定请走 ev_gate。" };
  };

  for (;;) {
    if (ctx?.signal?.aborted) return decide("cancelled", "aborted");
    if (existsSync(f.ans)) {
      const ans = readJson<GateAnswer>(f.ans);
      if (ans && typeof ans === "object") {
        const d = normalizeDecision(ans.decision);
        if (d) return decide(d, String(ans.by ?? "user"), ans);
        return decide("unavailable", "invalid-decision", ans);   // 坏值不混进 rejected
      }
      // ans 存在但 JSON 暂不可解析 = 写入中途，继续轮询（超时兜底）
    }
    if (Date.now() >= deadline) return decide("unavailable", "timeout");
    await delay(POLL_MS);
  }
}

// ---------- 主 handler ----------

export default function (pi: any) {
  pi.on("tool_call", async (event: any, ctx: any) => {
    const tool = String(event.toolName ?? "");
    const callId = String(event.toolCallId ?? "");
    const args = event.input ?? event.args ?? {};
    if (EXEMPT.has(tool)) return undefined;                    // 协议工具直通（求助/收口不能被门拦住）

    // S8 loop guard：先计数后判（被拦的重试仍计入 —— 模型死咬同一调用时计数照样涨）
    const sig = `${tool}:${createHash("sha1").update(stableJson(args)).digest("hex").slice(0, 16)}`;
    const lc = loopCount(sig);
    if (lc.n >= LOOP_HARD || (lc.n >= 2 && Date.now() - lc.firstTs >= LOOP_HARD_AGE_MS)) {
      emit("loop", { sig, n: lc.n, stop: "hard", tool });
      return { block: true, reason: "loop-guard: hard stop", terminate: true };
    }
    if (lc.n >= LOOP_WARN) {
      emit("loop", { sig, n: lc.n, stop: "warn", tool });
      return { block: true, reason: `loop-guard: 相同调用已连续 ${lc.n} 次，换方法或 ev_gate 求助` };
    }

    const spec = loadSpec();
    // 判定序：critical → deny → rules → restricted → grant → approve（见文件头）
    const res = resolveCall(spec, tool, args, loadGrants(), nodeDir());

    if (res.action === "block") {
      emit("gate_deny", { call_id: callId, tool, hit: res.hit, pattern: res.pattern ?? null, reason: res.reason });
      return { block: true, reason: res.reason };
    }
    if (res.action === "allow") return undefined;
    return await askApproval(tool, callId, args, ctx, res);
  });
}


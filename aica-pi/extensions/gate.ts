// aica-pi · gate：调用级审批门 + args 规则守门 + 受保护路径 + doom-loop guard（PRD v2 R1 S4+S8）
// 设计：文件态唯一真相 —— spec.json 判定依据、gate-req/gate-ans.json 审批对、grants.json 会话授权、
//   loop.json 循环计数、events.jsonl 审计（approve_ask/approve_decide/loop）。
// API 依据 pi-coding-agent@1.5.0 docs/extensions.md:971-986：
//   pi.on("tool_call", (event, ctx) => ...) —— event.toolName/toolCallId/input；
//   返回 {block:true, reason?, terminate?} 拦截（reason 回给模型 = 注入等效）；
//   handler 抛错 = fail-safe block（extensions.md:3233），故本文件全程不抛。
// spec 定位：AICA_STATE+AR_ROOT_ID+AR_NODE_PATH → runs/<r>/nodes/<p>/（workerEnv 注入，tools.ts 同款）；
//   perm-<session>.json 存在则覆盖 spec.permission（仿 Cindy 热档，每次 tool_call 现读）。
import { existsSync, readFileSync, writeFileSync, appendFileSync, unlinkSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

const POLL_MS = 500;
const APPROVE_TIMEOUT_MS = 5 * 60_000;   // 审批 5 分钟超时 → block
const LOOP_WARN = 5;                     // 同签名连续 N 次 → 软拦（换方法/求助）
const LOOP_HARD = 15;                    // 同签名连续 N 次 → 硬断 terminate
const LOOP_HARD_AGE_MS = 60 * 60_000;    // 同签名持续 60min → 硬顶
const PREVIEW = 300;

// 协议面工具永不进门：gate 自己要靠 ev_gate 求助；ev_done/ev_fail 不写 result 节点就回收不了
const EXEMPT = new Set(["ev_done", "ev_fail", "ev_gate", "ev_todo", "ev_learn"]);
// 工具三档（对齐 OMP read/write/exec；未登记一律 exec —— 宁严勿宽）
const READ_TOOLS = new Set(["read", "ls", "find", "grep", "ar_read", "kn_recall"]);
const WRITE_TOOLS = new Set(["write", "edit"]);

interface GateSpec {
  permission?: "supervised" | "edits" | "full";
  approve?: string[];
  deny?: string[];
  deny_paths?: string[];
  rules?: { pattern: string; message: string }[];
}

// ---------- 节点目录与文件 ----------

function nodeDir(): string {
  const state = process.env.AICA_STATE;
  const root = process.env.AR_ROOT_ID;
  const path = process.env.AR_NODE_PATH;
  if (state && root && path) return join(state, "runs", root, "nodes", path);
  return process.cwd();   // daemon spawn cwd 也是节点目录，双保险
}
const DIR = nodeDir();
const EVENTS = join(DIR, "events.jsonl");
const SPEC_FILE = join(DIR, "spec.json");
const REQ_FILE = join(DIR, "gate-req.json");
const ANS_FILE = join(DIR, "gate-ans.json");
const GRANTS_FILE = join(DIR, "grants.json");
const LOOP_FILE = join(DIR, "loop.json");

function emit(kind: string, data: Record<string, unknown>): void {
  try {
    appendFileSync(EVENTS, JSON.stringify({ ts: new Date().toISOString(), kind, data }) + "\n", "utf8");
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
  const spec = readJson<GateSpec>(SPEC_FILE) ?? {};
  const perm = loadPermOverride();
  if (perm) spec.permission = perm;
  return spec;
}

/** perm-<session>.json 热档：节点目录下任一 perm-*.json（取最新 mtime），{permission:"..."} 或裸字符串 */
function loadPermOverride(): GateSpec["permission"] | undefined {
  try {
    const files = readdirSync(DIR).filter((f) => /^perm-.+\.json$/i.test(f));
    if (!files.length) return undefined;
    files.sort((a, b) => statSync(join(DIR, b)).mtimeMs - statSync(join(DIR, a)).mtimeMs);
    const raw = JSON.parse(readFileSync(join(DIR, files[0]), "utf8"));
    const p = typeof raw === "string" ? raw : raw?.permission ?? raw?.mode;
    return p === "supervised" || p === "edits" || p === "full" ? p : undefined;
  } catch { return undefined; }
}

// ---------- 匹配与解析 ----------

/** 模式匹配：精确名，或 "bash:*" 前缀模式（尾部 * = 前缀通配） */
function matchAny(tool: string, patterns?: string[]): boolean {
  for (const p of patterns ?? []) {
    if (!p) continue;
    if (p === "*") return true;
    if (p.endsWith("*")) { if (tool.startsWith(p.slice(0, -1))) return true; }
    else if (tool === p) return true;
  }
  return false;
}

/** args 递归收集全部字符串值（deny_paths 命中检测用） */
function argStrings(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) argStrings(x, out);
  else if (v && typeof v === "object") for (const x of Object.values(v)) argStrings(x, out);
  return out;
}

const normPath = (s: string): string => s.replace(/\//g, "\\").toLowerCase();

/** deny_paths：任一 args 字符串含路径模式片段即命中（Windows 分隔符/大小写归一） */
function hitDenyPath(args: unknown, patterns?: string[]): boolean {
  if (!patterns?.length) return false;
  const strs = argStrings(args).map(normPath);
  return patterns.some((p) => {
    const np = normPath(p);
    return np && strs.some((s) => s.includes(np));
  });
}

/** gate-req.targets：key 像路径的参数 + 值形如绝对/相对路径的字符串（去重，≤10） */
function extractTargets(args: unknown): string[] {
  const out = new Set<string>();
  const PATH_KEY = /path|file|dir|cwd|target|output/i;
  const PATH_VAL = /^([a-zA-Z]:[\\/]|~[\\/]|\.\.?[\\/]|[^\s"']+[\\/][^\s"']+)/;
  const walk = (v: unknown, key: string): void => {
    if (typeof v === "string") {
      if (PATH_KEY.test(key) || PATH_VAL.test(v)) out.add(v.length > 200 ? v.slice(0, 200) + "…" : v);
    } else if (Array.isArray(v)) v.forEach((x) => walk(x, key));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, k);
  };
  walk(args, "");
  return [...out].slice(0, 10);
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
function tier(tool: string): "read" | "write" | "exec" {
  if (READ_TOOLS.has(tool)) return "read";
  if (WRITE_TOOLS.has(tool)) return "write";
  return "exec";
}

/** 是否进审批：spec.approve 模式命中，或 permission 档要求该 tier 问人工（full=不问；edits=问 exec；supervised=问 write+exec） */
function needsApproval(spec: GateSpec, tool: string): boolean {
  if (matchAny(tool, spec.approve)) return true;
  const t = tier(tool);
  if (spec.permission === "supervised") return t !== "read";
  if (spec.permission === "edits") return t === "exec";
  return false;   // "full"/未声明 → 档位不额外问
}

// ---------- grants.json（allow_session 会话授权） ----------

function loadGrants(): string[] {
  const g = readJson<{ tools?: string[] }>(GRANTS_FILE);
  return Array.isArray(g?.tools) ? g!.tools! : [];
}

function addGrant(tool: string): void {
  try {
    const tools = new Set(loadGrants());
    tools.add(tool);
    writeFileSync(GRANTS_FILE, JSON.stringify({ tools: [...tools], updated: new Date().toISOString() }, null, 2) + "\n", "utf8");
  } catch { /* grant 写失败下次还会问，不致命 */ }
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
    writeFileSync(LOOP_FILE, JSON.stringify({ sig, n: e.n, first_ts: new Date(e.firstTs).toISOString(), ts: new Date().toISOString() }, null, 2) + "\n", "utf8");
  } catch { /* 计数落盘失败不影响拦截 */ }
  return e;
}

// ---------- 审批问询 ----------

function cleanupGate(): void {
  try { unlinkSync(ANS_FILE); } catch { }
  try { unlinkSync(REQ_FILE); } catch { }
}

/** 写 gate-req → 轮询 gate-ans（500ms/5min）。决策：allow_once|allow 放行；allow_session 放行+记 grants；其余 deny → block(feedback||"denied") */
async function askApproval(tool: string, callId: string, args: unknown, ctx: any): Promise<{ block: boolean; reason?: string } | undefined> {
  try { unlinkSync(ANS_FILE); } catch { }   // 清掉上一轮的残答，防止秒答错配
  const req = { callId, tool, args, ts: new Date().toISOString(), targets: extractTargets(args) };
  try {
    writeFileSync(REQ_FILE, JSON.stringify(req, null, 2) + "\n", "utf8");
  } catch (e) {
    emit("gate_error", { call_id: callId, tool, error: String(e) });
    return { block: true, reason: `gate-req 写入失败，fail-closed 拦截：${String(e)}` };
  }
  emit("approve_ask", { call_id: callId, tool, args: preview(args), targets: req.targets });

  const deadline = Date.now() + APPROVE_TIMEOUT_MS;
  for (;;) {
    if (ctx?.signal?.aborted) {
      emit("approve_decide", { call_id: callId, tool, decision: "aborted" });
      cleanupGate();
      return { block: true, reason: "approval aborted" };
    }
    if (existsSync(ANS_FILE)) {
      const ans = readJson<{ decision?: string; feedback?: string }>(ANS_FILE);
      if (ans) {
        const d = String(ans.decision ?? "");
        emit("approve_decide", { call_id: callId, tool, decision: d, feedback: ans.feedback });
        cleanupGate();
        if (d === "allow_session") { addGrant(tool); return undefined; }
        if (d === "allow" || d === "allow_once" || d === "once") return undefined;
        return { block: true, reason: String(ans.feedback || "denied") };   // deny 及未知决策一律 fail-closed
      }
      // ans 存在但 JSON 暂不可解析 = 写入中途，继续轮询（超时兜底）
    }
    if (Date.now() > deadline) {
      emit("approve_decide", { call_id: callId, tool, decision: "timeout" });
      cleanupGate();
      return { block: true, reason: "approval timeout" };
    }
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
    const argsJson = preview(args);

    // 1) deny：工具名/前缀模式命中，或 args 路径命中 deny_paths → 恒拒不弹审批
    if (matchAny(tool, spec.deny) || hitDenyPath(args, spec.deny_paths)) {
      emit("gate_deny", { call_id: callId, tool });
      return { block: true, reason: "denied by spec" };
    }

    // 2) rules：逐条 RegExp 测 JSON.stringify(args)，命中 block(rule.message)（stream-rules-lite）
    for (const r of spec.rules ?? []) {
      try {
        if (r?.pattern && new RegExp(r.pattern).test(argsJson)) {
          emit("gate_rule", { call_id: callId, tool, pattern: r.pattern });
          return { block: true, reason: r.message || "blocked by spec rule" };
        }
      } catch { /* 坏正则跳过该条 */ }
    }

    // 3) grants：会话授权在列 → 放行
    if (matchAny(tool, loadGrants())) return undefined;

    // 4) approve：approve 模式命中 / permission 档要求 → 文件态问询
    if (!needsApproval(spec, tool)) return undefined;
    return await askApproval(tool, callId, args, ctx);
  });
}

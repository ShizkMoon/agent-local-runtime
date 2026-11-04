// workbench/view.ts —— /api/v1/view 的视图契约（S16）+ 工具时间线投影（S17）
//
// S16 契约化：本文件是"磁盘真相 → 视图 JSON"的唯一投影点。纯函数、无模块级 IO 状态：
//   · runsDir 由调用方传入（server.ts 传 STATE/runs，测试传 fixtures/runs）；
//   · 时间由 opts.now 注入（默认 Date.now()），快照可固定；
//   · 不读环境变量、不写盘、不碰 HTTP。server.ts 只剩胶水（解析 URL → 调 buildView → json）。
//
// S17 工具时间线：把节点 events.jsonl 的 tool_call / tool_execution / tool_update / file_edit
// 投影成 StepView[]（单行摘要 + 展开原文），并给每个节点一个闭合的 turn 结局 TurnView。
// 结果诚实性（docs/research/deepseek-harness.md §5 A7）：
//   · out 只给前 N 行，同时必给 total / truncated —— 截断必须自证，不得静默省略；
//   · capped 标记"源事件本身已是 300 字预览"（转写器 cap），UI 据此说明"全文不在事件里"；
//   · ref 带回 artifacts/ 大输出引用（A6 溢写），用户可点开原文。
//
// 已知双写来源（字段名两套，投影里归一）：
//   · src/transcribe.ts（daemon）：tool_call{call_id,tool,args} / tool_execution{call_id,tool,durationMs,isError,result}
//   · aica-pi/extensions/events.ts（worker）：tool_execution{phase:"start"|"end",call_id,tool,args,duration_ms,is_error,output}
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { join, normalize, sep } from "node:path";

// ---------------------------------------------------------------- 类型（对外契约）

export type StepKind = "tool" | "edit";
/** ok=成功 / err=失败 / run=进行中 / lost=有 start 无 end 且节点已不在（不许静默） */
export type StepStatus = "ok" | "err" | "run" | "lost";

export interface StepView {
  kind: StepKind;
  /** 工具名（file_edit 为 edit/write/add/delete + 路径末段） */
  name: string;
  /** 参数摘要：单行、空白折叠、≤160 字 */
  args: string;
  st: StepStatus;
  /** 退出码：事件里显式给，或从输出正文里认出（bash/powershell） */
  exit: number | null;
  /** 耗时 ms */
  ms: number | null;
  /** 输出前 N 行（N=opts.stepLines，默认 40，与 UI 展开上限一致） */
  out: string[];
  /** 可得输出的总行数；**源事件已是预览（capped）时为 null** —— 不知道就说不知道（P12） */
  total: number | null;
  /** 看到的不等于全部：capped，或 total 已知且大于 out.length */
  truncated: boolean;
  /** 源事件本身是预览截断（输出以 … 结尾 / 事件标了 truncated）：全文不在 events.jsonl 里 */
  capped: boolean;
  /** 大输出落盘引用（artifacts/xxx），来自输出首行的 ref= */
  ref: string | null;
  ts: string;
  /** events.jsonl 行号（0 基）：结论可回溯到具体事件行（PRD Q2） */
  i: number;
  call_id: string | null;
}

/** turn 结局闭集（A9）：max-tokens 压过 completed；interrupted 由"有 spawn 无 exit"合成 */
export type TurnState = "running" | "completed" | "max-tokens" | "interrupted" | "cancelled" | "failed";

/** 一次上下文压缩（S20 / A8）：compaction_start / summary / end 合成一条 */
export interface CompactionView {
  /** 结束事件（没有 end 就用 start）的时间戳 */
  at: string;
  /** 压缩前 tokens；事件没给就是 null（不拿"当前累计"冒充） */
  before_tokens: number | null;
  /** 压缩后 tokens；没给就是 null */
  after_tokens: number | null;
}

export interface TurnView {
  state: TurnState;
  /** 一句人话（失败原因 / 中断原因 / 完成摘要），没有则 null */
  reason: string | null;
  /** worker 退出码（若有） */
  code: number | null;
}

export interface ArtView {
  fn: string;
  sz: string;
  body: string;
}

export interface TreeNodeView {
  /** 深度（path 段数）：root=1 不进树，子节点从 2 起 */
  l: number;
  /** 服务的验收条目下标 */
  acl: number;
  st: string;
  nm: string;
  d: string;
  el: string;
  path: string;
  sum: string;
  steps: StepView[];
  out: string[];
  live: boolean;
  cur: string | null;
  spent: number | null;
  wait: string | null;
  todo: { text: string; done: boolean }[] | null;
  /** 等待对象：person:answer / dependency */
  wb: string;
  turn: TurnView;
  /** S20：该节点发生过的上下文压缩（compaction 三事件投影） */
  compactions: CompactionView[];
}

export interface RunView {
  id: string;
  title: string;
  status: "done" | "input" | "failed" | "working";
  dur: string;
  spent: number | null;
  snippet: string;
  req: string;
  obj: string;
  sum: string;
  chips: [string, string][];
  tree: TreeNodeView[];
  arts: ArtView[];
  /** 根节点工具步骤（S17：Run 详情的工具时间线） */
  steps: StepView[];
  /** 根节点 turn 结局 */
  turn: TurnView;
  /** S20：根节点发生过的压缩（子节点的在 tree[].compactions 上） */
  compactions: CompactionView[];
}

export interface InboxItem {
  id: string;
  t: string;
  d: string;
  crumb: string[];
  opts: [string, string, string][];
  gate: { run: number; nm: string; pd: string; sn: string };
}

export interface ViewPayload {
  runs: RunView[];
  inbox: InboxItem[];
  /** [标题, HH:MM, rootId] */
  settled: [string, string, string][];
}

export interface ViewOptions {
  /** 注入"现在"（ms）。缺省 Date.now()；快照测试必须传。 */
  now?: number;
  /** step 输出保留行数，默认 STEP_OUT_LINES */
  stepLines?: number;
}

export interface EvLine {
  /** events.jsonl 行号（0 基） */
  i: number;
  ev: any;
}

// ---------------------------------------------------------------- 路径与读盘原语

export const okId = (s: string): boolean => /^[A-Za-z0-9._-]+$/.test(s);
export const badSeg = (s: string): boolean =>
  !s || s.includes("..") || s.includes("\\") || /[<>:"|?*\x00-\x1f]/.test(s);

/** 路径安全：拒绝 .. 与绝对路径注入；返回 runsDir 内 resolved 路径或 null */
export function safeJoinIn(runsDir: string, ...parts: string[]): string | null {
  const root = normalize(runsDir);
  // 调用方可能带尾分隔符（如 fileURLToPath(new URL("./runs/", ...))）：去掉，否则 base+sep 会对不上
  const base = root.length > 1 && root.endsWith(sep) ? root.slice(0, -1) : root;
  const p = normalize(join(base, ...parts));
  return p.startsWith(base + sep) || p === base ? p : null;
}

export function readJson<T>(file: string): T | null {
  try { return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) as T : null; } catch { return null; }
}

/** 节点目录递归扫描（兼容未来 nodes/a/b 嵌套；当前 runs.ts 为扁平单层） */
export function nodePaths(runsDir: string, rootId: string): string[] {
  const nodesRoot = safeJoinIn(runsDir, rootId, "nodes");
  if (!nodesRoot || !existsSync(nodesRoot)) return [];
  const out: string[] = [];
  const walk = (dir: string, rel: string, depth: number): void => {
    if (depth > 6) return;
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      if (ent.name === "artifacts") continue;
      const childRel = rel ? `${rel}/${ent.name}` : ent.name;
      const childDir = join(dir, ent.name);
      if (existsSync(join(childDir, "spec.json")) || existsSync(join(childDir, "result.json")) || existsSync(join(childDir, "events.jsonl"))) {
        out.push(childRel);
      }
      walk(childDir, childRel, depth + 1); // 节点目录内仍可能有嵌套子节点（path=root/fetch）
    }
  };
  walk(nodesRoot, "", 0);
  return out.sort();
}

export function nodeStatus(runsDir: string, rootId: string, path: string): { status: string; summary?: string; finished_at?: string } {
  const dir = safeJoinIn(runsDir, rootId, "nodes", ...path.split("/"))!;
  const r = readJson<any>(join(dir, "result.json"));
  if (r) return { status: r.status ?? "?", summary: r.summary, finished_at: r.finished_at };
  return { status: existsSync(join(dir, "spec.json")) ? "running" : "empty" };
}

/** 读 events.jsonl 尾部 ~8KB 的最后一条可解析事件（append-only，尾行即最新） */
export function tailEvent(file: string): any | null {
  try {
    const size = statSync(file).size;
    if (!size) return null;
    const fd = openSync(file, "r");
    try {
      const buf = Buffer.alloc(Math.min(size, 8192));
      readSync(fd, buf, 0, buf.length, size - buf.length);
      const lines = buf.toString("utf8").split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        const l = lines[i].trim();
        if (!l) continue;
        try { const ev = JSON.parse(l); if (ev?.ts) return ev; } catch { /* 半截首行跳过 */ }
      }
    } finally { closeSync(fd); }
  } catch { /* 读失败当无事件 */ }
  return null;
}

/** 全量读 events.jsonl → 带行号的记录（坏行跳过；_raw 行保留，投影里忽略） */
export function readEvents(file: string): EvLine[] {
  if (!existsSync(file)) return [];
  const out: EvLine[] = [];
  let lines: string[];
  try { lines = readFileSync(file, "utf8").split("\n"); } catch { return []; }
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!l) continue;
    try { out.push({ i, ev: JSON.parse(l) }); } catch { /* 坏行跳过，不影响后续 */ }
  }
  return out;
}

export function evHint(ev: any): string {
  const d = ev?.data ?? {};
  if (ev?.kind === "exit") return `Worker 退出（code ${d.code ?? "?"}）${d.error ? " · " + d.error : ""}`;
  if (ev?.kind === "spawn") return "拉起 worker";
  if (ev?.kind === "gate") return String(d.question ?? "等你处理").slice(0, 80);
  const s = d.text ?? d.cmd ?? d.question ?? d.summary ?? d.args ?? d.tool ?? ev?.kind ?? "";
  return String(s).replace(/\s+/g, " ").trim().slice(0, 80);
}

/** run 级最近事件 + 全部节点最晚 finished_at（rail 预览/耗时用） */
export function runPulse(runsDir: string, rootId: string, paths: string[]): { last: any; ended_at: string | null } {
  let best: any = null, ended: string | null = null;
  for (const p of paths) {
    const dir = join(runsDir, rootId, "nodes", ...p.split("/"));
    const ev = tailEvent(join(dir, "events.jsonl"));
    if (ev && (!best || ev.ts > best.ts)) best = ev;
    const r = readJson<any>(join(dir, "result.json"));
    if (r?.finished_at && (!ended || r.finished_at > ended)) ended = r.finished_at;
  }
  return {
    last: best ? { kind: best.kind, ts: best.ts, hint: evHint(best), tool: best.data?.tool ?? null } : null,
    ended_at: ended,
  };
}

// ---------------------------------------------------------------- 时间格式

export const pad2 = (n: number): string => String(n).padStart(2, "0");
/** "mm:ss"（分钟可超 59，与原型一致） */
export function mmss(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${pad2(Math.floor(s / 60))}:${pad2(s % 60)}`;
}
/** settled 时间戳 "HH:MM"（本地时区） */
export function hhmm(iso: string): string {
  const d = new Date(iso);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// ---------------------------------------------------------------- S17：step 投影

export const STEP_OUT_LINES = 40;

/** 参数/输出摘要：单行、空白折叠、cap 字 */
function oneLine(v: unknown, cap: number): string {
  if (v == null) return "";
  let s: string;
  if (typeof v === "string") s = v;
  else { try { s = JSON.stringify(v); } catch { s = String(v); } }
  s = s.replace(/\s+/g, " ").trim();
  return s.length > cap ? s.slice(0, cap) + "…" : s;
}

function textOf(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map((c: any) => (typeof c === "string" ? c : c?.text ?? "")).filter(Boolean).join("\n");
  if (typeof v === "object") {
    const o = v as any;
    if (Array.isArray(o.content)) return textOf(o.content);
    try { return JSON.stringify(v); } catch { return String(v); }
  }
  return String(v);
}

/** 退出码：先看显式字段，再从输出正文认（bash/powershell 的 exit code 惯例） */
function exitOf(d: any, raw: string): number | null {
  for (const k of ["exit", "exit_code", "exitCode", "code"]) {
    const v = d?.[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  const m = /(?:exit\s*(?:code)?|退出码|returned)\s*[:=]?\s*(-?\d+)/i.exec(raw);
  return m ? Number(m[1]) : null;
}

/** 大输出落盘引用：输出首行的 ref=artifacts/xxx（A6 溢写） */
function refOf(raw: string): string | null {
  const m = /(?:^|\n)\s*ref=(\S+)/.exec(raw);
  return m ? m[1] : null;
}

/** 按候选键名取第一个有限数值（不同写入器/工具的字段名不一致） */
function firstNum(o: any, keys: string[]): number | null {
  for (const k of keys) {
    const v = o?.[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return null;
}

interface Draft {
  kind: StepKind;
  name: string;
  args: string;
  ts: string;
  i: number;
  call_id: string | null;
  raw: string;
  partial: string;
  ms: number | null;
  exit: number | null;
  isErr: boolean;
  ended: boolean;
  /** 已收到的 end 事件数（双写来源去重：只有第一次生效） */
  ends: number;
  /** 事件里显式给的"总数"（totalLines/totalChars/…）；没有就 null */
  explicitTotal: number | null;
  /** 事件自己声明了截断（data.truncated === true） */
  cappedFlag: boolean;
}

function draft(i: number, ts: unknown, kind: StepKind, name: string, args: unknown, callId: string | null): Draft {
  return {
    kind, name, args: oneLine(args, 160), ts: String(ts ?? ""), i, call_id: callId,
    raw: "", partial: "", ms: null, exit: null, isErr: false, ended: false, ends: 0,
    explicitTotal: null, cappedFlag: false,
  };
}

function finish(dr: Draft, lines: number, live: boolean): StepView {
  const raw = dr.ended ? dr.raw : (dr.partial || dr.raw);
  const all = raw.replace(/\r\n/g, "\n").split("\n");
  while (all.length && !all[all.length - 1].trim()) all.pop();
  const out = all.slice(0, lines);
  // P12 诚实性：源事件已是预览（以 … 结尾 / 事件标了 truncated）时，事件里的行数不是"总数" → total 记 null，
  // 绝不用"我手里有多少"冒充"一共多少"。
  const capped = dr.cappedFlag || /…$/.test(raw.trimEnd());
  const total = dr.explicitTotal ?? (capped ? null : all.length);
  const st: StepStatus = dr.ended ? (dr.isErr ? "err" : "ok") : (live ? "run" : "lost");
  return {
    kind: dr.kind,
    name: dr.name,
    args: dr.args,
    st,
    exit: dr.exit,
    ms: dr.ms,
    out,
    total,
    truncated: capped || (total !== null && total > out.length),
    capped,
    ref: refOf(raw),
    ts: dr.ts,
    i: dr.i,
    call_id: dr.call_id,
  };
}

/**
 * 事件流 → step 列表。同一 call_id 的 start/end 合并成一步；
 * 双写来源（transcribe + aica-pi）按 call_id 去重，不会出现两步。
 * 无 call_id 的 end 退化为"配对最近一步还没结束的同名 step"。
 */
export function buildSteps(events: EvLine[], opts: { lines?: number; live?: boolean } = {}): StepView[] {
  const lines = Math.max(0, opts.lines ?? STEP_OUT_LINES);
  const live = !!opts.live;
  const drafts: Draft[] = [];
  const byCall = new Map<string, Draft>();

  const openNamed = (name: string): Draft | null => {
    for (let k = drafts.length - 1; k >= 0; k--) {
      const d = drafts[k];
      if (!d.ended && d.kind === "tool" && d.name === name) return d;
    }
    return null;
  };
  const start = (i: number, ev: any, kind: StepKind, name: string, args: unknown, callId: string | null): Draft => {
    const known = callId ? byCall.get(callId) : null;
    if (known) { if (!known.args) known.args = oneLine(args, 160); return known; }
    const dr = draft(i, ev?.ts, kind, name, args, callId);
    drafts.push(dr);
    if (callId) byCall.set(callId, dr);
    return dr;
  };
  const end = (i: number, ev: any, name: string, callId: string | null, d: any): void => {
    let target = callId ? byCall.get(callId) : null;
    if (!target) target = openNamed(name);
    if (!target) target = start(i, ev, "tool", name, undefined, callId); // 孤立 end：也要出一条（不丢信息）
    if (target.ends > 0) return;                                        // 双写去重：同一 call 的重复 end 不叠加
    target.ends = 1;
    target.ended = true;
    target.isErr = !!(d?.isError ?? d?.is_error ?? d?.error ?? false);
    const ms = d?.durationMs ?? d?.duration_ms;
    if (typeof ms === "number" && Number.isFinite(ms)) target.ms = ms;
    const out = textOf(d?.result ?? d?.output ?? d?.text ?? "");
    // file_edit 已写入 diff 时把工具输出接在后面，不覆盖已有事实
    target.raw = [target.raw, out].filter(Boolean).join("\n");
    target.exit = exitOf(d, target.raw);
    // P12：事件显式给的总数 / 显式截断标记（有就采信，没有就不编）
    const explicit = firstNum(d, ["totalLines", "total_lines", "totalChars", "total_chars", "total_rows", "total"]);
    if (explicit !== null) target.explicitTotal = explicit;
    if (d?.truncated === true || d?.capped === true) target.cappedFlag = true;
  };

  for (const { i, ev } of events) {
    const d = ev?.data ?? {};
    const callId = typeof d.call_id === "string" ? d.call_id : (typeof d.callId === "string" ? d.callId : null);
    const tool = String(d.tool ?? d.toolName ?? d.name ?? "");
    switch (ev?.kind) {
      case "tool_call": // transcribe：start
        start(i, ev, "tool", tool || "?", d.args, callId);
        break;
      case "tool_execution": {
        const phase = String(d.phase ?? "");
        if (phase === "start") start(i, ev, "tool", tool || "?", d.args, callId);
        else if (phase === "end") end(i, ev, tool || "?", callId, d);
        else {
          // transcribe 的 end 没有 phase；有 result/output 才算结束
          if (d.result !== undefined || d.output !== undefined || d.isError !== undefined || d.is_error !== undefined) end(i, ev, tool || "?", callId, d);
          else start(i, ev, "tool", tool || "?", d.args, callId);
        }
        break;
      }
      case "tool_update": {
        // 增量：挂到同 call 的 step 尾部；没有对应 step 就单出一条（UI 显示"进行中"）
        const target = (callId ? byCall.get(callId) : null) ?? openNamed(tool || "?") ?? start(i, ev, "tool", tool || "?", d.args, callId);
        const delta = textOf(d.delta ?? d.text ?? d.partial ?? d.output ?? d.result ?? "");
        if (delta) target.partial = target.partial ? `${target.partial}\n${delta}` : delta;
        if (d.isError ?? d.is_error) target.isErr = true;
        break;
      }
      case "tool_result": // 旧写入器/夹具：tool_call 之后单发结果（无 call_id，按工具名配对）
        end(i, ev, tool || "?", callId, d);
        break;
      case "file_edit": {
        // G13/file_edit：{path, kind?, preview?, plus?, minus?}；没有 diff 正文就只报变更。
        // 同一 call_id 已有 tool_call 时并进那一步（一次调用一行，不重复）。
        const path = String(d.path ?? d.file ?? "");
        const act = String(d.kind ?? d.action ?? d.op ?? "edit");
        const name = `${act} ${path.split(/[\\/]/).pop() || path}`.trim();
        const known = callId ? byCall.get(callId) : null;
        const dr = known ?? start(i, ev, "edit", name, path, callId);
        dr.kind = "edit";
        dr.name = name;
        dr.args = oneLine(path || dr.args, 160);
        const plus = typeof d.plus === "number" ? `+${d.plus}` : "";
        const minus = typeof d.minus === "number" ? `-${d.minus}` : "";
        const detail = [textOf(d.preview ?? d.diff ?? ""), plus || minus ? `${plus} ${minus}`.trim() : ""]
          .filter(Boolean).join("\n");
        if (detail) dr.raw = dr.raw ? `${dr.raw}\n${detail}` : detail;
        dr.isErr = dr.isErr || !!(d.isError ?? d.is_error);
        dr.ended = true;
        break;
      }
      default:
        break; // 其它事件不铺开（反模式 A-1：原始事件不是内容）
    }
  }
  return drafts.map(dr => finish(dr, lines, live));
}

// ---------------------------------------------------------------- S20：压缩投影

const COMPACT_BEFORE_START = ["before_tokens", "tokensBefore", "beforeTokens", "tokenCount", "before", "tokens"];
const COMPACT_BEFORE_END = ["before_tokens", "tokensBefore", "beforeTokens", "before"];
const COMPACT_AFTER = ["after_tokens", "tokensAfter", "afterTokens", "after", "summaryTokens", "tokens", "tokenCount"];

/**
 * 把 pi 的压缩事件投影成一条条 CompactionView。pi 发三件：
 *   compaction_start（开压前）→ compaction_summary（摘要文本）→ compaction_end（压完）。
 * 也兼容 kind:"compaction" 单事件（没有 phase）与 data.phase 写法。
 * 原则：只报事件里说过的事；before/after 拿不到就是 null——不拿"当前累计"顶替。
 */
export function compactionsOf(events: EvLine[]): CompactionView[] {
  const out: CompactionView[] = [];
  let open: { at: string; before: number | null } | null = null;
  for (const { ev } of events) {
    const kind = String(ev?.kind ?? "");
    if (!kind.startsWith("compaction")) continue;
    const d = ev?.data ?? {};
    const at = String(ev?.ts ?? "");
    const phase = String(d.phase ?? kind.slice("compaction".length).replace(/^_/, ""));
    if (phase === "start") { open = { at, before: firstNum(d, COMPACT_BEFORE_START) }; continue; }
    if (phase === "summary") { if (!open) open = { at, before: null }; open.at = at; continue; }
    // "end" 或单事件：完整记录。
    // end 事件里的裸 tokens/tokenCount 视为"压缩后"——不拿它覆盖 start 记下的 before。
    out.push({
      at: at || open?.at || "",
      before_tokens: firstNum(d, COMPACT_BEFORE_END) ?? open?.before ?? null,
      after_tokens: firstNum(d, COMPACT_AFTER),
    });
    open = null;
  }
  // 只有 start 没有 end：压缩没走完，after 如实记 null（不许四舍五入成"压缩成功"）
  if (open) out.push({ at: open.at, before_tokens: open.before, after_tokens: null });
  return out;
}

// ---------------------------------------------------------------- S17：turn 结局

const MAX_TOKENS = /^(max[-_]?tokens?|maxTokens?|length)$/i;

/**
 * turn 结局闭集（A9）。优先级：max-tokens 压过 completed（模型被截断时"完成"是谎），
 * 其次 abort/cancelled，再次 result.status，最后按 exit 事件合成 interrupted。
 */
export function projectTurn(events: EvLine[], result: any, live: boolean): TurnView {
  const lastOf = (kind: string): any => {
    for (let k = events.length - 1; k >= 0; k--) if (events[k].ev?.kind === kind) return events[k].ev;
    return null;
  };
  const exitEv = lastOf("exit");
  const code = typeof exitEv?.data?.code === "number" ? exitEv.data.code : null;
  const abortEv = lastOf("abort");
  const msgEv = lastOf("message") ?? lastOf("agent_message") ?? lastOf("message_end");
  const stop = String(msgEv?.data?.stopReason ?? msgEv?.data?.stop ?? msgEv?.data?.message?.stopReason ?? "");
  const status = String(result?.status ?? "");
  const summary = typeof result?.summary === "string" ? result.summary : null;
  const maxTok: TurnView = { state: "max-tokens", reason: oneLine(msgEv?.data?.text ?? "达到 max tokens 上限", 120) || "达到 max tokens 上限", code };
  const cancelled: TurnView = { state: "cancelled", reason: oneLine(abortEv?.data?.reason ?? summary ?? "已中止", 160), code };

  if (status === "done" || status === "split" || status === "spec")
    return MAX_TOKENS.test(stop) ? maxTok : { state: "completed", reason: summary, code };
  if (status === "failed") {
    if (abortEv || /abort|中止/i.test(summary ?? "")) return cancelled;
    return MAX_TOKENS.test(stop) ? maxTok : { state: "failed", reason: summary, code };
  }
  if (status === "blocked") return { state: "failed", reason: summary ?? "节点被阻塞（依赖或守门未过）", code };
  if (status === "waiting") return { state: "running", reason: "等待人工裁决", code };
  if (status === "me") return { state: "running", reason: summary ?? "等待人工裁决", code };
  // 有 result 但 status 不在闭集里：这一刻确实结束了，按 completed 记，summary 如实带出
  if (result && typeof result === "object") return { state: "completed", reason: summary, code };
  // 无 result（或 result.status 未知）：
  if (abortEv) return cancelled;
  if (exitEv) {
    if (code !== 0) return { state: "failed", reason: oneLine(exitEv.data?.error ?? `worker 退出（code ${code ?? "?"}）`, 160), code };
    return { state: "interrupted", reason: "worker 已退出但无 result（未调用 ev_done）", code };
  }
  if (live) return { state: "running", reason: null, code: null };
  return { state: "interrupted", reason: "无 exit 事件（worker 已不在，Q1 幽灵节点）", code: null };
}

// ---------------------------------------------------------------- S16：run 级投影

function nodeName(runsDir: string, rootId: string, path: string): string {
  const spec = readJson<any>(join(runsDir, rootId, "nodes", ...path.split("/"), "spec.json"));
  const first = String(spec?.goal ?? "").split("\n")[0].trim();
  return (first || path.split("/").pop() || path).slice(0, 20);
}

function depDone(runsDir: string, rootId: string, dep: string): boolean {
  const p = dep.startsWith(`node:${rootId}/`) ? dep.slice(`node:${rootId}/`.length) : dep;
  return readJson<any>(join(runsDir, rootId, "nodes", ...p.split("/"), "result.json"))?.status === "done";
}

/** tree 的 st 映射：waiting→input（wait_on 挂起=等子节点，归 dep 不进 inbox）/
 *  无 result 且 dep 未满足→dep / 无 result（未拉起或跑着）→queued / blocked→dep */
function viewStatus(runsDir: string, rootId: string, spec: any, r: any): string {
  if (r) {
    if (r.status === "waiting" && Array.isArray(r.wait_on) && r.wait_on.length) return "dep"; // S7 ev_wait join：自动复活，不占人工位
    return ({ waiting: "input", done: "done", failed: "failed", blocked: "dep" } as Record<string, string>)[r.status] ?? "done";
  }
  if (spec?.depends?.length && spec.depends.some((d: string) => !depDone(runsDir, rootId, d))) return "dep";
  return "queued";
}

interface NodeProj {
  path: string;
  spec: any;
  r: any;
  gate: any;
  st: string;
  live: boolean;
  cur: string | null;
  spent: number | null;
  todo: { text: string; done: boolean }[] | null;
  wait: string | null;
  nm: string;
  d: string;
  sum: string;
  steps: StepView[];
  out: string[];
  el: string;
  ev: any | null;
  turn: TurnView;
  compactions: CompactionView[];
}

/** usage.json → 累计 tokens：旧字段 tokens 优先，没有就按分项相加（与 transcribe.usageTokens 同规则） */
function usageSpent(u: any): number | null {
  if (!u) return null;
  const t = Number(u.tokens);
  if (Number.isFinite(t) && t > 0) return t;
  const sum = ["in", "out", "cache"].reduce((s, k) => s + (Number(u.total?.[k]) || 0), 0);
  return sum > 0 ? sum : null;
}

function projectNode(runsDir: string, rootId: string, path: string, now: number, stepLines: number): NodeProj {
  const dir = join(runsDir, rootId, "nodes", ...path.split("/"));
  const spec = readJson<any>(join(dir, "spec.json"));
  const r = readJson<any>(join(dir, "result.json"));
  const gate = readJson<any>(join(dir, "gate.json"));
  const usage = readJson<any>(join(dir, "usage.json"));
  const todo = readJson<any>(join(dir, "todo.json"));
  const events = readEvents(join(dir, "events.jsonl"));
  let ev: any = null;
  for (let k = events.length - 1; k >= 0; k--) if (events[k].ev?.ts) { ev = events[k].ev; break; }
  const live = existsSync(join(dir, "worker.json"));
  const specFile = join(dir, "spec.json");
  // 无 spec.created_at，用 spec.json mtime 当"开始"
  const created = existsSync(specFile) ? statSync(specFile).mtimeMs : now;
  const ad = join(dir, "artifacts");
  const out = existsSync(ad)
    ? readdirSync(ad, { withFileTypes: true }).filter(f => f.isFile()).map(f => f.name).sort()
    : [];
  return {
    path, spec, r, gate,
    st: viewStatus(runsDir, rootId, spec, r),
    // S10 控制面投影：live=worker.json 租约在、cur=尾事件工具/动作、spent=token 累计、wait=waiting 原因
    live,
    cur: ev?.data?.tool ?? ev?.kind ?? null,
    spent: usageSpent(usage) ?? r?.spent?.tokens ?? null,
    todo: Array.isArray(todo?.items) ? todo.items : null, // S9 ev_todo 清单投影
    wait: r?.status === "waiting" ? (gate?.question ?? (Array.isArray(r?.wait_on) ? `等子节点 ${r.wait_on.join(", ")}` : r?.wait_on) ?? null) : null,
    nm: nodeName(runsDir, rootId, path),
    d: String(r?.summary ?? (ev ? evHint(ev) : "")).split("\n")[0].slice(0, 80), // 一句话
    sum: r?.summary ?? "",
    steps: buildSteps(events, { lines: stepLines, live }),
    out,
    el: mmss((r?.finished_at ? Date.parse(r.finished_at) : now) - created),
    ev,
    turn: projectTurn(events, r, live),
    compactions: compactionsOf(events),   // S20：压缩可见（三事件合成）
  };
}

/**
 * 磁盘真相 → 视图 JSON。
 * @param runsDir STATE/runs（调用方传入，本函数不读全局）
 * @param opts    { now, stepLines }；now 缺省 Date.now()，测试必须显式给
 */
export function buildView(runsDir: string, opts: ViewOptions = {}): ViewPayload {
  const now = opts.now ?? Date.now();
  const stepLines = opts.stepLines ?? STEP_OUT_LINES;
  const runs: RunView[] = [], inbox: InboxItem[] = [], settled: [string, string, string][] = [];
  if (!existsSync(runsDir)) return { runs, inbox, settled };

  const metaOf = new Map<string, any>();
  const rootIds = readdirSync(runsDir, { withFileTypes: true })
    .filter(d => d.isDirectory() && okId(d.name))
    .map(d => { metaOf.set(d.name, readJson<any>(join(runsDir, d.name, "run.json"))); return d.name; })
    .sort((a, b) => String(metaOf.get(b)?.created_at ?? "").localeCompare(String(metaOf.get(a)?.created_at ?? ""))); // 新 run 在前（同 /api/runs）

  for (const rootId of rootIds) {
    const meta = metaOf.get(rootId);
    const nodes = nodePaths(runsDir, rootId).map(path => projectNode(runsDir, rootId, path, now, stepLines));
    const waiting = nodes.filter(n => n.st === "input");
    const allDone = nodes.length > 0 && nodes.every(n => n.r?.status === "done");
    const ended = nodes.map(n => n.r?.finished_at).filter(Boolean).sort().pop() as string | undefined;
    // run 不自动隐藏：done/failed 也留在 runs 里可打开，只有显式 DELETE 才消失
    const status: RunView["status"] = allDone ? "done" : waiting.length ? "input"
      : nodes.some(n => n.r?.status === "failed") ? "failed" : "working";
    if (allDone) settled.push([meta?.subject ?? rootId, hhmm(ended ?? meta?.created_at ?? new Date(now).toISOString()), rootId]);
    const rootNode = nodes.find(n => n.path === "root") ?? nodes[0];
    // run 级 turn：失败时以"第一个失败节点"为准——run 状态是 failed，结局那行不许说"已完成"（R4）
    const failedNode = nodes.find(n => n.r?.status === "failed");
    const runTurn: TurnView = status === "failed" && failedNode
      ? { state: "failed", reason: oneLine(failedNode.r?.summary ?? failedNode.d ?? "失败", 160), code: failedNode.turn.code }
      : (rootNode?.turn ?? { state: "running", reason: null, code: null });
    // chips：根 spec.accept → [状态,条文]。spec.accept_idx===i 的节点 result 存在即 verified、failed 即 failed、无则 pending
    const chips: [string, string][] = (rootNode?.spec?.accept ?? []).map((a: string, i: number) => {
      const acx = nodes.find(n => n.spec?.accept_idx === i);
      return [!acx?.r ? "pending" : acx.r.status === "failed" ? "failed" : "verified", a] as [string, string];
    });
    const tree: TreeNodeView[] = nodes.filter(n => n.path.split("/").length >= 2) // l=path 段数；root(l=1) 不进树，子节点 l=2 起
      .map(n => ({
        l: n.path.split("/").length, acl: n.spec?.accept_idx ?? 0, st: n.st, nm: n.nm, d: n.d, el: n.el,
        path: n.path, sum: n.sum, steps: n.steps, out: n.out, // sheet 用：定位/小结/执行过程/产物
        live: n.live, cur: n.cur, spent: n.spent, wait: n.wait, todo: n.todo, // S10：live ✕ / Σtok / 回复框；S9：清单
        wb: n.st === "input" ? "person:answer" : n.st === "dep" ? "dependency" : "", // wb=等待对象：等人答/等依赖
        turn: n.turn,
        compactions: n.compactions,
      }));
    // arts：全部节点 artifacts/ 汇总到 run 级；非 root 节点的 fn 带 path 前缀防重名
    const arts: ArtView[] = [];
    for (const n of nodes) {
      const ad = join(runsDir, rootId, "nodes", ...n.path.split("/"), "artifacts");
      if (!existsSync(ad)) continue;
      for (const f of readdirSync(ad, { withFileTypes: true }).sort((x, y) => x.name.localeCompare(y.name))) {
        if (!f.isFile()) continue;
        const fp = join(ad, f.name);
        const sz = statSync(fp).size;
        arts.push({
          fn: n.path === "root" ? f.name : `${n.path}/${f.name}`,
          sz: sz >= 1024 ? `${(sz / 1024).toFixed(1).replace(/\.0$/, "")} KB` : `${sz} B`,
          body: readFileSync(fp).subarray(0, 64 * 1024).toString("utf8"),
        });
      }
    }
    const runIdx = runs.length;
    const last = runPulseFrom(nodes);
    // S6：run 行 Σtok = 各节点 spent（result.spent 或 usage.json）累加
    const spentTotal = nodes.reduce((s, n) => s + (typeof n.spent === "number" ? n.spent : 0), 0);
    runs.push({
      id: rootId, title: meta?.subject ?? rootId, status,
      dur: mmss((ended ? Date.parse(ended) : now) - Date.parse(meta?.created_at ?? new Date(now).toISOString())),
      spent: spentTotal || null,
      snippet: last?.hint ?? "",
      req: meta?.subject ?? "",                                          // 原始诉求
      obj: String(rootNode?.spec?.goal ?? "").split("\n")[0].slice(0, 80), // 目标（根 goal 首行）
      sum: rootNode?.r?.summary ?? "",                                   // 摘要（根 result）
      chips, tree, arts,
      steps: rootNode?.steps ?? [],                                      // S17：Run 详情工具时间线
      turn: runTurn,
      compactions: rootNode?.compactions ?? [],                          // S20：根节点的压缩记录
    });
    // inbox：waiting 节点 → 人工闸门条目（gate.run 指回 runs 数组下标）
    for (const n of waiting) {
      const q = String(n.gate?.question ?? n.r?.summary ?? "");
      const opts: [string, string, string][] = n.gate?.opts?.length
        ? n.gate.opts.map((o: string) => [o, "", `已选择·${o}`] as [string, string, string]) // [文案, 图标位, 已选后文案]
        : [["同意", "", "已同意"], ["拒绝", "", "已拒绝"]];
      const segs = n.path.split("/");
      const crumb = [meta?.subject ?? rootId, ...segs.map((_, i) => nodeName(runsDir, rootId, segs.slice(0, i + 1).join("/")))];
      inbox.push({
        id: n.spec?.id ?? `node:${rootId}/${n.path}`,
        t: q.split("\n")[0].slice(0, 80), d: q, crumb, opts,
        gate: { run: runIdx, nm: n.nm, pd: `回复已送达，${n.nm} 恢复执行`, sn: "已回复 · 节点恢复运行" },
      });
    }
  }
  return { runs, inbox, settled };
}

/** 已在 projectNode 里读过尾事件，这里不再二次读盘（等价 runPulse(runsDir, rootId, paths)） */
function runPulseFrom(nodes: NodeProj[]): { hint: string } | null {
  let best: any = null;
  for (const n of nodes) if (n.ev && (!best || n.ev.ts > best.ts)) best = n.ev;
  return best ? { hint: evHint(best) } : null;
}

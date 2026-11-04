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

// ---------------------------------------------------------------- S25：分组与聚合（P4/P5/P6/P14）

/** 聚合四态：blocked（等你）/ failed / working / done。rank 越大越紧急 */
export type AggStatus = "blocked" | "failed" | "working" | "done";

/** 只在这里定义紧急度；别处不许自己排序（P5 单一权威） */
export const AGG_RANK: Record<AggStatus, number> = { done: 0, working: 1, failed: 2, blocked: 3 };

/**
 * 节点状态 → 四态。
 * blocked **只**来自「人在环」：st=input（未答 gate / 未答提问）。
 * 等依赖（dep）与排队（queued）不占人工位，按 working 算——不然父行永远在喊「等你」。
 */
export function aggOfNode(st: string): AggStatus {
  if (st === "input") return "blocked";
  if (st === "failed") return "failed";
  if (st === "done") return "done";
  return "working";
}

/** 聚合取最紧急；空集合 = done（没有节点就没有未完成的事） */
export function aggMax(list: AggStatus[]): AggStatus {
  let best: AggStatus = "done";
  for (const a of list) if (AGG_RANK[a] > AGG_RANK[best]) best = a;
  return best;
}

/**
 * 节点四态：先看"有没有未答审批"，再看 st。
 * 未答 gate-req 的节点没有 result.json（worker 卡在 gate 里），st 是 queued —— 但人这边它就是"等你"。
 */
export function nodeAgg(st: string, approval = false): AggStatus {
  return approval ? "blocked" : aggOfNode(st);
}

/** 工具分类：只影响统计行，不影响任何真相 */
export type GroupKey = "cmd" | "edit" | "read" | "other";

/** 连续同类的一串 step（保持时间顺序；渲染按它分段） */
export interface StepGroupView {
  key: GroupKey;
  /** 组内条数 */
  n: number;
  /** 组内已知耗时合计 ms；一条都没有 ms 时为 null（不拿 0 冒充） */
  ms: number | null;
  /** 失败或丢失（err/lost）条数 */
  err: number;
  /** 在 steps[] 里的闭区间下标 */
  i0: number;
  i1: number;
}

/** 组头统计（"3 命令 · 1 编辑 · 42s" 的数据来源）：按分类全量合计，与分段无关 */
export interface StepStats {
  /** 只含 n>0 的键，顺序 cmd → edit → read → other */
  by: { key: GroupKey; n: number }[];
  n: number;
  /** 已知耗时合计；全都没有 ms 时 null */
  ms: number | null;
  /** err/lost 条数 */
  err: number;
  /** 进行中条数 */
  run: number;
}

const CMD_TOOLS = new Set(["bash", "sh", "shell", "exec", "cmd", "pwsh", "powershell", "terminal", "run"]);
const EDIT_TOOLS = new Set(["edit", "write", "add", "delete", "patch", "apply_patch", "file_edit", "mkdir", "mv", "cp", "rm"]);
const READ_TOOLS = new Set(["read", "glob", "grep", "ls", "list", "view", "stat", "open", "fetch", "webfetch", "websearch", "web_search", "search"]);

/** step → 组：kind=edit 一律归编辑；其余看工具名首词，未知归 other */
export function groupOfStep(s: StepView): GroupKey {
  if (s.kind === "edit") return "edit";
  const head = String(s.name || "").toLowerCase().split(/[\s:/]/)[0];
  if (CMD_TOOLS.has(head)) return "cmd";
  if (EDIT_TOOLS.has(head)) return "edit";
  if (READ_TOOLS.has(head)) return "read";
  return "other";
}

/** 连续同类合并（时间顺序不乱）；渲染用它分段 */
export function groupSteps(steps: StepView[]): StepGroupView[] {
  const out: StepGroupView[] = [];
  for (let i = 0; i < steps.length; i++) {
    const key = groupOfStep(steps[i]);
    const bad = steps[i].st === "err" || steps[i].st === "lost";
    const last = out[out.length - 1];
    if (last && last.key === key) {
      last.n += 1;
      last.i1 = i;
      if (bad) last.err += 1;
      if (typeof steps[i].ms === "number") last.ms = (last.ms ?? 0) + steps[i].ms;
    } else {
      out.push({
        key, n: 1, i0: i, i1: i, err: bad ? 1 : 0,
        ms: typeof steps[i].ms === "number" ? steps[i].ms : null,
      });
    }
  }
  return out;
}

/** 组头统计：按分类全量合计（跨段合并），耗时只在有 ms 时给 */
export function stepStats(steps: StepView[]): StepStats {
  const counts: Record<GroupKey, number> = { cmd: 0, edit: 0, read: 0, other: 0 };
  let ms: number | null = null, err = 0, run = 0;
  for (const s of steps) {
    counts[groupOfStep(s)] += 1;
    if (typeof s.ms === "number") ms = (ms ?? 0) + s.ms;
    if (s.st === "err" || s.st === "lost") err += 1;
    if (s.st === "run") run += 1;
  }
  const by = (["cmd", "edit", "read", "other"] as GroupKey[])
    .filter(k => counts[k] > 0)
    .map(k => ({ key: k, n: counts[k] }));
  return { by, n: steps.length, ms, err, run };
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

/** S18：一个文件的变更视图（file_edit 事件聚合）。patch 拿不到就是 null —— 只报统计，不编行内容 */
export interface DiffView {
  file: string;
  /** 新增行数（事件说多少就是多少；没有就是 0） */
  add: number;
  /** 删除行数 */
  del: number;
  /** @@ 段数（没有 patch 时为 0） */
  hunks: number;
  /** unified diff 的前 DIFF_PATCH_LINES 行；事件里没有 diff 正文 → null */
  patch: string[] | null;
  /** patch 的完整行数（patch=null 时为 0） */
  total: number;
  /** total > patch.length：UI 必须显示"还有 N 行" */
  truncated: boolean;
}

/** S23：计划条（ev_todo 事件投影） */
export interface PlanItem {
  text: string;
  done: boolean;
}
export interface PlanView {
  items: PlanItem[];
  /** 第一个未完成项的下标；全部完成=null */
  current: number | null;
}

/** S23：reviewer 节点的裁决强度（result.output.severity） */
export type Severity = "note" | "warn" | "block";

/** S26：审批审计对（问了什么 / 谁在什么时候答的 / 隔了多久） */
export interface AuditView {
  node: string;
  asked_at: string | null;
  question: string;
  decision: string | null;
  decided_at: string | null;
  ms: number | null;
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
  /** S25：该节点的四态（blocked 只来自未答 gate/提问） */
  agg: AggStatus;
  /** S20：该节点发生过的上下文压缩（compaction 三事件投影） */
  compactions: CompactionView[];
  /** S18：该节点的文件变更（按文件聚合） */
  diffs: DiffView[];
  /** S23：计划条 */
  plan: PlanView | null;
  /** S23：reviewer 裁决强度 */
  sev: Severity | null;
  /** S26：审批审计对 */
  audits: AuditView[];
}

export interface RunView {
  id: string;
  /** run.json.kind：task / test / smoke…（P1：smoke/test 在左栏归到「测试」分组） */
  kind: string | null;
  /** R3：title 以 smoke/test 开头（含空格写法）或 kind=test —— 左栏「测试」分组判据的唯一来源 */
  test_like: boolean;
  title: string;
  status: "done" | "input" | "failed" | "working";
  /** S25：run 行只能看这个 —— max(所有节点)，blocked > failed > working > done；done 不冒泡 */
  agg: AggStatus;
  /** 处于 agg 那一档的节点数（"等你 · 2"） */
  agg_n: number;
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
  /** S25：连续同类的分段（渲染用）与全量统计（组头行用） */
  groups: StepGroupView[];
  stats: StepStats;
  /** 根节点 turn 结局 */
  turn: TurnView;
  /** S20：根节点发生过的压缩（子节点的在 tree[].compactions 上） */
  compactions: CompactionView[];
  /** S18：根节点的文件变更（按文件聚合，过程组里渲染「文件名 +N −M」） */
  diffs: DiffView[];
  /** S23：根节点计划条 */
  plan: PlanView | null;
  /** S23：本 run 里最重的裁决强度（block > warn > note） */
  sev: Severity | null;
  /** S26：本 run 的审批审计对（可点开） */
  audits: AuditView[];
  /** R4：根节点 spec.profile（plan → 中栏渲染「计划（只读）」卡） */
  profile: string | null;
  /** R4：run.json.parallel（设置面板只读展示并发上限；缺省 null） */
  parallel: number | null;
  /** R5：根节点 spec.permission（supervised / full）；老 run 没有就是 null */
  permission: string | null;
  /** R5：根节点 spec.tools（审批模式徽标的另一半依据） */
  tools: string[] | null;
  /** R5：根节点 spec.model（模型回显） */
  model: string | null;
  /** R5：根节点 spec.budget.effort（档位回显；旧 run 可能没有） */
  effort: string | null;
  /** R5：审批模式（只读 / 可编辑 / 全权限）—— 由 permission + tools 推，null = 未知 */
  mode: "readonly" | "edit" | "full" | null;
}

/** R5：审批模式判定（徽标与设置面板共用；只读靠工具面推，全权限靠 permission） */
const READONLY_TOOLS = new Set(["read", "ls", "find", "grep", "kn_recall", "ar_read", "ev_read", "ev_list"]);
export function approvalModeOf(permission: unknown, tools: unknown): "readonly" | "edit" | "full" | null {
  const perm = String(permission ?? "");
  if (perm === "full") return "full";
  const t = Array.isArray(tools) ? tools.map(String) : null;
  if (t && t.length && t.every(x => READONLY_TOOLS.has(x))) return "readonly";   // 工具面全在只读集里
  if (perm === "supervised") return "edit";
  if (t && t.length) return "edit";
  return null;
}

export interface InboxItem {
  id: string;
  t: string;
  d: string;
  crumb: string[];
  opts: [string, string, string][];
  gate: { run: number; nm: string; pd: string; sn: string };
  /** R3：inbox 里的提案卡（点开跳「提案」页签并选中 slug） */
  kind?: "proposal" | "git";
  prop?: { slug: string; risk: string };
  /** R5：git 提交审批卡（批准才执行 git commit） */
  git?: { message: string; files: number; created_at: string | null };
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
  /** stat 指纹复用窗口（ms）。0=每次都 stat（测试默认）；server 传 1000 做热路径优化 */
  statTtl?: number;
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
      // 一次 readdir 判"是不是节点"（比 3 次 existsSync 便宜，也不会把空目录算成节点）
      let marks: string[] = [];
      try { marks = readdirSync(childDir); } catch { marks = []; }
      if (marks.includes("spec.json") || marks.includes("result.json") || marks.includes("events.jsonl")) out.push(childRel);
      walk(childDir, childRel, depth + 1); // 节点目录内仍可能有嵌套子节点（path=root/fetch）
    }
  };
  walk(nodesRoot, "", 0);
  return out.sort();
}

/** buildView 用的节点路径表：窗口内复用（watcher 有变化会先 clearViewCache） */
function nodePathsCached(runsDir: string, rootId: string, now: number, ttl: number): string[] {
  const nd = safeJoinIn(runsDir, rootId, "nodes");
  let ms = -1;
  try { ms = nd ? statSync(nd).mtimeMs : -1; } catch { ms = -1; }
  const hit = PATHS_CACHE.get(rootId);
  if (hit && hit.ms === ms) return hit.list;      // 目录 mtime 不变 = 节点集合不变（1 次 stat 换掉一轮 walk）
  const list = nodePaths(runsDir, rootId);
  PATHS_CACHE.set(rootId, { ms, list });
  if (PATHS_CACHE.size > CACHE_MAX) PATHS_CACHE.clear();
  return list;
}

/** buildView 用的 run.json：窗口内复用 */
function runMetaCached(runsDir: string, rootId: string, now: number, ttl: number): any {
  const f = join(runsDir, rootId, "run.json");
  let ms = -1;
  try { ms = statSync(f).mtimeMs; } catch { ms = -1; }
  const hit = META_CACHE.get(rootId);
  if (hit && hit.ms === ms) return hit.meta;      // run.json 没动就不重读
  const meta = readJson<any>(f);
  META_CACHE.set(rootId, { ms, meta });
  if (META_CACHE.size > CACHE_MAX) META_CACHE.clear();
  return meta;
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

// ---------------------------------------------------------------- S18：文件变更（diff）

/** 每个文件保留的 patch 行数上限（UI 展开先给 40 行，剩下靠 total 说"还有 N 行"） */
export const DIFF_PATCH_LINES = 60;

/** 这段正文像不像 unified diff：有 @@ 段，或有 ---/+++ 头，或同时有 + 行与 - 行 */
function looksLikeUnified(t: string): boolean {
  return /^@@ /m.test(t) || (/^--- /m.test(t) && /^\+\+\+ /m.test(t)) || (/^\+[^+]/m.test(t) && /^-[^-]/m.test(t));
}

/**
 * file_edit 事件 → 按文件聚合的 DiffView。
 * 诚实性：只有正文确实像 unified diff 才给 patch；否则 patch=null，只留 +N −M 统计（不编造行内容）。
 */
export function diffsOf(events: EvLine[]): DiffView[] {
  const byFile = new Map<string, { add: number; del: number; hunks: number; patch: string[]; total: number }>();
  const order: string[] = [];
  for (const { ev } of events) {
    if (ev?.kind !== "file_edit") continue;
    const d = ev.data ?? {};
    const file = String(d.path ?? d.file ?? "");
    if (!file) continue;
    let rec = byFile.get(file);
    if (!rec) { rec = { add: 0, del: 0, hunks: 0, patch: [], total: 0 }; byFile.set(file, rec); order.push(file); }
    rec.add += Math.max(0, firstNum(d, ["plus", "add", "added", "additions"]) ?? 0);
    rec.del += Math.max(0, firstNum(d, ["minus", "del", "removed", "deletions"]) ?? 0);
    const text = textOf(d.diff ?? d.patch ?? d.preview ?? "");
    if (!text || !looksLikeUnified(text)) continue;
    const lines = text.replace(/\r\n/g, "\n").split("\n");
    rec.hunks += lines.filter((l) => l.startsWith("@@")).length;
    rec.total += lines.length;
    for (const l of lines) if (rec.patch.length < DIFF_PATCH_LINES) rec.patch.push(l);
  }
  return order.map((file) => {
    const r = byFile.get(file)!;
    return {
      file, add: r.add, del: r.del, hunks: r.hunks,
      patch: r.patch.length ? r.patch : null,
      total: r.total, truncated: r.total > r.patch.length,
    };
  });
}

// ---------------------------------------------------------------- S23：计划条

/**
 * 计划条：ev_todo 事件（data.items / data.todos）优先，没有就退回节点 todo.json。
 * current = 第一个未完成项；全完成 = null（不瞎猜"下一步"）。
 */
export function planOf(events: EvLine[], todoJson?: any): PlanView | null {
  const norm = (raw: any[]): PlanItem[] => raw
    .map((it: any) => typeof it === "string"
      ? { text: it, done: false }
      : { text: String(it?.text ?? it?.title ?? it?.t ?? ""), done: !!(it?.done ?? it?.completed) })
    .filter((i: PlanItem) => i.text);
  let items: PlanItem[] | null = null;
  for (const { ev } of events) {
    if (ev?.kind !== "todo") continue;
    const d = ev.data ?? {};
    const raw = Array.isArray(d.items) ? d.items : Array.isArray(d.todos) ? d.todos : null;
    if (raw) items = norm(raw);
  }
  if (!items && Array.isArray(todoJson?.items)) items = norm(todoJson.items);
  if (!items || !items.length) return null;
  const idx = items.findIndex((i) => !i.done);
  return { items, current: idx >= 0 ? idx : null };
}

// ---------------------------------------------------------------- S23：裁决强度

export function severityOf(result: any): Severity | null {
  const raw = String(result?.output?.severity ?? result?.output?.sev ?? result?.severity ?? "").toLowerCase();
  return raw === "note" || raw === "warn" || raw === "block" ? raw : null;
}

const SEV_RANK: Record<Severity, number> = { note: 1, warn: 2, block: 3 };
export function sevMax(list: (Severity | null)[]): Severity | null {
  let best: Severity | null = null;
  for (const s of list) if (s && (!best || SEV_RANK[s] > SEV_RANK[best])) best = s;
  return best;
}

// ---------------------------------------------------------------- S26：审批审计对

const ASK_KINDS = new Set(["gate", "approve_ask"]);
const DECIDE_KINDS = new Set(["approve_decide", "gate_ans"]);

/** 问一次答一次配成一对；问完没人答的也要留一条（decision=null），不许只显示"已裁决" */
export function auditsOf(events: EvLine[], node = ""): AuditView[] {
  const out: AuditView[] = [];
  let ask: { asked_at: string | null; question: string } | null = null;
  for (const { ev } of events) {
    const kind = String(ev?.kind ?? "");
    if (ASK_KINDS.has(kind)) {
      if (ask) out.push({ node, ...ask, decision: null, decided_at: null, ms: null });
      const d = ev.data ?? {};
      ask = {
        asked_at: typeof ev.ts === "string" ? ev.ts : null,
        question: String(d.question ?? d.tool ?? d.summary ?? "审批请求").split("\n")[0].slice(0, 120),
      };
    } else if (DECIDE_KINDS.has(kind)) {
      const d = ev.data ?? {};
      const decision = String(d.decision ?? d.answer ?? "").trim() || null;
      const asked = ask?.asked_at ?? null;
      const decided = typeof ev.ts === "string" ? ev.ts : null;
      out.push({
        node, asked_at: asked, question: ask?.question ?? "", decision, decided_at: decided,
        ms: asked && decided ? Math.max(0, Date.parse(decided) - Date.parse(asked)) : null,
      });
      ask = null;
    }
  }
  if (ask) out.push({ node, ...ask, decision: null, decided_at: null, ms: null });
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

/**
 * gate-req 是否仍未答（req 在 / 未超 TTL / 没有比 req 更新的 gate-ans）。
 * 与 server.ts 的 pendingApproval 同一份契约；S21 把 approvals 并进 view 后这段应删。
 */
const APPROVAL_REQ = "gate-req.json";
const APPROVAL_ANS = "gate-ans.json";
const APPROVAL_TTL_MS = 10 * 60_000;
/** gate-ans.decision 的闭集：不在里面 = 没答。坏 ans 不许把"等你"弄消失（fail-closed） */
export const GATE_DECISIONS = ["allowed-once", "rejected", "cancelled", "unavailable"] as const;
const GATE_DECISION_SET = new Set<string>(GATE_DECISIONS);

export interface ApprovalState {
  /** 还有人要答（UI 卡照旧显示） */
  pending: boolean;
  /** 有 ans 但内容非法：仍算未答，UI 要提示"回答无效，请重答" */
  invalid: boolean;
  /** 解析后的 gate-req（pending 时非空） */
  req: any | null;
  asked_at: string | null;
  age_ms: number | null;
}

const NO_APPROVAL: ApprovalState = { pending: false, invalid: false, req: null, asked_at: null, age_ms: null };

/**
 * 单源判定：文件在 / 未超 TTL / 没有"合法且不比 req 旧"的 gate-ans。
 * server.ts 不再自带一份，直接调这里（S27 的 badGateAns 就是靠这层收口的）。
 */
export function approvalState(dir: string, now = Date.now()): ApprovalState {
  const reqFile = join(dir, APPROVAL_REQ);
  if (!existsSync(reqFile)) return NO_APPROVAL;
  let reqMs = 0;
  try { reqMs = statSync(reqFile).mtimeMs; } catch { return NO_APPROVAL; }
  let ansMs = 0, invalid = false;
  const ansFile = join(dir, APPROVAL_ANS);
  if (existsSync(ansFile)) {
    try {
      ansMs = statSync(ansFile).mtimeMs;
      const a = JSON.parse(readFileSync(ansFile, "utf8"));
      if (!GATE_DECISION_SET.has(String(a?.decision ?? ""))) invalid = true;
    } catch { invalid = true; }        // 半截/坏 JSON 一样算"没答"
  }
  const answered = ansMs > 0 && ansMs >= reqMs && !invalid;
  const age = now - reqMs;
  if (answered || age > APPROVAL_TTL_MS) return NO_APPROVAL;
  const req = readJson<any>(reqFile);
  return {
    pending: true, invalid,
    req: req && typeof req === "object" ? req : null,
    asked_at: new Date(reqMs).toISOString(),
    age_ms: Math.max(0, Math.round(age)),
  };
}

export function pendingApproval(dir: string, now = Date.now()): boolean {
  return approvalState(dir, now).pending;
}

/** stat 缓存版：mtime 与 ans 合法性都由 statNode 带出来，这里只比较，不再碰磁盘 */
function approvalByStamp(reqMs: number | null, ansMs: number | null, ansInvalid: boolean, now: number): boolean {
  if (reqMs == null) return false;
  if (ansMs != null && ansMs >= reqMs && !ansInvalid) return false;
  return now - reqMs <= APPROVAL_TTL_MS;
}

interface NodeProj {
  path: string;
  spec: any;
  r: any;
  gate: any;
  /** S25：有没有未答审批（决定 agg=blocked） */
  approval: boolean;
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
  diffs: DiffView[];
  plan: PlanView | null;
  sev: Severity | null;
  audits: AuditView[];
  /** R3：节点产出的提案（events.jsonl 里 kind=proposal） */
  proposals: { slug: string; risk: string; dir: string | null }[];
}

// ---- S26：mtime 缓存。stat 指纹不变 → 复用上次投影（投影里只放与时间无关的字段；
//      el / dur / approval 这类"跟着 now 变"的东西每次现算，不进缓存） ----
interface NodeCacheEntry {
  fp: string;
  /** 整份节点投影（除 el / approval / 带 depends 的 st 外都与 now 无关） */
  spec: any;
  r: any;
  gate: any;
  live: boolean;
  created: number;
  out: string[];
  st: string;
  nm: string;
  spent: number | null;
  wait: string | null;
  steps: StepView[];
  diffs: DiffView[];
  compactions: CompactionView[];
  plan: PlanView | null;
  audits: AuditView[];
  proposals: { slug: string; risk: string; dir: string | null }[];
  turn: TurnView;
  sev: Severity | null;
  todo: { text: string; done: boolean }[] | null;
  d: string;
  sum: string;
  lastEv: any | null;
}

/** stat 指纹缓存条目：一个窗口内重复请求不再逐个 stat（SSE watcher 有变化会先清掉） */
interface StatEntry {
  at: number;
  fp: string;
  live: boolean;
  reqMs: number | null;
  ansMs: number | null;
  /** gate-ans 存在但 decision 不在闭集（或 JSON 坏掉）：仍算未答 */
  invalidAns: boolean;
  specMs: number | null;
}

const NODE_CACHE = new Map<string, NodeCacheEntry>();
const STAT_CACHE = new Map<string, StatEntry>();
/** 每个 run 的节点路径表与 run.json：同样按窗口复用，免掉 500×(walk + read) */
const PATHS_CACHE = new Map<string, { ms: number; list: string[] }>();
const META_CACHE = new Map<string, { ms: number; meta: any }>();
/** 整个 run 的投影（键 = run 目录 / run.json / nodes 目录的 mtime+size） */
const RUN_CACHE = new Map<string, { fp: string; nodes: number; part: RunPart }>();
const CACHE_MAX = 4000;
/** stat 指纹的复用窗口（ms）。watcher 变更会立刻 clearViewCache，这里只是兜底 */
const STAT_TTL_MS = 1000;
let CACHE_HIT = 0, CACHE_MISS = 0;

/** 清缓存（测试改完夹具/临时目录后调用；生产由 SSE watcher 调） */
export function clearViewCache(): void {
  NODE_CACHE.clear();
  STAT_CACHE.clear();
  PATHS_CACHE.clear();
  META_CACHE.clear();
  RUN_CACHE.clear();
  CACHE_HIT = 0;
  CACHE_MISS = 0;
}

/** 缓存命中统计（性能测量与测试断言用） */
export function viewCacheStats(): { hits: number; misses: number; size: number } {
  return { hits: CACHE_HIT, misses: CACHE_MISS, size: NODE_CACHE.size };
}

/** gate-ans 的 decision 是否不合法（文件不在 = 不非法；坏 JSON / 闭集外 = 非法） */
function ansIsInvalid(dir: string): boolean {
  const f = join(dir, APPROVAL_ANS);
  if (!existsSync(f)) return false;
  try {
    const a = JSON.parse(readFileSync(f, "utf8"));
    return !GATE_DECISION_SET.has(String(a?.decision ?? ""));
  } catch { return true; }
}

/** 节点指纹 + 几个时间戳：一个窗口内只 stat 一次；live/审批时间戳一起带出来 */
function statNode(dir: string, stepLines: number, now: number, ttl: number): StatEntry {
  const hit = ttl > 0 ? STAT_CACHE.get(dir) : undefined;
  if (hit && now - hit.at < ttl) return hit;
  const one = (f: string): string => {
    try { const s = statSync(join(dir, f)); return `${s.size}.${Math.round(s.mtimeMs)}`; } catch { return "-"; }
  };
  const ms = (f: string): number | null => {
    try { return statSync(join(dir, f)).mtimeMs; } catch { return null; }
  };
  const live = existsSync(join(dir, "worker.json"));
  const entry: StatEntry = {
    at: now,
    live,
    reqMs: ms(APPROVAL_REQ),
    ansMs: ms(APPROVAL_ANS),
    invalidAns: ansIsInvalid(dir),
    specMs: ms("spec.json"),
    fp: [
      one("events.jsonl"), one("result.json"), one("spec.json"), one("todo.json"), one("gate.json"),
      one("usage.json"), one("worker.json"), one("gate-req.json"), one("gate-ans.json"), one("artifacts"),
      live ? 1 : 0, stepLines,
    ].join("|"),
  };
  if (ttl > 0) {
    STAT_CACHE.set(dir, entry);
    if (STAT_CACHE.size > CACHE_MAX) STAT_CACHE.clear();   // 有界：长跑守护进程不吃内存
  }
  return entry;
}

/** usage.json → 累计 tokens：旧字段 tokens 优先，没有就按分项相加（与 transcribe.usageTokens 同规则） */
function usageSpent(u: any): number | null {
  if (!u) return null;
  const t = Number(u.tokens);
  if (Number.isFinite(t) && t > 0) return t;
  const sum = ["in", "out", "cache"].reduce((s, k) => s + (Number(u.total?.[k]) || 0), 0);
  return sum > 0 ? sum : null;
}

function projectNode(runsDir: string, rootId: string, path: string, now: number, stepLines: number, statTtl: number): NodeProj {
  const dir = join(runsDir, rootId, "nodes", ...path.split("/"));
  const sn = statNode(dir, stepLines, now, statTtl);

  // 整份投影走指纹缓存：命中时这次调用一个 stat 都不做（除了下面 el 的纯计算）
  let c = NODE_CACHE.get(dir);
  if (!c || c.fp !== sn.fp) {
    CACHE_MISS += 1;
    const spec = readJson<any>(join(dir, "spec.json"));
    const r = readJson<any>(join(dir, "result.json"));
    const gate = readJson<any>(join(dir, "gate.json"));
    const usage = readJson<any>(join(dir, "usage.json"));
    const todo = readJson<any>(join(dir, "todo.json"));
    const created = sn.specMs ?? now;
    const ad = join(dir, "artifacts");
    const out = existsSync(ad)
      ? readdirSync(ad, { withFileTypes: true }).filter(f => f.isFile()).map(f => f.name).sort()
      : [];
    const events = readEvents(join(dir, "events.jsonl"));
    let lastEv: any = null;
    for (let k = events.length - 1; k >= 0; k--) if (events[k].ev?.ts) { lastEv = events[k].ev; break; }
    const audits = auditsOf(events, path);
    if (sn.invalidAns) {
      // fail-closed 的另一半：坏 ans 不让人消失，但要在审计里留痕（UI 提示"回答无效，请重答"）
      let askedMs: number | null = null;
      try { askedMs = statSync(join(dir, APPROVAL_REQ)).mtimeMs; } catch { askedMs = null; }
      audits.push({
        node: path,
        asked_at: askedMs ? new Date(askedMs).toISOString() : null,
        question: String(gate?.question ?? "").split("\n")[0].slice(0, 120),
        decision: "invalid-answer",
        decided_at: sn.ansMs ? new Date(sn.ansMs).toISOString() : null,
        ms: null,
      });
    }
    c = {
      fp: sn.fp, spec, r, gate, live: sn.live, created, out,
      st: viewStatus(runsDir, rootId, spec, r),
      nm: nodeName(runsDir, rootId, path),
      spent: usageSpent(usage) ?? r?.spent?.tokens ?? null,
      wait: r?.status === "waiting" ? (gate?.question ?? (Array.isArray(r?.wait_on) ? `等子节点 ${r.wait_on.join(", ")}` : r?.wait_on) ?? null) : null,
      steps: buildSteps(events, { lines: stepLines, live: sn.live }),
      diffs: diffsOf(events),
      compactions: compactionsOf(events),
      plan: planOf(events, todo),
      audits,
      proposals: propsOf(events),
      turn: projectTurn(events, r, sn.live),
      sev: severityOf(r),
      todo: Array.isArray(todo?.items) ? todo.items : null, // S9 ev_todo 清单投影
      d: String(r?.summary ?? (lastEv ? evHint(lastEv) : "")).split("\n")[0].slice(0, 80), // 一句话
      sum: r?.summary ?? "",
      lastEv,
    };
    NODE_CACHE.set(dir, c);
    if (NODE_CACHE.size > CACHE_MAX) NODE_CACHE.clear();   // 粗暴但有界，防止长跑守护进程吃内存
  } else {
    CACHE_HIT += 1;
  }

  return {
    path, spec: c.spec, r: c.r, gate: c.gate,
    // S25：未答审批也算"人在环"（TTL 跟 now 有关 → 每次按 stat 带出的 mtime 现算）
    approval: approvalByStamp(sn.reqMs, sn.ansMs, sn.invalidAns, now),
    // 带 depends 的节点状态依赖别人的 result.json → 不能吃缓存，现算
    st: c.spec?.depends?.length ? viewStatus(runsDir, rootId, c.spec, c.r) : c.st,
    // S10 控制面投影：live=worker.json 租约在、cur=尾事件工具/动作、spent=token 累计、wait=waiting 原因
    live: c.live,
    cur: c.lastEv?.data?.tool ?? c.lastEv?.kind ?? null,
    spent: c.spent,
    todo: c.todo,
    wait: c.wait,
    nm: c.nm,
    d: c.d,
    sum: c.sum,
    steps: c.steps,
    out: c.out,
    el: mmss((c.r?.finished_at ? Date.parse(c.r.finished_at) : now) - c.created),
    ev: c.lastEv,
    turn: c.turn,
    compactions: c.compactions,   // S20：压缩可见（三事件合成）
    diffs: c.diffs,               // S18：文件变更
    plan: c.plan,                 // S23：计划条
    sev: c.sev,                   // S23：裁决强度
    audits: c.audits,             // S26：审批审计对
    proposals: c.proposals,       // R3：节点产出的提案
  };
}

/** 节点事件里的提案（kind=proposal → {slug,risk,dir}），同 slug 只留第一条 */
function propsOf(events: EvLine[]): { slug: string; risk: string; dir: string | null }[] {
  const out: { slug: string; risk: string; dir: string | null }[] = [];
  for (const e of events) {
    if (e.ev?.kind !== "proposal") continue;
    const d: any = e.ev.data || {};
    const slug = String(d.slug ?? "").trim();
    if (!slug) continue;
    if (out.some(p => p.slug === slug)) continue;
    out.push({ slug, risk: String(d.risk ?? "low"), dir: typeof d.dir === "string" ? d.dir : null });
  }
  return out;
}

/** R3/P1：测试类 run 的判据 —— title 以 smoke/test 开头（后跟空格/连字符/下划线）或 kind=test */
export function isTestLike(subject: unknown, kind?: unknown): boolean {
  if (/^(smoke|test)[\s_-]/i.test(String(subject ?? ""))) return true;
  return String(kind ?? "").toLowerCase() === "test";
}

/**
 * 磁盘真相 → 视图 JSON。
 * @param runsDir STATE/runs（调用方传入，本函数不读全局）
 * @param opts    { now, stepLines }；now 缺省 Date.now()，测试必须显式给
 */
export function buildView(runsDir: string, opts: ViewOptions = {}): ViewPayload {
  const now = opts.now ?? Date.now();
  const stepLines = opts.stepLines ?? STEP_OUT_LINES;
  const statTtl = opts.statTtl ?? 0;
  const runs: RunView[] = [], inbox: InboxItem[] = [], settled: [string, string, string][] = [];
  if (!existsSync(runsDir)) return { runs, inbox, settled };

  const metaOf = new Map<string, any>();
  const rootIds = readdirSync(runsDir, { withFileTypes: true })
    .filter(d => d.isDirectory() && okId(d.name))
    .map(d => { metaOf.set(d.name, runMetaCached(runsDir, d.name, now, statTtl)); return d.name; })
    .sort((a, b) => String(metaOf.get(b)?.created_at ?? "").localeCompare(String(metaOf.get(a)?.created_at ?? ""))); // 新 run 在前（同 /api/runs）

  for (const rootId of rootIds) {
    const meta = metaOf.get(rootId);
    const paths = nodePathsCached(runsDir, rootId, now, statTtl);
    const rfp = runFingerprint(runsDir, rootId, paths);
    const hit = RUN_CACHE.get(rootId);
    let part: RunPart;
    if (hit && hit.fp === rfp) {
      CACHE_HIT += hit.nodes;                // 与 NODE_CACHE 同口径：等于这么多节点的投影被复用
      part = hit.part;                       // 整个 run 的投影（含 inbox/settled）原样复用
    } else {
      part = buildRunPart(runsDir, rootId, meta, now, stepLines, statTtl, paths);
      RUN_CACHE.set(rootId, { fp: rfp, nodes: paths.length, part });
      if (RUN_CACHE.size > CACHE_MAX) RUN_CACHE.clear();
    }
    const runIdx = runs.length;
    for (const it of part.inbox) it.gate.run = runIdx;   // gate.run 指回最终下标（缓存复用时也要重指）
    runs.push(part.view);
    inbox.push(...part.inbox);
    if (part.settled) settled.push(part.settled);
  }
  return { runs, inbox, settled };
}

/** 一个 run 的完整投影（run 级缓存单位） */
interface RunPart { view: RunView; inbox: InboxItem[]; settled: [string, string, string] | null; }

/**
 * run 级指纹：run 目录 / run.json / nodes 目录三处 mtime+size。
 * 命中就跳过整轮 readdir(nodes) + 逐节点 stat —— 500 run 时这是热路径的大头。
 * 内容级变化（events.jsonl 追加）由 server 的 fs.watch → clearViewCache 兜住。
 */
function runFingerprint(runsDir: string, rootId: string, paths: string[]): string {
  const one = (p: string): string => {
    try { const s = statSync(p); return `${s.size}.${Math.round(s.mtimeMs)}`; } catch { return "-"; }
  };
  const base = join(runsDir, rootId);
  // 逐节点的 events/result/spec：内容级失效（追加事件也会变），别只靠目录 mtime
  const nodeMs = paths.map(p => {
    const d = join(base, "nodes", ...p.split("/"));
    return one(d) + "," + one(join(d, "events.jsonl")) + "," + one(join(d, "result.json")) + "," + one(join(d, "spec.json"));
  });
  return [one(base), one(join(base, "run.json")), one(join(base, "nodes")), one(join(base, "git-ask.json")), ...nodeMs].join("|");
}

function buildRunPart(runsDir: string, rootId: string, meta: any, now: number, stepLines: number, statTtl: number, paths: string[]): RunPart {
  const inboxLocal: InboxItem[] = [];
  let settledLocal: [string, string, string] | null = null;
  {
    const nodes = paths.map(path => projectNode(runsDir, rootId, path, now, stepLines, statTtl));
    const waiting = nodes.filter(n => n.st === "input");
    const allDone = nodes.length > 0 && nodes.every(n => n.r?.status === "done");
    const ended = nodes.map(n => n.r?.finished_at).filter(Boolean).sort().pop() as string | undefined;
    // run 不自动隐藏：done/failed 也留在 runs 里可打开，只有显式 DELETE 才消失
    const status: RunView["status"] = allDone ? "done" : waiting.length ? "input"
      : nodes.some(n => n.r?.status === "failed") ? "failed" : "working";
    if (allDone) settledLocal = [meta?.subject ?? rootId, hhmm(ended ?? meta?.created_at ?? new Date(now).toISOString()), rootId];
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
        wb: n.approval ? "person:answer" : n.st === "input" ? "person:answer" : n.st === "dep" ? "dependency" : "", // wb=等待对象：等人答/等依赖
        turn: n.turn,
        agg: nodeAgg(n.st, n.approval),   // S25：节点四态（与 run 行同一套；未答审批 = 等你）
        compactions: n.compactions,
        diffs: n.diffs,                   // S18
        plan: n.plan,                     // S23
        sev: n.sev,                       // S23
        audits: n.audits,                 // S26
      }));
    // arts：全部节点 artifacts/ 汇总到 run 级；非 root 节点的 fn 带 path 前缀防重名
    const arts: ArtView[] = [];
    for (const n of nodes) {
      if (!n.out.length) continue;                  // projectNode 已经列过 artifacts/：空就整段跳过（省 existsSync+readdir）
      const ad = join(runsDir, rootId, "nodes", ...n.path.split("/"), "artifacts");
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
    const last = runPulseFrom(nodes);
    // S6：run 行 Σtok = 各节点 spent（result.spent 或 usage.json）累加
    const spentTotal = nodes.reduce((s, n) => s + (typeof n.spent === "number" ? n.spent : 0), 0);
    // S25：run 行状态 = max(所有节点)。blocked > failed > working > done；done 不冒泡（P5）
    const aggList = nodes.map(n => nodeAgg(n.st, n.approval));
    // 还没有任何节点 = 还没开始（不是 done）；有节点才按最紧急聚合
    const agg = aggList.length ? aggMax(aggList) : "working";
    const rootSteps = rootNode?.steps ?? [];
    const view: RunView = {
      id: rootId, kind: typeof meta?.kind === "string" ? meta.kind : null, title: meta?.subject ?? rootId, status,
      // 判据放宽：`smoke test 1587:57` / `test_foo` / `smoke-1` 都算；只认前缀，不认正文里的 smoke
      test_like: isTestLike(meta?.subject, meta?.kind),
      agg, agg_n: aggList.filter(a => a === agg).length,
      dur: mmss((ended ? Date.parse(ended) : now) - Date.parse(meta?.created_at ?? new Date(now).toISOString())),
      spent: spentTotal || null,
      snippet: last?.hint ?? "",
      req: meta?.subject ?? "",                                          // 原始诉求
      obj: String(rootNode?.spec?.goal ?? "").split("\n")[0].slice(0, 80), // 目标（根 goal 首行）
      sum: rootNode?.r?.summary ?? "",                                   // 摘要（根 result）
      profile: typeof rootNode?.spec?.profile === "string" ? rootNode.spec.profile : null,
      parallel: typeof meta?.parallel === "number" ? meta.parallel : null,
      /* R5：审批模式 / 模型 / 档位都从根 spec 回显（派发时真的写进了 spec 才算数） */
      permission: typeof rootNode?.spec?.permission === "string" ? rootNode.spec.permission : null,
      tools: Array.isArray(rootNode?.spec?.tools) ? rootNode.spec.tools.map(String) : null,
      model: typeof rootNode?.spec?.model === "string" ? rootNode.spec.model : null,
      effort: typeof rootNode?.spec?.budget?.effort === "string" ? rootNode.spec.budget.effort : null,
      mode: approvalModeOf(rootNode?.spec?.permission, rootNode?.spec?.tools),
      chips, tree, arts,
      steps: rootSteps,                                                  // S17：Run 详情工具时间线
      groups: groupSteps(rootSteps),                                     // S25：渲染分段（时间顺序）
      stats: stepStats(rootSteps),                                       // S25：组头统计（N 命令 · M 编辑 · 42s）
      turn: runTurn,
      compactions: rootNode?.compactions ?? [],                          // S20：根节点的压缩记录
      diffs: rootNode?.diffs ?? [],                                      // S18：根节点的文件变更
      plan: rootNode?.plan ?? null,                                      // S23：计划条
      sev: sevMax(nodes.map(n => n.sev)),                                // S23：本 run 最重裁决强度
      audits: nodes.flatMap(n => n.audits),                              // S26：审批审计对（全节点）
    };
    // inbox：waiting 节点 → 人工闸门条目（gate.run 由 buildView 落最终下标）
    for (const n of waiting) {
      const q = String(n.gate?.question ?? n.r?.summary ?? "");
      const opts: [string, string, string][] = n.gate?.opts?.length
        ? n.gate.opts.map((o: string) => [o, "", `已选择·${o}`] as [string, string, string]) // [文案, 图标位, 已选后文案]
        : [["同意", "", "已同意"], ["拒绝", "", "已拒绝"]];
      const segs = n.path.split("/");
      const crumb = [meta?.subject ?? rootId, ...segs.map((_, i) => nodeName(runsDir, rootId, segs.slice(0, i + 1).join("/")))];
      inboxLocal.push({
        id: n.spec?.id ?? `node:${rootId}/${n.path}`,
        t: q.split("\n")[0].slice(0, 80), d: q, crumb, opts,
        gate: { run: 0, nm: n.nm, pd: `回复已送达，${n.nm} 恢复执行`, sn: "已回复 · 节点恢复运行" },
      });
    }
    // R3 §9.5：节点产出的提案 → inbox 提案卡（点开跳「提案」页签）；已 applied/rejected 的不再打扰
    const seenProp = new Set<string>();
    for (const n of nodes) {
      for (const p of n.proposals) {
        if (seenProp.has(p.slug)) continue;
        seenProp.add(p.slug);
        const pdir = p.dir ?? join(runsDir, "..", "proposals", p.slug);
        if (existsSync(join(pdir, "applied.json")) || existsSync(join(pdir, "rejected.json"))) continue;
        let first = "";
        try {
          first = readFileSync(join(pdir, "proposal.md"), "utf8").split("\n")
            .map(l => l.trim()).find(l => l && !l.startsWith("#")) ?? "";
        } catch { first = ""; }
        inboxLocal.push({
          id: `proposal:${p.slug}`, kind: "proposal",
          t: `提案：${p.slug}`, d: first.slice(0, 160) || "（提案没有摘要）",
          crumb: [meta?.subject ?? rootId, n.nm], opts: [["查看提案", "", "已打开"]],
          gate: { run: 0, nm: n.nm, pd: "", sn: "" },
          prop: { slug: p.slug, risk: p.risk },
        });
      }
    }
    // R5：git 提交审批卡（批准前不执行任何 git 操作；拒绝只删 ask）
    try {
      const ask = readJson<any>(join(runsDir, rootId, "git-ask.json"));
      if (ask && typeof ask.message === "string") {
        const nFiles = Array.isArray(ask.files) ? ask.files.length : 0;
        inboxLocal.push({
          id: `git:${rootId}`, kind: "git",
          t: "提交改动：" + String(ask.message).split("\n")[0].slice(0, 60),
          d: `${nFiles} 个文件待提交 · 批准后才执行 git add -A && git commit`,
          crumb: [meta?.subject ?? rootId, "工作区"],
          opts: [["批准提交", "", "已提交"], ["拒绝", "", "已拒绝"]],
          gate: { run: 0, nm: "工作区", pd: "", sn: "" },
          git: { message: String(ask.message), files: nFiles, created_at: ask.created_at ?? null },
        });
      }
    } catch { /* 没有 ask 就是没有 */ }
    return { view, inbox: inboxLocal, settled: settledLocal };
  }
}

/** 已在 projectNode 里读过尾事件，这里不再二次读盘（等价 runPulse(runsDir, rootId, paths)） */
function runPulseFrom(nodes: NodeProj[]): { hint: string } | null {
  let best: any = null;
  for (const n of nodes) if (n.ev && (!best || n.ev.ts > best.ts)) best = n.ev;
  return best ? { hint: evHint(best) } : null;
}

// ---------------------------------------------------------------- R3：提案页签的读侧投影

export interface ProposalDetail {
  slug: string;
  risk: string;
  status: string;
  created_at: string | null;
  verify_cmd: string | null;
  /** proposal.md 全文（UI 自己截断） */
  proposal: string;
  /** change.patch 全文（UI 交给 S18 的 diff 组件） */
  patch: string;
  meta: any;
}

/**
 * 读一个提案目录的四件套（proposal.md / change.patch / verify.json / meta.json）。
 * 缺文件就如实留空 —— 不编内容；目录不存在返回 null。
 */
export function proposalDetail(dir: string): ProposalDetail | null {
  if (!dir || !existsSync(dir)) return null;
  const meta = readJson<any>(join(dir, "meta.json"));
  const verify = readJson<any>(join(dir, "verify.json"));
  const read = (f: string): string => {
    try { return readFileSync(join(dir, f), "utf8"); } catch { return ""; }
  };
  const slug = String(meta?.slug ?? dir.split(/[\\/]/).filter(Boolean).pop() ?? "");
  if (!slug) return null;
  return {
    slug,
    risk: String(meta?.risk ?? "low"),
    status: String(meta?.status ?? "pending"),
    created_at: typeof meta?.created_at === "string" ? meta.created_at : null,
    verify_cmd: typeof verify?.cmd === "string" ? verify.cmd : null,
    proposal: read("proposal.md"),
    // S28 写的是 patch.diff；change.patch 是早期命名，保留兼容
    patch: read("patch.diff") || read("change.patch"),
    meta: meta ?? null,
  };
}

/**
 * R3：列表项是权威（status/risk 由 S28 从 applied.json / rejected.json 算），
 * 正文（proposal/patch/verify_cmd）只补缺。合并顺序写在这里，防止再犯。
 */
export function mergeProposal(detail: ProposalDetail | null, hit: any): any | null {
  if (!detail) return null;
  return { ...detail, ...(hit && typeof hit === "object" ? hit : {}) };
}

/**
 * R4：提案列表的查询过滤（`/api/proposals?status=applied&auto=1`）。
 * 过滤规则只在这里定义，server 与测试共用 —— "自动应用"标记容忍几种常见命名。
 */
export function filterProposals(list: any[], q: { status?: string | null; auto?: string | null } = {}): any[] {
  if (!Array.isArray(list)) return [];
  const st = String(q.status ?? "").trim().toLowerCase();
  const wantAuto = String(q.auto ?? "").trim() === "1";
  return list.filter(p => {
    if (st && String(p?.status ?? "").toLowerCase() !== st) return false;
    if (wantAuto && !isAutoApplied(p)) return false;
    return true;
  });
}

/** 自动应用的判定：列表项自带标记优先，否则看提案目录的 applied.json / meta.json（S28 落盘是权威） */
function isAutoApplied(p: any): boolean {
  if (p?.auto === true || p?.applied_by === "auto" || p?.by === "auto") return true;
  const dir = typeof p?.dir === "string" ? p.dir : "";
  if (!dir) return false;
  try {
    const ap = readJson<any>(join(dir, "applied.json"));
    if (ap && (ap.by === "auto" || ap.auto === true)) return true;
    const meta = readJson<any>(join(dir, "meta.json"));
    if (meta?.auto === true) return true;
  } catch { /* 目录读不到就当不是自动应用 */ }
  return false;
}







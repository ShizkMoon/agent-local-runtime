// runs/ 运行目录操作：唯一的运行状态源，全部纯文件
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, appendFileSync, renameSync, unlinkSync, statSync, cpSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import type { SpecEnvelope, ResultEnvelope, EventRecord } from "./envelope.ts";
import { nodeId, stableId } from "./envelope.ts";

// 空串按未设置处理：daemon 若把 AICA_STATE="" 传给 worker，STATE="" 会让 RUNS_DIR 变成相对路径
// resolve 成绝对路径：相对 AICA_STATE 会被 worker 在节点 cwd 下再解析一次，写出嵌套目录
export const STATE = resolve(process.env.AICA_STATE || join(process.env.LOCALAPPDATA!, "aica", "state"));
export const RUNS_DIR = join(STATE, "runs");
const INDEX = join(RUNS_DIR, "index.jsonl");

export function runsDir(): string {
  mkdirSync(RUNS_DIR, { recursive: true });
  return RUNS_DIR;
}

function runDir(rootId: string): string {
  return join(RUNS_DIR, rootId);
}

export function nodeDir(rootId: string, path: string): string {
  return join(runDir(rootId), "nodes", path);
}

function writeJson(file: string, data: unknown): void {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2) + "\n", "utf8");
}

function readJson<T>(file: string): T | null {
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as T) : null;
}

export interface RunMeta {
  root_id: string;
  created_at: string;
  kind?: string;
  subject?: string;
  plan_version: number;
  /** S22：该 run 的并发上限（缺省 2）；spec.budget.parallel 优先 */
  parallel?: number;
}

/** 创建 Run：写 index + plan.v1 + 根节点目录 */
export function createRun(opts: { kind?: string; subject?: string }): { rootId: string; dir: string } {
  runsDir();
  const rootId = stableId(opts.subject ?? "run", Date.now().toString()).slice(0, 13);
  const dir = runDir(rootId);
  mkdirSync(dir, { recursive: true });
  const meta: RunMeta = { root_id: rootId, created_at: new Date().toISOString(), kind: opts.kind, subject: opts.subject, plan_version: 1 };
  writeJson(join(dir, "run.json"), meta);
  // coverage/paths 字段先空着：orchestrator 写 plan 时填（schema 松，S9）
  writeJson(join(dir, "plan.v1.json"), { version: 1, created_at: meta.created_at, nodes: [], coverage: [], paths: [] });
  appendFileSync(INDEX, JSON.stringify({ ts: meta.created_at, event: "run_create", root_id: rootId, subject: opts.subject }) + "\n", "utf8");
  return { rootId, dir };
}

/** 写派发信封 = 投递拉起意图（daemon 消费） */
export function writeSpec(rootId: string, path: string, spec: Omit<SpecEnvelope, "id">): SpecEnvelope {
  const full: SpecEnvelope = { ...spec, id: nodeId(rootId, path) };
  const dir = nodeDir(rootId, path);
  mkdirSync(join(dir, "artifacts"), { recursive: true });
  writeJson(join(dir, "spec.json"), full);
  appendFileSync(INDEX, JSON.stringify({ ts: new Date().toISOString(), event: "spec", root_id: rootId, node: full.id, path }) + "\n", "utf8");
  return full;
}

export function readSpec(rootId: string, path: string): SpecEnvelope | null {
  return readJson<SpecEnvelope>(join(nodeDir(rootId, path), "spec.json"));
}

export function readResult(rootId: string, path: string): ResultEnvelope | null {
  return readJson<ResultEnvelope>(join(nodeDir(rootId, path), "result.json"));
}

export function writeResult(rootId: string, path: string, result: Omit<ResultEnvelope, "id" | "finished_at" | "type"> & Partial<ResultEnvelope>): ResultEnvelope {
  const file = join(nodeDir(rootId, path), "result.json");
  // 幂等：result 一旦落盘不覆写（abort / daemon 兜底 / worker 自写三方竞态下先写者胜）
  const existing = readJson<ResultEnvelope>(file);
  if (existing) return existing;
  const full: ResultEnvelope = { id: nodeId(rootId, path), finished_at: new Date().toISOString(), ...result, type: "result" };
  writeJson(file, full);
  resetAttempts(rootId, path);   // S21：一次拉起正经落定 → 续跑计数清零（只有崩溃循环才会累到上限）
  appendFileSync(INDEX, JSON.stringify({ ts: full.finished_at, event: "result", root_id: rootId, node: full.id, status: full.status }) + "\n", "utf8");
  return full;
}

/** 补丁式改 result（writeResult 幂等先写者胜；daemon spent 回填等收尾场景走这里），无 result 返回 null */
export function patchResult(rootId: string, path: string, patch: Partial<ResultEnvelope>): ResultEnvelope | null {
  const file = join(nodeDir(rootId, path), "result.json");
  const cur = readJson<ResultEnvelope>(file);
  if (!cur) return null;
  const next: ResultEnvelope = { ...cur, ...patch, id: cur.id, type: "result" };
  writeJson(file, next);
  return next;
}

export function appendEvent(rootId: string, path: string, rec: Omit<EventRecord, "ts">): void {
  const file = join(nodeDir(rootId, path), "events.jsonl");
  const key = `${rootId}\u0000${path}`;
  const size = existsSync(file) ? statSync(file).size : 0;
  const hit = seqCache.get(key);
  let seq: number;
  if (hit && hit.size === size) seq = hit.seq + 1;   // 常规路径：本进程上次写过之后没人动过文件
  else {                                             // 首写 / 别的进程追加过（worker 直写事件）→ 重扫
    const scan = scanEvents(file);
    seq = Math.max(scan.lines, scan.maxSeq) + 1;
  }
  const line = JSON.stringify({ ts: new Date().toISOString(), ...rec, seq }) + "\n";
  appendFileSync(file, line, "utf8");
  seqCache.set(key, { seq, size: size + Buffer.byteLength(line, "utf8") });
}

// ---- S21：事件 seq / 增量读 / 命令幂等 ----

// 节点内单调递增的事件序号：写时自增，缓存 (last seq, 文件字节数)，文件被别的进程追加过就重扫
const seqCache = new Map<string, { seq: number; size: number }>();

function scanEvents(file: string): { lines: number; maxSeq: number } {
  if (!existsSync(file)) return { lines: 0, maxSeq: 0 };
  let lines = 0, maxSeq = 0;
  for (const l of readFileSync(file, "utf8").split("\n")) {
    if (!l.trim()) continue;
    lines += 1;
    try {
      const s = Number(JSON.parse(l)?.seq);
      if (Number.isFinite(s) && s > maxSeq) maxSeq = s;
    } catch { /* 坏行也占一行，仍然计数 */ }
  }
  return { lines, maxSeq };
}

export interface RawEvent {
  /** 行号（0 基）：seq 之前的写法，仍保留（老客户端与 worker 直写的事件靠它定位） */
  i: number;
  /** 节点内单调序号；worker 直写 / 老文件里没有 → null */
  seq: number | null;
  ts: string | null;
  kind: string;
  data: any;
}

/** 读一个节点的全部事件（raw 形状，带 seq 与行号）；坏行降级成 _raw，不吞 */
export function readEvents(rootId: string, path: string): RawEvent[] {
  const file = join(nodeDir(rootId, path), "events.jsonl");
  if (!existsSync(file)) return [];
  const out: RawEvent[] = [];
  readFileSync(file, "utf8").split("\n").forEach((l, i) => {
    if (!l.trim()) return;
    let ev: any;
    try { ev = JSON.parse(l); }
    catch { out.push({ i, seq: null, ts: null, kind: "_raw", data: { raw: l.slice(0, 300) } }); return; }
    const s = Number(ev?.seq);
    out.push({ i, seq: Number.isFinite(s) ? s : null, ts: typeof ev?.ts === "string" ? ev.ts : null, kind: String(ev?.kind ?? ""), data: ev?.data ?? null });
  });
  return out;
}

/** 最后一个 seq（写 checkpoint 的 last_event_seq 用）；没有 seq 的事件不算 */
export function lastSeq(rootId: string, path: string): number {
  let max = 0;
  for (const e of readEvents(rootId, path)) if (e.seq !== null && e.seq > max) max = e.seq;
  return max;
}

/**
 * 增量读：since 之后的事件。
 * 有 seq 的文件按 seq 过滤（mode:"seq"）；纯老文件没有 seq → 退回行号语义（mode:"index"）保持兼容。
 * worker 直写的事件没有 seq（aica-pi/extensions/events.ts 不在本切片写域）→ seq 模式下列不出来，
 * 用 unsequenced 计数如实告知，不假装"没有丢失"。
 */
export function readEventsSince(rootId: string, path: string, since = 0): {
  events: RawEvent[]; next: number; mode: "seq" | "index"; total: number; unsequenced: number;
} {
  const all = readEvents(rootId, path);
  const maxSeq = all.reduce((m, e) => (e.seq !== null && e.seq > m ? e.seq : m), 0);
  const unsequenced = all.filter((e) => e.seq === null).length;
  if (maxSeq === 0) {
    const start = Math.max(0, since);
    return { events: all.slice(start), next: all.length, mode: "index", total: all.length, unsequenced };
  }
  return { events: all.filter((e) => e.seq !== null && e.seq > since), next: maxSeq, mode: "seq", total: all.length, unsequenced };
}

/**
 * 命令回执幂等：同一条命令 + 同一份载荷只留一条 kind:"cmd" 事件。
 * 重复执行 ar done/fail/reply 时不再刷屏；载荷不同（例如两次不同的人工回复）仍然各留一条。
 */
export function appendCmdOnce(rootId: string, path: string, cmd: string, payload: Record<string, unknown> = {}): boolean {
  const key = JSON.stringify(payload);
  for (const e of readEvents(rootId, path)) {
    if (e.kind === "cmd" && e.data?.cmd === cmd && JSON.stringify(e.data?.payload ?? {}) === key) return false;
  }
  appendEvent(rootId, path, { kind: "cmd", data: { cmd, payload } });
  return true;
}

export interface UsageTurn {
  i: number;                 // turn 序号（同一次拉起内从 1 开始）
  attempt?: number;          // S20：第几次拉起（fallback 重试会从 1 重来，账仍是累计的）
  at?: string;
  in?: number | null;        // provider 没报分项时记 null，不编数
  out?: number | null;
  cache?: number | null;
  ms?: number;
  tokens: number;            // 该 turn 合计（有 totalTokens 用它，否则 in+out）
}

export interface UsageFile {
  tokens: number;                        // 兼容旧字段：全部 turn 的 tokens 累加
  byTurn: { i: number; tokens: number }[];
  turns?: UsageTurn[];                   // S20：turn 级账本（由 transcribe.ts 原子写，无 addUsage）
  total?: { in: number; out: number; cache: number };
}

/** ev_gate：节点目录写 gate.json（workbench inbox 投影读它），并记一条 gate 事件（尾事件 hint 即问题） */
export function writeGate(rootId: string, path: string, gate: { question: string; opts?: string[] }): void {
  writeJson(join(nodeDir(rootId, path), "gate.json"), { ...gate, ts: new Date().toISOString() });
  appendEvent(rootId, path, { kind: "gate", data: { question: gate.question } });
}

// ---- worker.json 租约锁（S3 · G29）：spawn 成功写、finish 删；pendingNodes 以它做防重入 ----
// S21：pid 死了不再默默清锁重拉 —— 死锁 + 无 result 是"孤儿"，由 reapOrphan 给归宿（process-bound effect 不重放）
export interface WorkerInfo {
  pid: number;
  started_at: string;
  cmd: string;
  /** 该节点第几次被拉起（S21 续跑预算；计数器落 attempts.json，跨 daemon 重启不丢） */
  attempts?: number;
}

const workerFile = (rootId: string, path: string): string => join(nodeDir(rootId, path), "worker.json");
const attemptsFile = (rootId: string, path: string): string => join(nodeDir(rootId, path), "attempts.json");

/** 同一节点连续拉起多少次仍没有 result 就判"续跑耗尽"（>10 次停止续跑） */
export const MAX_ATTEMPTS = 10;

export function readAttempts(rootId: string, path: string): number {
  try { return Math.max(0, Number(readJson<{ n: number }>(attemptsFile(rootId, path))?.n) || 0); }
  catch { return 0; }
}

export function resetAttempts(rootId: string, path: string): void {
  try { unlinkSync(attemptsFile(rootId, path)); } catch { /* 计数文件不在就算已清 */ }
}

export function writeWorker(rootId: string, path: string, info: { pid: number; started_at: string; cmd: string; attempts?: number }): WorkerInfo {
  const prev = readWorker(rootId, path);
  const attempts = info.attempts ?? Math.max(readAttempts(rootId, path), prev?.attempts ?? 0) + 1;
  const full: WorkerInfo = { ...info, attempts };
  writeJson(workerFile(rootId, path), full);
  writeJson(attemptsFile(rootId, path), { n: attempts, at: full.started_at });
  return full;
}

export function readWorker(rootId: string, path: string): WorkerInfo | null {
  try { return readJson<WorkerInfo>(workerFile(rootId, path)); } catch { return null; }
}

export function clearWorker(rootId: string, path: string): void {
  try { unlinkSync(workerFile(rootId, path)); } catch { /* 文件不在就算已清 */ }
}

/** pid 存活探测：kill(pid,0) 成功或 EPERM（进程在但无权杀）都算活 */
function pidAlive(pid: number): boolean {
  if (!(pid > 0)) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return (e as NodeJS.ErrnoException)?.code === "EPERM"; }
}

/** pendingNodes 防重入锁：worker.json 在且 pid 活 → true（skip）。
 *  pid 死但文件在 → **不再在这里清锁重拉**（S21：死锁是孤儿的证据，交给 reapOrphan 收尾） */
export function workerLive(rootId: string, path: string): boolean {
  const w = readWorker(rootId, path);
  return !!w && pidAlive(w.pid);
}

/**
 * S21：孤儿收尾 —— worker.json 在、pid 已死、且没有 result：
 * 标 failed("orphaned") + 一条 orphan 事件 + 清锁，返回 true 表示"已给归宿，别再拉起"。
 * 先写 result 再清锁（与 abortWorker 同款顺序）：任意时刻 pendingNodes 都不会把它判回待拉起。
 */
export function reapOrphan(rootId: string, path: string): boolean {
  const w = readWorker(rootId, path);
  if (!w || pidAlive(w.pid)) return false;
  const dir = nodeDir(rootId, path);
  if (existsSync(join(dir, "result.json"))) { clearWorker(rootId, path); return false; }   // 结果已落盘，只是锁没来得及清
  const res: Partial<ResultEnvelope> & { reason?: string } = {
    status: "failed",
    summary: `orphaned：worker 进程已消失（pid ${w.pid}）且没有 result——daemon 崩溃/被杀，按 process-bound effect 不重放`,
    reason: "orphaned",
  };
  writeResult(rootId, path, res);
  appendEvent(rootId, path, { kind: "orphan", data: { pid: w.pid, attempts: w.attempts ?? readAttempts(rootId, path) } });
  clearWorker(rootId, path);
  return true;
}

/** S21：续跑耗尽 —— 同一节点拉起次数超过上限仍无 result，停止续跑并留证据 */
export function exhaustResume(rootId: string, path: string, attempts = readAttempts(rootId, path)): void {
  const res: Partial<ResultEnvelope> & { reason?: string } = {
    status: "failed",
    summary: `resume exhausted：同一节点已拉起 ${attempts} 次仍没有 result（上限 ${MAX_ATTEMPTS}），停止续跑`,
    reason: "resume exhausted",
  };
  writeResult(rootId, path, res);
  appendEvent(rootId, path, { kind: "resume_exhausted", data: { attempts, limit: MAX_ATTEMPTS } });
}

// ---- S21：checkpoint（turn 边界快照；resume 时告诉 worker 从哪继续） ----
export interface Checkpoint {
  last_turn: number;
  last_event_seq: number;
  at: string;
}

export function writeCheckpoint(rootId: string, path: string, cp: Checkpoint): void {
  writeJson(join(nodeDir(rootId, path), "checkpoint.json"), cp);
}

export function readCheckpoint(rootId: string, path: string): Checkpoint | null {
  try { return readJson<Checkpoint>(join(nodeDir(rootId, path), "checkpoint.json")); } catch { return null; }
}

/**
 * S21：进程中断后，上一轮发出的 tool_call 永远不会等到结果 ——
 * 给每个没有收口、也没被补过的 call 追加一条 tool_execution{is_error:true, reason:"aborted"}。
 * 幂等：补过的 call 不再补第二次。返回补齐条数。
 */
export function closeDanglingTools(rootId: string, path: string): number {
  const open = new Map<string, string>();   // call_id → tool
  for (const e of readEvents(rootId, path)) {
    const id = e.data?.call_id ?? e.data?.callId;
    if (typeof id !== "string" || !id) continue;
    const tool = String(e.data?.tool ?? e.data?.toolName ?? "?");
    const isStart = e.kind === "tool_call" || (e.kind === "tool_execution" && e.data?.phase === "start");
    const isEnd = e.kind === "tool_result" || (e.kind === "tool_execution" && e.data?.phase !== "start");
    if (isStart) open.set(id, tool);
    else if (isEnd) open.delete(id);
  }
  let n = 0;
  for (const [id, tool] of open) {
    appendEvent(rootId, path, { kind: "tool_execution", data: {
      phase: "end", call_id: id, tool, is_error: true, reason: "aborted",
      output: "（进程中断，工具未返回结果）",
    } });
    n += 1;
  }
  return n;
}

/** abort：杀 worker 进程树 → 幂等写 failed result → 清锁 + abort 事件。cli abort / daemon 超时 / server DELETE 共用 */
export function abortWorker(rootId: string, path: string, summary = "aborted by user"): { pid: number | null; killed: boolean } {
  const w = readWorker(rootId, path);
  let killed = false;
  if (w && pidAlive(w.pid)) {
    try {
      if (process.platform === "win32") {
        execFileSync("taskkill", ["/PID", String(w.pid), "/T", "/F"], { windowsHide: true, timeout: 15_000, stdio: "ignore" });
      } else {
        process.kill(w.pid, "SIGKILL");
      }
      killed = true;
    } catch {
      try { process.kill(w.pid, "SIGKILL"); killed = true; } catch { /* 竞态下进程已退出 */ }
    }
  }
  // 先写 result 再清锁：任意时刻 pendingNodes 都不会把本节点判回 pending 重拉
  if (!existsSync(join(nodeDir(rootId, path), "result.json"))) {
    writeResult(rootId, path, { status: "failed", summary });
  }
  clearWorker(rootId, path);
  appendEvent(rootId, path, { kind: "abort", data: { pid: w?.pid ?? null, killed, summary } });
  return { pid: w?.pid ?? null, killed };
}

/** resume：waiting 的 result.json 归档为 result.resolved.json → 节点回到 pending（reply 时隐式触发） */
export function resolveWaiting(rootId: string, path: string): boolean {
  if (readResult(rootId, path)?.status !== "waiting") return false;
  try {
    renameSync(join(nodeDir(rootId, path), "result.json"), join(nodeDir(rootId, path), "result.resolved.json"));
    return true;
  } catch { return false; }
}

// ---- S22：回复投递三态 ----
// queue（默认）：worker 在跑 → 只写 spec.reply + reply-queued 事件（本轮结束后、下一次拉起才送达）；
//                 没有 live worker → 照旧 resume（waiting 归档 result）或仅存进 spec.reply。
// interrupt：显式打断（人操作，不是崩溃重放）——杀 worker → 删掉本次 abort 写的 failed result → 队列投递，daemon 重拉。
export type ReplyDelivery = "queued" | "resumed" | "stored" | "interrupted";

export function queueReply(
  rootId: string,
  path: string,
  text: string,
  mode: "queue" | "interrupt" = "queue",
): { node: string; resumed: boolean; delivery: ReplyDelivery; pid: number | null; at: string } {
  const spec = readSpec(rootId, path);
  if (!spec) throw new Error(`NO_NODE ${path}`);
  const at = new Date().toISOString();
  const live = workerLive(rootId, path);
  const pid = readWorker(rootId, path)?.pid ?? null;
  spec.reply = [...(spec.reply ?? []), { text, ts: at }];
  writeSpec(rootId, path, spec);
  if (live && mode === "queue") {
    appendEvent(rootId, path, { kind: "reply-queued", data: { text: text.slice(0, 500), pid, mode: "queue" } });
    return { node: spec.id, resumed: false, delivery: "queued", pid, at };
  }
  if (live && mode === "interrupt") {
    const summary = "interrupted by user (reply --mode interrupt)";
    abortWorker(rootId, path, summary);
    // 只删本次 abort 写的 result（进程中断后的"重拉"是显式人操作；崩溃重放仍按 process-bound effect 不重放）
    const r = readResult(rootId, path);
    if (r?.status === "failed" && r.summary === summary) {
      try { unlinkSync(join(nodeDir(rootId, path), "result.json")); } catch { /* 已不在则下次重拉 */ }
    }
    appendEvent(rootId, path, { kind: "reply-queued", data: { text: text.slice(0, 500), pid, mode: "interrupt" } });
    return { node: spec.id, resumed: true, delivery: "interrupted", pid, at };
  }
  const resumed = resolveWaiting(rootId, path);
  return { node: spec.id, resumed, delivery: resumed ? "resumed" : "stored", pid, at };
}

/** dep 路径归一：depends 可写兄弟 path（"root/a"）或完整节点 id（"node:<root>/root/a"） */
function depPath(rootId: string, dep: string): string {
  const prefix = `node:${rootId}/`;
  return dep.startsWith(prefix) ? dep.slice(prefix.length) : dep;
}

/** 递归列出 run 下全部节点 path（nodes/root/a 嵌套；pendingNodes/checkRun 共用一份走法）
 *  S21：artifacts / inputs / session 是节点内的数据目录，不是子节点（以前会被 check 误列成 running）
 *  S28：proposals/ 是提案目录（ev_propose 写的），同样不是子节点 */
const NODE_DATA_DIRS = new Set(["artifacts", "inputs", "session", "proposals"]);
export function listNodePaths(rootId: string): string[] {
  const nodesRoot = join(runDir(rootId), "nodes");
  if (!existsSync(nodesRoot)) return [];
  const paths: string[] = [];
  const walk = (dir: string, rel: string, depth: number): void => {
    if (depth > 6) return;
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (!ent.isDirectory() || NODE_DATA_DIRS.has(ent.name)) continue;
      const childRel = rel ? `${rel}/${ent.name}` : ent.name;
      paths.push(childRel);
      walk(join(dir, ent.name), childRel, depth + 1);
    }
  };
  walk(nodesRoot, "", 0);
  return paths;
}

/** S22 并发策略：run.json.parallel ?? spec.budget.parallel ?? AR_PARALLEL ?? 2；上限 16（防手滑写 0/负数） */
export const DEFAULT_PARALLEL = 2;
export const MAX_PARALLEL = 16;

function readRunMeta(rootId: string): RunMeta | null {
  try { return readJson<RunMeta>(join(runDir(rootId), "run.json")); } catch { return null; }
}

function clampParallel(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_PARALLEL;
  return Math.min(MAX_PARALLEL, Math.max(1, Math.floor(n)));
}

export function parallelLimit(rootId: string, spec?: SpecEnvelope | null): number {
  const fromSpec = Number((spec?.budget as { parallel?: number } | undefined)?.parallel);
  if (Number.isFinite(fromSpec) && fromSpec >= 1) return clampParallel(fromSpec);
  const fromRun = Number(readRunMeta(rootId)?.parallel);
  if (Number.isFinite(fromRun) && fromRun >= 1) return clampParallel(fromRun);
  const fromEnv = Number(process.env.AR_PARALLEL);
  if (Number.isFinite(fromEnv) && fromEnv >= 1) return clampParallel(fromEnv);
  return DEFAULT_PARALLEL;
}

/** daemon 消费的视图：待拉起节点。resumed = waiting 经人工回复后重新拉起（userMessage 追加恢复行用）
 *  S22：按 run 并发上限只放行 N 个——已 live 的 worker 也占配额，跨 daemon 重启同样成立 */
export function pendingNodes(): { rootId: string; path: string; spec: SpecEnvelope; resumed?: boolean }[] {
  runsDir();
  const out: { rootId: string; path: string; spec: SpecEnvelope; resumed?: boolean }[] = [];
  const used = new Map<string, number>();
  const take = (rootId: string): boolean => {
    const n = used.get(rootId) ?? 0;
    used.set(rootId, n + 1);
    return n;
  };
  const release = (rootId: string): void => {
    const n = used.get(rootId) ?? 0;
    if (n > 0) used.set(rootId, n - 1);
  };
  for (const rootId of readdirSync(RUNS_DIR)) {
    for (const path of listNodePaths(rootId)) {
      // worker.json 租约锁：live worker 在跑就 skip（daemon 重启也不二次拉起）；但照样占一个并发名额
      if (workerLive(rootId, path)) { take(rootId); continue; }
      const spec = readSpec(rootId, path);
      if (!spec) continue;
      // S21：死锁 + 无 result = 孤儿 → 标 failed("orphaned") 收尾，**不重放**（process-bound effect）
      if (reapOrphan(rootId, path)) continue;
      const r = readResult(rootId, path);
      // S21：续跑预算 —— 连续拉起太多次仍没有 result 就停止续跑（崩溃循环不会无限烧）
      if (!r && readAttempts(rootId, path) >= MAX_ATTEMPTS) { exhaustResume(rootId, path); continue; }
      let resumed = false;
      if (r) {
        if (r.status === "waiting") {
          if (r.wait_on?.length) {
            // S7 ev_wait join：wait_on 目标全部 done 才复活；各子摘要注进 spec.reply，worker 下轮上下文可见
            if (!r.wait_on.every((d) => readResult(rootId, depPath(rootId, d))?.status === "done")) continue;
            const ts = new Date().toISOString();
            spec.reply = [
              ...(spec.reply ?? []),
              ...r.wait_on.map((d) => ({
                text: `[系统] 子节点 ${depPath(rootId, d)}: ${readResult(rootId, depPath(rootId, d))?.summary ?? "(无摘要)"}`,
                ts,
              })),
            ];
            writeSpec(rootId, path, spec);
            if (resolveWaiting(rootId, path)) resumed = true;
            else continue;
          } else {
            // 最后一条人工回复晚于提问落盘时间 → 归档 result，视为重新 pending（绕过 reply 的直写也生效）
            const last = spec.reply?.at(-1);
            if (last && last.ts > r.finished_at && resolveWaiting(rootId, path)) resumed = true;
            else continue;   // 未回复的 waiting 挂着不动
          }
        } else continue;   // blocked / done / failed 等不再拉起
      } else if (existsSync(join(nodeDir(rootId, path), "result.resolved.json"))) {
        resumed = true;    // reply 已归档过 result，本次是恢复后的拉起
      }
      // 依赖闸门：spec.depends 列出的兄弟 path 全部 done 才拉起（dep 完成后下一轮自然满足）
      if (spec.depends?.length && spec.depends.some((d) => readResult(rootId, depPath(rootId, d))?.status !== "done")) continue;
      // 并发闸门：本 run 已占满 N 个名额就不再放行（daemon 下一轮再取）
      if (take(rootId) >= parallelLimit(rootId, spec)) { release(rootId); continue; }
      out.push({ rootId, path, spec, resumed });
    }
  }
  return out;
}

/** check：一个 Run 的状态汇总（给 evd / UI / 人工看） */
export function checkRun(rootId: string): { meta: RunMeta | null; nodes: { path: string; status: string; summary?: string }[] } {
  const meta = readJson<RunMeta>(join(runDir(rootId), "run.json"));
  const nodes = listNodePaths(rootId).map((path) => {
    const r = readResult(rootId, path);
    return { path, status: r ? r.status : "running", summary: r?.summary };
  });
  return { meta, nodes };
}

// ---- S21：fork（把一个节点复制成新 Run 的根） ----

export interface ForkResult {
  root_id: string;                                   // 新 Run
  node: string;                                      // 新节点 id（node:<新>/root）
  path: string;                                      // 新 Run 里的路径（恒为 root）
  forked_from: { root_id: string; path: string; at: string };
}

/**
 * 分叉：复制节点目录到新 Run。
 * 保留：spec（id 改写到新 run、去掉 parent、来源记 forked_from）、artifacts/ 与 inputs/（数据面成果）。
 * 不带：result / events / usage / worker / gate / checkpoint（进程面与上一轮的结论，否则新 run 一开始就是"已完成"）。
 * 也不带 session/：分叉是"换个走法重来一次"，要接着原上下文说话走 reply/resume 那条路。
 */
export function forkNode(rootId: string, path: string): ForkResult | null {
  const spec = readSpec(rootId, path);
  if (!spec) return null;
  const src = nodeDir(rootId, path);
  const forked_from = { root_id: rootId, path, at: new Date().toISOString() };
  const goalLine = String(spec.goal ?? "").split("\n")[0].slice(0, 60);
  const { rootId: newId } = createRun({ kind: "fork", subject: `分叉：${goalLine}` });
  const dst = nodeDir(newId, "root");
  mkdirSync(join(dst, "artifacts"), { recursive: true });
  const next = { ...spec, id: nodeId(newId, "root"), forked_from } as SpecEnvelope & { forked_from?: unknown };
  delete (next as { parent?: string }).parent;        // 新 run 里没有父节点，留着就是撒谎
  writeJson(join(dst, "spec.json"), next);
  for (const sub of ["artifacts", "inputs"]) {
    try { if (existsSync(join(src, sub))) cpSync(join(src, sub), join(dst, sub), { recursive: true }); }
    catch { /* 单个数据目录复制失败不阻断 fork */ }
  }
  const metaFile = join(runDir(newId), "run.json");
  const meta = readJson<RunMeta & { forked_from?: unknown }>(metaFile);
  if (meta) writeJson(metaFile, { ...meta, forked_from });
  appendFileSync(INDEX, JSON.stringify({ ts: forked_from.at, event: "fork", root_id: newId, from: rootId, node: path }) + "\n", "utf8");
  return { root_id: newId, node: nodeId(newId, "root"), path: "root", forked_from };
}

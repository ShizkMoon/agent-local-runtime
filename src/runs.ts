// runs/ 运行目录操作：唯一的运行状态源，全部纯文件
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, appendFileSync, renameSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import type { SpecEnvelope, ResultEnvelope, EventRecord } from "./envelope.ts";
import { nodeId, stableId } from "./envelope.ts";

// 空串按未设置处理：daemon 若把 AICA_STATE="" 传给 worker，STATE="" 会让 RUNS_DIR 变成相对路径
export const STATE = process.env.AICA_STATE || join(process.env.LOCALAPPDATA!, "aica", "state");
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
  const line = JSON.stringify({ ts: new Date().toISOString(), ...rec });
  appendFileSync(join(nodeDir(rootId, path), "events.jsonl"), line + "\n", "utf8");
}

export interface UsageFile {
  tokens: number;                        // 全部 turn 的 usage.totalTokens 累加
  byTurn: { i: number; tokens: number }[];
}

/** G7 spent 聚合面：stdout 转写器在 turn_end 时按 message.usage.totalTokens 累加写 usage.json */
export function addUsage(rootId: string, path: string, turn: number, tokens: number): void {
  const file = join(nodeDir(rootId, path), "usage.json");
  let cur: UsageFile;
  try { cur = readJson<UsageFile>(file) ?? { tokens: 0, byTurn: [] }; }
  catch { cur = { tokens: 0, byTurn: [] }; }
  cur.tokens += tokens;
  cur.byTurn.push({ i: turn, tokens });
  writeJson(file, cur);
}

/** ev_gate：节点目录写 gate.json（workbench inbox 投影读它），并记一条 gate 事件（尾事件 hint 即问题） */
export function writeGate(rootId: string, path: string, gate: { question: string; opts?: string[] }): void {
  writeJson(join(nodeDir(rootId, path), "gate.json"), { ...gate, ts: new Date().toISOString() });
  appendEvent(rootId, path, { kind: "gate", data: { question: gate.question } });
}

// ---- worker.json 租约锁（S3 · G29）：spawn 成功写、finish 删；pendingNodes 以它做防重入 ----
export interface WorkerInfo {
  pid: number;
  started_at: string;
  cmd: string;
}

const workerFile = (rootId: string, path: string): string => join(nodeDir(rootId, path), "worker.json");

export function writeWorker(rootId: string, path: string, info: WorkerInfo): void {
  writeJson(workerFile(rootId, path), info);
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

/** pendingNodes 防重入锁：worker.json 在且 pid 活 → true（skip）；pid 死文件在 → 删文件返回 false（按 pending 重拉，崩溃恢复） */
export function workerLive(rootId: string, path: string): boolean {
  const w = readWorker(rootId, path);
  if (!w) return false;
  if (pidAlive(w.pid)) return true;
  clearWorker(rootId, path);
  return false;
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

/** dep 路径归一：depends 可写兄弟 path（"root/a"）或完整节点 id（"node:<root>/root/a"） */
function depPath(rootId: string, dep: string): string {
  const prefix = `node:${rootId}/`;
  return dep.startsWith(prefix) ? dep.slice(prefix.length) : dep;
}

/** 递归列出 run 下全部节点 path（nodes/root/a 嵌套；pendingNodes/checkRun 共用一份走法） */
export function listNodePaths(rootId: string): string[] {
  const nodesRoot = join(runDir(rootId), "nodes");
  if (!existsSync(nodesRoot)) return [];
  const paths: string[] = [];
  const walk = (dir: string, rel: string, depth: number): void => {
    if (depth > 6) return;
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (!ent.isDirectory() || ent.name === "artifacts") continue;
      const childRel = rel ? `${rel}/${ent.name}` : ent.name;
      paths.push(childRel);
      walk(join(dir, ent.name), childRel, depth + 1);
    }
  };
  walk(nodesRoot, "", 0);
  return paths;
}

/** daemon 消费的视图：待拉起节点。resumed = waiting 经人工回复后重新拉起（userMessage 追加恢复行用） */
export function pendingNodes(): { rootId: string; path: string; spec: SpecEnvelope; resumed?: boolean }[] {
  runsDir();
  const out: { rootId: string; path: string; spec: SpecEnvelope; resumed?: boolean }[] = [];
  for (const rootId of readdirSync(RUNS_DIR)) {
    for (const path of listNodePaths(rootId)) {
      // worker.json 租约锁：live worker 在跑就 skip（daemon 重启也不二次拉起）；死锁文件已在上一步清掉
      if (workerLive(rootId, path)) continue;
      const spec = readSpec(rootId, path);
      if (!spec) continue;
      const r = readResult(rootId, path);
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

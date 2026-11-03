// runs/ 运行目录操作：唯一的运行状态源，全部纯文件
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import type { SpecEnvelope, ResultEnvelope, EventRecord } from "./envelope.ts";
import { nodeId, stableId } from "./envelope.ts";

const STATE = process.env.AICA_STATE ?? join(process.env.LOCALAPPDATA!, "aica", "state");
export const RUNS_DIR = join(STATE, "runs");
const INDEX = join(RUNS_DIR, "index.jsonl");

export function runsDir(): string {
  mkdirSync(RUNS_DIR, { recursive: true });
  return RUNS_DIR;
}

function runDir(rootId: string): string {
  return join(RUNS_DIR, rootId);
}

function nodeDir(rootId: string, path: string): string {
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
  writeJson(join(dir, "plan.v1.json"), { version: 1, created_at: meta.created_at, nodes: [] });
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

export function writeResult(rootId: string, path: string, result: Omit<ResultEnvelope, "id" | "finished_at"> & Partial<ResultEnvelope>): ResultEnvelope {
  const full: ResultEnvelope = { id: nodeId(rootId, path), finished_at: new Date().toISOString(), ...result, type: "result" };
  writeJson(join(nodeDir(rootId, path), "result.json"), full);
  appendFileSync(INDEX, JSON.stringify({ ts: full.finished_at, event: "result", root_id: rootId, node: full.id, status: full.status }) + "\n", "utf8");
  return full;
}

export function appendEvent(rootId: string, path: string, rec: Omit<EventRecord, "ts">): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...rec });
  appendFileSync(join(nodeDir(rootId, path), "events.jsonl"), line + "\n", "utf8");
}

/** daemon 消费的视图：有 spec 无 result 的节点 = 待拉起 */
export function pendingNodes(): { rootId: string; path: string; spec: SpecEnvelope }[] {
  runsDir();
  const out: { rootId: string; path: string; spec: SpecEnvelope }[] = [];
  for (const rootId of readdirSync(RUNS_DIR)) {
    const nodesRoot = join(runDir(rootId), "nodes");
    if (!existsSync(nodesRoot)) continue;
    for (const path of readdirSync(nodesRoot)) {
      const spec = readSpec(rootId, path);
      if (spec && !readResult(rootId, path)) out.push({ rootId, path, spec });
    }
  }
  return out;
}

/** check：一个 Run 的状态汇总（给 evd / UI / 人工看） */
export function checkRun(rootId: string): { meta: RunMeta | null; nodes: { path: string; status: string; summary?: string }[] } {
  const meta = readJson<RunMeta>(join(runDir(rootId), "run.json"));
  const nodesRoot = join(runDir(rootId), "nodes");
  const nodes = existsSync(nodesRoot)
    ? readdirSync(nodesRoot).map((path) => {
        const r = readResult(rootId, path);
        return { path, status: r ? r.status : "running", summary: r?.summary };
      })
    : [];
  return { meta, nodes };
}

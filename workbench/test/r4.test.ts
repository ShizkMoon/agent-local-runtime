// R4：计划卡 / 投递三态 / 设置面板的数据面
// 覆盖：RunView.profile（plan 档判定）与 parallel（设置面板只读展示）、filterProposals（自动应用列表查询）。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildView, clearViewCache, filterProposals } from "../view.ts";

const NOW = Date.parse("2026-11-04T04:00:00.000Z");
const ev = (ts: string, kind: string, data: any) => JSON.stringify({ ts, kind, data });

function mkRun(state: string, id: string, opts: { subject?: string; kind?: string; profile?: string; parallel?: number } = {}): string {
  const base = join(state, "runs", id);
  mkdirSync(join(base, "nodes", "root"), { recursive: true });
  const meta: any = { root_id: id, created_at: "2026-11-04T03:00:00.000Z", subject: opts.subject ?? id };
  if (opts.kind) meta.kind = opts.kind;
  if (typeof opts.parallel === "number") meta.parallel = opts.parallel;
  writeFileSync(join(base, "run.json"), JSON.stringify(meta));
  writeFileSync(join(base, "plan.v1.json"), JSON.stringify({ version: 1, nodes: [], coverage: [], paths: [] }));
  const spec: any = { id: `node:${id}/root`, type: "assign", goal: "拆一下计划", accept: [] };
  if (opts.profile) spec.profile = opts.profile;
  writeFileSync(join(base, "nodes", "root", "spec.json"), JSON.stringify(spec));
  writeFileSync(join(base, "nodes", "root", "events.jsonl"), ev("2026-11-04T03:00:01.000Z", "spawn", { cmd: "pi" }) + "\n");
  writeFileSync(join(base, "nodes", "root", "result.json"), JSON.stringify({
    id: `node:${id}/root`, type: "result", status: "done",
    summary: "目标：把提案页签接完。\n步骤：1) 列表 2) 详情。\n验收：测试全绿。\n风险：低。",
    finished_at: "2026-11-04T03:01:00.000Z",
  }));
  return base;
}

test("R4：根节点 profile=plan 投到 RunView.profile（计划卡的数据来源）", () => {
  const state = mkdtempSync(join(tmpdir(), "aica-r4-plan-"));
  mkRun(state, "plan-1", { profile: "plan", subject: "先出计划" });
  mkRun(state, "worker-1", { profile: "worker", subject: "直接干" });
  mkRun(state, "plain-1");
  clearViewCache();
  const v = buildView(join(state, "runs"), { now: NOW });
  const byId = new Map(v.runs.map(r => [r.id, r]));
  assert.equal(byId.get("plan-1")!.profile, "plan");
  assert.equal(byId.get("worker-1")!.profile, "worker");
  assert.equal(byId.get("plain-1")!.profile, null, "没写 profile 就是 null，不编");
  // 计划卡要的内容：summary 四段原文（不裁剪、不重排）
  assert.match(byId.get("plan-1")!.sum, /^目标：/);
  assert.match(byId.get("plan-1")!.sum, /风险：低。$/);
  rmSync(state, { recursive: true, force: true });
});

test("R4：run.json.parallel 投到 RunView.parallel（设置面板只读展示）", () => {
  const state = mkdtempSync(join(tmpdir(), "aica-r4-par-"));
  mkRun(state, "p3", { parallel: 3 });
  mkRun(state, "pnone");
  clearViewCache();
  const v = buildView(join(state, "runs"), { now: NOW });
  const byId = new Map(v.runs.map(r => [r.id, r]));
  assert.equal(byId.get("p3")!.parallel, 3);
  assert.equal(byId.get("pnone")!.parallel, null, "没写并发就是 null，UI 显示「默认」");
  rmSync(state, { recursive: true, force: true });
});

test("R4：filterProposals —— status 与 auto=1（最近自动应用列表的数据源）", () => {
  const list = [
    { slug: "a", status: "applied", auto: true, risk: "low" },
    { slug: "b", status: "applied", applied_by: "auto", risk: "low" },
    { slug: "c", status: "applied", risk: "high" },            // 手工应用的
    { slug: "d", status: "pending", auto: true, risk: "low" },
    { slug: "e", status: "rejected", auto: true, risk: "low" },
  ];
  assert.deepEqual(filterProposals(list, { status: "applied" }).map(p => p.slug), ["a", "b", "c"]);
  assert.deepEqual(filterProposals(list, { status: "applied", auto: "1" }).map(p => p.slug), ["a", "b"]);
  assert.deepEqual(filterProposals(list, { auto: "1" }).map(p => p.slug), ["a", "b", "d", "e"]);
  assert.deepEqual(filterProposals(list, {}).map(p => p.slug), ["a", "b", "c", "d", "e"]);
  assert.deepEqual(filterProposals([], { status: "applied" }), []);
  assert.deepEqual(filterProposals(null as any, { status: "applied" }), [], "非数组不炸（501/坏数据）");
});

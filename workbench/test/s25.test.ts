// S25 单元测试：工具分组统计（P4/P14）+ 节点/run 聚合状态（P5/P6）。
// 规格：docs/research/ux-synthesis.md §4 P1–P20、§6 U01–U28；PRD v3 §5.2 R1–R5。
//
// 这里只测"投影"这一层（纯函数）：聚合规则一旦错，UI 上就是"父行看不出子在等你"。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AGG_RANK, aggMax, aggOfNode, buildView, groupOfStep, groupSteps, stepStats,
  type StepView,
} from "../view.ts";

const FIXTURES = fileURLToPath(new URL("./fixtures/runs/", import.meta.url));
const NOW = Date.parse("2026-11-04T00:00:00Z");

/** 造一条 StepView（只给测试关心的字段，其余用中性值） */
function step(p: Partial<StepView> & { name: string }): StepView {
  return {
    kind: "tool", args: "", st: "ok", exit: 0, ms: null, out: [], total: 0,
    truncated: false, capped: false, ref: null, ts: "2026-01-01T00:00:00.000Z", i: 0, call_id: null,
    ...p,
  } as StepView;
}

/** 造一个最小 run 目录树（run.json + nodes/<path>/{spec,result,gate}.json） */
function mkRun(runsDir: string, id: string, nodes: { path: string; result?: any; spec?: any; gate?: any }[]): void {
  const dir = join(runsDir, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "run.json"), JSON.stringify({
    root_id: id, created_at: "2026-11-03T00:00:00Z", subject: `s25 ${id}`,
  }));
  for (const n of nodes) {
    const nd = join(dir, "nodes", ...n.path.split("/"));
    mkdirSync(nd, { recursive: true });
    writeFileSync(join(nd, "spec.json"), JSON.stringify(n.spec ?? { id: `node:${id}/${n.path}`, goal: "g" }));
    if (n.result !== undefined) writeFileSync(join(nd, "result.json"), JSON.stringify(n.result));
    if (n.gate) writeFileSync(join(nd, "gate.json"), JSON.stringify(n.gate));
  }
}

function withTmp<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "aica-s25-"));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

// ---------------------------------------------------------------- 分组（P4/P14）

test("s25.groupOfStep：命令/编辑/读取/其他四类，未知工具不猜", () => {
  assert.equal(groupOfStep(step({ name: "bash" })), "cmd");
  assert.equal(groupOfStep(step({ name: "powershell" })), "cmd");
  assert.equal(groupOfStep(step({ name: "grep" })), "read");
  assert.equal(groupOfStep(step({ name: "read" })), "read");
  assert.equal(groupOfStep(step({ name: "update a.ts", kind: "edit" })), "edit");
  assert.equal(groupOfStep(step({ name: "agent_desktop" })), "other", "未知工具归 other，不许硬塞进命令");
  assert.equal(groupOfStep(step({ name: "ev_done" })), "other");
});

test("s25.groupSteps：连续同类合并成一段，区间下标指回 steps", () => {
  const steps = [
    step({ name: "bash", ms: 120, i: 0 }),
    step({ name: "bash", ms: 80, st: "err", i: 1 }),
    step({ name: "update a.ts", kind: "edit", i: 2 }),
    step({ name: "read", i: 3 }),
    step({ name: "bash", ms: 10, i: 4 }),
  ];
  const g = groupSteps(steps);
  assert.deepEqual(g.map(x => [x.key, x.n, x.i0, x.i1]), [
    ["cmd", 2, 0, 1],
    ["edit", 1, 2, 2],
    ["read", 1, 3, 3],
    ["cmd", 1, 4, 4],
  ], "同一分类被打断就另起一段（时间顺序不许乱）");
  assert.deepEqual([g[0].ms, g[0].err], [200, 1], "组内耗时相加、失败计数");
  assert.equal(g[2].ms, null, "一条都没有 ms 时给 null，不拿 0 冒充");
});

test("s25.stepStats：组头统计跨段合计（N 命令 · M 编辑 · 耗时 · 异常）", () => {
  const steps = [
    step({ name: "bash", ms: 100 }),
    step({ name: "update a.ts", kind: "edit", ms: 40 }),
    step({ name: "bash", ms: 20 }),
    step({ name: "grep", st: "lost" }),
  ];
  const s = stepStats(steps);
  assert.deepEqual(s.by, [{ key: "cmd", n: 2 }, { key: "edit", n: 1 }, { key: "read", n: 1 }], "顺序固定为 cmd→edit→read→other");
  assert.deepEqual([s.n, s.ms, s.err, s.run], [4, 160, 1, 0]);
  assert.equal(stepStats([]).ms, null);
  assert.deepEqual(stepStats([]).by, []);
});

// ---------------------------------------------------------------- 聚合（P5/P6）

test("s25.aggOfNode：blocked 只来自人在环；等依赖/排队不占人工位", () => {
  assert.equal(aggOfNode("input"), "blocked", "未答 gate/提问 = 等你");
  assert.equal(aggOfNode("failed"), "failed");
  assert.equal(aggOfNode("done"), "done");
  assert.equal(aggOfNode("working"), "working");
  assert.equal(aggOfNode("queued"), "working", "还没交给人");
  assert.equal(aggOfNode("dep"), "working", "等上游子任务不算等你");
});

test("s25.aggMax：blocked > failed > working > done，空集合 done", () => {
  assert.equal(aggMax(["done", "working"]), "working", "done 不冒泡");
  assert.equal(aggMax(["working", "failed"]), "failed");
  assert.equal(aggMax(["failed", "blocked"]), "blocked", "等你压过失败");
  assert.equal(aggMax(["done", "done"]), "done");
  assert.equal(aggMax([]), "done");
  assert.ok(AGG_RANK.blocked > AGG_RANK.failed && AGG_RANK.failed > AGG_RANK.working);
});

test("s25.buildView：子节点在等审批 → run 行是 blocked（父行必须看得出在等你）", () => {
  withTmp(dir => {
    mkRun(dir, "blocked-case", [
      { path: "root", result: { status: "done", summary: "拆分完成" } },
      {
        path: "root/deploy", result: { status: "waiting", summary: "等你批准 rm -rf build" },
        gate: { question: "允许执行 rm -rf build 吗？", opts: ["同意", "拒绝"] },
      },
    ]);
    const run = buildView(dir, { now: NOW }).runs[0];
    assert.equal(run.agg, "blocked");
    assert.equal(run.agg_n, 1);
    assert.equal(run.tree.find(n => n.path === "root/deploy")!.agg, "blocked");
    assert.equal(run.status, "input", "旧字段保持兼容");
  });
});

test("s25.buildView：等依赖的节点让 run 保持 working，不是 blocked", () => {
  withTmp(dir => {
    mkRun(dir, "dep-case", [
      { path: "root", result: { status: "done", summary: "拆分完成" } },
      { path: "root/a", result: { status: "waiting", summary: "等 b 完成", wait_on: ["root/b"] } },
    ]);
    const run = buildView(dir, { now: NOW }).runs[0];
    assert.equal(run.tree.find(n => n.path === "root/a")!.st, "dep");
    assert.equal(run.tree.find(n => n.path === "root/a")!.agg, "working", "等依赖不占人工位");
    assert.equal(run.agg, "working", "没有人等你 → 父行不许喊「等你」");
    assert.equal(run.agg_n, 1);
  });
});

test("s25.buildView：根已完成、子节点还没跑 → run 不是 done（done 不冒泡）", () => {
  withTmp(dir => {
    mkRun(dir, "done-root", [
      { path: "root", result: { status: "done", summary: "已拆分" } },
      { path: "root/later", spec: { goal: "还没开始" } },   // 无 result.json → queued
    ]);
    const run = buildView(dir, { now: NOW }).runs[0];
    assert.equal(run.agg, "working");
    assert.equal(run.agg_n, 1);
  });
});

test("s25.buildView：全部节点完成才给 done；两个失败节点计数为 2", () => {
  withTmp(dir => {
    mkRun(dir, "all-done", [
      { path: "root", result: { status: "done", summary: "ok" } },
      { path: "root/a", result: { status: "done", summary: "ok" } },
    ]);
    mkRun(dir, "two-failed", [
      { path: "root", result: { status: "done", summary: "ok" } },
      { path: "root/a", result: { status: "failed", summary: "挂了" } },
      { path: "root/b", result: { status: "failed", summary: "也挂了" } },
    ]);
    const view = buildView(dir, { now: NOW });
    const done = view.runs.find(r => r.id === "all-done")!;
    const two = view.runs.find(r => r.id === "two-failed")!;
    assert.deepEqual([done.agg, done.agg_n], ["done", 2]);
    assert.deepEqual([two.agg, two.agg_n], ["failed", 2]);
  });
});

test("s25.buildView：未答审批（gate-req.json）也算 blocked —— 卡在 gate 里的节点没有 result.json", () => {
  withTmp(dir => {
    mkRun(dir, "approval-case", [
      { path: "root", result: { status: "done", summary: "拆分完成" } },
      { path: "root/deploy", spec: { goal: "rm -rf build/" } },   // 没有 result.json：worker 卡在 gate 里
    ]);
    const nodeDir = join(dir, "approval-case", "nodes", "root", "deploy");
    writeFileSync(join(nodeDir, "gate-req.json"),
      JSON.stringify({ call_id: "g1", tool: "bash", target: "rm -rf build/", opts: [] }));

    const v1 = buildView(dir, { now: Date.now() });
    assert.equal(v1.runs[0].agg, "blocked", "有未答审批 → 父行必须是等你");
    assert.equal(v1.runs[0].agg_n, 1);
    assert.equal(v1.runs[0].tree.find(n => n.path === "root/deploy")!.agg, "blocked");
    assert.equal(v1.runs[0].tree.find(n => n.path === "root/deploy")!.wb, "person:answer", "等的是人");

    /* 答过之后（gate-ans 比 req 新）就不是 blocked 了：旧答案不许把新请求解锁（S19 契约） */
    const ansFile = join(nodeDir, "gate-ans.json");
    writeFileSync(ansFile, JSON.stringify({ decision: "allowed-once" }));
    const later = new Date(Date.now() + 2000);
    utimesSync(ansFile, later, later);
    assert.notEqual(buildView(dir, { now: Date.now() }).runs[0].agg, "blocked");
  });
});

// ---------------------------------------------------------------- 真实夹具

test("s25.buildView：真实夹具的聚合与分组（三个 run 各一档）", () => {
  const view = buildView(FIXTURES, { now: NOW });
  const by = (id: string) => view.runs.find(r => r.id === id)!;
  assert.equal(by("372ce026-be1f").agg, "done");
  assert.equal(by("wb-fixture-demo1").agg, "failed");
  assert.equal(by("ef2706d6-2a3c").agg, "working", "还没派节点 = 还没开始，不是 done");
});

test("s25.buildView：run.groups/stats 覆盖根节点 steps（S17 时间线的统计来源）", () => {
  const view = buildView(FIXTURES, { now: NOW });
  const real = view.runs.find(r => r.id === "372ce026-be1f")!;
  assert.equal(real.steps.length, 2);
  assert.equal(real.stats.n, 2);
  assert.equal(real.stats.err, 0);
  assert.deepEqual(real.groups.map(g => [g.key, g.n]), [["other", 2]], "agent_desktop/ev_done 归 other，不冒充命令");
  const demo = view.runs.find(r => r.id === "wb-fixture-demo1")!;
  assert.deepEqual([demo.steps.length, demo.stats.n, demo.groups.length], [0, 0, 0], "根节点没有工具时不占位");
});

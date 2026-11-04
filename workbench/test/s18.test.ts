// S18/S23/S26 验收：diff 聚合、计划条、裁决强度、审计对、mtime 缓存。
import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const V = await import("../view.ts");
const { diffsOf, planOf, severityOf, sevMax, auditsOf, buildView, clearViewCache, viewCacheStats } = V;

const NOW = Date.parse("2026-11-04T12:00:00.000Z");
const PATCH = [
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,3 +1,4 @@",
  " const a = 1;",
  "-const b = 2;",
  "+const b = 3;",
  "+const c = 4;",
  " export { a, b };",
].join("\n");

const ev = (ts: string, kind: string, data: any) => ({ ts, kind, data });

// ---------------------------------------------------------------- S18 diff

test("diffs：file_edit 聚合出 file/add/del/hunks/patch", () => {
  const d = diffsOf([
    { i: 0, ev: ev("2026-11-04T00:00:01Z", "file_edit", { path: "src/app.ts", kind: "edit", plus: 2, minus: 1, diff: PATCH }) },
  ]);
  assert.equal(d.length, 1);
  assert.deepEqual({ file: d[0].file, add: d[0].add, del: d[0].del, hunks: d[0].hunks }, { file: "src/app.ts", add: 2, del: 1, hunks: 1 });
  assert.ok(Array.isArray(d[0].patch) && d[0].patch!.length === 8);
  assert.equal(d[0].total, 8);
  assert.equal(d[0].truncated, false);
});

test("diffs：拿不到 patch 时只给文件级统计，不编造行内容", () => {
  const d = diffsOf([
    { i: 0, ev: ev("T", "file_edit", { path: "notes.md", plus: 3, minus: 0, preview: "把标题改成 A" }) },
  ]);
  assert.equal(d[0].add, 3);
  assert.equal(d[0].del, 0);
  assert.equal(d[0].patch, null);
  assert.equal(d[0].hunks, 0);
  assert.equal(d[0].total, 0);
  assert.equal(d[0].truncated, false);
});

test("diffs：同一文件多次编辑聚合；超过 60 行标 truncated 且 total 是真实行数", () => {
  const big = ["--- a/big.ts", "+++ b/big.ts", "@@ -1,1 +1,80 @@", ...Array.from({ length: 80 }, (_, i) => `+line ${i}`)].join("\n");
  const d = diffsOf([
    { i: 0, ev: ev("T1", "file_edit", { path: "big.ts", plus: 80, minus: 0, diff: big }) },
    { i: 1, ev: ev("T2", "file_edit", { path: "big.ts", plus: 5, minus: 2, diff: PATCH }) },
    { i: 2, ev: ev("T3", "file_edit", { path: "other.ts", plus: 1, minus: 1 }) },
  ]);
  assert.equal(d.length, 2, "两个文件各一条");
  assert.equal(d[0].file, "big.ts");
  assert.equal(d[0].add, 85);
  assert.equal(d[0].del, 2);           // 行数只认事件自报的 plus/minus，不从 patch 正文里数（避免两处打架）
  assert.equal(d[0].hunks, 2);
  assert.equal(d[0].patch!.length, V.DIFF_PATCH_LINES, "patch 只留前 60 行");
  assert.equal(d[0].total, 83 + 8);
  assert.equal(d[0].truncated, true, "截断必须自证");
  assert.equal(d[1].patch, null);
});

// ---------------------------------------------------------------- S23 plan / severity

test("plan：ev_todo 事件 → items 与 current；全完成 current=null；没有计划=null", () => {
  const p = planOf([
    { i: 0, ev: ev("T1", "todo", { items: [{ text: "读代码", done: true }, { text: "写测试", done: false }, { text: "提交", done: false }] }) },
  ]);
  assert.deepEqual(p, { items: [{ text: "读代码", done: true }, { text: "写测试", done: false }, { text: "提交", done: false }], current: 1 });

  const done = planOf([{ i: 0, ev: ev("T1", "todo", { items: [{ text: "a", done: true }] }) }]);
  assert.equal(done!.current, null);

  assert.equal(planOf([]), null);
  assert.equal(planOf([{ i: 0, ev: ev("T1", "todo", { items: [] }) }]), null);
  // 没有事件时回落 todo.json
  assert.deepEqual(planOf([], { items: [{ text: "从文件来", done: false }] })!.items, [{ text: "从文件来", done: false }]);
});

test("severity：reviewer 的 result.output.severity 投影，run 级取最重", () => {
  assert.equal(severityOf({ output: { severity: "warn" } }), "warn");
  assert.equal(severityOf({ severity: "block" }), "block");
  assert.equal(severityOf({ output: { severity: "啥" } }), null, "闭集外的不认");
  assert.equal(severityOf(null), null);
  assert.equal(sevMax(["note", null, "block", "warn"]), "block");
  assert.equal(sevMax([null, null]), null);
});

// ---------------------------------------------------------------- S26 审计对

test("audits：问一次答一次配成对；问了没答的留 decision=null", () => {
  const a = auditsOf([
    { i: 0, ev: ev("2026-11-04T00:00:00.000Z", "gate", { question: "能跑 npm test 吗？" }) },
    { i: 1, ev: ev("2026-11-04T00:00:02.500Z", "approve_decide", { decision: "allowed-once" }) },
    { i: 2, ev: ev("2026-11-04T00:01:00.000Z", "gate", { question: "删掉 dist 吗？" }) },
  ], "root");
  assert.equal(a.length, 2);
  assert.equal(a[0].question, "能跑 npm test 吗？");
  assert.equal(a[0].decision, "allowed-once");
  assert.equal(a[0].ms, 2500, "决策耗时给的是真数字");
  assert.equal(a[0].node, "root");
  assert.equal(a[1].decision, null, "没人答就不许写成已裁决");
  assert.equal(a[1].asked_at, "2026-11-04T00:01:00.000Z");
});

// ---------------------------------------------------------------- S26 mtime 缓存

function mkRun(state: string, id: string, opts: { events?: any[]; result?: any } = {}): string {
  const dir = join(state, "runs", id, "nodes", "root");
  mkdirSync(join(dir, "artifacts"), { recursive: true });
  writeFileSync(join(state, "runs", id, "run.json"), JSON.stringify({ root_id: id, created_at: "2026-11-04T00:00:00.000Z", subject: id, plan_version: 1 }) + "\n", "utf8");
  writeFileSync(join(dir, "spec.json"), JSON.stringify({ id: `node:${id}/root`, type: "assign", goal: "做点事", accept: ["x"] }) + "\n", "utf8");
  writeFileSync(join(dir, "events.jsonl"), (opts.events ?? []).map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
  if (opts.result) writeFileSync(join(dir, "result.json"), JSON.stringify({ id: `node:${id}/root`, type: "result", ...opts.result }) + "\n", "utf8");
  return dir;
}

test("缓存：同一份磁盘真相第二次命中缓存；磁盘一变就重新投影", () => {
  const state = mkdtempSync(join(tmpdir(), "aica-s18-"));
  const dir = mkRun(state, "cache-1", {
    events: [
      ev("2026-11-04T00:00:01Z", "spawn", { cmd: "x" }),
      ev("2026-11-04T00:00:02Z", "file_edit", { path: "a.ts", plus: 1, minus: 0, diff: PATCH }),
    ],
    result: { status: "done", summary: "做完了", finished_at: "2026-11-04T00:00:03Z" },
  });
  clearViewCache();
  const v1 = buildView(join(state, "runs"), { now: NOW });
  const s1 = viewCacheStats();
  const v2 = buildView(join(state, "runs"), { now: NOW });
  const s2 = viewCacheStats();
  assert.deepEqual(v2, v1, "缓存命中时两次投影必须完全一致");
  assert.equal(s2.hits, s1.hits + 1, "第二次应该命中缓存");
  assert.equal(v1.runs[0].diffs.length, 1);
  assert.equal(v1.runs[0].diffs[0].file, "a.ts");

  // 磁盘变了（追加一次编辑）→ 指纹变 → 重新投影
  appendFileSync(join(dir, "events.jsonl"), JSON.stringify(ev("2026-11-04T00:00:04Z", "file_edit", { path: "b.ts", plus: 2, minus: 2 })) + "\n", "utf8");
  const v3 = buildView(join(state, "runs"), { now: NOW });
  const s3 = viewCacheStats();
  assert.equal(s3.misses, s2.misses + 1, "磁盘变了必须重新算");
  assert.equal(v3.runs[0].diffs.length, 2, "新文件出现在投影里");
});

test("buildView：run 级 plan / sev / audits 从节点投影汇总", () => {
  const state = mkdtempSync(join(tmpdir(), "aica-s18b-"));
  mkRun(state, "agg-1", {
    events: [
      ev("2026-11-04T00:00:01Z", "todo", { items: [{ text: "第一步", done: true }, { text: "第二步", done: false }] }),
      ev("2026-11-04T00:00:02Z", "gate", { question: "继续吗？" }),
      ev("2026-11-04T00:00:03Z", "approve_decide", { decision: "rejected" }),
    ],
    result: { status: "done", summary: "收工", finished_at: "2026-11-04T00:00:04Z", output: { severity: "warn" } },
  });
  clearViewCache();
  const v = buildView(join(state, "runs"), { now: NOW });
  const r = v.runs[0];
  assert.equal(r.plan!.items.length, 2);
  assert.equal(r.plan!.current, 1);
  assert.equal(r.sev, "warn");
  assert.equal(r.audits.length, 1);
  assert.equal(r.audits[0].decision, "rejected");
});

// R3：提案页签 / 子代理页签 / 左栏测试分组 / inbox 提案卡的数据面
// 覆盖：run.json.kind 与 test_like（分组判据）、proposalDetail 四件套、mergeProposal 的权威顺序、
//       kind=proposal 事件 → inbox 提案卡。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildView, clearViewCache, isTestLike, mergeProposal, proposalDetail } from "../view.ts";

const NOW = Date.parse("2026-11-04T04:00:00.000Z");
const ev = (ts: string, kind: string, data: any) => JSON.stringify({ ts, kind, data });

function mkRun(state: string, id: string, opts: { subject?: string; kind?: string; events?: string[] } = {}): string {
  const base = join(state, "runs", id);
  mkdirSync(join(base, "nodes", "root"), { recursive: true });
  const meta: any = { root_id: id, created_at: "2026-11-04T03:00:00.000Z", subject: opts.subject ?? id };
  if (opts.kind) meta.kind = opts.kind;
  writeFileSync(join(base, "run.json"), JSON.stringify(meta));
  writeFileSync(join(base, "plan.v1.json"), JSON.stringify({ version: 1, nodes: [], coverage: [], paths: [] }));
  writeFileSync(join(base, "nodes", "root", "spec.json"), JSON.stringify({ id: `node:${id}/root`, type: "assign", goal: "跑一件事", accept: [] }));
  const lines = [ev("2026-11-04T03:00:01.000Z", "spawn", { cmd: "pi" }), ...(opts.events ?? [])];
  writeFileSync(join(base, "nodes", "root", "events.jsonl"), lines.join("\n") + "\n");
  writeFileSync(join(base, "nodes", "root", "result.json"), JSON.stringify({
    id: `node:${id}/root`, type: "result", status: "done", summary: "做完了", finished_at: "2026-11-04T03:01:00.000Z",
  }));
  return base;
}

function mkProposal(root: string, slug: string, opts: { patchFile?: string; risk?: string; status?: string; md?: string } = {}): string {
  const dir = join(root, slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "proposal.md"), opts.md ?? "# 动机\n减少重复\n");
  writeFileSync(join(dir, opts.patchFile ?? "patch.diff"), "--- a/x.ts\n+++ b/x.ts\n@@ -1,2 +1,3 @@\n-a\n+b\n+c\n");
  writeFileSync(join(dir, "verify.json"), JSON.stringify({ cmd: "node --test" }));
  writeFileSync(join(dir, "meta.json"), JSON.stringify({ slug, risk: opts.risk ?? "low", status: opts.status ?? "pending" }));
  return dir;
}

test("R3：run.json.kind 投到 RunView.kind（左栏「测试」分组的数据来源）", () => {
  const state = mkdtempSync(join(tmpdir(), "aica-r3-kind-"));
  mkRun(state, "task-1", { kind: "task" });
  mkRun(state, "smoke-1", { kind: "test", subject: "smoke-1 冒烟" });
  clearViewCache();
  const v = buildView(join(state, "runs"), { now: NOW });
  const byId = new Map(v.runs.map(r => [r.id, r]));
  assert.equal(byId.get("task-1")!.kind, "task");
  assert.equal(byId.get("smoke-1")!.kind, "test");
  rmSync(state, { recursive: true, force: true });
});

test("R3：run.json 没有 kind 时是 null —— 不编造分组信息", () => {
  const state = mkdtempSync(join(tmpdir(), "aica-r3-kindnull-"));
  mkRun(state, "plain-1");
  clearViewCache();
  const v = buildView(join(state, "runs"), { now: NOW });
  assert.equal(v.runs[0].kind, null);
  assert.equal(v.runs[0].test_like, false, "普通任务不进「测试」分组");
  rmSync(state, { recursive: true, force: true });
});

test("R3：test_like 判据放宽 —— smoke 空格写法 / test 前缀 / kind=test 都算，正文里的 smoke 不算", () => {
  // 纯判据（UI 与 view 共用同一正则）
  assert.equal(isTestLike("smoke test 1587:57"), true, "冒号时间戳的旧标题也要归组");
  assert.equal(isTestLike("smoke-1 冒烟"), true);
  assert.equal(isTestLike("smoke_1"), true);
  assert.equal(isTestLike("test-projection"), true);
  assert.equal(isTestLike("Test 12"), true);
  assert.equal(isTestLike("把 smoke 接到左栏"), false, "只有前缀才算，别误伤正文");
  assert.equal(isTestLike("smokey thing"), false);
  assert.equal(isTestLike("", "test"), true, "kind=test 无条件归组");
  assert.equal(isTestLike("普通任务", "task"), false);

  const state = mkdtempSync(join(tmpdir(), "aica-r3-testlike-"));
  mkRun(state, "t1", { subject: "smoke test 1587:57" });
  mkRun(state, "t2", { subject: "验收：把 smoke 接到左栏" });
  mkRun(state, "t3", { subject: "随便", kind: "test" });
  clearViewCache();
  const v = buildView(join(state, "runs"), { now: NOW });
  const byId = new Map(v.runs.map(r => [r.id, r]));
  assert.equal(byId.get("t1")!.test_like, true);
  assert.equal(byId.get("t2")!.test_like, false);
  assert.equal(byId.get("t3")!.test_like, true);
  rmSync(state, { recursive: true, force: true });
});

test("R3：proposalDetail 读 proposal.md / patch.diff / verify.json / meta.json", () => {
  const root = mkdtempSync(join(tmpdir(), "aica-r3-prop-"));
  const dir = mkProposal(root, "prop-one", { risk: "high", md: "# 动机\n把重复逻辑抽掉\n" });
  const p = proposalDetail(dir)!;
  assert.equal(p.slug, "prop-one");
  assert.equal(p.risk, "high");
  assert.equal(p.status, "pending", "meta 没写 status 时缺省 pending");
  assert.equal(p.verify_cmd, "node --test");
  assert.match(p.proposal, /把重复逻辑抽掉/);
  assert.match(p.patch, /^\+b$/m, "patch.diff 原文原样给出（UI 自己接 diff 组件）");
  assert.match(p.patch, /^\+c$/m);

  // 目录不存在 → null（不是空对象）
  assert.equal(proposalDetail(join(root, "nope")), null);
  rmSync(root, { recursive: true, force: true });
});

test("R3：patch.diff 优先，change.patch 兼容（S28 写的是 patch.diff）", () => {
  const root = mkdtempSync(join(tmpdir(), "aica-r3-patch-"));
  // 只写 patch.diff（S28 的真实文件名）→ 必须读到正文
  const onlyNew = mkProposal(root, "prop-new");
  const a = proposalDetail(onlyNew)!;
  assert.match(a.patch, /^\+b$/m, "patch.diff 必须被读到（origin bug：只读 change.patch 导致补丁区永远空）");
  // 只写 change.patch（早期命名）→ 仍然兼容
  const onlyOld = join(root, "prop-old");
  mkdirSync(onlyOld, { recursive: true });
  writeFileSync(join(onlyOld, "meta.json"), JSON.stringify({ slug: "prop-old" }));
  writeFileSync(join(onlyOld, "change.patch"), "--- a/y\n+++ b/y\n@@ -1 +1 @@\n-x\n+y\n");
  const b = proposalDetail(onlyOld)!;
  assert.match(b.patch, /^\+y$/m, "旧文件名兜底");
  // 两个都在 → patch.diff 优先
  const both = mkProposal(root, "prop-both");
  writeFileSync(join(both, "change.patch"), "--- a/z\n+++ b/z\n@@ -1 +1 @@\n-zz\n+zz2\n");
  const c = proposalDetail(both)!;
  assert.match(c.patch, /^\+b$/m);
  assert.doesNotMatch(c.patch, /\+zz2/, "两个都在时不许用 change.patch 覆盖 patch.diff");
  rmSync(root, { recursive: true, force: true });
});

test("R3：mergeProposal —— 列表项（listProposals）是 status/risk 的权威，meta.json 只兜底", () => {
  const root = mkdtempSync(join(tmpdir(), "aica-r3-merge-"));
  const dir = mkProposal(root, "prop-x", { risk: "low", status: "pending", md: "# x\n摘要行\n" });
  const d = proposalDetail(dir)!;
  // 模拟：meta.json 说 pending，但模块按 rejected.json 算出 rejected
  const merged = mergeProposal(d, { slug: "prop-x", risk: "high", status: "rejected", dir, files: 1 })!;
  assert.equal(merged.status, "rejected", "列表项状态必须赢（防止再犯：详情用 meta.status 覆盖）");
  assert.equal(merged.risk, "high", "风险同理");
  assert.equal(merged.proposal, d.proposal, "正文来自 proposalDetail");
  assert.match(merged.patch, /^\+b$/m, "patch 来自 proposalDetail");
  assert.equal(mergeProposal(null, { slug: "x" }), null);
  rmSync(root, { recursive: true, force: true });
});

test("R3：kind=proposal 事件 → inbox 提案卡（title/risk/摘要，跳转靠 prop.slug）", () => {
  const state = mkdtempSync(join(tmpdir(), "aica-r3-inbox-"));
  const pdir = mkProposal(join(state, "proposals"), "prop-inbox", { risk: "high", md: "# 动机\n把重复逻辑抽掉\n" });
  mkRun(state, "run-1", {
    subject: "做一件会提提案的事",
    events: [ev("2026-11-04T03:00:30.000Z", "proposal", { ok: true, slug: "prop-inbox", dir: pdir, risk: "high", registered: true })],
  });
  clearViewCache();
  const v = buildView(join(state, "runs"), { now: NOW });
  const card = v.inbox.find(i => i.kind === "proposal")!;
  assert.ok(card, "提案事件必须变成 inbox 卡片（§9.5 闭环）");
  assert.equal(card.id, "proposal:prop-inbox");
  assert.equal(card.t, "提案：prop-inbox");
  assert.equal(card.prop!.slug, "prop-inbox");
  assert.equal(card.prop!.risk, "high");
  assert.equal(card.d, "把重复逻辑抽掉", "摘要 = proposal.md 第一条非标题行");
  assert.ok(card.crumb.length >= 2, "面包屑带 run + 节点");

  // 已 rejected 的提案不再打扰
  writeFileSync(join(pdir, "rejected.json"), JSON.stringify({ rejected_at: "2026-11-04T03:59:00.000Z" }));
  clearViewCache();
  const v2 = buildView(join(state, "runs"), { now: NOW });
  assert.equal(v2.inbox.filter(i => i.kind === "proposal").length, 0, "处理过的提案不该继续占卡位");
  rmSync(state, { recursive: true, force: true });
});

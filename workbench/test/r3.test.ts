// R3：提案页签 / 子代理页签 / 左栏测试分组的数据面
// 覆盖：run.json.kind → RunView.kind（分组依据）、proposalDetail 的四件套读取与缺失语义。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildView, clearViewCache, proposalDetail } from "../view.ts";

const NOW = Date.parse("2026-11-04T04:00:00.000Z");
const ev = (ts: string, kind: string, data: any) => JSON.stringify({ ts, kind, data });

function mkRun(state: string, id: string, opts: { subject?: string; kind?: string } = {}): string {
  const base = join(state, "runs", id);
  mkdirSync(join(base, "nodes", "root"), { recursive: true });
  const meta: any = { root_id: id, created_at: "2026-11-04T03:00:00.000Z", subject: opts.subject ?? id };
  if (opts.kind) meta.kind = opts.kind;
  writeFileSync(join(base, "run.json"), JSON.stringify(meta));
  writeFileSync(join(base, "plan.v1.json"), JSON.stringify({ version: 1, nodes: [], coverage: [], paths: [] }));
  writeFileSync(join(base, "nodes", "root", "spec.json"), JSON.stringify({ id: `node:${id}/root`, type: "assign", goal: "跑一件事", accept: [] }));
  writeFileSync(join(base, "nodes", "root", "events.jsonl"), [ev("2026-11-04T03:00:01.000Z", "spawn", { cmd: "pi" })].join("\n") + "\n");
  writeFileSync(join(base, "nodes", "root", "result.json"), JSON.stringify({
    id: `node:${id}/root`, type: "result", status: "done", summary: "做完了", finished_at: "2026-11-04T03:01:00.000Z",
  }));
  return base;
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
  rmSync(state, { recursive: true, force: true });
});

test("R3：proposalDetail 读 proposal.md / change.patch / verify.json / meta.json", () => {
  const root = mkdtempSync(join(tmpdir(), "aica-r3-prop-"));
  const dir = join(root, "prop-one");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "proposal.md"), "# 动机\n把重复逻辑抽掉\n");
  writeFileSync(join(dir, "change.patch"), "--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1,2 +1,3 @@\n-a\n+b\n+c\n");
  writeFileSync(join(dir, "verify.json"), JSON.stringify({ cmd: "node --test workbench/test" }));
  writeFileSync(join(dir, "meta.json"), JSON.stringify({ slug: "prop-one", risk: "high", created_at: "2026-11-04T03:00:00.000Z" }));

  const p = proposalDetail(dir)!;
  assert.equal(p.slug, "prop-one");
  assert.equal(p.risk, "high");
  assert.equal(p.status, "pending", "meta 没写 status 时缺省 pending");
  assert.equal(p.verify_cmd, "node --test workbench/test");
  assert.match(p.proposal, /把重复逻辑抽掉/);
  assert.match(p.patch, /^\+b$/m, "patch 原文原样给出（UI 自己接 diff 组件）");
  assert.equal(p.created_at, "2026-11-04T03:00:00.000Z");

  // 目录不存在 → null（不是空对象）
  assert.equal(proposalDetail(join(root, "nope")), null);
  rmSync(root, { recursive: true, force: true });
});

test("R3：提案缺文件时留空但不炸（proposal.md / verify.json 缺失）", () => {
  const root = mkdtempSync(join(tmpdir(), "aica-r3-prop2-"));
  const dir = join(root, "prop-bare");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "meta.json"), JSON.stringify({ slug: "prop-bare", risk: "low" }));
  writeFileSync(join(dir, "change.patch"), "");
  const p = proposalDetail(dir)!;
  assert.equal(p.slug, "prop-bare");
  assert.equal(p.proposal, "", "没有 proposal.md 就是空串，不编内容");
  assert.equal(p.verify_cmd, null, "没有 verify.json 就是 null");
  assert.equal(p.patch, "");
  rmSync(root, { recursive: true, force: true });
});

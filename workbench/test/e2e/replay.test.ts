// S27 · 录制回放（G-2 地基 / G-6 数据面）
// 夹具是**真跑出来的磁盘真相**（见 fixtures/*/case.json 的 note），这里把它按原顺序喂给产品自己的
// 投影：workbench/view.ts 的 buildView、src/transcribe.ts 的 turnUsage/recordTurnUsage。
// 断言两件事：①投影可重放且稳定（快照只钉语义字段，时间/绝对路径归一）；
//           ②转写器回放后能得到与录制时相同的用量账本（不 mock）。
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { digestOf, matchSnapshot, readCase, replayTranscribe, replayView } from "./lib/replay.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "fixtures");
const SNAP = join(HERE, "snapshots");

const CASES = readdirSync(FIX, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

test("G-6/夹具：每个 case 都有 case.json + events.jsonl + spec.json（缺一个就是坏夹具）", () => {
  assert.ok(CASES.length >= 5, `夹具太少：${CASES.join(", ")}`);
  for (const c of CASES) {
    const dir = join(FIX, c);
    assert.ok(existsSync(join(dir, "case.json")), `${c}: 缺 case.json`);
    assert.ok(existsSync(join(dir, "events.jsonl")), `${c}: 缺 events.jsonl`);
    assert.ok(existsSync(join(dir, "spec.json")), `${c}: 缺 spec.json`);
    const k = readCase(dir);
    assert.equal(k.runId, k.runId.replace(/[^A-Za-z0-9._-]/g, ""), `${c}: runId 必须是 okId`);
  }
});

for (const name of CASES) {
  test(`replay:${name} 投影稳定（归一化快照）`, () => {
    const { case: c, view, run, dirs } = replayView(join(FIX, name));
    assert.ok(run, `buildView 没有投影出 run ${c.runId}`);
    assert.equal(run.id, c.runId);
    assert.equal(run.title, c.subject, "run 标题取 run.json.subject");
    const digest = JSON.stringify(digestOf(view, { runsDir: dirs.runsDir }), null, 1);
    const r = matchSnapshot(SNAP, name, digest);
    if (!r.created) {
      assert.equal(digest, r.want, `快照不一致：${r.file}\n（确认改动符合预期后：$env:UPDATE_SNAPSHOTS='1'; node --test workbench/test/e2e）`);
    }
  });

  test(`replay:${name} 同一磁盘真相两次构建完全一致（纯函数）`, () => {
    const a = replayView(join(FIX, name));
    const b = replayView(join(FIX, name));
    assert.deepEqual(digestOf(a.view, { runsDir: a.dirs.runsDir }), digestOf(b.view, { runsDir: b.dirs.runsDir }));
  });

  test(`replay:${name} 转写器可重放（stdout.log → usage 账本）`, (t) => {
    const r = replayTranscribe(join(FIX, name));
    if (!r) {
      t.skip("该夹具没有 stdout.log / usage.json（审批态夹具，转写器无输入）");
      return;
    }
    assert.ok(r.turns > 0, `stdout.log 里没有可解析的 turn_end：${name}`);
    assert.equal(r.tokens, r.fixtureTokens, `回放出的 tokens 与录制账本不一致（重放 ${r.tokens} vs 录制 ${r.fixtureTokens}）`);
    assert.equal(r.ledger.turns.length, r.fixture.turns.length, "turn 条数不一致");
    assert.deepEqual(r.ledger.byTurn, r.fixture.byTurn, "byTurn 不一致");
    assert.deepEqual(r.ledger.total, r.fixture.total, "分项合计不一致");
  });
}

// ---- 每个夹具的语义断言：快照之外再说一遍"这条真相是什么意思" ----

test("replay:real-turn —— 真实一轮：done + 工具步骤 + 产物 + 结论可回溯", () => {
  const { view, run, case: c } = replayView(join(FIX, "real-turn"));
  assert.equal(run.status, "done");
  assert.equal(run.turn.state, "completed");
  assert.ok(run.steps.length >= 3, `根节点应有 ≥3 条工具步骤，实际 ${run.steps.length}`);
  assert.ok(run.steps.every((s) => typeof s.i === "number" && s.i >= 0), "每条 step 必须带 events.jsonl 行号（Q2 可回溯）");
  assert.ok(run.arts.length >= 1, "artifacts/ 里的产物必须进投影");
  assert.equal(run.tree.length, 0, "该 run 只有 root 节点，tree 里不该有子节点");
  assert.ok(run.sum.length > 0, "结论不能空");
  assert.equal(c.nodePath, "root");
  assert.ok(view.settled.some(([title, , id]) => id === c.runId && title === c.subject), "done 的 run 必须进 settled");
});

test("replay:budget-abort —— 预算拦截：failed + reason=budget exceeded + spent 已落账（G-5）", () => {
  const { run } = replayView(join(FIX, "budget-abort"));
  assert.equal(run.status, "failed");
  // run 级结局：失败节点优先（R4）。节点内部有 abort 事件（cancelled），但 run 行不许说"完成/取消"
  assert.equal(run.turn.state, "failed", "失败 run 的结局行必须是 failed");
  assert.match(String(run.turn.reason), /budget exceeded|预算/, "结局行必须说清是预算拦的");
  assert.ok(typeof run.spent === "number" && run.spent > 0, `spent 必须落账（实际 ${run.spent}）`);
  assert.equal(run.spent, 1915, "录制时 usage.json 记的 1915 tokens");
});

test("replay:compaction —— 压缩三事件合成为一条可显示的记录（A8）", () => {
  const { run } = replayView(join(FIX, "compaction"));
  assert.equal(run.compactions.length, 1, "三个 compaction 事件只应合成一条");
  const c = run.compactions[0];
  assert.ok(typeof c.before_tokens === "number" || c.before_tokens === null, "before_tokens 必须是数字或 null（不许编）");
});

test("replay:approval-wait —— worker 卡在审批里：没有 result，但聚合状态是「等你」", () => {
  const { view, run, case: c } = replayView(join(FIX, "approval-wait"));
  // 这条通道（gate-req）不是 ev_gate 的 inbox 卡：节点没有 result，视图状态是 queued，
  // 但 pendingApproval=true 让它聚合为 blocked —— 人这边它就是"等你"。
  assert.equal(run.agg, "blocked", "未答 gate-req 必须聚合为 blocked（P5）");
  assert.equal(view.inbox.filter((i) => (i.id as string).includes(c.runId)).length, 0, "gate-req 走 /api/approvals，不占 view.inbox");
  const audits = run.audits ?? [];
  assert.ok(audits.length >= 1, "审批要留下审计记录（问了什么）");
  assert.equal(audits[0].decision, null, "没人答的审批：decision 必须是 null，不许写成已完成");
});

test("replay:gate-question —— ev_gate 提问通道：waiting + 一问多选，进 inbox", () => {
  const { view, run, case: c } = replayView(join(FIX, "gate-question"));
  assert.equal(run.status, "input");
  const inbox = view.inbox.filter((i) => (i.id as string).includes(c.runId));
  assert.equal(inbox.length, 1, "inbox 里应有一条需要你处理的卡");
  assert.ok(inbox[0].opts.length >= 2, "卡必须有可点的选项");
  assert.match(String(inbox[0].t), /重连|SSE|断线/);
  assert.ok((inbox[0].crumb ?? []).length >= 2, "卡要带面包屑（哪条 run / 哪个节点）");
});

test("replay:failed-node —— 子节点失败带人话原因，结局不是 completed", () => {
  const { run, case: c } = replayView(join(FIX, "failed-node"));
  const n = run.tree.find((x) => x.path === c.nodePath);
  assert.ok(n, `tree 里应有 ${c.nodePath}`);
  assert.equal(n.st, "failed");
  assert.equal(n.turn.state, "failed");
  assert.match(String(n.turn.reason ?? n.d), /未物化|失败|read/i);
  assert.ok(n.sum.length > 0, "失败的节点也要有一句人话（不许折叠成完成）");
});


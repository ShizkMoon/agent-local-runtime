// S27 · 故障注入（G-3 恢复门 / G-1 契约门）
// 五个注入器各配一条断言；能起真进程的就起真进程（worker / daemon），
// 不 mock 产品逻辑：断言读的是 src/runs.ts 的收尾结果与 workbench/view.ts 的投影。
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runScenario } from "./lib/scenario-run.mjs";
import { badGateAns, diskReadonly, diskWritable, probeUnwritable, truncateEvents } from "./lib/faults.mjs";
import { materialize, mkTmp, readCase } from "./lib/replay.mjs";
import { approvalState, buildView, GATE_DECISIONS, pendingApproval, readEvents } from "../../view.ts";
import { rmSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "fixtures");

test("注入 1 · killWorker → 孤儿有归宿（failed/orphaned），且不重复拉起", async (t) => {
  const r = await runScenario("orphan");
  if (r.code !== 0 || !r.result) {
    t.diagnostic(r.stderr.slice(0, 800));
    assert.fail(`场景 orphan 退出码 ${r.code}`);
  }
  const { before, killed, after } = r.result;
  assert.equal(before.live, true, "注入前：worker.json 租约应当活着");
  assert.equal(before.pending, 0, "注入前：有活租约 → pendingNodes 不该列出它");
  assert.equal(killed.applied, true);
  assert.equal(killed.dead, true, `worker 进程必须真的死了（pid ${killed.pid}）`);
  assert.equal(after.status, "failed", "孤儿必须被收尾成 failed，不能永远 running");
  assert.equal(after.reason, "orphaned", "reason 必须是机器可判的 orphaned");
  assert.match(after.summary, /orphaned|进程已消失/);
  assert.equal(after.orphanEvents, 1, "收尾事件只能写一条");
  assert.equal(after.pending1, 0, "收尾后 pendingNodes 不许再列出它（= 不重复拉起）");
  assert.equal(after.pending2, 0, "再调一次也不许重复收尾（幂等）");
  assert.equal(after.spawnEvents, 0, "全程没有 spawn 事件：注入的是崩溃，不是重跑");
  assert.equal(after.workerFile, false, "租约文件必须清掉（无僵尸）");
  assert.equal(after.liveAfter, false);
  r.cleanup();
});

test("注入 2 · killDaemon ×10 → 重启不重复拉起、无僵尸、只收一次孤儿", async (t) => {
  const r = await runScenario("daemon-restart", { timeoutMs: 180000 });
  if (r.code !== 0 || !r.result) {
    t.diagnostic(r.stderr.slice(0, 800));
    assert.fail(`场景 daemon-restart 退出码 ${r.code}`);
  }
  const { rounds, after } = r.result;
  assert.equal(rounds.length, 10, "必须真的杀 10 次");
  for (const x of rounds) {
    assert.equal(x.dead, true, `第 ${x.i} 次：daemon ${x.pid} 必须真的死了`);
    assert.equal(x.pending, 0, `第 ${x.i} 次：有活租约时 pendingNodes 必须是 0（不许重复拉起）`);
  }
  assert.equal(after.spawnsBefore, 0, "10 次重启期间不许出现 spawn 事件");
  assert.equal(after.liveStill, true, "租约进程还活着时，租约必须仍然有效");
  assert.equal(after.orphanEvents, 1, "租约进程也死后，只收一次孤儿");
  assert.equal(after.status, "failed");
  assert.equal(after.pending, 0, "收尾后队列为空：没有僵尸节点在等重拉");
  r.cleanup();
});

test("注入 3 · truncateEvents → 半行日志不炸投影，行数如实变少", (t) => {
  const runsDir = mkTmp("aica-e2e-trunc-");
  const { nodeDir } = materialize(join(FIX, "real-turn"), runsDir);
  const file = join(nodeDir, "events.jsonl");
  const fullLines = readEvents(file).length;
  const cut = truncateEvents(file, { fraction: 0.7 });
  assert.equal(cut.applied, true);
  if (!cut.partial_tail) t.diagnostic("截断点恰好在行尾，这一轮没有制造半行 JSON");
  const after = readEvents(file);
  assert.ok(after.length < fullLines, `截断后行数必须变少：${after.length} vs ${fullLines}`);
  let view;
  assert.doesNotThrow(() => { view = buildView(runsDir, { now: readCase(join(FIX, "real-turn")).now }); }, "半行日志不许把投影炸掉");
  assert.equal(view.runs.length, 1, "run 仍在列表里（真相还在磁盘上）");
  const last = after[after.length - 1];
  assert.ok(typeof last.i === "number", "解析出来的每条事件仍带行号");
  rmSync(runsDir, { recursive: true, force: true });
});

test("注入 4 · badGateAns → 非法 ans 仍算 pending（fail-closed），卡不消失、节点不变成功", (t) => {
  const runsDir = mkTmp("aica-e2e-badans-");
  const { case: c, nodeDir } = materialize(join(FIX, "approval-wait"), runsDir);
  assert.equal(pendingApproval(nodeDir, c.now), true, "注入前：这条审批应当还挂着");
  const inj = badGateAns(nodeDir);
  assert.equal(inj.applied, true);
  // S19 fail-closed：decision 不在 {allowed-once,rejected,cancelled,unavailable} 闭集 = 视为没答
  const st = approvalState(nodeDir, c.now);
  assert.equal(st.invalid, true, "非法 decision 必须被标成 invalid");
  assert.equal(st.pending, true, "非法 ans 仍算 pending：卡留在「需要你」，不许悄悄收掉");
  assert.equal(pendingApproval(nodeDir, c.now), true, "pendingApproval 与 approvalState 必须说同一件事");
  assert.equal(existsSync(join(nodeDir, "result.json")), false, "非法 ans 不许伪造出 result");
  let view;
  assert.doesNotThrow(() => { view = buildView(runsDir, { now: c.now }); });
  assert.notEqual(view.runs[0].status, "done", "非法 ans 绝不能让 run 变 done");
  const decisions = (view.runs[0].audits ?? []).map((a) => a.decision);
  assert.ok(
    decisions.includes("invalid-answer"),
    `审计里要记 decision="invalid-answer"（实际 ${JSON.stringify(decisions)}）`,
  );
  t.diagnostic(
    `fail-closed 生效：invalid=${st.invalid} pending=${st.pending} age_ms=${st.age_ms}；闭集=${GATE_DECISIONS.join("|")}`,
  );
  rmSync(runsDir, { recursive: true, force: true });
});

test("注入 5 · diskReadonly → 事件写不进去必须抛错，不许静默丢", async (t) => {
  const tmpF = join(mkTmp("aica-e2e-ro-"), "events.jsonl");
  writeFileSync(tmpF, readFileSync(join(FIX, "real-turn", "events.jsonl")));
  const probe = diskReadonly(tmpF);
  const writable = probeUnwritable(tmpF);
  diskWritable(tmpF);
  if (!probe.applied || !writable) {
    t.skip(`本机不支持把文件设为只读（applied=${probe.applied}, reason=${probe.reason ?? "写入仍成功"}）`);
    return;
  }
  const r = await runScenario("readonly-events");
  if (r.code !== 0 || !r.result) {
    t.diagnostic(r.stderr.slice(0, 800));
    assert.fail(`场景 readonly-events 退出码 ${r.code}`);
  }
  const x = r.result;
  assert.equal(x.ro.applied, true);
  assert.equal(x.unwritable, true, "只读必须真的生效（否则断言无意义）");
  assert.equal(x.threw, true, "写不进 events.jsonl 必须抛错：事件丢失要炸，不要静默");
  assert.equal(x.unchanged, true, "失败的 append 不许留下半行（字节不变）");
  r.cleanup();
});

test("注入器自检：readonly 之后能恢复可写（不把夹具/环境搞脏）", () => {
  const f = join(mkTmp("aica-e2e-ro2-"), "events.jsonl");
  writeFileSync(f, "x\n");
  const before = readFileSync(f);
  assert.equal(diskReadonly(f).applied, true);
  assert.equal(diskWritable(f), true);
  const after = readFileSync(f);
  assert.deepEqual(after, before, "只读/恢复不应改变文件内容");
});


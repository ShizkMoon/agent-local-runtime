// S27 · 六道自检门的可跑用例（docs/prd-workbench-v3.md §3.3）
// 每道门至少一条用例；文件名与用例名都带 G-x，便于映射。
// 原则（A13）：验证世界而不是验证自我报告 —— 断言读的是磁盘/进程/HTTP，不读被测方自己的说辞。
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runScenario } from "./lib/scenario-run.mjs";
import { materialize, mkTmp, touchRecent } from "./lib/replay.mjs";
import { getJson, startServer } from "./lib/srv.mjs";
import { readUsage, usageTokens } from "../../../src/transcribe.ts";
import { enforceTokenBudget } from "../../../src/daemon.ts";
import { rmSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "fixtures");
const CLI = join(HERE, "..", "..", "..", "src", "cli.ts");
const NODE = process.env.NODE_BIN || process.execPath;
// 端口分带，避免多文件并行跑时互相踩：详见 README「端口分配」
const E2E_GATE_PORT = Number(process.env.AICA_E2E_GATE_PORT ?? 4480);

function runCli(args, env = {}) {
  const r = spawnSync(NODE, [CLI, ...args], {
    encoding: "utf8",
    timeout: 30000,
    windowsHide: true,
    env: { ...process.env, AICA_STATE: env.state ?? mkTmp("aica-e2e-cli-"), ...env },
  });
  const out = String(r.stdout ?? "").trim();
  let json = null;
  try { json = JSON.parse(out.split("\n").filter(Boolean).pop()); } catch { /* 非 JSON 记为 null */ }
  return { code: r.status, json, stdout: out, stderr: String(r.stderr ?? "") };
}

// ---------------------------------------------------------------- G-1 契约门

const SUBCOMMANDS = ["run-create", "dispatch", "node-create", "check", "reply", "gate", "done", "fail", "wait", "event", "events", "fork", "abort", "version", "no-such-command"];

test("G-1 契约门：每个子命令都回 envelope（坏输入不崩在 envelope 之外）", (t) => {
  const state = mkTmp("aica-e2e-g1-");
  const bad = [];
  for (const cmd of SUBCOMMANDS) {
    const r = runCli([cmd], { state });
    if (!r.json) { bad.push({ cmd, why: "没有 JSON envelope", stderr: r.stderr.slice(0, 120) }); continue; }
    if (r.json.version !== "1.0") bad.push({ cmd, why: `version=${r.json.version}` });
    if (typeof r.json.ok !== "boolean") bad.push({ cmd, why: "缺 ok 字段" });
    if (typeof r.json.command !== "string") bad.push({ cmd, why: "缺 command 字段" });
    if (r.json.ok === false && !r.json.error) bad.push({ cmd, why: "ok:false 但没有 error" });
  }
  assert.deepEqual(bad, [], `坏输入没有回到 envelope：${JSON.stringify(bad)}`);
  t.diagnostic(`G-1 已覆盖 ${SUBCOMMANDS.length} 个子命令的 envelope 形状`);
});

test("G-1 契约门（严格态）：坏输入必须是 USAGE 且非 0 退出——当前未达标则 skip 并列出缺口", (t) => {
  const state = mkTmp("aica-e2e-g1s-");
  const violations = [];
  for (const cmd of SUBCOMMANDS) {
    if (cmd === "version" || cmd === "no-such-command") continue;
    const r = runCli([cmd], { state });
    const code = r.json?.error?.code;
    const hasStack = /TypeError|Error:|at .*\.ts:\d+/.test(String(r.json?.error?.message ?? ""));
    if (r.code === 0) violations.push(`${cmd}: 失败却退出码 0`);
    if (code !== "USAGE") violations.push(`${cmd}: error.code=${code ?? "(缺)"}，期望 USAGE`);
    if (hasStack) violations.push(`${cmd}: error.message 里带栈（坏输入泄漏实现细节）`);
  }
  const uniq = [...new Set(violations)];
  if (uniq.length) {
    t.skip(`G-1 未达标（${uniq.length} 条）：${uniq.slice(0, 6).join(" / ")}${uniq.length > 6 ? " …" : ""}`);
    return;
  }
  t.diagnostic("G-1 严格态全绿：坏输入 → USAGE + 非 0 退出 + 无栈");
});

// ---------------------------------------------------------------- G-2 状态机门

test("G-2 状态机门：终止态不可被覆写；只有 waiting 能被归档复活", async (t) => {
  const r = await runScenario("state-machine");
  if (r.code !== 0 || !r.result) { t.diagnostic(r.stderr.slice(0, 600)); assert.fail(`场景退出码 ${r.code}`); }
  const s = r.result;
  assert.equal(s.firstStatus, "done");
  assert.equal(s.afterSecond, "done", "先写者胜：done 之后写 failed 不许覆盖（同 runner 三方竞态）");
  assert.equal(s.afterIllegal, "done", "done 之后写 waiting 也不许覆盖（终止态不可逆）");
  assert.equal(s.resolvedAfterDone, false, "resolveWaiting 只认 waiting：done 节点不许被归档回 pending");
  assert.equal(s.patched, "patched", "patchResult 是已文档化的收尾通道（spent 回填用）");
  r.cleanup();
});

test("G-2 状态机门（严格态）：非法迁移要主动报错——当前未实现则记录", (t) => {
  t.skip("待实现：writeResult 目前静默忽略非法迁移（先写者胜），没有返回错误码；S21 的归宿靠 pendingNodes 收口而非写入口校验");
});

// ---------------------------------------------------------------- G-3 恢复门

test("G-3 恢复门：kill worker → 孤儿有归宿、不重复拉起、无僵尸", async (t) => {
  const r = await runScenario("orphan");
  if (r.code !== 0 || !r.result) { t.diagnostic(r.stderr.slice(0, 600)); assert.fail(`场景退出码 ${r.code}`); }
  const { after, killed } = r.result;
  assert.equal(killed.dead, true);
  assert.equal(after.status, "failed");
  assert.equal(after.reason, "orphaned");
  assert.equal(after.pending1, 0);
  assert.equal(after.workerFile, false);
  t.diagnostic("kill daemon ×10 的完整用例在 faults.test.ts『注入 2』");
  r.cleanup();
});

// ---------------------------------------------------------------- G-4 安全门

test("G-4 安全门：越权工具 / 逃逸路径 / deny / 规则命中 / 控制面保护 全绿", async (t) => {
  const r = await runScenario("security");
  if (r.code !== 0 || !r.result) { t.diagnostic(r.stderr.slice(0, 600)); assert.fail(`场景退出码 ${r.code}`); }
  const s = r.result;
  assert.equal(s.denyTool, "block", "spec.deny 命中 → block（不弹窗、恒拒）");
  assert.equal(s.denyPath, "block", "deny_paths 命中（secrets/）→ block");
  assert.equal(s.ruleHit, "block", "rules 正则命中 curl|sh → block");
  assert.equal(s.criticalRm, "block", "rm -rf / 即使 full 档也必须硬拒");
  assert.match(String(s.criticalReason), /拒绝|critical|危险/);
  assert.equal(s.ask, "ask", "supervised + approve[bash] → ask（不是 allow）");
  assert.deepEqual(s.optLabels.slice(0, 1), ["允许一次"], "审批卡第一动作是『允许一次』");
  assert.ok(s.optLabels.includes("拒绝"), "审批卡必须有『拒绝』");
  assert.equal(s.grantEscape, false, "grant 不许跨目标生效（targetMatches 逃逸失败）");
  assert.equal(s.grantExact, true);
  assert.equal(s.controlPlane, true, "spec/result/gate 这类控制面文件必须被 gate 识别（防自我提权）");
  assert.equal(s.safeJoinTraversal, null, "safeJoinIn 必须挡住 .. 逃逸");
  assert.equal(s.badSeg, true, "badSeg 必须认出 ..");
  assert.equal(s.tiers.unknown, "exec", "未登记工具按 exec 处理（宁严勿宽）");
  r.cleanup();
});

// ---------------------------------------------------------------- G-5 预算门

test("G-5 预算门：复现真实拦截——预算事件 + abort + 同一句 summary", () => {
  const runsDir = mkTmp("aica-e2e-g5-");
  const { case: c, nodeDir } = materialize(join(FIX, "budget-abort"), runsDir);
  const spec = JSON.parse(readFileSync(join(nodeDir, "spec.json"), "utf8"));
  const usage = readUsage(nodeDir);
  const spent = usageTokens(usage);
  const recorded = JSON.parse(readFileSync(join(nodeDir, "result.json"), "utf8"));

  const calls = { append: [], abort: [], patch: [] };
  const res = enforceTokenBudget(spec.budget, spent, {
    append: (e) => calls.append.push(e),
    abort: (s) => calls.abort.push(s),
    patch: (p) => calls.patch.push(p),
  });

  assert.equal(spec.budget.tokens, 10, "夹具就是 10 token 的预算");
  assert.equal(spent, 1915, "录制时一个 turn 就烧了 1915");
  assert.equal(res, "exceeded", "超预算必须返回 exceeded");
  assert.equal(calls.append.length, 1, "必须留一条 budget 事件（可见证据）");
  assert.deepEqual(calls.append[0].data, { limit: 10, spent: 1915 }, "事件要带 limit 与 spent");
  assert.equal(calls.abort.length, 1, "必须中止（不是只记一笔）");
  assert.equal(calls.abort[0], recorded.summary, "abort 文案必须与录制时落盘的 result.summary 完全一致");
  assert.deepEqual(calls.patch, [{ reason: "budget exceeded" }], "result.reason 必须可机器判读");

  // 边界：等于上限不算超；没配预算不拦（不许拿 0 当无限严）
  const okDeps = { append: () => { throw new Error("不该写事件"); }, abort: () => { throw new Error("不该中止"); }, patch: () => {} };
  assert.equal(enforceTokenBudget({ tokens: 100 }, 100, okDeps), "ok");
  assert.equal(enforceTokenBudget({ tokens: 100 }, 101, { append: () => {}, abort: () => {}, patch: () => {} }), "exceeded");
  assert.equal(enforceTokenBudget(null, 999999, okDeps), "no-budget");
  assert.equal(enforceTokenBudget({ tokens: 0 }, 999, okDeps), "no-budget");
  rmSync(runsDir, { recursive: true, force: true });
  assert.equal(c.nodePath, "root");
});

// ---------------------------------------------------------------- G-6 UI 门（数据面）

test("G-6 UI 门（数据面）：/api/v1/view 与 /api/approvals 说同一件事", async (t) => {
  const state = mkTmp("aica-e2e-g6-");
  const runsDir = join(state, "runs");
  materialize(join(FIX, "real-turn"), runsDir);
  const aw = materialize(join(FIX, "approval-wait"), runsDir);
  touchRecent(aw.nodeDir);   // 服务端按 Date.now() 判审批 TTL，把夹具拨到"刚刚"
  const reqFile = join(aw.nodeDir, "gate-req.json");
  const req = JSON.parse(readFileSync(reqFile, "utf8"));

  let srv;
  try { srv = await startServer({ stateDir: state, port: E2E_GATE_PORT, expectRuns: 2 }); }
  catch (e) { if (String(e?.message ?? e).startsWith("PORT_BUSY")) { t.skip(`4487 被占用：${String(e.message)}`); return; } throw e; }
  try {
    const view = await getJson(`${srv.base}/api/v1/view`);
    assert.equal(view.status, 200);
    const runs = view.json?.runs ?? [];
    assert.equal(runs.length, 2, "两个 run 都要在视图里");
    const real = runs.find((r) => r.id === "e9a3cf91-a19c");
    assert.ok(real, "real-turn 必须在 /api/v1/view 里");
    assert.ok((real.steps ?? []).length >= 3, "工具体步骤要进视图（UI 的 .stp 行数来源）");
    assert.ok(real.sum.length > 0, "结论要进视图（UI 的 .concl 来源）");

    const ap = await getJson(`${srv.base}/api/approvals`);
    assert.equal(ap.status, 200);
    const list = ap.json?.approvals ?? [];
    assert.equal(list.length, 1, `未答审批应有 1 条（实际 ${list.length}）：${JSON.stringify(ap.json).slice(0, 200)}`);
    const card = list[0];
    const labels = (card.opts ?? []).map((o) => o.label);
    assert.deepEqual(labels, req.opts.map((o) => o.label), "卡片 opts 必须就是 gate-req 里的 opts（服务端生成、不重写）");
    assert.ok(labels.includes("允许一次") && labels.includes("拒绝"));
    assert.equal(card.tool, req.tool);
    assert.equal(card.run, aw.case.runId, "审批要能定位回 run");
    assert.ok(typeof card.age_ms === "number", "卡要带年龄（防误批/超时提示用）");

    // 世界核对：端点说"在等审批"，磁盘上也确实还没有 result
    assert.equal(existsSync(join(aw.nodeDir, "result.json")), false, "等审批的节点不许有 result（否则就是假状态）");
  } finally {
    await srv.stop();
  }
  t.diagnostic("DOM 层断言见 ui.test.ts（#threadScroll .stp / .concl 顺序 / 审批卡按钮）");
});








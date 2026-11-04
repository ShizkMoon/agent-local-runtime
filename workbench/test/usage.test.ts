// S20 验收：turn 级用量账本 / tokens 预算拦截 / 压缩投影 / 截断诚实性。
// src 模块在 import 时读 AICA_STATE（runs.ts 的 STATE 常量），所以先设环境变量再动态 import。
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STATE = mkdtempSync(join(tmpdir(), "aica-s20-"));
process.env.AICA_STATE = STATE;

const { turnUsage, readUsage, recordTurnUsage, usageTokens, tapStdout } = await import("../../src/transcribe.ts");
const { enforceTokenBudget } = await import("../../src/daemon.ts");
const { appendEvent, abortWorker, patchResult, readResult } = await import("../../src/runs.ts");
const { compactionsOf, buildSteps } = await import("../view.ts");

/** 假 child：只提供 tapStdout 用到的 stdout/stderr/on("close") */
function fakeChild(): any {
  const child: any = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => { child.killed = true; return true; };
  return child;
}
function nodeDirOf(rootId: string, path = "root"): string {
  const dir = join(STATE, "runs", rootId, "nodes", path);
  mkdirSync(dir, { recursive: true });
  return dir;
}
const turnEnd = (usage: Record<string, unknown>, durationMs?: number) =>
  JSON.stringify({ type: "turn_end", message: { usage, durationMs } });

// ---------------------------------------------------------------- 1. turn 级账本形状

test("usage：turn_end 按 turn 落账，形状 {turns,total} + 旧字段 tokens/byTurn 兼容", () => {
  const dir = nodeDirOf("led-1");
  const seen: { tokens: number; total: { in: number; out: number; cache: number } }[] = [];
  const child = fakeChild();
  tapStdout(child, dir, "led-1", "root", { onTurn: (ledger) => seen.push({ tokens: ledger.tokens, total: ledger.total }) });
  child.stdout.emit("data", Buffer.from([
    JSON.stringify({ type: "turn_start" }),
    turnEnd({ input: 1200, output: 831, cacheRead: 300, cacheWrite: 0, totalTokens: 2031 }, 4005),
    JSON.stringify({ type: "turn_start" }),
    turnEnd({ input: 200, output: 83, cacheRead: 0, cacheWrite: 50, totalTokens: 283 }, 1200),
    "",
  ].join("\n") + "\n"));

  const u = readUsage(dir)!;
  assert.equal(u.tokens, 2314, "旧字段 tokens = Σ turn totalTokens");
  assert.deepEqual(u.byTurn, [{ i: 1, tokens: 2031 }, { i: 2, tokens: 283 }]);
  assert.equal(u.turns.length, 2);
  assert.deepEqual(
    u.turns.map((t) => [t.i, t.in, t.out, t.cache, t.ms, t.tokens]),
    [[1, 1200, 831, 300, 4005, 2031], [2, 200, 83, 50, 1200, 283]],
  );
  assert.match(u.turns[0].at, /^\d{4}-\d\d-\d\dT/, "at 是 ISO 时间戳");
  assert.deepEqual(u.total, { in: 1400, out: 914, cache: 350 });
  assert.equal(seen.length, 2, "每个 turn 结束回调一次（daemon 的预算判定点）");
  assert.deepEqual(seen[1].total, { in: 1400, out: 914, cache: 350 });
  assert.equal(usageTokens(u), 2314);
});

test("usage：没有 usage 的 turn_end 不编数（不落账，也不写 0）", () => {
  const dir = nodeDirOf("led-2");
  const child = fakeChild();
  let calls = 0;
  tapStdout(child, dir, "led-2", "root", { onTurn: () => { calls += 1; } });
  child.stdout.emit("data", Buffer.from([
    JSON.stringify({ type: "turn_start" }),
    JSON.stringify({ type: "turn_end", message: {} }),
    "",
  ].join("\n") + "\n"));
  assert.equal(turnUsage({ type: "turn_end", message: {} }, 1), null);
  assert.equal(existsSync(join(dir, "usage.json")), false, "拿不到用量就不落账");
  assert.equal(calls, 0);
  const ev = readFileSync(join(dir, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(ev.filter((e) => e.kind === "turn_end").length, 1, "turn_end 事件仍然照写");
});

test("usage：老格式（只有 tokens/byTurn）追加新 turn 不丢历史累计", () => {
  const dir = nodeDirOf("led-3");
  writeFileSync(join(dir, "usage.json"), JSON.stringify({ tokens: 500, byTurn: [{ i: 1, tokens: 500 }] }) + "\n");
  const after = recordTurnUsage(dir, { i: 2, at: "2026-11-04T00:00:00.000Z", in: 10, out: 5, cache: null, ms: null, tokens: 15 });
  assert.equal(after.tokens, 515);
  assert.deepEqual(after.byTurn, [{ i: 1, tokens: 500 }, { i: 2, tokens: 15 }]);
  assert.equal(after.turns.length, 1, "老文件没有 turn 明细，只有新 turn 在 turns 里");
  assert.deepEqual(after.total, { in: 10, out: 5, cache: 0 });
  assert.equal(readUsage(dir)!.tokens, 515);
});

test("usage：字段名兼容（total_tokens / prompt_tokens / 只有 in+out 时按二者求和）", () => {
  const a = turnUsage({ message: { usage: { prompt_tokens: 10, completion_tokens: 4 } } }, 1);
  assert.deepEqual([a!.in, a!.out, a!.tokens], [10, 4, 14]);
  const b = turnUsage({ message: { usage: { total_tokens: 99 } } }, 2);
  assert.deepEqual([b!.in, b!.out, b!.tokens], [null, null, 99]);
});

test("usage：fallback 重拉（turn 序号从 1 重来）用 attempt 区分，tokens 继续累计", () => {
  const dir = nodeDirOf("led-4");
  const mk = (i: number, tokens: number) => ({ i, at: "2026-11-04T00:00:00.000Z", in: tokens, out: 0, cache: null, ms: null, tokens });
  recordTurnUsage(dir, mk(1, 100));
  recordTurnUsage(dir, mk(1, 30));   // 同一个 i：第二次拉起
  recordTurnUsage(dir, mk(2, 20));
  const u = readUsage(dir)!;
  assert.deepEqual(u.turns.map((t) => [t.attempt, t.i, t.tokens]), [[1, 1, 100], [2, 1, 30], [2, 2, 20]]);
  assert.equal(u.tokens, 150, "两次拉起烧的 token 都要记（成本是事实，不能因为重试就吞掉）");
});

// ---------------------------------------------------------------- 2. tokens 预算拦截

test("budget：超限 → budget 事件 + abort(reason) + result.reason（注入 fake）", () => {
  const calls: [string, any][] = [];
  const res = enforceTokenBudget({ tokens: 10 }, 2314, {
    append: (rec) => calls.push(["append", rec]),
    abort: (s) => calls.push(["abort", s]),
    patch: (p) => calls.push(["patch", p]),
  });
  assert.equal(res, "exceeded");
  assert.deepEqual(calls[0], ["append", { kind: "budget", data: { limit: 10, spent: 2314 } }], "先留证据再动手");
  assert.equal(calls[1][0], "abort");
  assert.match(calls[1][1], /budget exceeded/);
  assert.match(calls[1][1], /2314 \/ 上限 10 tokens/);
  assert.deepEqual(calls[2], ["patch", { reason: "budget exceeded" }]);
});

test("budget：未配 / 0 / 未超 → 不拦、不写事件", () => {
  const fail = { append: () => { throw new Error("不应该写事件"); }, abort: () => { throw new Error("不应该 abort"); }, patch: () => { throw new Error("不应该 patch"); } };
  assert.equal(enforceTokenBudget(undefined, 999999, fail), "no-budget");
  assert.equal(enforceTokenBudget({}, 999999, fail), "no-budget");
  assert.equal(enforceTokenBudget({ tokens: 0 }, 999999, fail), "no-budget", "0 不等于无限预算，等于没配");
  assert.equal(enforceTokenBudget({ tokens: 100 }, 100, fail), "ok", "等于上限不算超");
});

test("budget：真链路（tapStdout → 预算 → appendEvent/abortWorker）只触发一次，且 result 带 reason", () => {
  const rootId = "bud-1";
  const dir = nodeDirOf(rootId);
  const child = fakeChild();
  let hit = false;
  const aborts: string[] = [];
  tapStdout(child, dir, rootId, "root", {
    onTurn: (ledger) => {
      if (hit) return;
      enforceTokenBudget({ tokens: 100 }, usageTokens(ledger), {
        append: (rec) => appendEvent(rootId, "root", rec as any),
        abort: (summary) => { hit = true; aborts.push(summary); abortWorker(rootId, "root", summary); },
        patch: (p) => { patchResult(rootId, "root", p as any); },
      });
    },
  });
  child.stdout.emit("data", Buffer.from([
    JSON.stringify({ type: "turn_start" }),
    turnEnd({ input: 400, output: 100, totalTokens: 500 }),
    JSON.stringify({ type: "turn_start" }),
    turnEnd({ input: 400, output: 100, totalTokens: 500 }),
    "",
  ].join("\n") + "\n"));

  const events = readFileSync(join(dir, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const budgetEv = events.filter((e) => e.kind === "budget");
  assert.equal(budgetEv.length, 1, "预算事件只写一次");
  assert.deepEqual(budgetEv[0].data, { limit: 100, spent: 500 });
  assert.equal(aborts.length, 1, "abort 只调用一次（第二个 turn 不再重复）");

  const r = readResult(rootId, "root")!;
  assert.equal(r.status, "failed");
  assert.match(String(r.summary), /budget exceeded/);
  assert.equal((r as any).reason, "budget exceeded", "result.reason 记机器可读的 budget exceeded");
  assert.equal(readUsage(dir)!.tokens, 1000, "账本照记两个 turn（用量是事实，超限是判定）");
});

// ---------------------------------------------------------------- 3. 压缩投影

test("compactions：start/summary/end 三事件合成一条，缺 end 不许假装压缩成功", () => {
  const evs = [
    { i: 0, ev: { ts: "T1", kind: "compaction_start", data: { tokenCount: 180000 } } },
    { i: 1, ev: { ts: "T2", kind: "compaction_summary", data: { text: "摘要…" } } },
    { i: 2, ev: { ts: "T3", kind: "compaction_end", data: { tokens: 52000 } } },
    { i: 3, ev: { ts: "T4", kind: "compaction", data: { before_tokens: 50000, after_tokens: 20000 } } },
    { i: 4, ev: { ts: "T5", kind: "compaction_start", data: { tokens: 900 } } },
    { i: 5, ev: { ts: "T6", kind: "message", data: { text: "不是压缩事件" } } },
  ];
  assert.deepEqual(compactionsOf(evs as any), [
    { at: "T3", before_tokens: 180000, after_tokens: 52000 },
    { at: "T4", before_tokens: 50000, after_tokens: 20000 },
    { at: "T5", before_tokens: 900, after_tokens: null },
  ]);
  assert.deepEqual(compactionsOf([]), []);
});

// ---------------------------------------------------------------- 4. 截断诚实性（P12）

test("steps：源事件已截断时 total 记 null（不拿「我手里有几行」冒充总数）", () => {
  const capped = buildSteps([
    { i: 0, ev: { ts: "T", kind: "tool_call", data: { call_id: "c", tool: "read", args: "{}" } } },
    { i: 1, ev: { ts: "T", kind: "tool_execution", data: { call_id: "c", tool: "read", isError: false, result: "a\nb\nc…" } } },
  ] as any);
  assert.equal(capped[0].capped, true);
  assert.equal(capped[0].total, null);
  assert.equal(capped[0].truncated, true, "看不到全部就必须说 truncated");

  const full = buildSteps([
    { i: 0, ev: { ts: "T", kind: "tool_execution", data: { call_id: "d", tool: "read", isError: false, result: Array.from({ length: 60 }, (_, i) => `L${i}`).join("\n") } } },
  ] as any);
  assert.equal(full[0].capped, false);
  assert.equal(full[0].total, 60);
  assert.equal(full[0].truncated, true);

  const small = buildSteps([
    { i: 0, ev: { ts: "T", kind: "tool_execution", data: { call_id: "e", tool: "read", isError: false, result: "只有一行" } } },
  ] as any);
  assert.deepEqual([small[0].total, small[0].truncated, small[0].capped], [1, false, false]);
});

test("steps：事件显式给的总数优先（totalLines / truncated 标记）", () => {
  const s = buildSteps([
    { i: 0, ev: { ts: "T", kind: "tool_execution", data: { call_id: "x", tool: "bash", isError: false, result: "截断的预览…", totalLines: 4096, truncated: true } } },
  ] as any);
  assert.equal(s[0].total, 4096, "事件说了一共多少行就采信");
  assert.equal(s[0].capped, true);
  assert.equal(s[0].truncated, true);
});

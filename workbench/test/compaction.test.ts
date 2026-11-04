// R6：压缩策略 —— 80% 阈值、三事件、≤2KB 摘要注入、最近 3 轮保留原文。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AICA_STATE = mkdtempSync(join(tmpdir(), "aica-r6-compact-state-"));
const D = await import("../../src/daemon.ts");

const spec = (budget?: any) => ({ id: "node:x/root", type: "assign", goal: "g", accept: ["a"], ...(budget ? { budget } : {}) }) as any;

const turnEvents = (n: number, textLen = 40) => {
  const ev: { kind: string; data?: any }[] = [];
  for (let i = 1; i <= n; i++) {
    ev.push({ kind: "turn", data: { i } });
    ev.push({ kind: "agent_message", data: { role: "assistant", text: `第${i}轮：` + "做了一些工作".repeat(textLen) } });
  }
  return ev;
};

test("阈值：默认窗口 128k × 80% = 102400；spec.budget.context_tokens 覆盖窗口", () => {
  assert.equal(D.compactionWindow(spec()), 128_000);
  assert.equal(D.compactionThreshold(128_000), 102_400);
  assert.equal(D.compactionWindow(spec({ context_tokens: 1000 })), 1000);
  assert.equal(D.compactionThreshold(D.compactionWindow(spec({ context_tokens: 1000 }))), 800);
  assert.equal(D.compactionWindow(spec({ context_tokens: -5 })), 128_000, "非法值回落默认");
});

test("未到阈值：below，零事件零文件", () => {
  const dir = mkdtempSync(join(tmpdir(), "aica-r6-c1-"));
  const events: any[] = [];
  let wrote: any = null;
  const r = D.maybeCompact(spec({ context_tokens: 1000 }), {
    used: 799,
    events: () => turnEvents(5),
    append: (rec: any) => events.push(rec),
    write: (rec: any) => { wrote = rec; },
  });
  assert.equal(r, "below");
  assert.equal(events.length, 0);
  assert.equal(wrote, null);
  assert.equal(D.readCompaction(dir), null);
});

test("到阈值：写 compaction_start/summary/end 三事件 + 记录；最近 3 轮保留，更早轮次进摘要", () => {
  const events: any[] = [];
  let rec: any = null;
  const r = D.maybeCompact(spec({ context_tokens: 1000 }), {
    used: 800,
    events: () => turnEvents(6),
    append: (e: any) => events.push(e),
    write: (x: any) => { rec = x; },
  });
  assert.equal(r, "compacted");
  assert.deepEqual(events.map((e) => e.kind), ["compaction_start", "compaction_summary", "compaction_end"]);
  assert.equal(events[0].data.before_tokens, 800);
  assert.equal(events[0].data.threshold, 800);
  assert.equal(events[1].data.turns.length, 3, "6 轮里更早的 3 轮被摘要");
  assert.deepEqual(events[1].data.kept, [4, 5, 6], "保留最近 3 轮");
  assert.match(String(events[1].data.summary), /第 1 轮/);
  assert.equal(/第 6 轮/.test(String(events[1].data.summary)), false, "保留的轮次不进摘要");
  assert.equal(events[2].data.after_tokens, null, "压缩后 tokens 未知就 null，不编");
  assert.deepEqual(rec.kept, [4, 5, 6]);
  assert.equal(rec.before_tokens, 800);
});

test("摘要 ≤2KB（字节）：超长文本被截断", () => {
  const long = turnEvents(4, 400);
  const out = D.buildCompactionSummary(long);
  assert.ok(Buffer.byteLength(out.summary, "utf8") <= 2048, `bytes=${Buffer.byteLength(out.summary, "utf8")}`);
});

test("already=true 不重复压；compaction.json 注入 userMessage 的 ## 上下文压缩（≤2KB）", () => {
  const events: any[] = [];
  const r = D.maybeCompact(spec({ context_tokens: 1000 }), {
    used: 900, events: () => turnEvents(5), append: (e: any) => events.push(e), write: () => {},
  }, true);
  assert.equal(r, "skipped");
  assert.equal(events.length, 0);

  const dir = mkdtempSync(join(tmpdir(), "aica-r6-c2-"));
  const rec = {
    at: new Date().toISOString(), window: 1000, threshold: 800, before_tokens: 900, after_tokens: null,
    turns: [1, 2], kept: [3, 4, 5], summary: "- 第 1 轮：改了 daemon\n- 第 2 轮：补了测试",
  };
  writeFileSync(join(dir, "compaction.json"), JSON.stringify(rec), "utf8");
  const msg = D.userMessage(spec(), false, dir);
  assert.match(msg, /## 上下文压缩/);
  assert.match(msg, /第 1 轮：改了 daemon/);
  assert.match(msg, /最近 3 轮原文仍在会话里/);
  assert.ok(Buffer.byteLength(rec.summary, "utf8") <= 2048);
});

test("没有 compaction.json 时不出现压缩段（老 run 零影响）", () => {
  const dir = mkdtempSync(join(tmpdir(), "aica-r6-c3-"));
  mkdirSync(dir, { recursive: true });
  const msg = D.userMessage(spec(), false, dir);
  assert.equal(/## 上下文压缩/.test(msg), false);
});

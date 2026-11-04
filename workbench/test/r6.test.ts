// R6：审计 Top10 的 P0/P1 六条 —— 投影层单源断言
// 覆盖 R5-01（arg_text 映射 + 词边界截断）、R5-02（右栏 d 去重）、R5-05（idle_ms 判据）、
// R5-06（opts[].kind）。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { argTextOf, wordCut, optKindOf, buildView, clearViewCache, lastActivityMs } from "../view.ts";

test("R5-01：bash 取命令首行并剥掉 shell 包装", () => {
  assert.equal(argTextOf("tool", "bash", { command: 'echo UI-OK > artifacts/ui.txt; echo "exit=$?"' }),
    'echo UI-OK > artifacts/ui.txt; echo "exit=$?"');
  assert.equal(argTextOf("tool", "bash", { command: 'bash -lc "npm test"' }), "npm test");
  assert.equal(argTextOf("tool", "powershell", { command: "pwsh -c 'Get-ChildItem'" }), "Get-ChildItem");
  // 多行只取首行
  assert.equal(argTextOf("tool", "bash", { command: "line1\nline2" }), "line1");
});

test("R5-01：read/glob 取路径，edit 出 `文件 +N −M`，ev_* 取摘要首句", () => {
  assert.equal(argTextOf("tool", "read", { path: "workbench/view.ts" }), "workbench/view.ts");
  assert.equal(argTextOf("tool", "glob", { pattern: "workbench/**/*.ts" }), "workbench/**/*.ts");
  assert.equal(argTextOf("tool", "edit", { path: "workbench/view.ts", add: 12, del: 3 }), "workbench/view.ts +12 −3");
  assert.equal(argTextOf("ev", "ev_done", { summary: "已执行 echo UI-OK。后面还有一句。" }), "已执行 echo UI-OK。");
  // 其余工具 key=value
  assert.equal(argTextOf("tool", "custom_tool", { a: 1, b: "x" }), "a=1 · b=x");
});

test("R5-01：截断落在词边界（不出现 artifa… 这种半截词）", () => {
  assert.equal(argTextOf("tool", "bash", { command: "cat a.txt" }), "cat a.txt", "短命令原样返回，不加省略号");
  const long = "cat artifacts/2026-11-04-long-name-component.ts " + "and-then-more-words ".repeat(6) + "artifacts-final-marker.ts";
  assert.ok(long.length > 140, "测试用的命令得够长（>120）");
  const cut = argTextOf("tool", "bash", { command: long });
  assert.ok(cut.endsWith("…"), cut);
  const body = cut.slice(0, -1);
  assert.ok(long.startsWith(body), "截断结果必须是原文前缀");
  const nextChar = long.charAt(body.length);
  assert.ok(!/[A-Za-z0-9]/.test(body.slice(-1)) || !/[A-Za-z0-9]/.test(nextChar),
    `不能切在单词中间：…${body.slice(-8)}|${long.slice(body.length, body.length + 8)}…`);
  assert.equal(wordCut("a".repeat(200), 10), "a".repeat(10) + "…", "没有边界时才硬切");
  assert.equal(wordCut("short", 10), "short");
});

test("R5-02：单行问题只在 t 里说一次（d 为空）", () => {
  const state = mkdtempSync(join(tmpdir(), "aica-r6-dedup-"));
  const base = join(state, "runs", "ask");
  mkdirSync(join(base, "nodes", "root"), { recursive: true });
  writeFileSync(join(base, "run.json"), JSON.stringify({ root_id: "ask", created_at: "2026-11-04T03:00:00.000Z", subject: "问一件事" }));
  writeFileSync(join(base, "plan.v1.json"), JSON.stringify({ version: 1, nodes: [], coverage: [], paths: [] }));
  writeFileSync(join(base, "nodes", "root", "spec.json"), JSON.stringify({ id: "node:ask/root", type: "assign", goal: "g", accept: [] }));
  writeFileSync(join(base, "nodes", "root", "events.jsonl"), JSON.stringify({ ts: "2026-11-04T03:00:01.000Z", kind: "spawn", data: { cmd: "pi" } }) + "\n");
  writeFileSync(join(base, "nodes", "root", "gate.json"), JSON.stringify({ question: "旧 smoke 记录要不要一起删？", opts: ["删", "留着"] }));
  writeFileSync(join(base, "nodes", "root", "result.json"), JSON.stringify({ id: "node:ask/root", type: "result", status: "waiting", summary: "等你回答", finished_at: "2026-11-04T03:01:00.000Z" }));
  clearViewCache();
  const v = buildView(join(state, "runs"), { now: Date.parse("2026-11-04T04:00:00.000Z") });
  const card = v.inbox[0];
  assert.equal(card.t, "旧 smoke 记录要不要一起删？");
  assert.equal(card.d, "", "t 与 d 不能是同一句");
  rmSync(state, { recursive: true, force: true });
});

test("R5-02：多行问题 —— d 只放标题之外的那部分", () => {
  const state = mkdtempSync(join(tmpdir(), "aica-r6-dedup2-"));
  const base = join(state, "runs", "ask2");
  mkdirSync(join(base, "nodes", "root"), { recursive: true });
  writeFileSync(join(base, "run.json"), JSON.stringify({ root_id: "ask2", created_at: "2026-11-04T03:00:00.000Z", subject: "问两件事" }));
  writeFileSync(join(base, "plan.v1.json"), JSON.stringify({ version: 1, nodes: [], coverage: [], paths: [] }));
  writeFileSync(join(base, "nodes", "root", "spec.json"), JSON.stringify({ id: "node:ask2/root", type: "assign", goal: "g", accept: [] }));
  writeFileSync(join(base, "nodes", "root", "events.jsonl"), JSON.stringify({ ts: "2026-11-04T03:00:01.000Z", kind: "spawn", data: { cmd: "pi" } }) + "\n");
  writeFileSync(join(base, "nodes", "root", "gate.json"), JSON.stringify({ question: "标题一句？\n补充说明第二句。", opts: ["好", "不"] }));
  writeFileSync(join(base, "nodes", "root", "result.json"), JSON.stringify({ id: "node:ask2/root", type: "result", status: "waiting", summary: "等", finished_at: "2026-11-04T03:01:00.000Z" }));
  clearViewCache();
  const card = buildView(join(state, "runs"), { now: Date.parse("2026-11-04T04:00:00.000Z") }).inbox[0];
  assert.equal(card.t, "标题一句？");
  assert.equal(card.d, "补充说明第二句。");
  rmSync(state, { recursive: true, force: true });
});

test("R5-06：opts[].kind —— 删/拒绝是 danger，允许类是 solid", () => {
  assert.equal(optKindOf("删"), "danger");
  assert.equal(optKindOf("拒绝并说明"), "danger");
  assert.equal(optKindOf("中止"), "danger");
  assert.equal(optKindOf("留着"), "solid");
  assert.equal(optKindOf("允许一次"), "solid");
  assert.equal(optKindOf("随便"), "");

  const state = mkdtempSync(join(tmpdir(), "aica-r6-kind-"));
  const base = join(state, "runs", "ask3");
  mkdirSync(join(base, "nodes", "root"), { recursive: true });
  writeFileSync(join(base, "run.json"), JSON.stringify({ root_id: "ask3", created_at: "2026-11-04T03:00:00.000Z", subject: "删不删" }));
  writeFileSync(join(base, "plan.v1.json"), JSON.stringify({ version: 1, nodes: [], coverage: [], paths: [] }));
  writeFileSync(join(base, "nodes", "root", "spec.json"), JSON.stringify({ id: "node:ask3/root", type: "assign", goal: "g", accept: [] }));
  writeFileSync(join(base, "nodes", "root", "events.jsonl"), JSON.stringify({ ts: "2026-11-04T03:00:01.000Z", kind: "spawn", data: { cmd: "pi" } }) + "\n");
  writeFileSync(join(base, "nodes", "root", "gate.json"), JSON.stringify({ question: "删不删？", opts: ["删", "留着"] }));
  writeFileSync(join(base, "nodes", "root", "result.json"), JSON.stringify({ id: "node:ask3/root", type: "result", status: "waiting", summary: "等", finished_at: "2026-11-04T03:01:00.000Z" }));
  clearViewCache();
  const card = buildView(join(state, "runs"), { now: Date.parse("2026-11-04T04:00:00.000Z") }).inbox[0];
  assert.deepEqual(card.opts, [["删", "danger", "已选择·删"], ["留着", "solid", "已选择·留着"]]);
  rmSync(state, { recursive: true, force: true });
});

test("R5-05：idle_ms 来自最近一次事件/心跳，不是创建时间", () => {
  const state = mkdtempSync(join(tmpdir(), "aica-r6-idle-"));
  const base = join(state, "runs", "zombie");
  mkdirSync(join(base, "nodes", "root"), { recursive: true });
  writeFileSync(join(base, "run.json"), JSON.stringify({ root_id: "zombie", created_at: "2026-11-03T00:00:00.000Z", subject: "老 run" }));
  writeFileSync(join(base, "plan.v1.json"), JSON.stringify({ version: 1, nodes: [], coverage: [], paths: [] }));
  writeFileSync(join(base, "nodes", "root", "spec.json"), JSON.stringify({ id: "node:zombie/root", type: "assign", goal: "g", accept: [] }));
  writeFileSync(join(base, "nodes", "root", "events.jsonl"), JSON.stringify({ ts: "2026-11-03T00:00:01.000Z", kind: "spawn", data: { cmd: "pi" } }) + "\n");
  const now = Date.parse("2026-11-04T04:00:00.000Z");
  // 判据看的是事件时间戳（mtime 会被"复制/生成状态"污染，所以必须用 ts）
  const oldTs = new Date(now - 25 * 3600_000).toISOString();
  writeFileSync(join(base, "nodes", "root", "events.jsonl"),
    JSON.stringify({ ts: oldTs, kind: "spawn", data: { cmd: "pi" } }) + "\n");
  // mtime 故意新鲜：证明 mtime 不能冒充"有动静"
  utimesSync(join(base, "nodes", "root", "events.jsonl"), new Date(now), new Date(now));
  clearViewCache();
  const r = buildView(join(state, "runs"), { now }).runs.find(x => x.id === "zombie");
  assert.ok(r, "run 应该被投影出来");
  assert.ok(r.idle_ms != null && r.idle_ms > 24 * 3600_000, `idle_ms 应大于 24h，实际 ${r.idle_ms}`);
  assert.equal(r.status, "working", "僵尸 run 的磁盘状态仍是 working —— 由 UI 按 idle_ms 判「疑似卡住」");
  // 心跳刷新后 idle_ms 归零附近
  const freshTs = new Date(now - 5_000).toISOString();
  writeFileSync(join(base, "nodes", "root", "events.jsonl"),
    JSON.stringify({ ts: oldTs, kind: "spawn", data: { cmd: "pi" } }) + "\n" +
    JSON.stringify({ ts: freshTs, kind: "tool_call", data: { call_id: "c1", tool: "read", args: {} } }) + "\n");
  clearViewCache();
  const r2 = buildView(join(state, "runs"), { now }).runs.find(x => x.id === "zombie");
  assert.ok(r2.idle_ms != null && r2.idle_ms < 60_000, `新事件后 idle_ms 应变小，实际 ${r2.idle_ms}`);
  rmSync(state, { recursive: true, force: true });
});

test("R5-05：lastActivityMs 直接算（无时间戳 → null）", () => {
  const dir = mkdtempSync(join(tmpdir(), "aica-r6-last-"));
  rmSync(dir, { recursive: true, force: true });
  assert.equal(lastActivityMs(dir, "nope", [], Date.now()), null);
});




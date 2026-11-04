// S17 单元测试：events.jsonl → step 列表 / turn 结局闭集。
// 用合成事件覆盖双写来源（transcribe + aica-pi）、无 call_id 的旧写入器、截断诚实性。
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSteps, projectTurn, readEvents, type EvLine, type StepView } from "../view.ts";

const FIXTURES = fileURLToPath(new URL("./fixtures/runs/", import.meta.url));
const TS = "2026-01-01T00:00:00.000Z";
const e = (kind: string, data: Record<string, unknown>, ts = TS) => ({ kind, ts, data });
const lines = (evs: any[]): EvLine[] => evs.map((ev, i) => ({ i, ev }));
const steps = (evs: any[], opts?: { lines?: number; live?: boolean }): StepView[] => buildSteps(lines(evs), opts);

test("steps：双写来源（transcribe tool_call/tool_execution + aica-pi phase start/end）合并成一步", () => {
  const s = steps([
    e("tool_execution", { phase: "start", call_id: "c1", tool: "bash", args: '{"command":"echo hi"}' }),
    e("tool_call", { call_id: "c1", tool: "bash", args: '{"command":"echo hi"}' }),
    e("tool_execution", { phase: "end", call_id: "c1", tool: "bash", is_error: false, duration_ms: 12, output: "hi\n" }),
    e("tool_execution", { call_id: "c1", tool: "bash", durationMs: 12, isError: false, result: "hi\n" }),
  ]);
  assert.equal(s.length, 1, "同一 call_id 只应出一行");
  assert.deepEqual([s[0].name, s[0].st, s[0].ms], ["bash", "ok", 12]);
  assert.equal(s[0].args, '{"command":"echo hi"}');
  assert.deepEqual(s[0].out, ["hi"]);
  assert.equal(s[0].i, 0, "行号取首次出现位置（可回溯）");
});

test("steps：旧写入器 tool_call + tool_result（无 call_id）按工具名配对", () => {
  const s = steps([
    e("tool_call", { tool: "ls", args: '{"path":"src/"}' }),
    e("tool_result", { tool: "ls", is_error: false, output: "a.ts\nb.ts" }),
    e("tool_call", { tool: "read", args: '{"path":"x"}' }),
    e("tool_result", { tool: "read", is_error: true, output: "ENOENT: x" }),
  ]);
  assert.deepEqual(s.map(x => x.st), ["ok", "err"], "同一工具的两次调用不能串味");
  assert.deepEqual(s[0].out, ["a.ts", "b.ts"]);
});

test("steps：孤立 end（只有结果没有 start）也要出一条，不许丢", () => {
  const s = steps([e("tool_execution", { call_id: "zz", tool: "grep", isError: false, result: "hit" })]);
  assert.equal(s.length, 1);
  assert.equal(s[0].name, "grep");
  assert.equal(s[0].st, "ok");
});

test("steps：tool_update 挂到同 call 的步骤上，未收口时按 live 判 run/lost", () => {
  const evs = [
    e("tool_call", { call_id: "c2", tool: "bash", args: '{"command":"npm test"}' }),
    e("tool_update", { call_id: "c2", delta: "line1\nline2" }),
  ];
  const run = steps(evs, { live: true });
  assert.deepEqual(run[0].out, ["line1", "line2"]);
  assert.equal(run[0].st, "run");
  const lost = steps(evs, { live: false });
  assert.equal(lost[0].st, "lost", "有 start 无 end 且 worker 不在 = lost（Q1 不静默失败）");
});

test("steps：file_edit 投影成 edit step，带路径末段与 +N −M", () => {
  const s = steps([e("file_edit", { path: "src/a.ts", kind: "update", plus: 12, minus: 3, preview: "-old\n+new" })]);
  assert.equal(s[0].kind, "edit");
  assert.equal(s[0].name, "update a.ts");
  assert.equal(s[0].args, "src/a.ts");
  assert.deepEqual(s[0].out, ["-old", "+new", "+12 -3"]);
  assert.equal(s[0].st, "ok");
});

test("steps：file_edit 与同 call 的 tool_call 合并成一行（一次调用一行）", () => {
  const s = steps([
    e("tool_call", { call_id: "w1", tool: "write", args: '{"path":"notes/a.md"}' }),
    e("file_edit", { call_id: "w1", path: "notes/a.md", kind: "update", plus: 3, minus: 1, preview: "+ a\n- b" }),
    e("tool_execution", { call_id: "w1", tool: "write", isError: false, durationMs: 40, result: "ok" }),
  ]);
  assert.equal(s.length, 1, "tool_call + file_edit 不许出现两行");
  assert.deepEqual([s[0].kind, s[0].name, s[0].st, s[0].ms], ["edit", "update a.md", "ok", 40]);
  assert.deepEqual(s[0].out, ["+ a", "- b", "+3 -1", "ok"]);
});

test("steps：截断必须自证——out 前 N 行 + total/truncated", () => {
  const body = Array.from({ length: 60 }, (_, i) => `L${i + 1}`).join("\n");
  const s = steps([e("tool_call", { call_id: "c3", tool: "bash", args: "{}" }),
                   e("tool_execution", { call_id: "c3", tool: "bash", isError: false, result: body })]);
  assert.equal(s[0].out.length, 40, "默认给 40 行（与 UI 展开上限一致）");
  assert.equal(s[0].total, 60);
  assert.equal(s[0].truncated, true);
  const small = steps([e("tool_execution", { call_id: "c3", tool: "bash", isError: false, result: body })], { lines: 5 });
  assert.equal(small[0].out.length, 5);
  assert.equal(small[0].truncated, true);
});

test("steps：源事件本身是 300 字预览时 capped=true（全文不在事件里）", () => {
  const capped = steps([e("tool_call", { call_id: "c4", tool: "read", args: "{}" }),
                        e("tool_execution", { call_id: "c4", tool: "read", isError: false, result: "long text…" })]);
  assert.equal(capped[0].capped, true);
  const full = steps([e("tool_execution", { call_id: "c5", tool: "read", isError: false, result: "short" })]);
  assert.equal(full[0].capped, false);
});

test("steps：ref= 溢写引用被带出（A6）", () => {
  const s = steps([e("tool_execution", { call_id: "c6", tool: "agent_desktop", isError: false,
    output: "ref=artifacts/ad-1234.txt\n{\"ok\":true}" })]);
  assert.equal(s[0].ref, "artifacts/ad-1234.txt");
});

test("steps：退出码优先取显式字段，其次从正文认", () => {
  const explicit = steps([e("tool_execution", { call_id: "c7", tool: "bash", isError: true, exit: 5, result: "boom" })]);
  assert.equal(explicit[0].exit, 5);
  const textual = steps([e("tool_execution", { call_id: "c8", tool: "bash", isError: true, result: "npm ERR\nexit code 2" })]);
  assert.equal(textual[0].exit, 2);
  const none = steps([e("tool_execution", { call_id: "c9", tool: "read", isError: false, result: "ok" })]);
  assert.equal(none[0].exit, null);
});

test("steps：args 摘要单行化（折叠空白、封顶 160 字）", () => {
  const s = steps([e("tool_call", { call_id: "ca", tool: "bash", args: '{"command":\n  "echo   a\\n  b"}' })]);
  assert.equal(s[0].args.includes("\n"), false);
  const long = steps([e("tool_call", { call_id: "cb", tool: "bash", args: "x".repeat(400) })]);
  assert.equal(long[0].args.length, 161, "160 字 + 省略号");
  assert.ok(long[0].args.endsWith("…"));
});

test("steps：非工具事件不铺开（反模式 A-1）", () => {
  const s = steps([
    e("spawn", { cmd: "pi" }), e("message", { text: "hi" }), e("session", {}),
    e("turn", { i: 1 }), e("gate", { question: "?" }), e("exit", { code: 0 }), e("agent_message", { text: "x" }),
  ]);
  assert.deepEqual(s, []);
});

test("steps：真实夹具事件（wb-fixture-demo1/root/fetch）→ 3 步，参数与状态可读", () => {
  const evs = readEvents(join(FIXTURES, "wb-fixture-demo1", "nodes", "root", "fetch", "events.jsonl"));
  const s = buildSteps(evs);
  assert.deepEqual(s.map(x => x.name), ["ls", "read", "write"]);
  assert.deepEqual(s.map(x => x.st), ["ok", "ok", "ok"]);
  assert.equal(s[0].args, '{"path":"src/"}');
  assert.deepEqual(s[0].out, ["cli.ts", "daemon.ts", "envelope.ts", "runs.ts"]);
});

// ---------------------------------------------------------------- turn 结局闭集

test("turn：done → completed（带 result 摘要）", () => {
  const t = projectTurn(lines([e("spawn", {}), e("exit", { code: 0 })]), { status: "done", summary: "做好了" }, false);
  assert.deepEqual(t, { state: "completed", reason: "做好了", code: 0 });
});

test("turn：max-tokens 压过 completed（A9）", () => {
  const evs = [e("message", { stopReason: "maxTokens", text: "被截断" }), e("exit", { code: 0 })];
  const t = projectTurn(lines(evs), { status: "done", summary: "看似完成" }, false);
  assert.equal(t.state, "max-tokens");
});

test("turn：abort 事件 → cancelled（不是 failed）", () => {
  const evs = [e("abort", { reason: "用户中止" }), e("exit", { code: -1 })];
  const t = projectTurn(lines(evs), { status: "failed", summary: "aborted by user" }, false);
  assert.equal(t.state, "cancelled");
});

test("turn：exit≠0 且无 result → failed，原因带退出码", () => {
  const t = projectTurn(lines([e("spawn", {}), e("exit", { code: 2, error: "boom" })]), null, false);
  assert.equal(t.state, "failed");
  assert.match(String(t.reason), /2|boom/);
  assert.equal(t.code, 2);
});

test("turn：exit=0 但无 result → interrupted（不谎称完成）", () => {
  const t = projectTurn(lines([e("spawn", {}), e("exit", { code: 0 })]), null, false);
  assert.equal(t.state, "interrupted");
  assert.match(String(t.reason), /无 result/);
});

test("turn：有 spawn 无 exit 且 worker 已不在 → interrupted（Q1 幽灵节点可见）", () => {
  const t = projectTurn(lines([e("spawn", {})]), null, false);
  assert.equal(t.state, "interrupted");
  assert.match(String(t.reason), /无 exit/);
});

test("turn：有 spawn 无 exit 但 worker 在 → running", () => {
  const t = projectTurn(lines([e("spawn", {})]), null, true);
  assert.equal(t.state, "running");
});

test("turn：waiting / me → running（等的是人，不是 turn 结束）", () => {
  assert.equal(projectTurn(lines([]), { status: "waiting" }, true).state, "running");
  assert.equal(projectTurn(lines([]), { status: "me" }, true).state, "running");
});

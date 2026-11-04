// S21 验收：事件 seq / 命令幂等 / 孤儿与续跑预算 / checkpoint / fork / 中断收尾。
// runs.ts 在 import 时按 AICA_STATE 算 RUNS_DIR，所以先设环境变量再动态 import。
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STATE = mkdtempSync(join(tmpdir(), "aica-s21-"));
process.env.AICA_STATE = STATE;

const R = await import("../../src/runs.ts");

const RUNS = join(STATE, "runs");
const nodeDirOf = (rootId: string, path = "root"): string => {
  const dir = R.nodeDir(rootId, path);
  mkdirSync(dir, { recursive: true });
  return dir;
};
const eventsOf = (rootId: string, path = "root") => R.readEvents(rootId, path);
const kinds = (rootId: string, path = "root") => eventsOf(rootId, path).map((e) => e.kind);

/** 拿一个"确定已经死了"的 pid：拉起一个立刻退出的子进程，等它 exit */
function deadPid(): Promise<number> {
  return new Promise((res) => {
    const c = spawn(process.execPath, ["-e", "0"], { stdio: "ignore", windowsHide: true });
    const pid = c.pid!;
    c.on("exit", () => setTimeout(() => res(pid), 50));
  });
}

/** 造一个 run + root spec */
function seedRun(subject: string, extra: Record<string, unknown> = {}): string {
  const { rootId } = R.createRun({ subject });
  R.writeSpec(rootId, "root", { type: "assign", goal: `${subject} 的目标`, accept: ["一句话"], ...extra } as any);
  return rootId;
}
const isPending = (rootId: string): boolean => R.pendingNodes().some((p) => p.rootId === rootId && p.path === "root");

// ---------------------------------------------------------------- 1. 事件 seq

test("seq：节点内单调递增；worker 直写（无 seq）之后仍然递增、不撞号", () => {
  const rootId = seedRun("seq 单调");
  const dir = nodeDirOf(rootId);
  R.appendEvent(rootId, "root", { kind: "turn", data: { i: 1 } });
  R.appendEvent(rootId, "root", { kind: "turn_end", data: { i: 1 } });
  assert.deepEqual(eventsOf(rootId).map((e) => e.seq), [1, 2]);

  // worker 直写一行（aica-pi 的 events.ts 不带 seq）→ 下一次写要重扫，不能复用缓存里的 3
  appendFileSync(join(dir, "events.jsonl"), JSON.stringify({ ts: "T", kind: "todo", data: { items: [] } }) + "\n", "utf8");
  R.appendEvent(rootId, "root", { kind: "message", data: { text: "x" } });
  assert.deepEqual(eventsOf(rootId).map((e) => e.seq), [1, 2, null, 4], "外部追加后 seq 跳过 3，保持严格递增");
  assert.equal(R.lastSeq(rootId, "root"), 4);
});

test("since：seq 游标只返回 N 之后；纯老文件退回行号语义（mode 自证）", () => {
  const rootId = seedRun("since 游标");
  for (let i = 0; i < 3; i++) R.appendEvent(rootId, "root", { kind: "turn", data: { i } });
  const cut = R.readEventsSince(rootId, "root", 1);
  assert.equal(cut.mode, "seq");
  assert.deepEqual(cut.events.map((e) => e.seq), [2, 3]);
  assert.equal(cut.next, 3, "next 给的是下次要用的 seq 游标");
  assert.equal(cut.total, 3);

  const legacyId = seedRun("老文件");
  const legacyDir = nodeDirOf(legacyId);
  writeFileSync(join(legacyDir, "events.jsonl"), [1, 2, 3].map((n) => JSON.stringify({ ts: "T", kind: "turn", data: { n } })).join("\n") + "\n", "utf8");
  const legacy = R.readEventsSince(legacyId, "root", 1);
  assert.equal(legacy.mode, "index");
  assert.equal(legacy.events.length, 2);
  assert.equal(legacy.unsequenced, 3);
});

// ---------------------------------------------------------------- 2. 命令幂等

test("幂等：同 cmd 同载荷只留一条 cmd 回执；载荷不同各留一条", () => {
  const rootId = seedRun("幂等");
  assert.equal(R.appendCmdOnce(rootId, "root", "done", { status: "done", summary: "ok" }), true);
  assert.equal(R.appendCmdOnce(rootId, "root", "done", { status: "done", summary: "ok" }), false, "重放不写第二条");
  assert.equal(R.appendCmdOnce(rootId, "root", "done", { status: "done", summary: "改主意了" }), true, "载荷不同是另一件事");
  const cmds = eventsOf(rootId).filter((e) => e.kind === "cmd");
  assert.equal(cmds.length, 2);
  assert.equal(cmds[0].data.cmd, "done");
});

// ---------------------------------------------------------------- 3. 孤儿 / 续跑预算

test("孤儿：pid 已死且无 result → failed(orphaned)，pendingNodes 不再拉起", async () => {
  const rootId = seedRun("孤儿节点");
  const pid = await deadPid();
  R.writeWorker(rootId, "root", { pid, started_at: new Date().toISOString(), cmd: "fake worker" });
  appendFileSync(join(nodeDirOf(rootId), "events.jsonl"), JSON.stringify({ ts: "T", kind: "spawn", data: { cmd: "fake" } }) + "\n", "utf8");

  assert.equal(R.workerLive(rootId, "root"), false);
  assert.equal(isPending(rootId), false, "孤儿不能被判回待拉起");
  const r = R.readResult(rootId, "root")!;
  assert.equal(r.status, "failed");
  assert.equal((r as any).reason, "orphaned");
  assert.match(String(r.summary), /orphaned/);
  assert.equal(existsSync(join(nodeDirOf(rootId), "worker.json")), false, "锁已清");
  assert.ok(kinds(rootId).includes("orphan"), "留了一条 orphan 事件");
  // 再跑一轮也不会重复标记（result 已存在 → reapOrphan 返回 false，继续不进 pending）
  assert.equal(R.reapOrphan(rootId, "root"), false);
  assert.equal(eventsOf(rootId).filter((e) => e.kind === "orphan").length, 1);
});

test("孤儿不误伤：pid 还活着 → 不标 failed，只是不入队", () => {
  const rootId = seedRun("活着的 worker");
  R.writeWorker(rootId, "root", { pid: process.pid, started_at: new Date().toISOString(), cmd: "self" });
  assert.equal(R.workerLive(rootId, "root"), true);
  assert.equal(isPending(rootId), false);
  assert.equal(R.readResult(rootId, "root"), null, "有活 pid 就不许写 result");
  assert.equal(R.reapOrphan(rootId, "root"), false);
});

test("续跑预算：attempts 到上限 → failed(resume exhausted) 且不再拉起；差一次仍入队", () => {
  const okId = seedRun("还能续跑");
  const okDir = nodeDirOf(okId);
  writeFileSync(join(okDir, "attempts.json"), JSON.stringify({ n: R.MAX_ATTEMPTS - 1 }) + "\n", "utf8");
  assert.equal(isPending(okId), true);

  const badId = seedRun("续跑耗尽");
  const badDir = nodeDirOf(badId);
  writeFileSync(join(badDir, "attempts.json"), JSON.stringify({ n: R.MAX_ATTEMPTS }) + "\n", "utf8");
  assert.equal(isPending(badId), false);
  const r = R.readResult(badId, "root")!;
  assert.equal(r.status, "failed");
  assert.equal((r as any).reason, "resume exhausted");
  assert.ok(kinds(badId).includes("resume_exhausted"));
  assert.match(String(r.summary), /resume exhausted/);
});

test("attempts：每次拉起 +1，result 落定后清零", () => {
  const rootId = seedRun("attempts 计数");
  const w1 = R.writeWorker(rootId, "root", { pid: process.pid, started_at: "t1", cmd: "x" });
  const w2 = R.writeWorker(rootId, "root", { pid: process.pid, started_at: "t2", cmd: "x" });
  assert.deepEqual([w1.attempts, w2.attempts], [1, 2]);
  assert.equal(R.readAttempts(rootId, "root"), 2);
  R.writeResult(rootId, "root", { status: "done", summary: "ok" });
  assert.equal(R.readAttempts(rootId, "root"), 0, "有 result 就不再算崩溃循环");
});

// ---------------------------------------------------------------- 4. checkpoint

test("checkpoint：turn 边界写 {last_turn,last_event_seq,at}，读回来一致且 seq 对得上", () => {
  const rootId = seedRun("checkpoint");
  R.appendEvent(rootId, "root", { kind: "turn", data: { i: 1 } });
  R.appendEvent(rootId, "root", { kind: "turn_end", data: { i: 1 } });
  const seq = R.lastSeq(rootId, "root");
  const cp = { last_turn: 1, last_event_seq: seq, at: "2026-11-04T00:00:00.000Z" };
  R.writeCheckpoint(rootId, "root", cp);
  assert.deepEqual(R.readCheckpoint(rootId, "root"), cp);
  assert.equal(R.readCheckpoint(seedRun("没有 checkpoint"), "root"), null);
});

// ---------------------------------------------------------------- 5. 中断收尾

test("中断收尾：遗留 tool_call 补 aborted 的 tool_execution，补过的不再补", () => {
  const rootId = seedRun("中断收尾");
  R.appendEvent(rootId, "root", { kind: "tool_call", data: { call_id: "call_a", tool: "bash", args: "{}" } });
  R.appendEvent(rootId, "root", { kind: "tool_call", data: { call_id: "call_b", tool: "read", args: "{}" } });
  R.appendEvent(rootId, "root", { kind: "tool_execution", data: { phase: "end", call_id: "call_b", tool: "read", is_error: false } });

  assert.equal(R.closeDanglingTools(rootId, "root"), 1, "只补没收回的那一个");
  const patched = eventsOf(rootId).filter((e) => e.kind === "tool_execution" && e.data?.call_id === "call_a");
  assert.equal(patched.length, 1);
  assert.equal(patched[0].data.is_error, true);
  assert.equal(patched[0].data.reason, "aborted");
  assert.equal(R.closeDanglingTools(rootId, "root"), 0, "幂等：补过的不再补");
});

// ---------------------------------------------------------------- 6. fork

test("fork：spec 保留并改写 id，result/events 不复制，artifacts 跟走，forked_from 记来源", () => {
  const rootId = seedRun("分叉源", { budget: { tokens: 1234 }, tools: ["bash"] });
  R.writeResult(rootId, "root", { status: "done", summary: "原节点做完了" });
  R.appendEvent(rootId, "root", { kind: "turn", data: { i: 1 } });
  const srcDir = nodeDirOf(rootId);
  mkdirSync(join(srcDir, "artifacts"), { recursive: true });
  writeFileSync(join(srcDir, "artifacts", "out.txt"), "hello fork", "utf8");

  const f = R.forkNode(rootId, "root")!;
  assert.ok(f && f.root_id && f.root_id !== rootId);
  assert.equal(f.forked_from.root_id, rootId);
  assert.equal(f.forked_from.path, "root");

  const spec = R.readSpec(f.root_id, "root")!;
  assert.equal(spec.id, `node:${f.root_id}/root`, "id 改写到新 run");
  assert.equal(spec.goal, "分叉源 的目标", "goal 等字段原样保留");
  assert.deepEqual(spec.budget, { tokens: 1234 });
  assert.equal((spec as any).forked_from.root_id, rootId);
  assert.equal(R.readResult(f.root_id, "root"), null, "result 不复制");
  assert.equal(eventsOf(f.root_id).length, 0, "events 不复制");
  assert.equal(readFileSync(join(nodeDirOf(f.root_id), "artifacts", "out.txt"), "utf8"), "hello fork");
  assert.equal(readFileSync(join(srcDir, "artifacts", "out.txt"), "utf8"), "hello fork", "源节点不受影响");

  const meta = JSON.parse(readFileSync(join(RUNS, f.root_id, "run.json"), "utf8"));
  assert.equal(meta.kind, "fork");
  assert.equal(meta.forked_from.root_id, rootId);
  assert.equal(R.forkNode(rootId, "root/不存在"), null, "没有 spec 的节点 → null");
});

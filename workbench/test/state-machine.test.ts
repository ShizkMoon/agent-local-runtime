// R4 G-2：result 状态机 —— 闭集迁移、非法迁移保旧状态 + state_reject、CLI 返回 ILLEGAL_TRANSITION。
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const STATE = mkdtempSync(join(tmpdir(), "aica-r4-sm-"));
process.env.AICA_STATE = STATE;
const R = await import("../../src/runs.ts");
const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "cli.ts");

const spec = (id: string) => ({ id, type: "assign", goal: "g", accept: ["x"], budget: { depth_left: 1 } }) as any;

function freshNode(path = "root") {
  const { rootId } = R.createRun({ subject: "G-2 状态机" });
  R.writeSpec(rootId, path, spec(`node:${rootId}/${path}`));
  return { rootId, dir: R.nodeDir(rootId, path) };
}

const eventsOf = (rootId: string, path = "root") => R.readEvents(rootId, path);
const rejects = (rootId: string, path = "root") => eventsOf(rootId, path).filter((e: any) => e.kind === "state_reject");

test("迁移闭集：running→waiting|done|failed，waiting→running|done|failed，done/failed 终止", () => {
  assert.equal(R.canTransit(null, "waiting"), true, "没有 result = running");
  assert.equal(R.canTransit("running", "waiting"), true);
  assert.equal(R.canTransit("running", "done"), true);
  assert.equal(R.canTransit("running", "failed"), true);
  assert.equal(R.canTransit("waiting", "running"), true);
  assert.equal(R.canTransit("waiting", "done"), true);
  assert.equal(R.canTransit("waiting", "failed"), true);
  assert.equal(R.canTransit("done", "failed"), false, "终止态不可覆写");
  assert.equal(R.canTransit("done", "waiting"), false);
  assert.equal(R.canTransit("failed", "done"), false);
  assert.equal(R.canTransit("done", "done"), true, "同状态幂等");
});

test("transitResult：running→waiting→done 合法；done→failed 非法且保留旧状态 + state_reject", () => {
  const { rootId } = freshNode();
  const a = R.transitResult(rootId, "root", { status: "waiting", summary: "问一下" }, { source: "test" });
  assert.equal(a.ok, true);
  assert.equal(R.readResult(rootId, "root")?.status, "waiting");

  const b = R.transitResult(rootId, "root", { status: "done", summary: "完成" }, { source: "test" });
  assert.equal(b.ok, true);

  const c = R.transitResult(rootId, "root", { status: "failed", summary: "想覆盖" }, { source: "test" });
  assert.equal(c.ok, false);
  assert.equal(c.code, "ILLEGAL_TRANSITION");
  assert.equal(c.from, "done");
  assert.equal(c.to, "failed");
  const kept = R.readResult(rootId, "root")!;
  assert.equal(kept.status, "done", "旧状态必须保留");
  assert.equal(kept.summary, "完成", "旧内容不被覆盖");

  const rej = rejects(rootId);
  assert.equal(rej.length, 1);
  assert.deepEqual(rej[0].data, { from: "done", to: "failed", source: "test" });
});

test("patchResult：带 status 走状态机（非法 → state_reject + 原样返回）；不带 status 照旧", () => {
  const { rootId } = freshNode();
  R.transitResult(rootId, "root", { status: "done", summary: "完成" });
  const out = R.patchResult(rootId, "root", { status: "waiting", summary: "x" });
  assert.equal(out?.status, "done", "非法补丁不生效");
  assert.equal(rejects(rootId).length, 1);

  const spent = R.patchResult(rootId, "root", { spent: { tokens: 12 } });
  assert.equal(spent?.spent.tokens, 12);
  assert.equal(R.readResult(rootId, "root")?.status, "done");
});

test("resolveWaiting：waiting 可归档回 running；done 节点写 state_reject 且不归档", () => {
  const { rootId } = freshNode();
  R.transitResult(rootId, "root", { status: "waiting", summary: "等待" });
  assert.equal(R.resolveWaiting(rootId, "root"), true);
  assert.equal(existsSync(join(R.nodeDir(rootId, "root"), "result.resolved.json")), true);
  assert.equal(R.readResult(rootId, "root"), null);

  const b = freshNode();
  R.transitResult(b.rootId, "root", { status: "done", summary: "完成" });
  assert.equal(R.resolveWaiting(b.rootId, "root"), false);
  assert.equal(rejects(b.rootId).at(-1)?.data.from, "done");
  assert.equal(R.readResult(b.rootId, "root")?.status, "done");
});

test("CLI：done 之后再 fail → ILLEGAL_TRANSITION + 退出码 1 + 旧 result 不变；gate 在 done 上不留孤儿 gate.json", () => {
  const { rootId, dir } = freshNode();
  const env = { ...process.env, AICA_STATE: STATE };
  const run = (args: string[]) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env });

  const done = run(["done", "--run", rootId, "--node", "root", "--summary", "完成"]);
  assert.equal(done.status, 0, String(done.stdout) + String(done.stderr));

  const fail = run(["fail", "--run", rootId, "--node", "root", "--summary", "想覆盖"]);
  assert.equal(fail.status, 1, "G-1：失败退出码 1");
  const envj = JSON.parse(String(fail.stdout).trim().split("\n").pop()!);
  assert.equal(envj.ok, false);
  assert.equal(envj.error.code, "ILLEGAL_TRANSITION");
  assert.equal(envj.data.from, "done");
  assert.equal(envj.data.to, "failed");
  assert.equal(/ at .*\.ts:\d+/.test(String(envj.error.message)), false, "无裸栈");
  assert.equal(R.readResult(rootId, "root")?.summary, "完成");

  const gate = run(["gate", "--run", rootId, "--node", "root", "--question", "还需要人吗"]);
  assert.equal(gate.status, 1);
  assert.equal(JSON.parse(String(gate.stdout).trim().split("\n").pop()!).error.code, "ILLEGAL_TRANSITION");
  assert.equal(existsSync(join(dir, "gate-req.json")), false, "终止态节点不该留下孤儿 gate-req");
});

test("CLI：waiting→done 合法（正常路径不误伤）", () => {
  const { rootId } = freshNode();
  const env = { ...process.env, AICA_STATE: STATE };
  const run = (args: string[]) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env });
  assert.equal(run(["gate", "--run", rootId, "--node", "root", "--question", "确认"]).status, 0);
  const done = run(["done", "--run", rootId, "--node", "root", "--summary", "批准后完成"]);
  assert.equal(done.status, 0, String(done.stdout));
  assert.equal(R.readResult(rootId, "root")?.status, "done");
});

test("steer：ar reply --mode steer → UNSUPPORTED + 退出码 1，不假装成功也不改 spec", () => {
  const { rootId } = freshNode();
  const env = { ...process.env, AICA_STATE: STATE };
  const run = (args: string[]) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env });

  const steer = run(["reply", "--run", rootId, "--node", "root", "--text", "插一句", "--mode", "steer"]);
  assert.equal(steer.status, 1, "G-1：失败退出码 1");
  const j = JSON.parse(String(steer.stdout).trim().split("\n").pop()!);
  assert.equal(j.ok, false);
  assert.equal(j.error.code, "UNSUPPORTED");
  assert.match(j.error.message, /pi RPC/);
  assert.match(j.error.message, /interrupt|queue/);
  assert.equal((R.readSpec(rootId, "root") as any)?.reply, undefined, "steer 不落 spec.reply");

  // 对照：queue 仍然正常（显式人操作可用的两条路之一）
  const q = run(["reply", "--run", rootId, "--node", "root", "--text", "下一轮看这条", "--mode", "queue"]);
  assert.equal(q.status, 0, String(q.stdout));
  assert.equal((R.readSpec(rootId, "root") as any)?.reply.length, 1);
});

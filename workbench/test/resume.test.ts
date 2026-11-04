// R6：ar resume —— 按 cwd 找最近 run、注入 --text、返回 {root_id,node,resumed_from,delivery}；终态节点归档旧 result 后重排。
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const STATE = mkdtempSync(join(tmpdir(), "aica-r6-resume-"));
process.env.AICA_STATE = STATE;
const R = await import("../../src/runs.ts");
const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "cli.ts");
const NODE = process.execPath;

const spec = (goal: string) => ({ type: "assign", goal, accept: ["产出"], budget: { depth_left: 1 } }) as any;

function mkRun(cwd: string, goal = "任务") {
  const { rootId } = R.createRun({ subject: "resume 用例", cwd });
  R.writeSpec(rootId, "root", spec(goal));
  return rootId;
}

test("createRun 记 cwd；latestRunForCwd 按 cwd 精确匹配并取 mtime 最新", () => {
  const a = mkdtempSync(join(tmpdir(), "aica-r6-cwd-a-"));
  const b = mkdtempSync(join(tmpdir(), "aica-r6-cwd-b-"));
  const runA = mkRun(a, "A 的任务");
  assert.equal(JSON.parse(readFileSync(join(STATE, "runs", runA, "run.json"), "utf8")).cwd, a);

  // 同 cwd 第二个 run：把第一个的 run.json mtime 拨旧，确保取最新
  const runA2 = mkRun(a, "A 的第二个任务");
  const old = new Date(Date.now() - 60_000);
  utimesSync(join(STATE, "runs", runA, "run.json"), old, old);

  const hit = R.latestRunForCwd(a)!;
  assert.equal(hit.rootId, runA2, "取最近一次");
  assert.equal(R.latestRunForCwd(b), null, "别的目录不匹配");
  assert.equal(R.latestRunForCwd(join(a, "sub")), null, "不做祖先匹配（精确 cwd）");
});

test("resumeRun：无 result 的节点 → 注入 reply、delivery=stored、进 pending", () => {
  const dir = mkdtempSync(join(tmpdir(), "aica-r6-cwd-c-"));
  const rootId = mkRun(dir);
  const r = R.resumeRun(rootId, "接着做第二步");
  assert.equal(r.root_id, rootId);
  assert.equal(r.node, `node:${rootId}/root`);
  assert.equal(r.resumed_from, null);
  assert.equal(r.delivery, "stored");
  const specAfter = R.readSpec(rootId, "root")!;
  assert.equal(specAfter.reply?.at(-1)?.text, "接着做第二步");
  assert.equal(R.pendingNodes().some((p: any) => p.rootId === rootId && p.path === "root"), true);
});

test("resumeRun：done 节点 → 归档 result.prev.json + resume 事件，重新排队，delivery=resumed", () => {
  const dir = mkdtempSync(join(tmpdir(), "aica-r6-cwd-d-"));
  const rootId = mkRun(dir);
  R.transitResult(rootId, "root", { status: "done", summary: "第一轮完成" }, { source: "test" });
  assert.equal(R.readResult(rootId, "root")?.status, "done");

  const r = R.resumeRun(rootId, "继续加点东西");
  assert.equal(r.resumed_from, "done");
  assert.equal(r.delivery, "resumed");
  const nd = R.nodeDir(rootId, "root");
  assert.equal(existsSync(join(nd, "result.json")), false, "旧 result 已归档，节点重新变 pending");
  assert.equal(JSON.parse(readFileSync(join(nd, "result.prev.json"), "utf8")).summary, "第一轮完成");
  const ev = R.readEvents(rootId, "root").filter((e: any) => e.kind === "resume");
  assert.equal(ev.length, 1);
  assert.equal(ev[0].data.from, "done");
  assert.equal(R.readSpec(rootId, "root")?.reply?.at(-1)?.text, "继续加点东西");
  assert.equal(R.pendingNodes().some((p: any) => p.rootId === rootId), true);
});

test("resumeRun：failed 节点同样可续；不存在的节点抛 NO_NODE", () => {
  const dir = mkdtempSync(join(tmpdir(), "aica-r6-cwd-e-"));
  const rootId = mkRun(dir);
  R.transitResult(rootId, "root", { status: "failed", summary: "崩了" }, { source: "test" });
  const r = R.resumeRun(rootId, "重试一次");
  assert.equal(r.resumed_from, "failed");
  assert.equal(r.delivery, "resumed");
  assert.throws(() => R.resumeRun(rootId, "x", "root/nope"), /NO_NODE/);
});

test("真机 ar resume：--cwd 找到最近 run 并返回 delivery；无匹配 → NOT_FOUND；--run 指定可用", () => {
  const dir = mkdtempSync(join(tmpdir(), "aica-r6-cwd-f-"));
  const rootId = mkRun(dir, "真机 resume");
  const env = { ...process.env, AICA_STATE: STATE };
  const run = (args: string[]) => spawnSync(NODE, [CLI, ...args], { encoding: "utf8", env });
  const j = (r: any) => JSON.parse(String(r.stdout).trim().split("\n").pop()!);

  const ok = run(["resume", "--cwd", dir, "--text", "继续"]);
  assert.equal(ok.status, 0, String(ok.stdout) + String(ok.stderr));
  const e = j(ok);
  assert.equal(e.ok, true);
  assert.equal(e.data.root_id, rootId);
  assert.equal(e.data.node, `node:${rootId}/root`);
  assert.equal(e.data.resumed_from, null);
  assert.match(String(e.data.delivery), /stored|resumed|queued/);
  assert.equal(e.data.matched_by, `cwd:${dir}`);

  const empty = mkdtempSync(join(tmpdir(), "aica-r6-cwd-g-"));
  const nf = run(["resume", "--cwd", empty]);
  assert.equal(nf.status, 1, "G-1：NOT_FOUND 退出码 1");
  assert.equal(j(nf).error.code, "NOT_FOUND");

  const byRun = run(["resume", "--run", rootId, "--text", "指定 run"]);
  assert.equal(byRun.status, 0);
  assert.equal(j(byRun).data.matched_by, "run");
});

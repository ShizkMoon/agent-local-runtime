// S16 快照测试：buildView(真实 run 目录) 的输出必须逐字节稳定。
// 三个夹具见 fixtures/README.md；不确定性（mtime / now / 时区）在这里被钉死。
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildView, hhmm, type ViewPayload } from "../view.ts";

const FIXTURES = fileURLToPath(new URL("./fixtures/runs/", import.meta.url));
const SNAPSHOTS = fileURLToPath(new URL("./snapshots/", import.meta.url));
const FIXED_MTIME = new Date("2026-11-03T00:00:00Z");
const NOW = Date.parse("2026-11-04T00:00:00Z");
const RUN_IDS = ["372ce026-be1f", "wb-fixture-demo1", "ef2706d6-2a3c"] as const;

/** 把夹具里每个文件的 mtime 钉死，让"耗时 el"可复现 */
function pinMtimes(dir: string): void {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) pinMtimes(p);
    else utimesSync(p, FIXED_MTIME, FIXED_MTIME);
  }
}

/** 只归一"与环境有关"的位：时区 HH:MM、绝对路径。其余字段原样进快照。 */
function normalize(v: ViewPayload, runsDir: string): string {
  const copy = JSON.parse(JSON.stringify(v)) as any;
  copy.settled = (copy.settled as [string, string, string][]).map(([title, tm, id]) => [title, "<hh:mm>", id]);
  return JSON.stringify(copy, null, 1).split(runsDir.replace(/\\/g, "/")).join("<runs>/");
}

function matchSnapshot(name: string, actual: string): void {
  const file = join(SNAPSHOTS, `${name}.json`);
  if (!existsSync(file) || process.env.UPDATE_SNAPSHOTS === "1") {
    mkdirSync(SNAPSHOTS, { recursive: true });
    writeFileSync(file, actual + "\n", "utf8");
  }
  const want = readFileSync(file, "utf8").trimEnd();
  assert.equal(actual, want, `快照不一致：${file}\n（确认改动符合预期后：$env:UPDATE_SNAPSHOTS='1'; node --test workbench/test）`);
}

test("buildView：3 个真实 run 目录的快照", () => {
  pinMtimes(FIXTURES);
  const view = buildView(FIXTURES, { now: NOW });
  assert.deepEqual(view.runs.map(r => r.id), [...RUN_IDS], "run 列表顺序：新 created_at 在前");
  for (const id of RUN_IDS) {
    const run = view.runs.find(r => r.id === id)!;
    assert.ok(run, `缺少 run ${id}`);
    matchSnapshot(id, normalize({ runs: [run], inbox: view.inbox.filter(i => (i.id as string).includes(id)),
      settled: view.settled.filter(s => s[2] === id) } as ViewPayload, FIXTURES));
  }
});

test("buildView：纯函数——同一磁盘真相两次构建完全一致", () => {
  const a = buildView(FIXTURES, { now: NOW });
  const b = buildView(FIXTURES, { now: NOW });
  assert.deepEqual(a, b);
});

test("buildView：run 列表与旧实现等价（id / 状态 / 标题）", () => {
  const view = buildView(FIXTURES, { now: NOW });
  const triples = view.runs.map(r => [r.id, r.status, r.title]);
  assert.deepEqual(triples, [
    ["372ce026-be1f", "done", "smoke-tools"],
    ["wb-fixture-demo1", "failed", "workbench 冒烟夹具"],
    ["ef2706d6-2a3c", "working", "smoke test"],
  ]);
});

test("buildView：空目录/不存在的 runsDir 不抛，返回空视图", () => {
  assert.deepEqual(buildView(join(FIXTURES, "no-such-dir"), { now: NOW }), { runs: [], inbox: [], settled: [] });
});

test("buildView：settled 的行形状（标题 / HH:MM / rootId）", () => {
  const view = buildView(FIXTURES, { now: NOW });
  const endedAt = "2026-11-03T20:55:29.027Z";
  assert.deepEqual(view.settled, [["smoke-tools", hhmm(endedAt), "372ce026-be1f"]]);
  assert.match(hhmm(endedAt), /^\d\d:\d\d$/);
});

test("buildView：失败节点带 turn 人话原因（S17 失败有 reason）", () => {
  const view = buildView(FIXTURES, { now: NOW });
  const demo = view.runs.find(r => r.id === "wb-fixture-demo1")!;
  const summarize = demo.tree.find(n => n.path === "root/summarize")!;
  assert.equal(summarize.st, "failed");
  assert.equal(summarize.turn.state, "failed");
  assert.match(String(summarize.turn.reason), /ENOENT|失败|未物化|read/);
});

test("buildView：run 级工具时间线取根节点 steps（S17）", () => {
  const view = buildView(FIXTURES, { now: NOW });
  const real = view.runs.find(r => r.id === "372ce026-be1f")!;
  assert.deepEqual(real.steps.map(s => s.name), ["agent_desktop", "ev_done"]);
  assert.deepEqual(real.steps.map(s => s.st), ["ok", "ok"]);
  assert.equal(real.steps[0].ref, "artifacts/ad-fa7cd7db.txt", "溢写引用必须带出（A6）");
  assert.equal(real.steps[0].capped, true, "源事件是 300 字预览：capped 必须为 true（A7）");
  assert.ok(statSync(FIXTURES).isDirectory());
});

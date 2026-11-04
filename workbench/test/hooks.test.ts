// R3 §9.5：node_settled hook 的提案闭环（登记 STATE/proposals/index.jsonl + 节点 learn 事件 + 幂等）。
// hook 是独立子进程（daemon 用 execFileSync 调它），所以这里也按子进程跑，断言的是磁盘世界。
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "aica-pi", "hooks", "node_settled.mjs");
const STATE = mkdtempSync(join(tmpdir(), "aica-r3-hook-"));
process.env.AICA_STATE = STATE;

function nodeDirWith(proposal?: { slug: string; meta?: Record<string, unknown> } | null): string {
  const dir = mkdtempSync(join(tmpdir(), "aica-r3-node-"));
  writeFileSync(join(dir, "spec.json"), JSON.stringify({ id: "node:x/root" }) + "\n");
  writeFileSync(join(dir, "result.json"), JSON.stringify({ id: "node:x/root", status: "done", summary: "做完了", ...(proposal ? { proposal: proposal.slug } : {}) }) + "\n");
  if (proposal) {
    const pdir = join(dir, "proposals", proposal.slug);
    mkdirSync(pdir, { recursive: true });
    writeFileSync(join(pdir, "meta.json"), JSON.stringify({ slug: proposal.slug, risk: "low", ...(proposal.meta ?? {}) }) + "\n");
    writeFileSync(join(pdir, "patch.diff"), "--- a/docs/x.md\n+++ b/docs/x.md\n@@ -1,1 +1,1 @@\n-a\n+b\n");
  }
  return dir;
}

function runHook(dir: string, result: Record<string, unknown>, spec: Record<string, unknown> = { id: "node:x/root" }) {
  const r = spawnSync(process.execPath, [HOOK, dir], {
    encoding: "utf8",
    input: JSON.stringify({ spec, result }),
    env: { ...process.env, AICA_STATE: STATE },
    timeout: 20_000,
  });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(String(r.stdout).trim());
}

const indexLines = (): any[] => {
  const f = join(STATE, "proposals", "index.jsonl");
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
};
const learnEvents = (dir: string): any[] => {
  const f = join(dir, "events.jsonl");
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l)).filter((e) => e.kind === "learn");
};

test("hook：无 proposal 字段 → 行为不变（只写 hooks.log，不登记、不写 learn）", () => {
  const dir = nodeDirWith(null);
  const out = runHook(dir, { status: "done", summary: "没有提案" });
  assert.deepEqual(out, { dispatch: [] });
  assert.equal(indexLines().length, 0, "index.jsonl 不因普通节点出现");
  assert.equal(learnEvents(dir).length, 0);
  assert.match(readFileSync(join(dir, "hooks.log"), "utf8"), /node_settled node:x\/root status=done/);
});

test("hook：result.proposal（slug）→ 登记 index.jsonl + 节点 learn 事件", () => {
  const dir = nodeDirWith({ slug: "demo-opt" });
  const out = runHook(dir, { status: "done", summary: "提了个提案", proposal: "demo-opt" });
  assert.equal(out.dispatch.length, 0);
  assert.equal(out.proposal.registered, true);
  assert.equal(out.proposal.slug, "demo-opt");
  assert.equal(out.proposal.risk, "low");

  const idx = indexLines();
  assert.equal(idx.length, 1);
  assert.equal(idx[0].slug, "demo-opt");
  assert.equal(idx[0].node, "node:x/root");
  assert.equal(idx[0].risk, "low");
  assert.equal(idx[0].status, "pending");
  assert.deepEqual(idx[0].files, []);
  assert.ok(existsSync(idx[0].dir), "登记的目录真实存在");

  const learn = learnEvents(dir);
  assert.equal(learn.length, 1, "节点写一条 learn 事件（§9.5）");
  assert.equal(learn[0].data.proposal, "demo-opt");
  assert.equal(learn[0].data.risk, "low");
});

test("hook：重复触发幂等（index 只登记一次，learn 事件也不重复写）", () => {
  const dir = nodeDirWith({ slug: "idem" });
  const a = runHook(dir, { status: "done", summary: "第一次", proposal: "idem" });
  const b = runHook(dir, { status: "done", summary: "第二次", proposal: "idem" });
  assert.equal(a.proposal.registered, true);
  assert.equal(b.proposal.registered, false, "第二次只回 registered:false");
  assert.equal(indexLines().filter((x) => x.slug === "idem").length, 1, "index 只有一行");
  assert.equal(learnEvents(dir).length, 1, "learn 事件也只有一条");
});

test("hook：proposal 写成路径也能找到；不存在的提案不崩、不登记", () => {
  const dir = nodeDirWith({ slug: "by-path" });
  const out = runHook(dir, { status: "done", summary: "x", proposal: "proposals/by-path" });
  assert.equal(out.proposal.registered, true);
  assert.equal(out.proposal.slug, "by-path");

  const missing = runHook(dir, { status: "done", summary: "x", proposal: "no-such-proposal" });
  assert.equal(missing.proposal.ok, false);
  assert.match(String(missing.proposal.error), /提案未找到/);
  assert.equal(missing.dispatch.length, 0, "不阻塞、不派后续");
  assert.equal(indexLines().filter((x) => x.slug === "no-such-proposal").length, 0);
});

test("daemon 侧接线：proposal 结果 → 节点 proposal 事件 + index 登记（inbox 类目的数据源）", async () => {
  const R = await import("../../src/runs.ts");
  const D = await import("../../src/daemon.ts");
  const { rootId } = R.createRun({ subject: "hook 接线" });
  const spec = { id: `node:${rootId}/root`, type: "assign", goal: "x", accept: ["y"], budget: { depth_left: 1 } } as any;
  R.writeSpec(rootId, "root", spec);
  // §9.1 提案目录在节点目录下
  const pdir = join(R.nodeDir(rootId, "root"), "proposals", "wired");
  mkdirSync(pdir, { recursive: true });
  writeFileSync(join(pdir, "meta.json"), JSON.stringify({ slug: "wired", risk: "high" }));
  writeFileSync(join(pdir, "patch.diff"), "--- /dev/null\n+++ b/docs/x.md\n@@ -0,0 +1,1 @@\n+x\n");
  R.writeResult(rootId, "root", { status: "done", summary: "做完了", proposal: "wired" } as any);

  D.runNodeSettledHook(rootId, "root", spec);

  const ev = R.readEvents(rootId, "root");
  const prop = ev.filter((e) => e.kind === "proposal");
  assert.equal(prop.length, 1, "daemon 写一条 proposal 事件（不新造通知通道）");
  assert.equal(prop[0].data.slug, "wired");
  assert.equal(prop[0].data.registered, true);
  assert.ok(ev.some((e) => e.kind === "learn" && e.data.proposal === "wired"), "hook 写的 learn 事件也在节点上");
  assert.match(readFileSync(join(STATE, "proposals", "index.jsonl"), "utf8"), /"slug":"wired"/);
});

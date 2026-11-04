// S22 验收：spawn 原语（命名/寻址/隔离/深度）、并发策略（run 级 N）、回复三态（queue 落地）。
// runs.ts 在 import 时按 AICA_STATE 算 RUNS_DIR，所以先设环境变量再动态 import。
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chdir } from "node:process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const STATE = mkdtempSync(join(tmpdir(), "aica-s22-"));
const REPO = mkdtempSync(join(tmpdir(), "aica-s22-repo-"));
process.env.AICA_STATE = STATE;
process.env.AICA_REPO_ROOT = REPO;
process.env.AR_MAX_WORKERS = "8";

const R = await import("../../src/runs.ts");
const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "cli.ts");
process.env.AR_CLI = CLI;

// 用假 pi 捕获工具注册（tools.ts 的默认导出就是注册函数）
const registered: any[] = [];
const mod = await import("../../aica-pi/extensions/tools.ts");
mod.default({ registerTool: (t: any) => registered.push(t) });
const spawnTool = registered.find((t) => t.name === "spawn");
const proposeTool = registered.find((t) => t.name === "ev_propose");

assert.ok(spawnTool && proposeTool, "spawn / ev_propose 已注册");

function seedRun(): string {
  const { rootId } = R.createRun({ subject: "S22 子代理" });
  R.writeSpec(rootId, "root", {
    type: "assign", agent: "pi", goal: "父节点：派三个子任务", accept: ["汇总"],
    budget: { depth_left: 2 }, permission: "supervised", tools: ["spawn", "read"],
  });
  return rootId;
}

/** 以 (root, path) 身份调用工具（工具从 AR_ROOT_ID/AR_NODE_PATH 取当前节点，就像 worker 里一样） */
async function callAs(tool: any, root: string, path: string, args: any): Promise<any> {
  process.env.AR_ROOT_ID = root;
  process.env.AR_NODE_PATH = path;
  return await tool.execute("call-1", args);
}
const textOf = (res: any): string => res?.content?.[0]?.text ?? "";
const cli = (...args: string[]): any => {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8", env: { ...process.env, AICA_STATE: STATE, AICA_REPO_ROOT: REPO },
  });
  return JSON.parse(String(r.stdout ?? "").trim().split("\n").filter(Boolean).pop() ?? "{}");
};

// ---------------------------------------------------------------- 1. spawn × 3

test("spawn：一个父节点派 3 个子节点，parent/id/depth 正确，父节点 children 可见", async () => {
  const rootId = seedRun();
  for (const n of ["a", "b", "c"]) {
    const res = await callAs(spawnTool, rootId, "root", { path: n, goal: `子任务 ${n}`, accept: [`${n} 完成`] });
    assert.equal(res.isError, undefined, textOf(res));
    assert.match(textOf(res), new RegExp(`node_id=node:${rootId}/root/${n}`));
  }
  const paths = R.listNodePaths(rootId);
  for (const n of ["a", "b", "c"]) {
    assert.ok(paths.includes(`root/${n}`), `子树里可见 root/${n}`);
    const spec = R.readSpec(rootId, `root/${n}`)!;
    assert.equal(spec.parent, `node:${rootId}/root`, "parent 指向父节点");
    assert.equal(spec.id, `node:${rootId}/root/${n}`);
    assert.equal(spec.budget?.depth_left, 1, "depth_left 递减");
    assert.equal(spec.permission, "supervised", "审批档继承（子节点不能借 spawn 降档）");
    assert.deepEqual(spec.tools, ["spawn", "read"], "工具面继承");
    assert.deepEqual(spec.accept, [`${n} 完成`]);
    // 树结构：子节点是父节点路径的下一层（view 的 tree 就按 path 段数挂载）
    assert.equal(`root/${n}`.split("/").length, "root".split("/").length + 1);
  }
  const spawnEvents = R.readEvents(rootId, "root").filter((e) => e.kind === "spawn");
  assert.equal(spawnEvents.length, 3, "父节点留 3 条 spawn 审计事件");

  // 重复 path 拒绝
  const dup = await callAs(spawnTool, rootId, "root", { path: "a", goal: "重复" });
  assert.equal(dup.isError, true);
  assert.match(textOf(dup), /EXISTS/);
});

test("spawn：depth_left 归零后拒绝；path 逃逸/绝对路径/非法段一律拒绝", async () => {
  const rootId = seedRun();
  assert.equal((await callAs(spawnTool, rootId, "root", { path: "l1", goal: "第一层" })).isError, undefined);
  const l1 = R.readSpec(rootId, "root/l1")!;
  assert.equal(l1.budget?.depth_left, 1);
  assert.equal((await callAs(spawnTool, rootId, "root/l1", { path: "l2", goal: "第二层" })).isError, undefined);
  const l2 = R.readSpec(rootId, "root/l1/l2")!;
  assert.equal(l2.budget?.depth_left, 0, "第二层 depth 为 0");
  const tooDeep = await callAs(spawnTool, rootId, "root/l1/l2", { path: "l3", goal: "第三层" });
  assert.equal(tooDeep.isError, true);
  assert.match(textOf(tooDeep), /DEPTH/);
  assert.equal(R.readSpec(rootId, "root/l1/l2/l3"), null, "越界 depth 不留下空节点");

  for (const bad of ["../evil", "/abs", "a/../b", "a b", "a\\..\\b", ""]) {
    const res = await callAs(spawnTool, rootId, "root", { path: bad, goal: "x" });
    assert.equal(res.isError, true, `path=${JSON.stringify(bad)} 应被拒`);
  }
  assert.deepEqual(R.listNodePaths(rootId).sort(), ["root", "root/l1", "root/l1/l2"]);
});

// ---------------------------------------------------------------- 2. 并发策略

test("并发：默认 2；run.json.parallel / spec.budget.parallel 覆盖；live worker 也占名额", async () => {
  const rootId = seedRun();
  for (const n of ["a", "b", "c"]) await callAs(spawnTool, rootId, "root", { path: n, goal: `子 ${n}` });
  R.writeResult(rootId, "root", { status: "done", summary: "父节点完成" });

  const ofRun = () => R.pendingNodes().filter((p) => p.rootId === rootId).map((p) => p.path).sort();
  assert.deepEqual(ofRun(), ["root/a", "root/b"], "默认并发 2：只放行 2 个");

  // run.json.parallel 覆盖
  const metaFile = join(R.RUNS_DIR, rootId, "run.json");
  const meta = JSON.parse(readFileSync(metaFile, "utf8"));
  meta.parallel = 3;
  writeFileSync(metaFile, JSON.stringify(meta, null, 2) + "\n", "utf8");
  assert.deepEqual(ofRun(), ["root/a", "root/b", "root/c"], "run.parallel=3 放行 3 个");

  // spec.budget.parallel 优先于 run.json，且夹在 1..16
  const spec = R.readSpec(rootId, "root/c")!;
  assert.equal(R.parallelLimit(rootId, { ...spec, budget: { depth_left: 0, parallel: 1 } }), 1);
  assert.equal(R.parallelLimit(rootId, { ...spec, budget: { depth_left: 0, parallel: 99 } }), 16);
  assert.equal(R.parallelLimit(rootId, { ...spec, budget: { depth_left: 0 } }), 3, "缺省回落到 run.json.parallel");

  // live worker 占配额：上限调回 2，1 个在跑 → 只再放行 1 个
  const meta2 = JSON.parse(readFileSync(metaFile, "utf8")); meta2.parallel = 2;
  writeFileSync(metaFile, JSON.stringify(meta2, null, 2) + "\n", "utf8");
  R.writeWorker(rootId, "root/a", { pid: process.pid, started_at: new Date().toISOString(), cmd: "test" });
  assert.deepEqual(ofRun(), ["root/b"]);
  R.clearWorker(rootId, "root/a");
  const meta3 = JSON.parse(readFileSync(metaFile, "utf8")); meta3.parallel = 3;
  writeFileSync(metaFile, JSON.stringify(meta3, null, 2) + "\n", "utf8");
  assert.deepEqual(ofRun(), ["root/a", "root/b", "root/c"], "锁释放后配额恢复");
});

// ---------------------------------------------------------------- 3. 回复三态

test("reply：running 节点只排队（reply-queued，不 resume）；waiting 节点照旧 resume", () => {
  const rootId = R.createRun({ subject: "reply 三态" }).rootId;
  R.writeSpec(rootId, "root", { type: "assign", goal: "跑着", accept: ["x"], budget: { depth_left: 1 } });
  R.writeWorker(rootId, "root", { pid: process.pid, started_at: new Date().toISOString(), cmd: "test" });

  const queued = cli("reply", "--run", rootId, "--node", "root", "--text", "别停，接着跑");
  assert.equal(queued.ok, true, JSON.stringify(queued));
  assert.equal(queued.data.delivery, "queued");
  assert.equal(queued.data.resumed, false, "running 节点不打断本轮");
  assert.equal(R.readResult(rootId, "root"), null, "没有写 result（worker 未结束）");
  const spec = R.readSpec(rootId, "root")!;
  assert.equal(spec.reply?.at(-1)?.text, "别停，接着跑");
  const evs = R.readEvents(rootId, "root");
  assert.ok(evs.some((e) => e.kind === "reply-queued"), "reply-queued 事件（UI 用它显示『本轮结束后送达』）");

  // 进程结束 → 排队的那条等下一次拉起；waiting 节点回复则立刻 resume
  R.clearWorker(rootId, "root");
  R.writeResult(rootId, "root", { status: "waiting", summary: "请确认" });
  const resumed = cli("reply", "--run", rootId, "--node", "root", "--text", "同意");
  assert.equal(resumed.data.delivery, "resumed");
  assert.equal(resumed.data.resumed, true);
  assert.ok(existsSync(join(R.nodeDir(rootId, "root"), "result.resolved.json")), "waiting result 已归档 → 下一轮重拉");

  // idle 且非 waiting：只存进 spec.reply
  const stored = cli("reply", "--run", rootId, "--node", "root", "--text", "补充说明");
  assert.equal(stored.data.delivery, "stored");
});

test("reply：--mode interrupt 打断并重拉（删掉本次 abort 写的 result，排队送达）", () => {
  const rootId = R.createRun({ subject: "interrupt" }).rootId;
  R.writeSpec(rootId, "root", { type: "assign", goal: "跑着", accept: ["x"], budget: { depth_left: 1 } });
  // 用真实存活的假 worker 进程（不能拿 process.pid：taskkill /T 会把测试进程自己杀掉）
  const dummy = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 60000)"], { stdio: "ignore", windowsHide: true });
  R.writeWorker(rootId, "root", { pid: dummy.pid!, started_at: new Date().toISOString(), cmd: "test" });
  try {
    const r = cli("reply", "--run", rootId, "--node", "root", "--text", "换方向", "--mode", "interrupt");
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.data.delivery, "interrupted");
    assert.equal(existsSync(join(R.nodeDir(rootId, "root"), "result.json")), false, "abort 的 failed result 被移除 → 可重拉");
    assert.equal(R.readSpec(rootId, "root")!.reply?.at(-1)?.text, "换方向");
    assert.ok(R.pendingNodes().some((p) => p.rootId === rootId && p.path === "root"), "节点回到待拉起");
  } finally {
    try { dummy.kill(); } catch { /* 已被 taskkill 收掉 */ }
  }
});

// ---------------------------------------------------------------- 4. ev_propose 工具

test("ev_propose：只写 proposals/<slug>/ 四件套；禁止级路径在工具里直接报错", async () => {
  const nodeDir = mkdtempSync(join(tmpdir(), "aica-s22-node-"));
  mkdirSync(join(nodeDir, "artifacts"), { recursive: true });
  const cwd0 = process.cwd();
  try {
    chdir(nodeDir);
    const okRes = await proposeTool.execute("p1", {
      slug: "demo-skill",
      proposal: "动机：加一条示例技能；风险：low；影响：SKILL.md",
      patch: ["--- /dev/null", "+++ b/aica-pi/skills/demo/SKILL.md", "@@ -0,0 +1,2 @@", "+# 示例技能", "+只用只读工具"].join("\n") + "\n",
    });
    assert.equal(okRes.isError, undefined, textOf(okRes));
    const dir = join(nodeDir, "proposals", "demo-skill");
    for (const f of ["proposal.md", "patch.diff", "verify.json", "meta.json"]) {
      assert.ok(existsSync(join(dir, f)), `写了 ${f}`);
    }
    const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
    assert.equal(meta.risk, "low");
    if (process.env.AR_ROOT_ID) assert.equal(meta.source?.root_id, process.env.AR_ROOT_ID, "meta 记录来源节点（learn 事件用）");
    assert.match(textOf(okRes), /risk=low/);

    const bad = await proposeTool.execute("p2", {
      slug: "shell-hack",
      proposal: "提权",
      patch: ["--- a/workbench/shell/main.go", "+++ b/workbench/shell/main.go", "@@ -1,1 +1,1 @@", "-package main", "+package evil"].join("\n") + "\n",
    });
    assert.equal(bad.isError, true);
    assert.match(textOf(bad), /FORBIDDEN/);
    assert.equal(existsSync(join(nodeDir, "proposals", "shell-hack")), false, "非法提案不落盘");
    assert.deepEqual(readdirSync(join(nodeDir, "proposals")), ["demo-skill"]);
  } finally { chdir(cwd0); }
});


// R3 D5 plan mode：只读工具面 + plan prompt + plan 文本两处落盘（result.summary / artifacts/plan.md）。
// daemon.ts 在 import 时按 AICA_STATE 算 RUNS_DIR，所以先设环境变量再动态 import。
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const STATE = mkdtempSync(join(tmpdir(), "aica-r3-plan-"));
process.env.AICA_STATE = STATE;

const D = await import("../../src/daemon.ts");
const R = await import("../../src/runs.ts");
const AICA_PI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "aica-pi");

const spec = (extra: Record<string, unknown> = {}) =>
  ({ id: "node:x/root", type: "assign", goal: "把任务拆成可验收的计划", accept: ["四段齐全"], budget: { depth_left: 1 }, ...extra }) as any;

test("工具面：plan 只有 8 个只读/协议工具，spec.tools 也不能提权", () => {
  const plan = D.toolAllowlist(spec({ profile: "plan", tools: ["bash", "write", "spawn"] }));
  assert.deepEqual(plan, ["read", "ls", "find", "grep", "ar_read", "ev_gate", "ev_done", "ev_fail"]);
  assert.equal(plan.includes("write"), false);
  assert.equal(plan.includes("bash"), false);
  assert.equal(plan.includes("spawn"), false);

  // 对照：worker 仍有执行面，reviewer 仍是只读 8 个
  assert.ok(D.toolAllowlist(spec()).includes("bash"), "worker 不受影响");
  assert.deepEqual(D.toolAllowlist(spec({ profile: "reviewer" })), ["read", "ls", "find", "grep", "ar_read", "ev_done", "ev_fail", "ev_gate"]);
});

test("launcher：plan 档注入 prompts/plan.md 与只读工具面", () => {
  const l = D.launcher(spec({ profile: "plan" }), false, join(STATE, "node"));
  const i = l.args.indexOf("--append-system-prompt");
  assert.equal(l.args[i + 1], join(AICA_PI, "prompts", "plan.md"));
  assert.ok(existsSync(l.args[i + 1]), "prompt 文件真实存在");
  const j = l.args.indexOf("--tools");
  assert.equal(l.args[j + 1], "read,ls,find,grep,ar_read,ev_gate,ev_done,ev_fail");
  assert.match(l.desc, /\[pi\/plan /, "desc 标出 plan 档（观测用）");
  // 对照：worker 档仍用 worker.md
  const w = D.launcher(spec(), false, join(STATE, "node"));
  assert.equal(w.args[w.args.indexOf("--append-system-prompt") + 1], join(AICA_PI, "prompts", "worker.md"));
});

test("prompt 文件：四段要求齐（目标拆解 / 每步验收 / 风险 / 需要人批的点）", () => {
  const md = readFileSync(join(AICA_PI, "prompts", "plan.md"), "utf8");
  for (const k of ["目标拆解", "每步验收", "风险", "需要人批的点"]) assert.ok(md.includes(k), `plan.md 缺「${k}」`);
  assert.match(md, /只读/);
});

test("userMessage：plan 档钉死产出位置与四段要求", () => {
  const msg = D.userMessage(spec({ profile: "plan" }), false, STATE);
  assert.match(msg, /## 计划模式（只读）/);
  assert.match(msg, /artifacts\/plan\.md/);
  assert.match(msg, /目标拆解 \/ 每步验收 \/ 风险 \/ 需要人批的点/);
  // 非 plan 档不出现这段
  assert.equal(D.userMessage(spec(), false, STATE).includes("## 计划模式（只读）"), false);
});

test("plan 工作目录是数据面：`ls <节点目录>` 不该被 gate 当成控制面（真跑时踩到过）", async () => {
  const G = await import("../../aica-pi/extensions/gate.ts");
  const { rootId } = R.createRun({ subject: "plan cwd" });
  R.writeSpec(rootId, "root", spec({ profile: "plan" }));
  const prev = { root: process.env.AR_ROOT_ID, node: process.env.AR_NODE_PATH, state: process.env.AICA_STATE };
  process.env.AR_ROOT_ID = rootId;
  process.env.AR_NODE_PATH = "root";
  try {
    const dir = R.nodeDir(rootId, "root");
    assert.equal(G.controlPlaneHit([dir]), null, "节点目录本身 = 数据面");
    assert.equal(G.controlPlaneHit([join(dir, "artifacts")]), null, "artifacts 子目录 = 数据面");
    assert.equal(G.controlPlaneHit([join(dir, "spec.json")]), join(dir, "spec.json"), "控制文件仍恒问");
  } finally {
    if (prev.root === undefined) delete process.env.AR_ROOT_ID; else process.env.AR_ROOT_ID = prev.root;
    if (prev.node === undefined) delete process.env.AR_NODE_PATH; else process.env.AR_NODE_PATH = prev.node;
    if (prev.state === undefined) delete process.env.AICA_STATE; else process.env.AICA_STATE = prev.state;
  }
});

test("finalizePlanArtifact：plan 节点 done 后用 summary 兜底写 artifacts/plan.md（幂等、不覆盖已有的）", () => {
  const { rootId } = R.createRun({ subject: "plan 落盘" });
  R.writeSpec(rootId, "root", spec({ profile: "plan" }));
  const planText = "## 目标拆解\n1. 读代码\n\n## 每步验收\n1. 命令返回 0\n\n## 风险\n- 无\n\n## 需要人批的点\n- 写文件";
  R.writeResult(rootId, "root", { status: "done", summary: planText });
  D.finalizePlanArtifact(rootId, "root", spec({ profile: "plan" }));
  const f = join(R.nodeDir(rootId, "root"), "artifacts", "plan.md");
  assert.equal(readFileSync(f, "utf8").trim(), planText.trim(), "summary 与 plan.md 内容一致");

  // 已是 worker 自己写的就不覆盖
  writeFileSync(f, "worker 自己写的\n", "utf8");
  D.finalizePlanArtifact(rootId, "root", spec({ profile: "plan" }));
  assert.equal(readFileSync(f, "utf8"), "worker 自己写的\n");

  // 非 plan / failed 不写
  const b = R.createRun({ subject: "非 plan" });
  R.writeSpec(b.rootId, "root", spec());
  R.writeResult(b.rootId, "root", { status: "done", summary: planText });
  D.finalizePlanArtifact(b.rootId, "root", spec());
  assert.equal(existsSync(join(R.nodeDir(b.rootId, "root"), "artifacts", "plan.md")), false);
});

test("profile 闭集：入口拒非法值（BAD_INPUT + 非 0 退出），daemon 兜底按 worker 并记 input 警告", async () => {
  const { spawnSync } = await import("node:child_process");
  const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "cli.ts");
  const env = { ...process.env, AICA_STATE: STATE };

  const bad = spawnSync(process.execPath, [cli, "node-create", "--run", "whatever", "--path", "root", "--goal", "g", "--profile", "plna"], { encoding: "utf8", env });
  assert.equal(bad.status, 1, "G-1：失败必须非 0 退出");
  const bj = JSON.parse(String(bad.stdout).trim().split("\n").pop()!);
  assert.equal(bj.ok, false);
  assert.equal(bj.error.code, "BAD_INPUT");
  assert.match(bj.error.message, /profile 只接受/);
  assert.equal(/ at .*\.ts:\d+/.test(String(bj.error.message)), false, "无裸栈");

  const disp = spawnSync(process.execPath, [cli, "dispatch"], { encoding: "utf8", env, input: JSON.stringify({ subject: "s", profile: "plna" }) });
  assert.equal(disp.status, 1);
  assert.equal(JSON.parse(String(disp.stdout).trim().split("\n").pop()!).error.code, "BAD_INPUT");

  // 合法值照常通过
  const okRun = R.createRun({ subject: "profile ok" });
  const good = spawnSync(process.execPath, [cli, "node-create", "--run", okRun.rootId, "--path", "root", "--goal", "g", "--profile", "plan"], { encoding: "utf8", env });
  assert.equal(good.status, 0, String(good.stdout) + String(good.stderr));
  assert.equal(R.readSpec(okRun.rootId, "root")?.profile, "plan");

  // 运行期兜底：历史 spec 里的非法 profile → 按 worker 跑 + input 警告
  const legacy = R.createRun({ subject: "legacy profile" });
  R.writeSpec(legacy.rootId, "root", spec({ profile: "plna" }));
  const norm = D.normalizeProfile(legacy.rootId, "root", R.readSpec(legacy.rootId, "root")!);
  assert.equal(norm.profile, "worker");
  assert.ok(D.toolAllowlist(norm).includes("bash"), "兜底后按 worker 的工具面跑");
  const warn = R.readEvents(legacy.rootId, "root").filter((e) => e.kind === "input" && e.data.field === "profile");
  assert.equal(warn.length, 1, "记一条 input 警告");
  assert.equal(warn[0].data.value, "plna");
});

test("gate：只读工具能读 aica-pi 源码（plan 的意义），写 aica-pi / 读 .git / 别的 run 控制文件仍拦", async () => {
  const G = await import("../../aica-pi/extensions/gate.ts");
  const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const mine = R.createRun({ subject: "gate plan" });
  R.writeSpec(mine.rootId, "root", spec({ profile: "plan" }));
  const prev = { root: process.env.AR_ROOT_ID, node: process.env.AR_NODE_PATH };
  process.env.AR_ROOT_ID = mine.rootId;
  process.env.AR_NODE_PATH = "root";
  try {
    for (const tool of ["read", "ls", "find", "grep", "ar_read"]) {
      const r = G.resolveCall({ permission: "supervised" }, tool, { path: join(repo, "aica-pi") }, [], repo);
      assert.equal(r.action, "allow", `${tool} 读 aica-pi 应放行（不再弹审批）`);
    }
    const w = G.resolveCall({ permission: "full" }, "write", { path: join(repo, "aica-pi", "x.ts") }, [], repo);
    assert.equal(w.action, "ask", "写 aica-pi 仍要批");
    assert.equal(w.hit, "control");
    const bash = G.resolveCall({ permission: "full" }, "bash", { command: "cat aica-pi/extensions/gate.ts" }, [], repo);
    assert.equal(bash.action, "ask", "执行面读 aica-pi 仍要批（bash 不是只读工具）");

    const gitRead = G.resolveCall({ permission: "full" }, "read", { path: join(repo, ".git", "config") }, [], repo);
    assert.equal(gitRead.action, "ask", ".git 读也拦");

    // 本节点自己的控制文件：只读工具放行（worker 看自己的 spec/result 是常态），写仍拦
    const nodeDir = R.nodeDir(mine.rootId, "root");
    assert.equal(G.resolveCall({ permission: "supervised" }, "read", { path: join(nodeDir, "spec.json") }, [], repo).action, "allow");
    assert.equal(G.resolveCall({ permission: "full" }, "read", { path: "spec.json" }, [], nodeDir).action, "allow", "裸 spec.json + cwd=节点目录");
    assert.equal(G.resolveCall({ permission: "full" }, "write", { path: join(nodeDir, "spec.json") }, [], repo).action, "ask", "写自己的 spec 仍要批");

    const other = R.createRun({ subject: "other run" });
    R.writeSpec(other.rootId, "root", spec());
    R.writeResult(other.rootId, "root", { status: "done", summary: "x" });
    const st = G.resolveCall({ permission: "full" }, "read", { path: join(R.nodeDir(other.rootId, "root"), "result.json") }, [], repo);
    assert.equal(st.action, "ask", "别的 run 的 STATE 控制文件：只读也拦");
    assert.equal(st.hit, "control");
  } finally {
    if (prev.root === undefined) delete process.env.AR_ROOT_ID; else process.env.AR_ROOT_ID = prev.root;
    if (prev.node === undefined) delete process.env.AR_NODE_PATH; else process.env.AR_NODE_PATH = prev.node;
  }
});

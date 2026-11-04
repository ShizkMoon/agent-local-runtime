// S28 验收（PRD v3 §9.6）：low 生效 / high 需 --force / 禁止级拒 / verify 失败字节级回滚 /
// 第 4 次 stale / 坏 patch 不崩 + 路径逃逸与 rejection。
// proposals.ts 在 import 时按 AICA_STATE/AICA_REPO_ROOT 取路径，所以先设环境变量再动态 import。
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const STATE = mkdtempSync(join(tmpdir(), "aica-s28-state-"));
const REPO = mkdtempSync(join(tmpdir(), "aica-s28-repo-"));
process.env.AICA_STATE = STATE;
process.env.AICA_REPO_ROOT = REPO;

const P = await import("../../src/proposals.ts");
const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "cli.ts");

const sha = (s: string | Buffer): string => createHash("sha256").update(s).digest("hex");

// ---- 假仓库 ----
function put(rel: string, content: string): void {
  const abs = join(REPO, ...rel.split("/"));
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
}
const SKILL = "aica-pi/skills/demo/SKILL.md";
const DAEMON = "src/daemon.ts";
put(SKILL, "# demo skill\n\nold line\n");
put(DAEMON, "// daemon\nexport const x = 1;\n");
put("workbench/shell/main.go", "package main\n// shell\n");
put("docs/guide.md", "# guide\n\nv1\n");
put("package.json", '{\n  "name": "fake",\n  "scripts": { "t": "node t.js" }\n}\n');
put("verify-ok.mjs", "process.exit(0);\n");
put("verify-bad.mjs", "console.error('VERIFY_BOOM line1'); process.exit(3);\n");

const lines = (s: string): string[] => s.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");

/** 整文件替换的单 hunk unified diff（足够覆盖 apply 的上下文/增删行） */
function patchOf(rel: string, before: string, after: string): string {
  const b = before === "" ? [] : lines(before);
  const a = lines(after);
  const head = before === "" ? "--- /dev/null" : `--- a/${rel}`;
  const range = before === "" ? "@@ -0,0" : `@@ -1,${b.length}`;
  return [head, `+++ b/${rel}`, `${range} +1,${a.length} @@`, ...b.map((l) => "-" + l), ...a.map((l) => "+" + l)].join("\n") + "\n";
}

function cli(...args: string[]): any {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, AICA_STATE: STATE, AICA_REPO_ROOT: REPO },
  });
  const out = String(r.stdout ?? "").trim().split("\n").filter(Boolean).pop() ?? "{}";
  return JSON.parse(out);
}

// ---------------------------------------------------------------- 1. low

test("§9.6-2 low：只改 aica-pi/skills 的提案 → verify 通过 → 落盘 + 备份 + applied.json", () => {
  const before = readFileSync(join(REPO, SKILL), "utf8");
  const after = "# demo skill\n\nnew line（低风险，可一键应用）\n";
  const rec = P.createProposal({
    slug: "low-skill", proposal: "动机：让 worker 看到新技能", patch: patchOf(SKILL, before, after),
    verify: { cmd: "node verify-ok.mjs" },
  });
  assert.equal(rec.risk, "low");
  assert.equal(rec.meta.files[0].path, SKILL);
  assert.equal(rec.meta.files[0].sha256, sha(before), "meta 记录基线 sha256");

  const r = P.applyProposal("low-skill");
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(readFileSync(join(REPO, SKILL), "utf8"), after, "仓库文件已更新（下一轮 worker 的 --skill 能看到）");
  assert.equal(readFileSync(join(rec.dir, "backup", ...SKILL.split("/")), "utf8"), before, "落盘前备份被改文件");
  const applied = JSON.parse(readFileSync(join(rec.dir, "applied.json"), "utf8"));
  assert.equal(applied.history.length, 1);
  assert.equal(applied.history[0].files[0].sha256, sha(after), "applied.json 记录落盘后 sha256");
  assert.deepEqual(P.listProposals().map((p) => p.slug), ["low-skill"]);
  assert.equal(P.listProposals()[0].status, "applied");
});

// ---------------------------------------------------------------- 2. high

test("§9.6-3 high：改 src/ 无 --force 拒绝；带 --force 才落盘", () => {
  const before = readFileSync(join(REPO, DAEMON), "utf8");
  const after = before + "export const spawned = true;\n";
  const rec = P.createProposal({ slug: "high-daemon", patch: patchOf(DAEMON, before, after), verify: { cmd: "node verify-ok.mjs" } });
  assert.equal(rec.risk, "high");

  const denied = P.applyProposal("high-daemon");
  assert.equal(denied.ok, false);
  assert.equal(denied.code, "NEEDS_FORCE");
  assert.equal(readFileSync(join(REPO, DAEMON), "utf8"), before, "未 --force 时仓库零改动");

  const forced = P.applyProposal("high-daemon", { force: true });
  assert.equal(forced.ok, true, JSON.stringify(forced));
  assert.equal(readFileSync(join(REPO, DAEMON), "utf8"), after);
});

// ---------------------------------------------------------------- 3. 禁止级

test("§9.6-4 禁止级：workbench/shell 与 gate.ts/package.json 直接拒，工具侧就报错", () => {
  const shellBefore = readFileSync(join(REPO, "workbench/shell/main.go"), "utf8");
  assert.throws(() => P.createProposal({ slug: "shell-hack", patch: patchOf("workbench/shell/main.go", shellBefore, "package main\n// hacked\n") }),
    (e: any) => e.code === "FORBIDDEN" && /workbench\/shell/.test(e.message));
  assert.throws(() => P.createProposal({ slug: "gate-hack", patch: patchOf("aica-pi/extensions/gate.ts", "", "process.exit(0);\n") }),
    (e: any) => e.code === "FORBIDDEN");
  assert.throws(() => P.createProposal({ slug: "pkg-hack", patch: patchOf("package.json", readFileSync(join(REPO, "package.json"), "utf8"), '{"scripts":{}}') }),
    (e: any) => e.code === "FORBIDDEN");
  // 白名单外的路径 = 默认拒绝
  assert.throws(() => P.createProposal({ slug: "readme-hack", patch: patchOf("README.md", "", "x\n") }),
    (e: any) => e.code === "FORBIDDEN");
  assert.equal(readFileSync(join(REPO, "workbench/shell/main.go"), "utf8"), shellBefore, "禁止级文件未被改动");
});

test("§9.6-1 路径逃逸/绝对路径/.. 一律拒绝；符号链接拒绝（无权限建链则跳过）", () => {
  assert.throws(() => P.createProposal({ slug: "escape", patch: patchOf("../outside.md", "", "x\n") }), (e: any) => e.code === "BAD_PATH");
  assert.throws(() => P.createProposal({ slug: "abs", patch: patchOf("C:/windows/x.md", "", "x\n") }), (e: any) => e.code === "BAD_PATH");
  assert.throws(() => P.createProposal({ slug: "dotdot", patch: patchOf("docs/../../x.md", "", "x\n") }), (e: any) => e.code === "BAD_PATH");
  assert.throws(() => P.createProposal({ slug: "bad slug!", patch: patchOf("docs/x.md", "", "x\n") }), (e: any) => e.code === "BAD_SLUG");

  const link = join(REPO, "docs", "link.md");
  try { symlinkSync(join(REPO, "docs", "guide.md"), link); } catch { return; }   // Windows 无权限则跳过
  try {
    assert.throws(() => P.createProposal({ slug: "symlink", patch: patchOf("docs/link.md", "", "x\n") }), (e: any) => e.code === "SYMLINK");
  } finally { try { rmSync(link, { force: true }); } catch { /* ignore */ } }
});

// ---------------------------------------------------------------- 4. verify 失败回滚

test("§9.6-5 verify 失败：零落盘、字节级不变（sha256 相同）、给出失败输出前 40 行", () => {
  const target = "docs/guide.md";
  const before = readFileSync(join(REPO, target), "utf8");
  P.createProposal({ slug: "bad-verify", patch: patchOf(target, before, "# guide\n\nv2 SHOULD NOT LAND\n"), verify: { cmd: "node verify-bad.mjs" } });
  const r = P.applyProposal("bad-verify");
  assert.equal(r.ok, false);
  assert.equal(r.code, "VERIFY_FAILED");
  assert.equal(r.rolled_back, true);
  assert.equal(sha(readFileSync(join(REPO, target), "utf8")), sha(before), "被改文件 sha256 与之前一致");
  assert.match(r.tail ?? "", /VERIFY_BOOM/);
  const dir = P.showProposal("bad-verify")!.dir;
  assert.equal(existsSync(join(dir, "applied.json")), false, "失败不记应用历史");
});

// ---------------------------------------------------------------- 5. stale

test("§9.6-6 stale：7 天内第 4 次 apply 被拒（前 3 次正常计数）", () => {
  const dir = P.showProposal("bad-verify")!.dir;   // 复用目录：写 3 条 7 天内的历史
  const now = new Date();
  const hist = [1, 2, 3].map((i) => ({ at: new Date(now.getTime() - i * 3600_000).toISOString(), files: [] }));
  writeFileSync(join(dir, "applied.json"), JSON.stringify({ slug: "bad-verify", history: hist }) + "\n", "utf8");
  assert.equal(P.showProposal("bad-verify")!.applies_7d, 3);
  const r = P.applyProposal("bad-verify", { force: true });
  assert.equal(r.ok, false);
  assert.equal(r.code, "STALE", "第 4 次直接 stale，连 verify 都不跑");
  // 7 天外的历史不计数
  const old = [1, 2, 3].map((i) => ({ at: new Date(now.getTime() - (8 + i) * 86_400_000).toISOString() }));
  writeFileSync(join(dir, "applied.json"), JSON.stringify({ slug: "bad-verify", history: old }) + "\n", "utf8");
  assert.equal(P.showProposal("bad-verify")!.applies_7d, 0);
});

// ---------------------------------------------------------------- 6. 坏 patch / reject / CLI

test("§9.6-1 坏 patch 不崩：apply 返回 BAD_PATCH；reject 后 apply 拒绝", () => {
  const dir = join(STATE, "proposals", "broken");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "meta.json"), JSON.stringify({ slug: "broken", created_at: new Date().toISOString(), risk: "low", files: [], verify: { cmd: "node verify-ok.mjs" } }) + "\n", "utf8");
  writeFileSync(join(dir, "patch.diff"), "this is not a diff\n@@ garbage @@\n", "utf8");
  writeFileSync(join(dir, "verify.json"), JSON.stringify({ cmd: "node verify-ok.mjs" }) + "\n", "utf8");
  const r = P.applyProposal("broken");
  assert.equal(r.ok, false);
  assert.equal(r.code, "BAD_PATCH");
  assert.doesNotThrow(() => P.showProposal("broken"));

  const rej = P.rejectProposal("low-skill", "方向不对");
  assert.equal(rej.ok, true);
  const after = P.applyProposal("low-skill", { force: true });
  assert.equal(after.ok, false);
  assert.equal(after.code, "REJECTED");
  assert.equal(P.listProposals().find((p) => p.slug === "low-skill")!.status, "rejected");
});

test("§9.6-1 CLI：list/show/apply/reject/new 全通，坏输入返回结构化错误（无栈）", () => {
  const list = cli("propose", "list");
  assert.equal(list.ok, true);
  assert.ok(Array.isArray(list.data.proposals));

  const show = cli("propose", "show", "high-daemon");
  assert.equal(show.ok, true);
  assert.equal(show.data.proposal.slug, "high-daemon");

  const missing = cli("propose", "show", "nope");
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, "NOT_FOUND");
  assert.equal(/ at \S+:\d+/.test(String(missing.error.message ?? "")), false, "错误里没有调用栈");

  const usage = cli("propose", "apply");
  assert.equal(usage.ok, false);
  assert.equal(usage.error.code, "USAGE");

  // new：补丁走 stdin（-），验证 CLI 侧的创建路径
  const before = readFileSync(join(REPO, "docs/guide.md"), "utf8");
  const p = spawnSync(process.execPath, [CLI, "propose", "new", "--slug", "cli-new", "--patch", "-", "--verify-cmd", "node verify-ok.mjs"], {
    encoding: "utf8", input: patchOf("docs/guide.md", before, "# guide\n\nfrom cli\n"),
    env: { ...process.env, AICA_STATE: STATE, AICA_REPO_ROOT: REPO },
  });
  const made = JSON.parse(String(p.stdout).trim().split("\n").pop()!);
  assert.equal(made.ok, true, JSON.stringify(made));
  assert.equal(made.data.risk, "low");
  assert.equal(cli("propose", "apply", "cli-new").ok, true);
  assert.equal(readFileSync(join(REPO, "docs/guide.md"), "utf8"), "# guide\n\nfrom cli\n");

  const badPatch = spawnSync(process.execPath, [CLI, "propose", "new", "--slug", "cli-bad", "--patch", "-"], {
    encoding: "utf8", input: "not a diff at all\n",
    env: { ...process.env, AICA_STATE: STATE, AICA_REPO_ROOT: REPO },
  });
  const bad = JSON.parse(String(badPatch.stdout).trim().split("\n").pop()!);
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, "BAD_PATCH");
  assert.equal(badPatch.status, 1, "G-1：失败必须非 0 退出；但仍结构化、无裸栈");
  assert.equal(/ at \S+:\d+/.test(String(bad.error.message ?? "")), false);
});

// ---------------------------------------------------------------- 7. git 格式 / 删除 / learn

test("补丁兼容 git 头（diff --git / index / new file mode）；删除文件也能应用", () => {
  const body = readFileSync(join(REPO, "docs/guide.md"), "utf8");
  const gitStyle = [
    "diff --git a/docs/guide.md b/docs/guide.md",
    "index 1234567..89abcde 100644",
    "--- a/docs/guide.md",
    "+++ b/docs/guide.md",
    "@@ -1,3 +1,3 @@",
    " # guide",
    " ",
    "-from cli",
    "+from git-format patch",
  ].join("\n") + "\n";
  P.createProposal({ slug: "gitfmt", patch: gitStyle, verify: { cmd: "node verify-ok.mjs" } });
  assert.equal(P.applyProposal("gitfmt").ok, true);
  assert.equal(readFileSync(join(REPO, "docs/guide.md"), "utf8"), "# guide\n\nfrom git-format patch\n");
  assert.equal(body.includes("from cli"), true);

  // 新建 → 删除（whitelist 内的 docs/）
  P.createProposal({ slug: "del", patch: patchOf("docs/obsolete.md", "", "临时文件\n"), verify: { cmd: "node verify-ok.mjs" } });
  assert.equal(P.applyProposal("del").ok, true);
  assert.ok(existsSync(join(REPO, "docs/obsolete.md")));
  const delPatch = ["--- a/docs/obsolete.md", "+++ /dev/null", "@@ -1,1 +0,0 @@", "-临时文件"].join("\n") + "\n";
  P.createProposal({ slug: "del2", patch: delPatch, verify: { cmd: "node verify-ok.mjs" } });
  const r = P.applyProposal("del2");
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(existsSync(join(REPO, "docs/obsolete.md")), false, "删除已落盘");
});

test("§9.5 learn：apply 成功给来源节点写一条 learn 事件", async () => {
  const R = await import("../../src/runs.ts");
  const { rootId } = R.createRun({ subject: "提案来源" });
  R.writeSpec(rootId, "root", { type: "assign", goal: "x", accept: ["y"], budget: { depth_left: 1 } });
  const before = readFileSync(join(REPO, "docs/guide.md"), "utf8");
  P.createProposal({
    slug: "learn-ev", patch: patchOf("docs/guide.md", before, before.replace("from git-format patch", "learn edge")),
    verify: { cmd: "node verify-ok.mjs" }, source: { root_id: rootId, path: "root" },
  });
  const r = P.applyProposal("learn-ev");
  assert.equal(r.ok, true, JSON.stringify(r));
  const learn = R.readEvents(rootId, "root").filter((e) => e.kind === "learn");
  assert.equal(learn.length, 1, "落一条 learn 事件");
  assert.equal(learn[0].data.proposal, "learn-ev");
  assert.equal(learn[0].data.verify.exit, 0);
});

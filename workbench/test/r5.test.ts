// R5：审批模式 / 模型档位 / Git 面板的数据面
// 覆盖：RunView.permission/tools/model/effort/mode 投影、approvalModeOf 判定、
//       git status/diff/commit 与"提交审批卡"的生命周期（拒绝 = 一条 git 命令都不跑）。
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approvalModeOf, buildView, clearViewCache } from "../view.ts";
import { gitStatus, gitDiff, gitCommit, readAsk, writeAsk, clearAsk } from "../git.ts";

const NOW = Date.parse("2026-11-04T04:00:00.000Z");
const ev = (ts: string, kind: string, data: any) => JSON.stringify({ ts, kind, data });

function mkRun(state: string, id: string, specExtra: Record<string, unknown> = {}): string {
  const base = join(state, "runs", id);
  mkdirSync(join(base, "nodes", "root"), { recursive: true });
  writeFileSync(join(base, "run.json"), JSON.stringify({ root_id: id, created_at: "2026-11-04T03:00:00.000Z", subject: id }));
  writeFileSync(join(base, "plan.v1.json"), JSON.stringify({ version: 1, nodes: [], coverage: [], paths: [] }));
  writeFileSync(join(base, "nodes", "root", "spec.json"), JSON.stringify({ id: `node:${id}/root`, type: "assign", goal: "g", accept: [], ...specExtra }));
  writeFileSync(join(base, "nodes", "root", "events.jsonl"), ev("2026-11-04T03:00:01.000Z", "spawn", { cmd: "pi" }) + "\n");
  writeFileSync(join(base, "nodes", "root", "result.json"), JSON.stringify({ id: `node:${id}/root`, type: "result", status: "done", summary: "ok", finished_at: "2026-11-04T03:01:00.000Z" }));
  return base;
}

function gitIn(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=T", ...args], { cwd, encoding: "utf8", windowsHide: true });
}

test("R5：审批模式 / 模型 / 档位从根 spec 回显（派发写进 spec 才算数）", () => {
  const state = mkdtempSync(join(tmpdir(), "aica-r5-mode-"));
  mkRun(state, "ro", { permission: "supervised", tools: ["read", "ls", "find", "grep", "kn_recall"], model: "opencode-pool/deepseek-v4.1-flash", budget: { depth_left: 2, effort: "high" } });
  mkRun(state, "full", { permission: "full", tools: ["read", "write", "edit", "bash"], model: "opencode-pool/deepseek-v4.1-flash", budget: { effort: "low" } });
  mkRun(state, "plain");
  clearViewCache();
  const v = buildView(join(state, "runs"), { now: NOW });
  const byId = new Map(v.runs.map(r => [r.id, r]));
  assert.equal(byId.get("ro")!.mode, "readonly", "没有写/编辑工具 → 只读");
  assert.equal(byId.get("ro")!.permission, "supervised");
  assert.equal(byId.get("ro")!.model, "opencode-pool/deepseek-v4.1-flash");
  assert.equal(byId.get("ro")!.effort, "high");
  assert.equal(byId.get("full")!.mode, "full", "permission=full → 全权限");
  assert.equal(byId.get("full")!.effort, "low");
  assert.equal(byId.get("plain")!.mode, null, "老 run 没有 permission → 不编徽标");
  assert.equal(byId.get("plain")!.model, null);
  rmSync(state, { recursive: true, force: true });
});

test("R5：approvalModeOf 判定（只读看工具面，全权限看 permission）", () => {
  assert.equal(approvalModeOf("supervised", ["read", "ls"]), "readonly");
  assert.equal(approvalModeOf("supervised", ["read", "write"]), "edit");
  assert.equal(approvalModeOf("supervised", ["read", "bash"]), "edit");
  assert.equal(approvalModeOf("full", ["read"]), "full", "full 压过工具面");
  assert.equal(approvalModeOf(undefined, undefined), null);
  assert.equal(approvalModeOf(undefined, []), null, "空工具面不算只读（没声明 ≠ 只读）");
});

function mkRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "aica-r5-git-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir, windowsHide: true });
  gitIn(dir, ["config", "user.email", "t@example.com"]);
  gitIn(dir, ["config", "user.name", "T"]);
  writeFileSync(join(dir, "a.txt"), "one\ntwo\n");
  writeFileSync(join(dir, "gone.txt"), "bye\n");
  gitIn(dir, ["add", "-A"]);
  gitIn(dir, ["commit", "-q", "-m", "init"]);
  return dir;
}

test("R5：git status / diff（A/M/D + ±行数）", () => {
  const dir = mkRepo();
  const clean = gitStatus(dir);
  assert.equal(clean.repo, true);
  assert.equal(clean.files.length, 0);
  assert.equal(clean.branch, "main");

  writeFileSync(join(dir, "a.txt"), "one\nTWO\n");      // M
  writeFileSync(join(dir, "new.txt"), "n1\nn2\n");      // A（未跟踪）
  rmSync(join(dir, "gone.txt"));                        // D
  const st = gitStatus(dir);
  const by = new Map(st.files.map(f => [f.path, f]));
  assert.equal(by.get("a.txt")!.code, "M");
  assert.equal(by.get("new.txt")!.code, "A");
  assert.equal(by.get("gone.txt")!.code, "D");
  assert.ok((by.get("new.txt")!.add || 0) > 0, "未跟踪文件按整文件行数算 +");

  const d = gitDiff(dir, "a.txt");
  assert.equal(d.ok, true);
  assert.match(d.patch, /^-two$/m);
  assert.match(d.patch, /^\+TWO$/m, "diff 正文要给 UI 的 +/− 行");
  rmSync(dir, { recursive: true, force: true });
});

test("R5：提交审批卡 —— 拒绝不落任何 git 操作；批准才真的 commit", () => {
  const dir = mkRepo();
  const state = mkdtempSync(join(tmpdir(), "aica-r5-ask-"));
  const runs = join(state, "runs");
  mkdirSync(join(runs, "run-1"), { recursive: true });

  writeFileSync(join(dir, "a.txt"), "one\nTWO\n");
  const head0 = gitIn(dir, ["rev-parse", "HEAD"]).trim();
  const st0 = gitStatus(dir);

  // —— 提 ask（POST /api/git/commit 走的就是这一步：只落卡，不动 git）
  writeAsk(runs, "run-1", { id: "git-x", message: "改 a.txt", files: st0.files.map(f => f.path), created_at: "2026-11-04T04:00:00.000Z" });
  assert.equal(gitIn(dir, ["rev-parse", "HEAD"]).trim(), head0, "落卡阶段不许产生提交");
  assert.equal(gitStatus(dir).files.length, st0.files.length, "工作区也没被动过");

  // —— 拒绝：只删卡
  clearAsk(runs, "run-1");
  assert.equal(readAsk(runs, "run-1"), null);
  assert.equal(gitIn(dir, ["rev-parse", "HEAD"]).trim(), head0, "拒绝后 HEAD 不变");
  assert.equal(gitStatus(dir).files.length, st0.files.length, "拒绝后工作区原样（没 add）");

  // —— 批准才执行
  const out = gitCommit(dir, "改 a.txt");
  assert.equal(out.ok, true, out.error);
  assert.ok(out.sha && out.sha.length >= 7);
  assert.notEqual(gitIn(dir, ["rev-parse", "HEAD"]).trim(), head0, "批准后才真的有新提交");
  assert.equal(gitStatus(dir).files.length, 0, "提交后工作区干净");
  rmSync(state, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
});

test("R5：不是 git 仓库时返回 repo=false（Git 页签空态的数据来源）", () => {
  const dir = mkdtempSync(join(tmpdir(), "aica-r5-nogit-"));
  writeFileSync(join(dir, "x.txt"), "x\n");
  const st = gitStatus(dir);
  assert.equal(st.repo, false);
  assert.deepEqual(st.files, []);
  assert.equal(gitCommit(dir, "nope").ok, false);
  rmSync(dir, { recursive: true, force: true });
});


test("R5：仓库没配身份也能提交（兜底 AICA，不留半截 index）", () => {
  const dir = mkdtempSync(join(tmpdir(), "aica-r5-noid-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir, windowsHide: true });
  writeFileSync(join(dir, "x.txt"), "x\n");
  const out = gitCommit(dir, "无身份提交");
  assert.equal(out.ok, true, out.error);
  assert.match(gitIn(dir, ["log", "-1", "--pretty=%an"]).trim(), /AICA/);
  assert.equal(gitStatus(dir).files.length, 0, "提交后工作区干净（index 没留半截）");
  rmSync(dir, { recursive: true, force: true });
});

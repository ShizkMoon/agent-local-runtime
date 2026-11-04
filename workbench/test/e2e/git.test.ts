// R6：Git 面板的两段式提交（commit 必须过审批卡，拒绝则 git 一动不动）。
// 断言全部落在外部世界：真 git 仓库 + 真 HEAD sha + 真工作区状态；HTTP 走真 server.ts 路由。
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getJson, postJson, startServer } from "./lib/srv.mjs";

const PORT = Number(process.env.AICA_E2E_GIT_PORT ?? 4501);
const RUN = "git-fixture-run";

let repo = "", state = "", srv = null, base = "", head0 = "";

const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
const head = () => git(repo, ["rev-parse", "HEAD"]);
const askFile = () => join(state, "runs", RUN, "git-ask.json");

test.before(async () => {
  repo = mkdtempSync(join(tmpdir(), "aica-e2e-git-"));
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "e2e@localhost"]);
  git(repo, ["config", "user.name", "E2E"]);
  writeFileSync(join(repo, "app.txt"), "v1\n", "utf8");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "init"]);
  head0 = head();
  // 让工作区有改动（未提交），这样 /api/git/status 才有东西可看
  writeFileSync(join(repo, "app.txt"), "v1\nv2\n", "utf8");
  writeFileSync(join(repo, "new.txt"), "brand new\n", "utf8");

  state = mkdtempSync(join(tmpdir(), "aica-e2e-git-state-"));
  const runDir = join(state, "runs", RUN);
  const nodeDir = join(runDir, "nodes", "root");
  mkdirSync(nodeDir, { recursive: true });
  writeFileSync(join(runDir, "run.json"), JSON.stringify({
    root_id: RUN, kind: "assign", subject: "git 提交卡", created_at: "2026-11-04T12:00:00.000Z", cwd: repo,
  }, null, 2) + "\n", "utf8");
  writeFileSync(join(nodeDir, "spec.json"), JSON.stringify({
    id: `node:${RUN}/root`, type: "assign", agent: "pi", goal: "改文件并提交", accept: ["ok"], inputs: [], tools: ["bash"],
  }) + "\n", "utf8");
  writeFileSync(join(nodeDir, "result.json"), JSON.stringify({
    id: `node:${RUN}/root`, type: "result", status: "done", summary: "改完了", finished_at: "2026-11-04T12:10:00.000Z",
  }) + "\n", "utf8");

  try {
    srv = await startServer({ stateDir: state, port: PORT, expectRuns: 1 });
  } catch (e) {
    if (String(e?.message ?? e).startsWith("PORT_BUSY")) { srv = null; return; }
    throw e;
  }
  base = srv.base;
});

test.after(async () => {
  if (srv) await srv.stop();
  for (const d of [repo, state]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 临时目录 */ } }
});

test("git：/api/git/status 给出 repo/branch/files（A/M + ±行数）", async (t) => {
  if (!srv) { t.skip("端口全占（4487 及顺延段）"); return; }
  const r = await getJson(`${base}/api/git/status?run=${RUN}`);
  assert.equal(r.status, 200, r.text);
  const j = r.json;
  assert.equal(j.ok, true);
  assert.equal(j.run, RUN);
  assert.equal(j.repo, true, "临时仓库必须是 git 仓库");
  assert.ok(typeof j.branch === "string" && j.branch.length > 0, `branch 不该为空：${j.branch}`);
  const files = j.files.map((f) => `${f.code} ${f.path}`).sort();
  assert.deepEqual(files, ["A new.txt", "M app.txt"], `改动清单不对：${JSON.stringify(j.files)}`);
  const app = j.files.find((f) => f.path === "app.txt");
  assert.equal(app.add, 1, "app.txt 加了一行");
  const neu = j.files.find((f) => f.path === "new.txt");
  assert.equal(neu.add, 1, "未跟踪文件按整文件行数算 +");
});

test("git：POST commit 只落卡，HEAD 一动不动", async (t) => {
  if (!srv) { t.skip("端口不可用"); return; }
  const r = await postJson(`${base}/api/git/commit`, { run: RUN, message: "e2e：两段式提交" });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.pending, true, "只是 ask，还没提交");
  assert.equal(r.json.ask.message, "e2e：两段式提交");
  assert.deepEqual(r.json.ask.files.sort(), ["app.txt", "new.txt"]);
  assert.equal(existsSync(askFile()), true, "卡要落盘（git-ask.json）");
  assert.equal(head(), head0, "提卡阶段 HEAD 不许变");
});

test("git：拒绝 → 卡删除、HEAD 与工作区都不动", async (t) => {
  if (!srv) { t.skip("端口不可用"); return; }
  const before = head();
  const r = await postJson(`${base}/api/git/commit/reject`, { run: RUN });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.rejected, true);
  assert.equal(r.json.had, true, "确实拒掉了一张存在的卡");
  assert.equal(existsSync(askFile()), false, "卡必须删掉");
  assert.equal(head(), before, "拒绝后 HEAD 不许变");
  const st = git(repo, ["status", "--porcelain"]);
  assert.match(st, /app\.txt/, "拒绝不能顺手 add/commit（工作区改动还在）");
});

test("git：批准 → 真的提交，HEAD 变化且 commit message 就是卡上的字", async (t) => {
  if (!srv) { t.skip("端口不可用"); return; }
  await postJson(`${base}/api/git/commit`, { run: RUN, message: "e2e：批准后提交" });
  const r = await postJson(`${base}/api/git/commit/approve`, { run: RUN });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.ok, true, r.text);
  const sha = r.json.commit;
  assert.match(String(sha), /^[0-9a-f]{40}$/, `commit 应是 40 位 sha：${sha}`);
  assert.equal(head(), sha, "返回的 sha 必须等于真 HEAD");
  assert.notEqual(head(), head0, "批准后 HEAD 必须变化");
  assert.equal(git(repo, ["log", "-1", "--format=%s"]), "e2e：批准后提交");
  assert.equal(git(repo, ["status", "--porcelain"]), "", "提交后工作区应干净");
  assert.equal(existsSync(askFile()), false, "卡用掉就该消失");
});

test("git：坏输入 —— 空 message 400、没有卡时 approve 404", async (t) => {
  if (!srv) { t.skip("端口不可用"); return; }
  const empty = await postJson(`${base}/api/git/commit`, { run: RUN, message: "   " });
  assert.equal(empty.status, 400, empty.text);
  assert.match(empty.text, /commit message/);
  const noAsk = await postJson(`${base}/api/git/commit/approve`, { run: RUN });
  assert.equal(noAsk.status, 404, noAsk.text);
  assert.match(noAsk.text, /没有待审批/);
  const badRun = await postJson(`${base}/api/git/commit`, { run: "../etc", message: "x" });
  assert.equal(badRun.status, 400, "run 必须过 okId");
});

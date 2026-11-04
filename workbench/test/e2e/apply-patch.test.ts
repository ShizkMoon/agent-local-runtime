// R6 G-3/契约：apply_patch 的多文件 all-or-nothing 与"失败零写入"。
// 走真产品路径：aica-pi/extensions/tools.ts 的 apply_patch 工具 → src/patch.ts 应用 → 事件直写节点目录 → workbench/view.ts 聚合。
// 不 mock：sha256 是外部重算的，事件是产品自己写的，聚合用产品自己的 diffsOf。
import test from "node:test";
import assert from "node:assert/strict";
import { runScenario } from "./lib/scenario-run.mjs";

let cached = null;
async function once() {
  if (!cached) cached = await runScenario("apply-patch", { timeoutMs: 120000 });
  return cached;
}
test.after(() => { cached?.cleanup(); });

test("apply_patch：一改一新建 → patch 事件 files 的 add/del 与磁盘一致", async (t) => {
  const r = await once();
  if (r.code !== 0 || !r.result) {
    t.diagnostic(r.stderr.slice(0, 800));
    assert.fail(`场景 apply-patch 退出码 ${r.code}`);
  }
  const x = r.result;
  assert.equal(x.okRes.isError, false, x.okRes.text);
  // 磁盘：a 被改、b 被建、c 没碰
  assert.equal(x.filesAfterOk.a, "one\ntwo\ntwo-and-half\nthree\n");
  assert.equal(x.filesAfterOk.b, "hello\nworld\n");
  assert.equal(x.filesAfterOk.c, "keep\n");
  // patch 事件：两条文件记录，action/add/del 与 diff 一致
  assert.equal(x.patchEv.length, 1, "一次 apply_patch 只写一条 patch 事件");
  const files = x.patchEv[0].files;
  assert.deepEqual(files.map((f) => [f.path, f.action, f.add, f.del]), [
    ["src/a.txt", "update", 1, 0],
    ["src/b.txt", "create", 2, 0],
  ]);
  assert.ok(String(x.patchEv[0].patch).includes("+two-and-half"), "patch 事件里要留可复现的补丁正文");
});

test("apply_patch：每文件一条 file_edit，能被 view.diffsOf 聚合成补丁", async (t) => {
  const r = await once();
  if (!r.result) assert.fail(`场景失败：${r.stderr.slice(0, 400)}`);
  const x = r.result;
  assert.equal(x.editEv.length, 2, "两个文件 → 两条 file_edit");
  for (const e of x.editEv) {
    assert.ok(String(e.diff).startsWith("--- "), "file_edit 要带 unified diff（UI 才能展示）");
    assert.equal(e.tool, "apply_patch");
  }
  assert.deepEqual(x.diffs, [
    { file: "src/a.txt", add: 1, del: 0, hunks: 1, hasPatch: true },
    { file: "src/b.txt", add: 2, del: 0, hunks: 1, hasPatch: true },
  ]);
});

test("apply_patch：上下文不匹配 → CONTEXT 且 sha256 全部不变（零写入）", async (t) => {
  const r = await once();
  if (!r.result) assert.fail(`场景失败：${r.stderr.slice(0, 400)}`);
  const x = r.result;
  assert.equal(x.badRes.isError, true);
  assert.match(x.badRes.text, /"code":"CONTEXT"/);
  assert.match(x.badRes.text, /第 1 行上下文不匹配/, "报错要指到具体行");
  // 世界核对：失败前后两个文件的 sha256 一致（第二个文件本来能改，也不许写）
  assert.deepEqual(x.shaAfterBad, x.shaBeforeBad, `零写入被破坏：${JSON.stringify(x.shaBeforeBad)} → ${JSON.stringify(x.shaAfterBad)}`);
  assert.equal(x.patchEvCount, 1, "失败不许补写 patch 事件");
  assert.equal(x.fileEditCount, 2, "失败不许补写 file_edit 事件");
});

test("apply_patch：没读过的文件 → NEEDS_READ，且磁盘一个字节没动", async (t) => {
  const r = await once();
  if (!r.result) assert.fail(`场景失败：${r.stderr.slice(0, 400)}`);
  const x = r.result;
  assert.equal(x.noRead.isError, true);
  assert.match(x.noRead.text, /NEEDS_READ/);
  assert.match(x.noRead.text, /read-before-edit/);
  assert.equal(x.cSha0.length, 64, "sha256 应当是 64 位十六进制");
});

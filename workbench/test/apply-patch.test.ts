// R5：apply_patch —— 多文件 all-or-nothing、read-before-edit、patch/file_edit 事件、路径白名单。
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chdir } from "node:process";

const WS = mkdtempSync(join(tmpdir(), "aica-r5-patch-"));
writeFileSync(join(WS, "a.txt"), "l1\nl2\nl3\n", "utf8");
writeFileSync(join(WS, "c.txt"), "keep\n", "utf8");
mkdirSync(join(WS, "sub"), { recursive: true });
writeFileSync(join(WS, "sub", "s.txt"), "s1\ns2\n", "utf8");

const prev = process.cwd();
chdir(WS);
const T: any = await import("../../aica-pi/extensions/tools.ts");

const pi: any = {
  tools: new Map<string, any>(),
  handlers: new Map<string, any>(),
  registerTool(t: any) { this.tools.set(t.name, t); },
  on(name: string, fn: any) { this.handlers.set(name, fn); },
};
T.default(pi);

const patch = async (text: string) => {
  const r = await pi.tools.get("apply_patch").execute("call-1", { patch: text });
  return { isError: !!r.isError, text: String(r.content?.[0]?.text ?? "") };
};
/** 模拟 pi 的 read 工具调用（start 记 path，end 非错误才落账） */
const readFile = (p: string, id = `c${Math.random()}`) => {
  pi.handlers.get("tool_execution_start")?.({ toolName: "read", toolCallId: id, args: { path: p } });
  pi.handlers.get("tool_execution_end")?.({ toolName: "read", toolCallId: id, isError: false });
};
const events = (): any[] => {
  const f = join(WS, "events.jsonl");
  return existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
};

test("多文件补丁一次成功：update + create，落盘正确，写 patch + 每文件 file_edit", async () => {
  readFile("a.txt");
  const diff = [
    "--- a/a.txt",
    "+++ b/a.txt",
    "@@ -1,3 +1,3 @@",
    " l1",
    "-l2",
    "+L2",
    " l3",
    "--- /dev/null",
    "+++ b/b.txt",
    "@@ -0,0 +1,2 @@",
    "+hello",
    "+world",
  ].join("\n");
  const r = await patch(diff);
  assert.equal(r.isError, false, r.text);
  assert.equal(readFileSync(join(WS, "a.txt"), "utf8"), "l1\nL2\nl3\n");
  assert.equal(readFileSync(join(WS, "b.txt"), "utf8"), "hello\nworld\n");

  const ev = events();
  const patchEv = ev.filter((e) => e.kind === "patch");
  assert.equal(patchEv.length, 1);
  assert.deepEqual(patchEv[0].data.files.map((f: any) => [f.path, f.add, f.del]), [["a.txt", 1, 1], ["b.txt", 2, 0]]);
  const edits = ev.filter((e) => e.kind === "file_edit");
  assert.equal(edits.length, 2);
  const a = edits.find((e) => e.data.path === "a.txt");
  assert.equal(a.data.add, 1);
  assert.equal(a.data.del, 1);
  assert.match(a.data.diff, /^--- a\/a\.txt\n\+\+\+ b\/a\.txt\n@@ -1,3 \+1,3 @@/);
  assert.ok(a.data.diff.split("\n").length >= 6);
});

test("read-before-edit：未 read 的已存在文件 → NEED_READ，零写入", async () => {
  const before = readFileSync(join(WS, "c.txt"), "utf8");
  const r = await patch(["--- a/c.txt", "+++ b/c.txt", "@@ -1,1 +1,1 @@", "-keep", "+changed"].join("\n"));
  assert.equal(r.isError, true);
  const j = JSON.parse(r.text);
  assert.equal(j.code, "NEEDS_READ");
  assert.deepEqual(j.needs, ["c.txt"]);
  assert.match(j.message, /先 read c\.txt/);
  assert.equal(readFileSync(join(WS, "c.txt"), "utf8"), before, "零写入");
});

test("上下文不匹配 → 整次失败，一个文件也不写（all-or-nothing）", async () => {
  readFile("a.txt");
  readFile("c.txt");
  const aBefore = readFileSync(join(WS, "a.txt"), "utf8");
  const cBefore = readFileSync(join(WS, "c.txt"), "utf8");
  // a.txt 这段本身合法；c.txt 的上下文是错的（磁盘上是 keep）——必须整次失败
  const diff = [
    "--- a/a.txt",
    "+++ b/a.txt",
    "@@ -1,3 +1,3 @@",
    " l1",
    "-L2",
    "+L2-fixed",
    " l3",
    "--- a/c.txt",
    "+++ b/c.txt",
    "@@ -1,1 +1,1 @@",
    "-not-on-disk",
    "+nope",
  ].join("\n");
  const r = await patch(diff);
  assert.equal(r.isError, true);
  const j = JSON.parse(r.text);
  assert.equal(j.code, "CONTEXT");
  assert.equal(j.path, "c.txt");
  assert.equal(j.line, 1);
  assert.match(j.message, /第 1 行上下文不匹配/);
  assert.match(j.message, /建议先 read|先 read/);
  assert.equal(readFileSync(join(WS, "a.txt"), "utf8"), aBefore, "前一个文件不得半写");
  assert.equal(readFileSync(join(WS, "c.txt"), "utf8"), cBefore);
});

test("路径白名单：.git 拒绝、逃出 cwd 拒绝、新建已存在文件拒绝", async () => {
  const git = await patch(["--- /dev/null", "+++ b/.git/config", "@@ -0,0 +1,1 @@", "+x"].join("\n"));
  assert.equal(JSON.parse(git.text).code, "BAD_PATH");

  const escape = await patch(["--- a/../outside.txt", "+++ b/../outside.txt", "@@ -1,1 +1,1 @@", "-a", "+b"].join("\n"));
  assert.equal(escape.isError, true);
  assert.equal(existsSync(join(WS, "..", "outside.txt")), false);

  const dup = await patch(["--- /dev/null", "+++ b/a.txt", "@@ -0,0 +1,1 @@", "+dup"].join("\n"));
  assert.equal(JSON.parse(dup.text).code, "BAD_PATCH");
  assert.match(JSON.parse(dup.text).message, /已存在/);
});

test("新建不需要 read；删除需要 read，删后文件消失", async () => {
  const add = await patch(["--- /dev/null", "+++ b/sub/new.txt", "@@ -0,0 +1,1 @@", "+n"].join("\n"));
  assert.equal(add.isError, false, add.text);

  const delNoRead = await patch(["--- a/sub/s.txt", "+++ /dev/null", "@@ -1,2 +0,0 @@", "-s1", "-s2"].join("\n"));
  assert.equal(JSON.parse(delNoRead.text).code, "NEEDS_READ");

  readFile("sub/s.txt");
  const del = await patch(["--- a/sub/s.txt", "+++ /dev/null", "@@ -1,2 +0,0 @@", "-s1", "-s2"].join("\n"));
  assert.equal(del.isError, false, del.text);
  assert.equal(existsSync(join(WS, "sub", "s.txt")), false);
});

test("写过的文件视为已读：连续两次 patch 同一文件不必再 read", async () => {
  const d1 = ["--- a/a.txt", "+++ b/a.txt", "@@ -2,1 +2,1 @@", "-L2", "+L2-fixed"].join("\n");
  const r1 = await patch(d1);
  assert.equal(r1.isError, false, r1.text);
  const d2 = ["--- a/a.txt", "+++ b/a.txt", "@@ -2,1 +2,1 @@", "-L2-fixed", "+L2-again"].join("\n");
  const r2 = await patch(d2);
  assert.equal(r2.isError, false, r2.text);
  assert.equal(readFileSync(join(WS, "a.txt"), "utf8"), "l1\nL2-again\nl3\n");
});

process.on("exit", () => { try { chdir(prev); } catch { /* ignore */ } });

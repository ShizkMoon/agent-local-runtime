// R3 B3：@file 引用 —— 注入「## 引用文件」段；单文件 ≤8KB、总量 ≤32KB；缺失注入 [缺失] 且不阻塞。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STATE = mkdtempSync(join(tmpdir(), "aica-r3-at-state-"));
process.env.AICA_STATE = STATE;
const D = await import("../../src/daemon.ts");

const BASE = mkdtempSync(join(tmpdir(), "aica-r3-at-"));
writeFileSync(join(BASE, "a.md"), "ALPHA 内容\n第二行\n", "utf8");
writeFileSync(join(BASE, "big.md"), "x".repeat(10 * 1024), "utf8");
for (const n of ["b1", "b2", "b3", "b4", "b5"]) writeFileSync(join(BASE, `${n}.md`), "y".repeat(8 * 1024), "utf8");

const spec = (goal: string) => ({ id: "node:x/root", type: "assign", goal, accept: ["x"], budget: { depth_left: 1 } }) as any;

test("expandAtRefs：存在的文件按原文注入，段落头是「## 引用文件」", () => {
  const r = D.expandAtRefs("先读 @a.md 再继续", BASE);
  assert.equal(r.refs.length, 1);
  assert.equal(r.refs[0].ref, "a.md");
  assert.equal(r.refs[0].ok, true);
  assert.equal(r.refs[0].bytes, Buffer.byteLength("ALPHA 内容\n第二行\n"));
  assert.match(r.text, /^## 引用文件/);
  assert.match(r.text, /ALPHA 内容/);
  assert.match(r.text, /第二行/);
});

test("expandAtRefs：缺失 → [缺失] 标记 + 回调（daemon 用它记 input 事件），不丢其它引用", () => {
  const missing: string[] = [];
  const r = D.expandAtRefs("看 @a.md 和 @nope.md", BASE, (ref) => missing.push(ref));
  assert.deepEqual(missing, ["nope.md"]);
  assert.match(r.text, /- \[缺失\] nope\.md/);
  assert.match(r.text, /ALPHA 内容/, "同一条 goal 里的有效引用照常注入");
  assert.equal(r.refs.find((x) => x.ref === "nope.md")?.ok, false);
});

test("expandAtRefs：单文件 8KB 截断（标记已截断），总量 32KB 封顶", () => {
  const one = D.expandAtRefs("@big.md", BASE);
  assert.equal(one.refs[0].bytes, 8 * 1024);
  assert.equal(one.refs[0].truncated, true);
  assert.match(one.text, /已截断：超出注入上限/);

  const many = D.expandAtRefs("@b1.md @b2.md @b3.md @b4.md @b5.md", BASE);
  const total = many.refs.reduce((s, x) => s + x.bytes, 0);
  assert.equal(total, 32 * 1024, "四份 8KB 打满，总量不超 32KB");
  assert.equal(many.refs.length, 5);
  assert.equal(many.refs[4].bytes, 0, "第五份不再注入");
  assert.match(many.text, /超出注入总量上限/);
});

test("expandAtRefs：绝对路径可用、重复引用只注入一次、没有 @ 就不加段", () => {
  const abs = join(BASE, "a.md");
  const r = D.expandAtRefs(`@${abs}`, BASE);
  assert.match(r.text, /ALPHA 内容/);

  const dup = D.expandAtRefs("@a.md 再看 @a.md", BASE);
  assert.equal(dup.refs.length, 1, "同一 ref 只算一次");

  assert.deepEqual(D.expandAtRefs("没有引用", BASE), { text: "", refs: [] });
});

test("expandAtRefs：.git 与 STATE 内的路径一律拒绝（@ 是绕过 gate 的直接读）", () => {
  mkdirSync(join(BASE, ".git"), { recursive: true });
  writeFileSync(join(BASE, ".git", "config"), "[core]\n", "utf8");
  const g = D.expandAtRefs("@.git/config", BASE);
  assert.equal(g.refs[0].ok, false);
  assert.equal(g.refs[0].denied, ".git 目录");
  assert.match(g.text, /\[拒绝\] \.git\/config/);

  mkdirSync(join(STATE, "runs", "r", "nodes", "root"), { recursive: true });
  writeFileSync(join(STATE, "runs", "r", "nodes", "root", "gate-req.json"), "{\"secret\":1}", "utf8");
  const s = D.expandAtRefs("@runs/r/nodes/root/gate-req.json", STATE);
  assert.equal(s.refs[0].ok, false);
  assert.equal(s.refs[0].denied, "运行时状态目录");
  assert.equal(s.text.includes("secret"), false, "控制面内容绝不进 prompt");
});

test("userMessage：@file 段进 user message（资料不当指令），缺失回调接到 input 事件写入方", () => {
  const missing: string[] = [];
  const msg = D.userMessage(spec("照着 @a.md 做，缺的看 @gone.md"), false, BASE, (ref) => missing.push(ref));
  assert.match(msg, /## 引用文件/);
  assert.match(msg, /ALPHA 内容/);
  assert.match(msg, /\[缺失\] gone\.md/);
  assert.deepEqual(missing, ["gone.md"]);
  assert.ok(msg.indexOf("## 引用文件") > msg.indexOf("## 节点上下文"), "引用段在上下文之后");
});

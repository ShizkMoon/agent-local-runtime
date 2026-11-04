// R3 B3：@file 引用 —— 注入「## 引用文件」段；单文件 ≤8KB、总量 ≤32KB；缺失注入 [缺失] 且不阻塞。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 目录布局模拟"STATE 放在仓库里"：R/package.json + R/state/runs → atRefBases 能向上找到仓库根 R
const R = mkdtempSync(join(tmpdir(), "aica-r3-at-repo-"));
writeFileSync(join(R, "package.json"), "{\"name\":\"r3-at\"}\n", "utf8");
const STATE = join(R, "state");
process.env.AICA_STATE = STATE;
mkdirSync(join(STATE, "runs"), { recursive: true });
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
  const r = D.expandAtRefs("看 @a.md 和 @nope.md", BASE, (ref, info) => { if (!info.ok) missing.push(ref); });
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
  const msg = D.userMessage(spec("照着 @a.md 做，缺的看 @gone.md"), false, BASE, (ref, info) => { if (!info.ok) missing.push(ref); });
  assert.match(msg, /## 引用文件/);
  assert.match(msg, /ALPHA 内容/);
  assert.match(msg, /\[缺失\] gone\.md/);
  assert.deepEqual(missing, ["gone.md"]);
  assert.ok(msg.indexOf("## 引用文件") > msg.indexOf("## 节点上下文"), "引用段在上下文之后");
});

test("atRefBases：AICA_REPO_ROOT → runs 祖先里的仓库根 → 节点目录", () => {
  const nodeDir = mkdtempSync(join(tmpdir(), "aica-r3-at-node-"));
  const bases = D.atRefBases(nodeDir);
  assert.deepEqual(bases.map((b: any) => b.label), ["repo", "node"]);
  assert.equal(bases[0].dir, R, "从 runs 上一路找到含 package.json 的祖先");
  assert.equal(bases[1].dir, nodeDir);

  process.env.AICA_REPO_ROOT = join(tmpdir(), "aica-r3-at-fake-repo");
  try {
    const withEnv = D.atRefBases(nodeDir);
    assert.equal(withEnv[0].label, "repo");
    assert.equal(withEnv[0].dir, join(tmpdir(), "aica-r3-at-fake-repo"), "显式 AICA_REPO_ROOT 最优先");
  } finally { delete process.env.AICA_REPO_ROOT; }
});

test("expandAtRefs：同一 ref 按基准顺序命中，命中哪个记在 base 上（repo 优先于 node）", () => {
  const nodeDir = mkdtempSync(join(tmpdir(), "aica-r3-at-node2-"));
  mkdirSync(join(R, "docs"), { recursive: true });
  writeFileSync(join(R, "docs", "ref.md"), "REPO-COPY", "utf8");
  mkdirSync(join(nodeDir, "docs"), { recursive: true });
  writeFileSync(join(nodeDir, "docs", "ref.md"), "NODE-COPY", "utf8");
  writeFileSync(join(nodeDir, "local.md"), "NODE-ONLY", "utf8");

  const both = D.expandAtRefs("@docs/ref.md", D.atRefBases(nodeDir));
  assert.equal(both.refs[0].base, "repo", "两处都有 → repo 优先");
  assert.match(both.text, /REPO-COPY/);

  const nodeOnly = D.expandAtRefs("@local.md", D.atRefBases(nodeDir));
  assert.equal(nodeOnly.refs[0].base, "node", "只有节点目录有 → 回落到 node");
  assert.match(nodeOnly.text, /NODE-ONLY/);
});

test("userMessage：@ref 命中的 base 进回调（daemon 用它在 input 事件里记 base）", () => {
  const nodeDir = mkdtempSync(join(tmpdir(), "aica-r3-at-node3-"));
  mkdirSync(join(R, "docs"), { recursive: true });
  writeFileSync(join(R, "docs", "ref.md"), "REPO-COPY", "utf8");
  const seen: any[] = [];
  const msg = D.userMessage(spec("看 @docs/ref.md"), false, nodeDir, (_ref: string, info: any) => seen.push(info));
  assert.match(msg, /REPO-COPY/);
  assert.equal(seen[0].base, "repo");
  assert.equal(seen[0].ok, true);
});

// R5：AGENTS.md 项目上下文 —— 项目根→cwd 逐级、AGENTS.md 优先、≤8KB、userMessage 注入 + input 事件回调。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AICA_STATE = mkdtempSync(join(tmpdir(), "aica-r5-am-state-"));
const D: any = await import("../../src/daemon.ts");

const REPO = mkdtempSync(join(tmpdir(), "aica-r5-am-"));
mkdirSync(join(REPO, "packages", "app"), { recursive: true });
writeFileSync(join(REPO, "AGENTS.md"), "# 根规则\n\n- 中文注释\n- 测试放 workbench/test\n", "utf8");
writeFileSync(join(REPO, "packages", "app", "AGENTS.md"), "# 子包规则\n\n- 只改 src/\n", "utf8");

const spec: any = { id: "node:x/root", type: "assign", goal: "干点活", accept: ["产出文件"] };

test("从项目根到 cwd 逐级收集，AGENTS.md 拼接（根在前）", () => {
  const r = D.collectAgentsMd(join(REPO, "packages", "app"), REPO);
  assert.deepEqual(r.files, ["AGENTS.md", "packages/app/AGENTS.md"]);
  assert.ok(r.text.indexOf("根规则") < r.text.indexOf("子包规则"), "根在前");
  assert.ok(r.bytes > 0 && r.bytes <= 8 * 1024);
  assert.equal(r.bytes, Buffer.byteLength(r.text, "utf8"));
});

test("同一目录 AGENTS.md 优先于 CLAUDE.md", () => {
  const dir = mkdtempSync(join(tmpdir(), "aica-r5-am2-"));
  writeFileSync(join(dir, "AGENTS.md"), "AGENTS 内容", "utf8");
  writeFileSync(join(dir, "CLAUDE.md"), "CLAUDE 内容", "utf8");
  const r = D.collectAgentsMd(dir, dir);
  assert.deepEqual(r.files, ["AGENTS.md"]);
  assert.match(r.text, /AGENTS 内容/);
  assert.equal(/CLAUDE 内容/.test(r.text), false, "有 AGENTS.md 时不再读 CLAUDE.md");
});

test("只有 CLAUDE.md 时回落读取它", () => {
  const dir = mkdtempSync(join(tmpdir(), "aica-r5-am3-"));
  writeFileSync(join(dir, "CLAUDE.md"), "旧项目约定", "utf8");
  const r = D.collectAgentsMd(dir, dir);
  assert.deepEqual(r.files, ["CLAUDE.md"]);
  assert.match(r.text, /旧项目约定/);
});

test("总字节 ≤ 8KB：超长文件截断并标记", () => {
  const dir = mkdtempSync(join(tmpdir(), "aica-r5-am4-"));
  const big = Array.from({ length: 2000 }, (_, i) => `第 ${i} 行：` + "很长的项目约定".repeat(3)).join("\n");
  writeFileSync(join(dir, "AGENTS.md"), big, "utf8");
  const r = D.collectAgentsMd(dir, dir);
  assert.ok(r.bytes <= 8 * 1024, `bytes=${r.bytes}`);
  assert.match(r.text, /8KB 截断/);
});

test("找不到 → 空文本；userMessage 不注入、不回调", () => {
  const dir = mkdtempSync(join(tmpdir(), "aica-r5-am5-"));
  const r = D.collectAgentsMd(dir, dir);
  assert.equal(r.text, "");
  assert.deepEqual(r.files, []);
  const seen: any[] = [];
  const msg = D.userMessage(spec, false, dir, undefined, (i: any) => seen.push(i));
  assert.equal(/根规则|项目约定/.test(msg), false);
  assert.equal(seen.length, 0, "找不到不写事件");
});

test("userMessage 注入 AGENTS.md 并回调 {files, bytes}", () => {
  const prev = process.env.AICA_REPO_ROOT;
  process.env.AICA_REPO_ROOT = REPO;             // 生产里 worker cwd 在 STATE 下，项目根靠这个变量指过来
  try {
    const seen: any[] = [];
    const msg = D.userMessage(spec, false, join(REPO, "packages", "app"), undefined, (i: any) => seen.push(i));
    assert.match(msg, /## AGENTS\.md/);
    assert.match(msg, /根规则/);
    assert.match(msg, /子包规则/);
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0].files, ["AGENTS.md", "packages/app/AGENTS.md"]);
    assert.ok(seen[0].bytes > 0 && seen[0].bytes <= 8 * 1024);
  } finally {
    if (prev === undefined) delete process.env.AICA_REPO_ROOT; else process.env.AICA_REPO_ROOT = prev;
  }
});

test("findProjectRoot：AICA_REPO_ROOT 优先；否则向上找 .git/package.json", () => {
  const prev = process.env.AICA_REPO_ROOT;
  process.env.AICA_REPO_ROOT = REPO;
  assert.equal(D.findProjectRoot(join(REPO, "packages", "app")), REPO);
  delete process.env.AICA_REPO_ROOT;
  const dir = mkdtempSync(join(tmpdir(), "aica-r5-am6-"));
  mkdirSync(join(dir, "a", "b"), { recursive: true });
  writeFileSync(join(dir, "package.json"), "{}", "utf8");
  assert.equal(D.findProjectRoot(join(dir, "a", "b")), dir);
  if (prev !== undefined) process.env.AICA_REPO_ROOT = prev;
});

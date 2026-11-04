// R6：learned.md 闭环 —— ev_learn 同格式写入、sha1 去重、≤2KB 注入、mtime 更新、提案应用/被拒追条目。
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const STATE = mkdtempSync(join(tmpdir(), "aica-r6-learned-"));
process.env.AICA_STATE = STATE;
const R = await import("../../src/runs.ts");
const D = await import("../../src/daemon.ts");
const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "cli.ts");
const NODE = process.execPath;

const learnedFile = () => join(STATE, "memory", "learned.md");

test("appendLearnedEntry：与 ev_learn 同格式（## iso · sha1:<10hex>），重复内容不写第二遍", () => {
  assert.equal(R.appendLearnedEntry("[proposal] demo 已应用（risk=low）"), true);
  const text = readFileSync(learnedFile(), "utf8");
  assert.match(text, /^## \d{4}-\d{2}-\d{2}T[^ ]+ · sha1:[0-9a-f]{10}\n\[proposal\] demo 已应用/);
  assert.equal(R.appendLearnedEntry("[proposal] demo 已应用（risk=low）"), false, "sha1 去重");
  assert.equal(readFileSync(learnedFile(), "utf8").split("## ").length - 1, 1);
  assert.equal(R.appendLearnedEntry("   "), false, "空内容不写");
});

test("新条目 prepend；超过 50 条只留最新 50 条", () => {
  for (let i = 0; i < 60; i++) R.appendLearnedEntry(`条目 ${i}`);
  const blocks = readFileSync(learnedFile(), "utf8").split(/^## /m).filter((b) => b.trim());
  assert.equal(blocks.length, 50, "上限 50 条");
  assert.match(blocks[0], /条目 59/, "最新的在最前");
});

test("learnedText：按 mtime 缓存，文件变了才重读；≤2KB 按字节截断", () => {
  const first = D.learnedText();
  assert.match(first, /条目 59/);
  // 同 mtime 不改内容 → 命中缓存（返回值一致）
  assert.equal(D.learnedText(), first);

  const f = learnedFile();
  const body = Array.from({ length: 300 }, (_, i) => `很长的经验 ${i} `).join("");
  writeFileSync(f, `## ${new Date().toISOString()} · sha1:abcdef0123\n${body}\n`, "utf8");
  const future = new Date(Date.now() + 5000);
  utimesSync(f, future, future);
  const second = D.learnedText();
  assert.notEqual(second, first, "mtime 变了要重读");
  assert.ok(Buffer.byteLength(second, "utf8") <= 2048, `bytes=${Buffer.byteLength(second, "utf8")}`);
});

test("userMessage 注入 ## 经验教训；没有文件时不出现该段", () => {
  const dir = mkdtempSync(join(tmpdir(), "aica-r6-lm-dir-"));
  const spec: any = { id: "node:x/root", type: "assign", goal: "g", accept: ["a"] };
  writeFileSync(learnedFile(), `## ${new Date().toISOString()} · sha1:1111111111\n别用 rm -rf\n`, "utf8");
  const future = new Date(Date.now() + 8000);
  utimesSync(learnedFile(), future, future);
  const msg = D.userMessage(spec, false, dir);
  assert.match(msg, /## 经验教训/);
  assert.match(msg, /别用 rm -rf/);
});

test("提案被拒 → CLI 追一条 learned 条目（闭环）", () => {
  const repo = mkdtempSync(join(tmpdir(), "aica-r6-lm-repo-"));
  writeFileSync(join(repo, "package.json"), "{}", "utf8");
  const pdir = join(STATE, "proposals", "r6-demo");
  mkdirSync(pdir, { recursive: true });
  writeFileSync(join(pdir, "proposal.md"), "# demo\n", "utf8");
  writeFileSync(join(pdir, "patch.diff"), "--- /dev/null\n+++ b/docs/x.md\n@@ -0,0 +1,1 @@\n+x\n", "utf8");
  writeFileSync(join(pdir, "verify.json"), JSON.stringify({ cmd: "node -e process.exit(0)", timeout_ms: 30000 }), "utf8");
  writeFileSync(join(pdir, "meta.json"), JSON.stringify({ slug: "r6-demo", risk: "low", files: [] }), "utf8");

  const env = { ...process.env, AICA_STATE: STATE, AICA_REPO_ROOT: repo };
  const r = spawnSync(NODE, [CLI, "propose", "reject", "r6-demo", "--reason", "与目标不符"], { encoding: "utf8", env });
  assert.equal(r.status, 0, String(r.stdout) + String(r.stderr));
  const text = readFileSync(learnedFile(), "utf8");
  assert.match(text, /\[proposal\] r6-demo 被拒（与目标不符）/);
  assert.equal(existsSync(join(pdir, "rejected.json")), true);
});

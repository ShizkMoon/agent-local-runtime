// R5：斜杠命令 —— aica-pi/prompts/cmd-*.md 为准，ar cmd list 返回 4 条 {name,title,prompt,profile,tools}。
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const C = await import("../../src/commands.ts");
const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "cli.ts");

test("内置 4 条预设：init / review / compact / plan，字段齐全", () => {
  const list = C.listCommands();
  assert.deepEqual(list.map((c: any) => c.name), ["compact", "init", "plan", "review"]);
  for (const c of list) {
    assert.ok(c.title && c.title !== c.name, `${c.name} 要有 title`);
    assert.ok(c.prompt.length > 80, `${c.name} 的 prompt 来自文件正文，不能是占位`);
    assert.ok(c.profile, `${c.name} 要有 profile`);
  }
  assert.equal(list.find((c: any) => c.name === "plan")!.profile, "plan");
  assert.equal(list.find((c: any) => c.name === "review")!.profile, "reviewer");
  assert.equal(list.find((c: any) => c.name === "init")!.tools.includes("apply_patch"), true);
  assert.match(list.find((c: any) => c.name === "init")!.prompt, /AGENTS\.md/);
  assert.match(list.find((c: any) => c.name === "compact")!.prompt, /压缩/);
});

test("预设以文件为准：自定义目录/头部解析（不硬编码长文本）", () => {
  const dir = mkdtempSync(join(tmpdir(), "aica-r5-cmd-"));
  writeFileSync(join(dir, "cmd-hello.md"), "---\ntitle: 打招呼\nprofile: worker\ntools: read, grep\n---\n说你好，别多说。\n", "utf8");
  writeFileSync(join(dir, "not-a-command.md"), "忽略我", "utf8");
  const list = C.listCommands(dir);
  assert.equal(list.length, 1);
  assert.deepEqual(list[0], { name: "hello", title: "打招呼", prompt: "说你好，别多说。", profile: "worker", tools: ["read", "grep"] });

  const prev = process.env.AICA_PROMPTS;
  process.env.AICA_PROMPTS = dir;
  try {
    assert.deepEqual(C.listCommands().map((c: any) => c.name), ["hello"], "AICA_PROMPTS 覆盖目录");
  } finally {
    if (prev === undefined) delete process.env.AICA_PROMPTS; else process.env.AICA_PROMPTS = prev;
  }
});

test("没有头部也能用：title 回落 name、profile 回落 worker", () => {
  const dir = mkdtempSync(join(tmpdir(), "aica-r5-cmd2-"));
  writeFileSync(join(dir, "cmd-bare.md"), "只写正文。", "utf8");
  const c = C.listCommands(dir)[0];
  assert.equal(c.name, "bare");
  assert.equal(c.title, "bare");
  assert.equal(c.profile, "worker");
  assert.equal(c.prompt, "只写正文。");
});

test("ar cmd list 真机：ok + count=4；未知子命令 → USAGE 退出码 2", () => {
  const env = { ...process.env, AICA_STATE: mkdtempSync(join(tmpdir(), "aica-r5-cmd-state-")) };
  const ok = spawnSync(process.execPath, [CLI, "cmd", "list"], { encoding: "utf8", env });
  assert.equal(ok.status, 0, String(ok.stdout) + String(ok.stderr));
  const j = JSON.parse(String(ok.stdout).trim().split("\n").pop()!);
  assert.equal(j.ok, true);
  assert.equal(j.command, "cmd:list");
  assert.equal(j.data.count, 4);
  assert.deepEqual(j.data.commands.map((c: any) => c.name), ["compact", "init", "plan", "review"]);

  const bad = spawnSync(process.execPath, [CLI, "cmd", "nope"], { encoding: "utf8", env });
  assert.equal(bad.status, 2, "G-1：USAGE → 2");
  assert.equal(JSON.parse(String(bad.stdout).trim().split("\n").pop()!).error.code, "USAGE");
});

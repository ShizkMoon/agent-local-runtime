// R4 自动应用：settings.auto_apply_low 开 + risk=low + 未 force → 自动应用（applied.json{auto:true} + auto_applied 审计）；
// high 永远要 --force；开关关着时 low 也要 force。
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = mkdtempSync(join(tmpdir(), "aica-r4-aa-repo-"));
const STATE = mkdtempSync(join(tmpdir(), "aica-r4-aa-state-"));
process.env.AICA_REPO_ROOT = REPO;
process.env.AICA_STATE = STATE;

writeFileSync(join(REPO, "package.json"), "{\"name\":\"r4-aa\"}\n", "utf8");
writeFileSync(join(REPO, "verify-ok.mjs"), "console.log('verify ok');\n", "utf8");
mkdirSync(join(REPO, "docs"), { recursive: true });
writeFileSync(join(REPO, "docs", "existing.md"), "# 旧文档\n", "utf8");

const P = await import("../../src/proposals.ts");
const S = await import("../../src/settings.ts");
const R = await import("../../src/runs.ts");

const createPatch = (rel: string, body: string) =>
  `--- /dev/null\n+++ b/${rel}\n@@ -0,0 +1,1 @@\n+${body}\n`;
const modifyPatch = (rel: string, from: string, to: string) =>
  `--- a/${rel}\n+++ b/${rel}\n@@ -1,1 +1,1 @@\n-${from}\n+${to}\n`;

function makeProposal(slug: string, patch: string, source?: { root_id: string; path: string }) {
  const dir = join(STATE, "proposals", slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "proposal.md"), `# ${slug}\n`, "utf8");
  writeFileSync(join(dir, "patch.diff"), patch, "utf8");
  writeFileSync(join(dir, "verify.json"), JSON.stringify({ cmd: "node verify-ok.mjs", timeout_ms: 30_000 }) + "\n", "utf8");
  writeFileSync(join(dir, "meta.json"), JSON.stringify({ slug, risk: "low", files: [{ path: "x", action: "create" }], ...(source ? { source } : {}) }) + "\n", "utf8");
  return dir;
}

const indexEvents = (): any[] => {
  const f = join(STATE, "runs", "index.jsonl");
  return existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
};

test("开关关（默认）：low 仍可手工 apply，但不标 auto、不写 auto_applied", () => {
  const slug = "low-off";
  const dir = makeProposal(slug, createPatch("docs/low-off.md", "低风险内容"));
  const r = P.applyProposal(slug);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.auto, false, "开关关着 → 不是自动应用");
  assert.equal(readFileSync(join(REPO, "docs", "low-off.md"), "utf8").trim(), "低风险内容");
  assert.equal(JSON.parse(readFileSync(join(dir, "applied.json"), "utf8")).auto, false);
  assert.equal(indexEvents().filter((e) => e.event === "auto_applied").length, 0);
});

test("开关打开：low + 未 force → 自动应用；applied.json{auto:true} + auto_applied 审计（index + 来源节点）", () => {
  S.writeSettings({ auto_apply_low: true });
  const { rootId } = R.createRun({ subject: "自动应用来源" });
  R.writeSpec(rootId, "root", { id: `node:${rootId}/root`, type: "assign", goal: "g", accept: ["x"], budget: { depth_left: 1 } } as any);

  const slug = "low-auto";
  const dir = makeProposal(slug, createPatch("docs/low-auto.md", "自动落盘"), { root_id: rootId, path: "root" });
  const r = P.applyProposal(slug);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.auto, true, "结果里标 auto");
  assert.equal(r.forced, false);
  assert.equal(readFileSync(join(REPO, "docs", "low-auto.md"), "utf8").trim(), "自动落盘");

  const applied = JSON.parse(readFileSync(join(dir, "applied.json"), "utf8"));
  assert.equal(applied.auto, true, "applied.json 顶层 auto:true");
  assert.equal(applied.history.at(-1).auto, true, "历史记录也标 auto");
  assert.equal(applied.history.at(-1).forced, false);

  const audit = indexEvents().filter((e) => e.event === "auto_applied");
  assert.ok(audit.some((e) => e.slug === slug), "index.jsonl 有 auto_applied 审计");
  const nodeEv = R.readEvents(rootId, "root").filter((e: any) => e.kind === "auto_applied");
  assert.equal(nodeEv.length, 1, "来源节点也有 auto_applied 事件");
  assert.equal(nodeEv[0].data.slug, slug);
});

test("high 永远不自动：开关开着，无 --force 仍 NEEDS_FORCE；--force 后 forced:true、auto:false", () => {
  S.writeSettings({ auto_apply_low: true });
  const highSlug = "high-src";
  makeProposal(highSlug, createPatch("src/r4-auto.ts", "export const x = 1;"));
  const noForce = P.applyProposal(highSlug);
  assert.equal(noForce.ok, false);
  assert.equal(noForce.code, "NEEDS_FORCE");
  assert.equal(existsSync(join(REPO, "src", "r4-auto.ts")), false);

  const forced = P.applyProposal(highSlug, { force: true });
  assert.equal(forced.ok, true, JSON.stringify(forced));
  assert.equal(forced.forced, true);
  assert.equal(forced.auto, false, "force 路径不算自动应用");
  assert.equal(existsSync(join(REPO, "src", "r4-auto.ts")), true);

  // 开关关掉后 low 不再标 auto、也不写审计
  S.writeSettings({ auto_apply_low: false });
  const lowAgain = "low-after-off";
  const dir = makeProposal(lowAgain, createPatch("docs/low-after-off.md", "x"));
  const r = P.applyProposal(lowAgain);
  assert.equal(r.ok, true);
  assert.equal(r.auto, false);
  assert.equal(JSON.parse(readFileSync(join(dir, "applied.json"), "utf8")).auto, false);
  assert.equal(indexEvents().filter((e) => e.event === "auto_applied" && e.slug === lowAgain).length, 0);
});

test("settings：缺文件/坏 JSON 回落默认；write 原子写且可读回", () => {
  assert.equal(S.readSettings().auto_apply_low, false, "默认关");
  writeFileSync(S.settingsPath(), "{bad json", "utf8");
  assert.equal(S.readSettings().auto_apply_low, false, "坏 JSON 不炸，回落默认");
  const w = S.writeSettings({ auto_apply_low: true, mcp: [{ name: "demo", url: "http://127.0.0.1:9/mcp" }] });
  assert.equal(w.auto_apply_low, true);
  assert.equal(S.readSettings().mcp[0].name, "demo");
  // 未知字段/类型不对的 mcp 条目被过滤
  S.writeSettings({ mcp: [{ name: "", url: "x" } as any] });
  assert.deepEqual(S.readSettings().mcp, []);
});

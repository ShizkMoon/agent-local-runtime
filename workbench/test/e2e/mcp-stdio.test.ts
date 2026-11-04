// R6：MCP stdio 的 e2e 面 —— 注册表形状、未声明白名单、超时降级不阻塞。
// 走真 src/mcp.ts（spawn 真子进程做 stdio server）+ 真 aica-pi/extensions/tools.ts 的 mcp_call 工具。
import test from "node:test";
import assert from "node:assert/strict";
import { runScenario } from "./lib/scenario-run.mjs";

let cached = null;
async function once() {
  if (!cached) cached = await runScenario("mcp-stdio", { timeoutMs: 180000 });
  return cached;
}
test.after(() => { cached?.cleanup(); });

test("MCP stdio：tools/list → 注册表 transport=stdio，env（可能含密钥）不落盘", async (t) => {
  const r = await once();
  if (r.code !== 0 || !r.result) {
    t.diagnostic(r.stderr.slice(0, 800));
    assert.fail(`场景 mcp-stdio 退出码 ${r.code}`);
  }
  const x = r.result;
  const local = x.registry.find((s) => s.name === "local");
  assert.ok(local, "注册表里应有 local");
  assert.equal(local.ok, true, JSON.stringify(local));
  assert.equal(local.transport, "stdio", "本地 command 起的服务必须是 stdio");
  assert.deepEqual(local.tools, ["echo"]);
  assert.equal(local.command, "set");
  assert.equal(local.url, null, "stdio 服务不该有 url");
  assert.equal(x.envLeaked, false, "mcp.json 里不许出现 env 值（可能含密钥）");
  assert.match(x.callEcho, /echo:echo:env=sekret-token/, "callMcp 要真的把 env 传给了子进程并回显");
  assert.equal(x.resolve.hit, true, "mcp_<server>_<tool> 必须能解析");
  assert.equal(x.resolve.miss, null, "未列出的工具解析不到（fail-closed）");
});

test("MCP stdio：不响应的 server → 2s 超时降级，记 mcp_unavailable，不影响别的 server", async (t) => {
  const r = await once();
  if (!r.result) assert.fail(`场景失败：${r.stderr.slice(0, 400)}`);
  const x = r.result;
  const hang = x.registry.find((s) => s.name === "hang");
  assert.ok(hang, "注册表里应有 hang（失败也要留痕）");
  assert.equal(hang.ok, false);
  assert.equal(hang.transport, "stdio");
  assert.equal(hang.tools.length, 0);
  assert.ok(hang.error && hang.error.length > 0, "失败要带原因，不许静默");
  // 超时是"降级"不是"卡死"：约 2s 结束，且 local 仍然可用
  assert.ok(x.elapsed >= 1800 && x.elapsed < 30000, `超时应在 ~2s 量级（实际 ${x.elapsed}ms）`);
  assert.equal(x.registry.find((s) => s.name === "local").ok, true, "一个 server 挂不该拖垮另一个");
  assert.equal(x.unavail.length, 1, `runs/index.jsonl 应有一条 mcp_unavailable（实际 ${JSON.stringify(x.unavail)}）`);
  assert.equal(x.unavail[0].server, "hang");
  assert.equal(x.unavail[0].transport, "stdio");
});

test("MCP：spec.tools 未声明 → NOT_DECLARED；声明后才转发", async (t) => {
  const r = await once();
  if (!r.result) assert.fail(`场景失败：${r.stderr.slice(0, 400)}`);
  const x = r.result;
  assert.equal(x.undeclared.isError, true);
  assert.match(x.undeclared.text, /NOT_DECLARED/, "未声明必须拒，且不给网络机会");
  assert.match(x.undeclared.text, /spec\.tools 未声明/);
  assert.equal(x.ghost.isError, true);
  assert.match(x.ghost.text, /NOT_DECLARED/, "连服务里不存在的工具也只能报 NOT_DECLARED");
  assert.equal(x.declared.isError, false, x.declared.text);
  assert.match(x.declared.text, /echo:echo/, "声明后真的转发到 MCP server");
});

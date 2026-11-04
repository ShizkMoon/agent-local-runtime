// R5：MCP stdio 传输 —— settings 里 {name,command,args,env} → daemon 启动 spawn + tools/list（2s 超时）、
// 注册表 transport:"stdio"、env 不进注册表、失败 mcp_unavailable 不阻塞、进程随退出清理。
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const STATE = mkdtempSync(join(tmpdir(), "aica-r5-stdio-"));
process.env.AICA_STATE = STATE;
mkdirSync(join(STATE, "runs"), { recursive: true });
const M = await import("../../src/mcp.ts");

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "cli.ts");
const NODE = process.execPath;

// 假 MCP stdio server：行分隔 JSON-RPC；tools/list 与 tools/call 都回显 env
const SERVER = join(STATE, "fake-mcp.mjs");
writeFileSync(SERVER, `
let buf = "";
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    const env = process.env.MCP_TEST_ENV ?? "none";
    if (msg.method === "tools/list") send({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "echo", description: "回显参数与环境" }] } });
    else if (msg.method === "tools/call") send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "echo:" + msg.params.name + ":env=" + env }] } });
  }
});
setInterval(() => {}, 1000);
`, "utf8");

const HANG = join(STATE, "hang-mcp.mjs");
writeFileSync(HANG, `process.stdin.resume(); setInterval(() => {}, 1000);\n`, "utf8");

const indexEvents = (): any[] => {
  const f = join(STATE, "runs", "index.jsonl");
  return existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
};

test("stdio：tools/list 成功 → 注册表 transport=stdio，env 不落盘，call 可用", async () => {
  const reg = await M.initMcp([{ name: "local", command: NODE, args: [SERVER], env: { MCP_TEST_ENV: "sekret-token" } }]);
  assert.equal(reg.servers.length, 1);
  const s = reg.servers[0];
  assert.equal(s.ok, true, JSON.stringify(s));
  assert.equal(s.transport, "stdio");
  assert.deepEqual(s.tools.map((t: any) => t.name), ["echo"]);

  const raw = readFileSync(join(STATE, "mcp.json"), "utf8");
  assert.match(raw, /"transport": "stdio"/);
  assert.equal(/sekret-token/.test(raw), false, "env（可能含密钥）不得写进注册表");

  const r = await M.callMcp(s, "echo", { q: 1 });
  assert.match(String(r?.content?.[0]?.text), /echo:echo:env=sekret-token/);

  const hit = M.resolveMcpTool("mcp_local_echo");
  assert.equal(hit?.server.name, "local");
});

test("stdio：不响应 → 2s 超时，记 mcp_unavailable(transport=stdio)，其他 server 不受影响", async () => {
  const t0 = Date.now();
  const reg = await M.initMcp([
    { name: "hang", command: NODE, args: [HANG] },
    { name: "local", command: NODE, args: [SERVER] },
  ]);
  const ms = Date.now() - t0;
  assert.ok(ms >= 1800 && ms < 12000, `约 2s，实际 ${ms}ms`);

  const hang = reg.servers.find((s: any) => s.name === "hang")!;
  assert.equal(hang.transport, "stdio");
  assert.equal(hang.ok, false);
  assert.match(String(hang.error), /timeout 2000ms/);
  assert.equal(reg.servers.find((s: any) => s.name === "local")!.ok, true, "另一个 server 照常注册");

  const un = indexEvents().filter((e) => e.event === "mcp_unavailable" && e.server === "hang");
  assert.equal(un.length, 1);
  assert.equal(un[0].transport, "stdio");
});

test("真 daemon --once：stdio server 注册成功且不阻塞退出（子进程随退出清理）", () => {
  const st = mkdtempSync(join(tmpdir(), "aica-r5-stdio-daemon-"));
  const env = {
    ...process.env,
    AICA_STATE: st,
    AICA_MCP: JSON.stringify([{ name: "local", command: NODE, args: [SERVER], env: { MCP_TEST_ENV: "x" } }]),
  };
  const t0 = Date.now();
  const r = spawnSync(NODE, [CLI, "daemon", "--once"], { encoding: "utf8", env, timeout: 60000 });
  const ms = Date.now() - t0;
  assert.equal(r.status, 0, String(r.stdout) + String(r.stderr));
  assert.ok(ms < 20000, `daemon 不应被 stdio 子进程拖住，实际 ${ms}ms`);
  const reg = JSON.parse(readFileSync(join(st, "mcp.json"), "utf8"));
  assert.equal(reg.servers[0].transport, "stdio");
  assert.equal(reg.servers[0].ok, true);
});

test("closeAllMcp 幂等：重复调用不抛", async () => {
  M.closeAllMcp();
  M.closeAllMcp();
  assert.ok(true);
});

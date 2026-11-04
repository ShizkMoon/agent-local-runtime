// R4 H2：MCP 网关（fail-closed）—— tools/list 注册表、2s 超时降级、白名单未声明 NOT_DECLARED。
// 用本地假 server（node:http）验证，不依赖外网。
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chdir } from "node:process";

const STATE = mkdtempSync(join(tmpdir(), "aica-r4-mcp-"));
process.env.AICA_STATE = STATE;
mkdirSync(join(STATE, "runs"), { recursive: true });
const M = await import("../../src/mcp.ts");

interface Fake { url: string; close: () => Promise<void>; calls: any[] }
function fakeServer(tools: { name: string; description?: string }[], opts: { hang?: boolean } = {}): Promise<Fake> {
  const calls: any[] = [];
  return new Promise((resolve) => {
    const srv = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        if (opts.hang) return;                       // 永不响应 → 客户端 2s 超时
        let msg: any = {};
        try { msg = JSON.parse(body || "{}"); } catch { /* ignore */ }
        calls.push({ method: msg.method, params: msg.params });
        const send = (result: unknown) => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id ?? 1, result }));
        };
        if (msg.method === "tools/list") return send({ tools });
        if (msg.method === "tools/call") return send({ content: [{ type: "text", text: `echo:${msg.params?.name}:${JSON.stringify(msg.params?.arguments ?? {})}` }] });
        send({});
      });
    });
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as any).port;
      resolve({ url: `http://127.0.0.1:${port}/mcp`, calls, close: () => new Promise((r) => srv.close(() => r())) });
    });
  });
}

const indexEvents = (): any[] => {
  const f = join(STATE, "runs", "index.jsonl");
  return existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
};

test("initMcp：tools/list → 注册表写入 mcp.json；mcp_<server>_<tool> 可解析", async () => {
  const srv = await fakeServer([{ name: "echo", description: "回声" }, { name: "sum" }]);
  try {
    const reg = await M.initMcp([{ name: "demo", url: srv.url }]);
    assert.equal(reg.servers.length, 1);
    assert.equal(reg.servers[0].ok, true);
    assert.deepEqual(reg.servers[0].tools.map((t: any) => t.name), ["echo", "sum"]);
    assert.equal(existsSync(join(STATE, "mcp.json")), true);
    assert.equal(JSON.parse(readFileSync(join(STATE, "mcp.json"), "utf8")).servers[0].name, "demo");

    const hit = M.resolveMcpTool("mcp_demo_echo", reg)!;
    assert.equal(hit.server.name, "demo");
    assert.equal(hit.tool, "echo");
    assert.equal(M.resolveMcpTool("mcp_demo_nope", reg), null, "未列出的工具解析不到（fail-closed）");
    assert.deepEqual(M.declaredMcpTools(["mcp_demo_echo", "read", "mcp_demo_ghost"], reg), ["mcp_demo_echo"]);
  } finally { await srv.close(); }
});

test("initMcp：连不上/超时 → 记 mcp_unavailable 并跳过该 server，不抛不阻塞", async () => {
  const hang = await fakeServer([], { hang: true });
  const dead = await fakeServer([{ name: "x" }]);
  const deadUrl = dead.url;
  await dead.close();                                // 端口关掉 → ECONNREFUSED

  try {
    const t0 = Date.now();
    const reg = await M.initMcp([
      { name: "slow", url: hang.url },
      { name: "dead", url: deadUrl },
      { name: "ok", url: "http://127.0.0.1:1/mcp" },
    ]);
    const ms = Date.now() - t0;
    assert.ok(ms >= 1800 && ms < 12000, `超时应约 2s，实际 ${ms}ms`);
    assert.equal(reg.servers.length, 3);
    assert.equal(reg.servers[0].ok, false);
    assert.match(String(reg.servers[0].error), /timeout 2000ms/);
    assert.equal(reg.servers[1].ok, false);
    assert.equal(reg.servers[2].ok, false);

    const un = indexEvents().filter((e) => e.event === "mcp_unavailable");
    assert.equal(un.length, 3, "每个失败 server 一条 mcp_unavailable 事件");
    assert.deepEqual(un.map((e) => e.server).sort(), ["dead", "ok", "slow"]);
  } finally {
    await hang.close();
  }
});

// ---- worker 侧：mcp_call 的白名单与降级 ----
test("mcp_call：未声明 NOT_DECLARED；已声明转发；服务挂掉 UNAVAILABLE", async () => {
  const srv = await fakeServer([{ name: "echo" }]);
  const nodeDir = mkdtempSync(join(tmpdir(), "aica-r4-mcp-node-"));
  writeFileSync(join(nodeDir, "spec.json"), JSON.stringify({ id: "node:x/root", type: "assign", goal: "g", accept: ["x"], tools: [] }) + "\n");

  const prevCwd = process.cwd();
  chdir(nodeDir);
  try {
    const T: any = await import("../../aica-pi/extensions/tools.ts");
    const pi: any = { tools: new Map<string, any>(), registerTool(t: any) { this.tools.set(t.name, t); } };
    T.default(pi);
    const call = async (args: any) => {
      const r = await pi.tools.get("mcp_call").execute("call-1", args);
      return { isError: !!r.isError, text: String(r.content?.[0]?.text ?? "") };
    };

    // 1) 未声明：不给任何网络机会
    const reg = await M.initMcp([{ name: "demo", url: srv.url }]);
    assert.equal(reg.servers[0].ok, true);
    const undeclared = await call({ tool: "mcp_demo_echo", args: { q: 1 } });
    assert.equal(undeclared.isError, true);
    assert.match(undeclared.text, /NOT_DECLARED/);
    assert.equal(srv.calls.filter((c) => c.method === "tools/call").length, 0, "未声明不发请求");

    // 2) 已声明：转发到 MCP server
    writeFileSync(join(nodeDir, "spec.json"), JSON.stringify({ id: "node:x/root", type: "assign", goal: "g", accept: ["x"], tools: ["mcp_demo_echo"] }) + "\n");
    const hit = await call({ tool: "mcp_demo_echo", args: { q: 1 } });
    assert.equal(hit.isError, false, hit.text);
    assert.match(hit.text, /echo:echo:/);
    assert.match(hit.text, /q\\?"?:\s*1/);
    assert.equal(srv.calls.filter((c) => c.method === "tools/call").length, 1);

    // 3) server 挂掉（注册表 ok:false）→ UNAVAILABLE，不抛栈
    await srv.close();
    const downReg = await M.initMcp([{ name: "demo", url: srv.url }]);
    assert.equal(downReg.servers[0].ok, false);
    const down = await call({ tool: "mcp_demo_echo", args: {} });
    assert.equal(down.isError, true);
    assert.match(down.text, /UNAVAILABLE/);
    assert.match(down.text, /MCP 服务不可用|未注册/);
  } finally {
    chdir(prevCwd);
    await srv.close();
  }
});

// R4/R5：MCP 网关（fail-closed）。两种传输：HTTP(JSON-RPC) 与 stdio（command+args）。
// 规则：daemon 启动时对 settings.mcp / AICA_MCP 声明的每个服务做 tools/list（2s 超时）；
//   连不上 → 记 mcp_unavailable 事件并跳过该 server（不阻塞节点拉起）；
//   工具名 = mcp_<server>_<tool>；worker 侧只有 spec.tools 里显式声明过的才能调（未声明 → NOT_DECLARED）。
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RUNS_DIR, STATE } from "./runs.ts";
import { readSettings, type McpServerCfg } from "./settings.ts";

export const MCP_TIMEOUT_MS = 2000;

export interface McpToolDef { name: string; description?: string }
export interface McpServerState {
  name: string;
  transport: "http" | "stdio";
  /** http 传输的 URL */
  url?: string;
  /** stdio 传输的启动命令（env 不进注册表，避免把密钥写进 STATE） */
  command?: string;
  args?: string[];
  ok: boolean;
  error?: string;
  tools: McpToolDef[];
}
export interface McpRegistry { updated_at: string; servers: McpServerState[] }

/** 配置来源：env AICA_MCP（JSON 数组）优先，其次 settings.json 的 mcp */
export function mcpConfig(): McpServerCfg[] {
  const env = process.env.AICA_MCP;
  if (env) {
    try {
      const arr = JSON.parse(env);
      if (Array.isArray(arr)) {
        return arr
          .filter((x: any) => x && typeof x.name === "string" && x.name.trim() && ((typeof x.url === "string" && x.url.trim()) || (typeof x.command === "string" && x.command.trim())))
          .map((x: any) => ({
            name: String(x.name).trim(),
            ...(x.url ? { url: String(x.url).trim() } : {}),
            ...(x.command ? { command: String(x.command).trim() } : {}),
            ...(Array.isArray(x.args) ? { args: x.args.map(String) } : {}),
            ...(x.env && typeof x.env === "object" ? { env: x.env } : {}),
          }));
      }
    } catch { /* env 坏了回落 settings */ }
  }
  return readSettings().mcp;
}

// ---------------- stdio 客户端（按进程缓存；daemon 与 worker 各一份） ----------------

const stdioClients = new Map<string, StdioClient>();

class StdioClient {
  private child: ChildProcessWithoutNullStreams;
  private buf = "";
  private seq = 1;
  private pending = new Map<number, { res: (v: any) => void; rej: (e: Error) => void; timer: NodeJS.Timeout }>();
  private dead: string | null = null;

  constructor(cfg: McpServerCfg) {
    if (!cfg.command) throw new Error(`MCP ${cfg.name} 缺 command`);
    this.child = spawn(cfg.command, cfg.args ?? [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...(cfg.env ?? {}) },
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams;
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (c: string) => this.onData(c));
    this.child.on("error", (e) => this.fail(String(e?.message ?? e)));
    this.child.on("exit", (code, sig) => this.fail(`stdio 进程退出（code=${code} sig=${sig ?? ""}）`));
    // 不阻塞宿主事件循环（daemon --once / worker 结束时能正常退出）；退出时由 closeAllMcp 收拾
    this.child.unref();
    this.child.stdout.unref?.();
    (this.child.stdin as any).unref?.();
    (this.child.stderr as any).unref?.();
  }

  private fail(reason: string): void {
    if (this.dead) return;
    this.dead = reason;
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.rej(new Error(reason)); }
    this.pending.clear();
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    for (;;) {
      const nl = this.buf.indexOf("\n");
      if (nl < 0) break;
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let msg: any;
      try { msg = JSON.parse(line); } catch { continue; }
      const id = Number(msg?.id);
      const p = this.pending.get(id);
      if (!p) continue;
      this.pending.delete(id);
      clearTimeout(p.timer);
      if (msg.error) p.rej(new Error(String(msg.error?.message ?? "rpc error")));
      else p.res(msg.result);
    }
  }

  request(method: string, params: unknown, timeoutMs = MCP_TIMEOUT_MS): Promise<any> {
    if (this.dead) return Promise.reject(new Error(this.dead));
    const id = this.seq++;
    return new Promise((res, rej) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rej(Object.assign(new Error(`timeout ${timeoutMs}ms`), { name: "AbortError" }));
      }, timeoutMs);
      this.pending.set(id, { res, rej, timer });
      try {
        this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        rej(new Error(String((e as Error)?.message ?? e)));
      }
    });
  }

  close(): void {
    this.fail("closed");
    try { this.child.kill(); } catch { /* 已退出 */ }
  }
}

function getStdioClient(name: string, cfg?: McpServerCfg): StdioClient {
  const hit = stdioClients.get(name);
  if (hit) return hit;
  const c0 = cfg ?? mcpConfig().find((s) => s.name === name);
  if (!c0 || !c0.command) throw new Error(`MCP ${name} 未配置 command`);
  const c = new StdioClient(c0);
  stdioClients.set(name, c);
  return c;
}

/** daemon 退出/测试收尾：杀掉所有 stdio 子进程（幂等） */
export function closeAllMcp(): void {
  for (const [name, c] of stdioClients) {
    try { c.close(); } catch { /* ignore */ }
    stdioClients.delete(name);
  }
}
try { process.once("exit", () => closeAllMcp()); } catch { /* 某些宿主没有 process.on */ }

// ---------------- HTTP 传输 ----------------

export async function mcpRpc(url: string, method: string, params: unknown, timeoutMs = MCP_TIMEOUT_MS): Promise<any> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json: any = await res.json();
    if (json?.error) throw new Error(String(json.error?.message ?? "rpc error"));
    return json?.result;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------- 注册表 ----------------

export function registryPath(): string {
  return join(STATE, "mcp.json");
}

export function readRegistry(): McpRegistry {
  try {
    const j = JSON.parse(readFileSync(registryPath(), "utf8"));
    if (j && Array.isArray(j.servers)) {
      // R4 时代的注册表没有 transport 字段：有 url 就是 http
      return { updated_at: String(j.updated_at ?? ""), servers: j.servers.map((s: any) => ({ ...s, transport: s.transport ?? (s.url ? "http" : "stdio") })) };
    }
  } catch { /* 没有 = 没注册过 */ }
  return { updated_at: "", servers: [] };
}

function writeRegistry(reg: McpRegistry): void {
  mkdirSync(STATE, { recursive: true });
  writeFileSync(registryPath(), JSON.stringify(reg, null, 2) + "\n", "utf8");
}

function indexLog(rec: Record<string, unknown>): void {
  try { appendFileSync(join(RUNS_DIR, "index.jsonl"), JSON.stringify({ ts: new Date().toISOString(), ...rec }) + "\n", "utf8"); }
  catch { /* 目录未建也不阻塞 */ }
}

const errText = (e: unknown): string => {
  const any = e as any;
  if (any?.name === "AbortError" || any?.name === "TimeoutError") return `timeout ${MCP_TIMEOUT_MS}ms`;
  return String(any?.message ?? any).slice(0, 300);
};

/** 对单个 server 做 tools/list（initMcp 用） */
async function listTools(cfg: McpServerCfg): Promise<McpToolDef[]> {
  const r = cfg.command
    ? await getStdioClient(cfg.name, cfg).request("tools/list", {})
    : await mcpRpc(cfg.url!, "tools/list", {});
  return Array.isArray(r?.tools)
    ? r.tools.filter((t: any) => t && typeof t.name === "string" && t.name).map((t: any) => ({ name: String(t.name), ...(t.description ? { description: String(t.description) } : {}) }))
    : [];
}

/** daemon 启动时调一次：列工具 → 写 <STATE>/mcp.json；单个 server 失败只影响它自己 */
export async function initMcp(servers?: McpServerCfg[]): Promise<McpRegistry> {
  const cfg = servers ?? mcpConfig();
  const states: McpServerState[] = [];
  for (const s of cfg) {
    const base: McpServerState = {
      name: s.name,
      transport: s.command ? "stdio" : "http",
      ...(s.url ? { url: s.url } : {}),
      ...(s.command ? { command: s.command } : {}),
      ...(s.args ? { args: s.args } : {}),
      ok: false,
      tools: [],
    };
    try {
      const tools = await listTools(s);
      states.push({ ...base, ok: true, tools });
    } catch (e) {
      const error = errText(e);
      states.push({ ...base, error, tools: [] });
      indexLog({ event: "mcp_unavailable", server: s.name, transport: base.transport, ...(s.url ? { url: s.url } : {}), ...(s.command ? { command: s.command } : {}), error });
      if (s.command) {
        const c = stdioClients.get(s.name);
        if (c) { c.close(); stdioClients.delete(s.name); }
      }
    }
  }
  const reg: McpRegistry = { updated_at: new Date().toISOString(), servers: states };
  try { writeRegistry(reg); } catch { /* 写不进注册表也不阻塞 daemon */ }
  return reg;
}

/** mcp_<server>_<tool> → {server, tool}；server 名按最长前缀匹配（名字里可以有下划线） */
export function resolveMcpTool(qualified: string, reg: McpRegistry = readRegistry()): { server: McpServerState; tool: string } | null {
  const q = String(qualified ?? "");
  if (!q.startsWith("mcp_")) return null;
  const rest = q.slice("mcp_".length);
  const servers = [...reg.servers].sort((a, b) => b.name.length - a.name.length);
  for (const s of servers) {
    const prefix = `${s.name}_`;
    if (!rest.startsWith(prefix)) continue;
    const tool = rest.slice(prefix.length);
    if (s.tools.some((t) => t.name === tool)) return { server: s, tool };
  }
  return null;
}

/** 展示用：某个节点声明的 MCP 工具（UI/诊断） */
export function declaredMcpTools(specTools: string[] | undefined, reg: McpRegistry = readRegistry()): string[] {
  return (specTools ?? []).filter((t) => typeof t === "string" && t.startsWith("mcp_") && !!resolveMcpTool(t, reg));
}

/** 调一个已注册 server 的工具（stdio 按进程懒启动；调用方负责白名单判定） */
export async function callMcp(server: McpServerState, tool: string, args: unknown, timeoutMs = MCP_TIMEOUT_MS): Promise<any> {
  if (server.transport === "stdio") {
    return getStdioClient(server.name).request("tools/call", { name: tool, arguments: args ?? {} }, timeoutMs);
  }
  return mcpRpc(server.url!, "tools/call", { name: tool, arguments: args ?? {} }, timeoutMs);
}

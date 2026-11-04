// R4 H2：MCP 网关（fail-closed）。
// 规则：daemon 启动时对 settings.mcp / AICA_MCP 声明的每个服务做 tools/list（2s 超时）；
//   连不上 → 记 mcp_unavailable 事件并跳过该 server（不阻塞节点拉起）；
//   工具名 = mcp_<server>_<tool>；worker 侧只有 spec.tools 里显式声明过的才能调（未声明 → NOT_DECLARED）。
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RUNS_DIR, STATE } from "./runs.ts";
import { readSettings, type McpServerCfg } from "./settings.ts";

export const MCP_TIMEOUT_MS = 2000;

export interface McpToolDef { name: string; description?: string }
export interface McpServerState { name: string; url: string; ok: boolean; error?: string; tools: McpToolDef[] }
export interface McpRegistry { updated_at: string; servers: McpServerState[] }

/** 配置来源：env AICA_MCP（JSON 数组）优先，其次 settings.json 的 mcp */
export function mcpConfig(): McpServerCfg[] {
  const env = process.env.AICA_MCP;
  if (env) {
    try {
      const arr = JSON.parse(env);
      if (Array.isArray(arr)) {
        return arr
          .filter((x: any) => x && typeof x.name === "string" && x.name.trim() && typeof x.url === "string" && x.url.trim())
          .map((x: any) => ({ name: String(x.name).trim(), url: String(x.url).trim() }));
      }
    } catch { /* env 坏了回落 settings */ }
  }
  return readSettings().mcp;
}

/** 单条 JSON-RPC 调用（HTTP transport）；超时用 AbortSignal，失败抛错由调用方降级 */
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

export function registryPath(): string {
  return join(STATE, "mcp.json");
}

export function readRegistry(): McpRegistry {
  try {
    const j = JSON.parse(readFileSync(registryPath(), "utf8"));
    if (j && Array.isArray(j.servers)) return { updated_at: String(j.updated_at ?? ""), servers: j.servers };
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

/** daemon 启动时调一次：列工具 → 写 <STATE>/mcp.json；单个 server 失败只影响它自己 */
export async function initMcp(servers?: McpServerCfg[]): Promise<McpRegistry> {
  const cfg = servers ?? mcpConfig();
  const states: McpServerState[] = [];
  for (const s of cfg) {
    try {
      const r = await mcpRpc(s.url, "tools/list", {});
      const tools: McpToolDef[] = Array.isArray(r?.tools)
        ? r.tools.filter((t: any) => t && typeof t.name === "string" && t.name).map((t: any) => ({ name: String(t.name), ...(t.description ? { description: String(t.description) } : {}) }))
        : [];
      states.push({ name: s.name, url: s.url, ok: true, tools });
    } catch (e) {
      const error = errText(e);
      states.push({ name: s.name, url: s.url, ok: false, error, tools: [] });
      indexLog({ event: "mcp_unavailable", server: s.name, url: s.url, error });
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

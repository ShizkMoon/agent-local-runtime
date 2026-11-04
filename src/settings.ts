// R4：settings.json —— 运行时开关的唯一读写口（UI 侧走 server 代理，不直接碰文件）。
// 位置：<STATE>/settings.json；读写都容错（坏 JSON/缺字段 → 回落默认值，不炸 daemon）。
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { STATE } from "./runs.ts";

export interface McpServerCfg { name: string; url: string }

export interface Settings {
  /** 低风险提案是否自动应用（默认关；high 永远要 --force） */
  auto_apply_low: boolean;
  /** MCP 服务列表；env AICA_MCP（JSON 数组）优先 */
  mcp: McpServerCfg[];
}

export const DEFAULT_SETTINGS: Settings = { auto_apply_low: false, mcp: [] };

export function settingsPath(): string {
  return join(STATE, "settings.json");
}

const isMcp = (x: unknown): x is McpServerCfg =>
  !!x && typeof x === "object" && typeof (x as McpServerCfg).name === "string" && !!(x as McpServerCfg).name.trim()
  && typeof (x as McpServerCfg).url === "string" && !!(x as McpServerCfg).url.trim();

/** 读 settings：缺文件/坏 JSON/字段类型不对都回落默认值（daemon 不能被配置写坏） */
export function readSettings(): Settings {
  let raw: Record<string, unknown> = {};
  try {
    const j = JSON.parse(readFileSync(settingsPath(), "utf8"));
    if (j && typeof j === "object" && !Array.isArray(j)) raw = j;
  } catch { /* 没有或坏 JSON → 默认值 */ }
  const mcp = Array.isArray(raw.mcp) ? raw.mcp.filter(isMcp).map((s) => ({ name: s.name.trim(), url: s.url.trim() })) : [];
  return { auto_apply_low: raw.auto_apply_low === true, mcp };
}

/** 合并写回（原子：同目录 tmp → rename）；返回写后的完整设置 */
export function writeSettings(patch: Partial<Settings>): Settings {
  const cur = readSettings();
  const next: Settings = {
    auto_apply_low: patch.auto_apply_low === undefined ? cur.auto_apply_low : patch.auto_apply_low === true,
    mcp: patch.mcp === undefined ? cur.mcp : (Array.isArray(patch.mcp) ? patch.mcp.filter(isMcp).map((s) => ({ name: s.name.trim(), url: s.url.trim() })) : cur.mcp),
  };
  mkdirSync(STATE, { recursive: true });
  const file = settingsPath();
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", "utf8");
  try {
    renameSync(tmp, file);       // Windows 下同卷 rename 覆盖是原子的（MoveFileEx REPLACE_EXISTING）
  } catch {
    writeFileSync(file, JSON.stringify(next, null, 2) + "\n", "utf8");
    try { writeFileSync(tmp, "", "utf8"); } catch { /* 清不掉 tmp 无所谓 */ }
  }
  return next;
}

/** 测试/CLI 用：设置文件是否存在（不读内容） */
export function hasSettings(): boolean {
  return existsSync(settingsPath());
}

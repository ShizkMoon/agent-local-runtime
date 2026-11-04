// stdout 转写器：pi --mode json 的 stdout 逐行解析 → events.jsonl 增量 EventRecord + usage.json turn 级账本
// 原始流仍全量落 stdout.log（先写原始 chunk 再喂解析器）；解析失败的行落 kind:"_raw"
// 与 aica-pi/extensions/events.ts 的关系：同写 events.jsonl，冲突以 stdout 行序为准叠在后头（转写器说了算）
//
// S20（M8 / P12）：
//   · usage.json 从"一个 tokens 数字"升级成 turn 级账本 {turns[], total:{in,out,cache}}，
//     旧字段 tokens / byTurn 保留（view 与 daemon.backfillSpent 仍在读）；
//   · 每个 turn 落账后回调 hooks.onTurn —— daemon 用它在 turn 边界做 tokens 预算拦截；
//   · 落账用 tmp + rename 原子写，读者不会看到半截 JSON。
import { createWriteStream, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { appendEvent } from "./runs.ts";

const ARGS_PREVIEW = 80;
const RESULT_PREVIEW = 300;
const TEXT_PREVIEW = 300;
const RAW_PREVIEW = 200;
const DATA_CAP = 800;      // 未映射 kind 的 data 序列化上限，超出降级 {raw}
const SKIP = new Set(["message_update", "tool_execution_update"]);  // delta 流太碎，不转写

function preview(v: unknown, cap: number): string {
  let s: string;
  try { s = typeof v === "string" ? v : JSON.stringify(v); } catch { s = String(v); }
  return s.length > cap ? s.slice(0, cap) + "…" : s;
}

// tool_execution_end.result = AgentToolResult { content: [{type:"text",text}...] } —— 抽文本再截断
function resultText(result: any): string {
  const content = result?.content;
  if (Array.isArray(content)) {
    return content.filter((c: any) => c?.type === "text").map((c: any) => c.text ?? "").join("\n");
  }
  return typeof result === "string" ? result : JSON.stringify(result);
}

// message_end(role=assistant) 摘要：thinking 优先，其次 text（与 events.ts 同款取法）
function messageSummary(m: any): string {
  const content = Array.isArray(m?.content) ? m.content : [];
  const thinking = content.filter((c: any) => c?.type === "thinking").map((c: any) => c.thinking ?? "").join("\n");
  const text = content.filter((c: any) => c?.type === "text").map((c: any) => c.text ?? "").join("\n");
  return thinking || text;
}

// ---------------------------------------------------------------- S20：turn 级用量账本

/** 一个 turn 的用量。拿不到的项一律 null —— 不拿 0 冒充"确实用了 0"（P12） */
export interface TurnUsage {
  i: number;                 // turn 序号（1 基，与 events.jsonl 的 turn/turn_end 一致）
  at: string;                // 落账时间（turn_end 的 ts）
  in: number | null;         // 输入 tokens
  out: number | null;        // 输出 tokens
  cache: number | null;      // cache read + cache write
  ms: number | null;         // 该 turn 墙钟时长
  tokens: number;            // 该 turn 的 totalTokens（pi 报什么记什么）
  /** 第几次拉起（fallback 重试会让 turn 序号从 1 重来；落账时补，调用方不用给） */
  attempt?: number;
}

/** usage.json 的形状：新账本 + 旧字段（tokens/byTurn 兼容 view 与老文件） */
export interface UsageLedger {
  tokens: number;                                    // 旧字段：Σ turns[].tokens
  byTurn: { i: number; tokens: number }[];           // 旧字段：S6 前端饼图
  turns: TurnUsage[];                                // S20：turn 级账本
  total: { in: number; out: number; cache: number }; // S20：分项累计（未知项不累加）
}

function emptyLedger(): UsageLedger {
  return { tokens: 0, byTurn: [], turns: [], total: { in: 0, out: 0, cache: 0 } };
}

function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") { const n = Number(v); return Number.isFinite(n) ? n : null; }
  return null;
}
/** 从对象里按候选键名取第一个数值（不同 provider / pi 版本的字段名不一致） */
function pick(o: any, ...keys: string[]): number | null {
  for (const k of keys) { const n = num(o?.[k]); if (n !== null) return n; }
  return null;
}

/** 读 usage.json；老文件（只有 tokens/byTurn）补成新形状，不丢已有累计 */
export function readUsage(dir: string): UsageLedger | null {
  const file = join(dir, "usage.json");
  if (!existsSync(file)) return null;
  let raw: any;
  try { raw = JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
  if (!raw || typeof raw !== "object") return null;
  const legacyTokens = num(raw.tokens)
    ?? (Array.isArray(raw.byTurn) ? raw.byTurn.reduce((s: number, t: any) => s + (num(t?.tokens) ?? 0), 0) : 0);
  return {
    tokens: legacyTokens,
    byTurn: Array.isArray(raw.byTurn) ? raw.byTurn : [],
    turns: Array.isArray(raw.turns) ? raw.turns : [],
    total: {
      in: num(raw.total?.in) ?? 0,
      out: num(raw.total?.out) ?? 0,
      cache: num(raw.total?.cache) ?? 0,
    },
  };
}

/** 累计 tokens：优先旧字段 tokens（= Σ turn totalTokens），没有就按分项相加 */
export function usageTokens(u: UsageLedger | null | undefined): number {
  if (!u) return 0;
  const t = num(u.tokens);
  if (t !== null && t > 0) return t;
  return (num(u.total?.in) ?? 0) + (num(u.total?.out) ?? 0) + (num(u.total?.cache) ?? 0);
}

/** 从 pi 的 turn_end 原始事件抽一个 turn 用量；没有任何用量信息时返回 null（不编数） */
export function turnUsage(ev: any, i: number, at?: string): TurnUsage | null {
  const m = ev?.message ?? {};
  const u = m.usage ?? ev?.usage ?? null;
  if (!u || typeof u !== "object") return null;
  const inTok = pick(u, "input", "inputTokens", "input_tokens", "prompt_tokens", "promptTokens");
  const outTok = pick(u, "output", "outputTokens", "output_tokens", "completion_tokens", "completionTokens");
  const cacheRead = pick(u, "cacheRead", "cache_read_input_tokens", "cacheReadTokens", "cache_read");
  const cacheWrite = pick(u, "cacheWrite", "cache_write_input_tokens", "cacheWriteTokens", "cache_write");
  const explicit = pick(u, "totalTokens", "total_tokens", "tokens");
  const summed = inTok === null && outTok === null ? null : (inTok ?? 0) + (outTok ?? 0);
  const tokens = explicit ?? summed;
  if (tokens === null) return null;
  return {
    i,
    at: at ?? String(ev?.ts ?? new Date().toISOString()),
    in: inTok,
    out: outTok,
    cache: cacheRead === null && cacheWrite === null ? null : (cacheRead ?? 0) + (cacheWrite ?? 0),
    ms: pick(m, "durationMs", "duration_ms") ?? pick(ev?.data, "durationMs", "duration_ms"),
    tokens,
  };
}

/** 追加一个 turn 并原子落盘（tmp + rename：读者不会读到半截 JSON） */
export function recordTurnUsage(dir: string, tu: TurnUsage): UsageLedger {
  const cur = readUsage(dir) ?? emptyLedger();
  // 同一节点被 fallback 重拉一次时，转写器的 turn 计数从 1 重来 → 用 attempt 区分第几次拉起，
  // 避免 turns 里出现两条 i=1。tokens 仍然跨 attempt 累计（两次拉起烧的 token 都是成本）。
  const last = cur.turns[cur.turns.length - 1];
  const attempt = last && tu.i <= last.i ? (last.attempt ?? 1) + 1 : (last?.attempt ?? 1);
  cur.turns = [...cur.turns, { ...tu, attempt }];
  cur.byTurn = [...cur.byTurn, { i: tu.i, tokens: tu.tokens }];
  cur.tokens = (num(cur.tokens) ?? 0) + tu.tokens;   // 旧字段随新 turn 递增（老文件也适用）
  cur.total = {
    in: cur.total.in + (tu.in ?? 0),
    out: cur.total.out + (tu.out ?? 0),
    cache: cur.total.cache + (tu.cache ?? 0),
  };
  const file = join(dir, "usage.json");
  const tmp = join(dir, `.usage.${process.pid}.tmp`);
  try {
    writeFileSync(tmp, JSON.stringify(cur, null, 2) + "\n", "utf8");
    renameSync(tmp, file);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* tmp 本来就不在 */ }
    throw e;
  }
  return cur;
}

/** 转写器回调：turn 已落账（daemon 在 turn 边界做预算判定） */
export interface TapHooks {
  onTurn?: (ledger: UsageLedger, turn: TurnUsage) => void;
}

/** 把 child.stdout 同时导进 stdout.log（全量原始字节）和 events.jsonl（逐行转写）；stderr 只进 log */
export function tapStdout(child: ChildProcess, dir: string, rootId: string, path: string, hooks: TapHooks = {}): void {
  const log = createWriteStream(join(dir, "stdout.log"), { flags: "a" });
  log.on("error", () => { /* 日志写不动不阻塞转写 */ });
  let turn = 0;
  let buf = "";

  const emitGeneric = (ev: any): void => {
    const { type, ...rest } = ev ?? {};
    const s = JSON.stringify(rest);
    appendEvent(rootId, path, { kind: String(type ?? "unknown"), data: s.length <= DATA_CAP ? rest : { raw: s.slice(0, DATA_CAP) + "…" } });
  };

  const onLine = (line: string): void => {
    if (!line.trim()) return;
    let ev: any;
    try { ev = JSON.parse(line); }
    catch {
      appendEvent(rootId, path, { kind: "_raw", data: { raw: line.slice(0, RAW_PREVIEW) } });
      return;
    }
    try {
      switch (ev?.type) {
        case "turn_start":
          turn += 1;
          appendEvent(rootId, path, { kind: "turn", data: { i: turn } });
          break;
        case "message_start":
          if (ev.message?.role === "assistant") break;   // delta 太碎，跳过
          emitGeneric(ev);
          break;
        case "tool_execution_start":
          appendEvent(rootId, path, { kind: "tool_call", data: { call_id: ev.toolCallId, tool: ev.toolName, args: preview(ev.args, ARGS_PREVIEW) } });
          break;
        case "tool_execution_end":
          appendEvent(rootId, path, { kind: "tool_execution", data: {
            call_id: ev.toolCallId, tool: ev.toolName, durationMs: ev.durationMs,
            isError: !!ev.isError, result: preview(resultText(ev.result), RESULT_PREVIEW),
          } });
          break;
        case "message_end": {
          const m = ev.message;
          if (m?.role === "assistant") {
            appendEvent(rootId, path, { kind: "message", data: {
              tokens: m.usage?.totalTokens, model: m.model, stopReason: m.stopReason,
              text: preview(messageSummary(m), TEXT_PREVIEW),
            } });
          } else emitGeneric(ev);                        // system/user/toolResult 原样截断
          break;
        }
        case "turn_end": {
          // S20：turn 边界 —— 先落账（usage.json），再回调（daemon 的 tokens 预算在这里判定）
          const tu = turnUsage(ev, turn);
          appendEvent(rootId, path, { kind: "turn_end", data: { i: turn, tokens: tu?.tokens, durationMs: ev.message?.durationMs } });
          if (tu) {
            let ledger: UsageLedger | null = null;
            try { ledger = recordTurnUsage(dir, tu); }
            catch { /* 落账失败不得打断转写：events.jsonl 里仍有 turn_end */ }
            if (ledger) {
              try { hooks.onTurn?.(ledger, tu); }
              catch { /* 回调（如预算拦截）失败同样不得打断转写 */ }
            }
          }
          break;
        }
        case "agent_end":
          appendEvent(rootId, path, { kind: "agent_end", data: { willRetry: ev.willRetry ?? null, aborted: ev.aborted ?? null } });
          break;
        default:
          if (!SKIP.has(String(ev?.type))) emitGeneric(ev);
      }
    } catch { /* 单行转写失败不得打断后续行 */ }
  };

  child.stdout?.on("data", (c: Buffer) => {
    log.write(c);                                        // ① 原始流全量保留
    buf += c.toString("utf8");                           // ② 逐行转写
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      onLine(line.replace(/\r$/, ""));
    }
  });
  child.stderr?.on("data", (c: Buffer) => log.write(c)); // stderr 只进 stdout.log（沿用旧行为）
  child.stdout?.on("end", () => { if (buf.trim()) onLine(buf); buf = ""; });
  child.on("close", () => log.end());
}

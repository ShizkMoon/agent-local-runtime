// stdout 转写器：pi --mode json 的 stdout 逐行解析 → events.jsonl 增量 EventRecord + usage.json token 聚合
// 原始流仍全量落 stdout.log（先写原始 chunk 再喂解析器）；解析失败的行落 kind:"_raw"
// 与 aica-pi/extensions/events.ts 的关系：同写 events.jsonl，冲突以 stdout 行序为准叠在后头（转写器说了算）
import { createWriteStream } from "node:fs";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { appendEvent, addUsage } from "./runs.ts";

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

/** 把 child.stdout 同时导进 stdout.log（全量原始字节）和 events.jsonl（逐行转写）；stderr 只进 log */
export function tapStdout(child: ChildProcess, dir: string, rootId: string, path: string): void {
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
          const tokens = ev.message?.usage?.totalTokens;
          appendEvent(rootId, path, { kind: "turn_end", data: { i: turn, tokens, durationMs: ev.message?.durationMs } });
          if (typeof tokens === "number") addUsage(rootId, path, turn, tokens);   // G7 spent 聚合
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

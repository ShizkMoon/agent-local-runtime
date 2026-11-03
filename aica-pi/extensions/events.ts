// aica-pi · events：把 pi 事件流逐条 append 到节点目录 events.jsonl
// 生成式 UI / DS-Bot 进度卡片 / Obelisk 召回的唯一数据面
// API 依据 pi-coding-agent@1.5.0 dist/core/extensions/types.d.ts：
//   tool_execution_start: { toolCallId, toolName, args }
//   tool_execution_end:   { toolCallId, toolName, result, isError, durationMs? }
//   message_end:          { message: AgentMessage }（assistant content 为 TextContent[]）
import { appendFileSync } from "node:fs";
import { join } from "node:path";

const EVENTS = join(process.cwd(), "events.jsonl");
const PREVIEW = 300;

function emit(kind: string, data: Record<string, unknown>): void {
  try {
    appendFileSync(EVENTS, JSON.stringify({ ts: new Date().toISOString(), kind, data }) + "\n", "utf8");
  } catch { /* 事件流失败不得阻塞 Worker */ }
}

function preview(v: unknown): string {
  let s: string;
  try { s = typeof v === "string" ? v : JSON.stringify(v); } catch { s = String(v); }
  return s.length > PREVIEW ? s.slice(0, PREVIEW) + "…" : s;
}

// tool_execution_end.result = AgentToolResult { content: [{type:"text",text}...], details } —— 抽文本再截断
function resultText(result: any): string {
  const content = result?.content;
  if (Array.isArray(content)) {
    return content.filter((c: any) => c?.type === "text").map((c: any) => c.text ?? "").join("\n");
  }
  return typeof result === "string" ? result : JSON.stringify(result);
}

export default function (pi: any) {
  pi.on("tool_execution_start", async (event: any) => {
    emit("tool_execution", { phase: "start", call_id: event.toolCallId, tool: event.toolName, args: preview(event.args) });
  });
  pi.on("tool_execution_end", async (event: any) => {
    emit("tool_execution", {
      phase: "end",
      call_id: event.toolCallId,
      tool: event.toolName,
      is_error: !!event.isError,
      duration_ms: event.durationMs,
      output: preview(resultText(event.result)),
    });
  });
  pi.on("message_end", async (event: any) => {
    const m = event.message;
    if (m?.role !== "assistant") return;
    const text = Array.isArray(m.content) ? m.content.filter((c: any) => c?.type === "text").map((c: any) => c.text ?? "").join("\n") : "";
    emit("agent_message", { role: "assistant", stop: m.stopReason, tokens: m.usage?.totalTokens, text: preview(text) });
  });
}

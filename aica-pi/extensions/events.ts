// aica-pi · events：把 pi 事件流逐条 append 到节点目录 events.jsonl
// 生成式 UI / DS-Bot 进度卡片 / Obelisk 召回的唯一数据面
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
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > PREVIEW ? s.slice(0, PREVIEW) + "…" : s;
}

export default function (pi: any) {
  pi.on("tool_execution_start", async (event: any) => {
    emit("tool_call", { tool: event.toolName ?? event.name, args: preview(event.args) });
  });
  pi.on("tool_execution_end", async (event: any) => {
    emit("tool_result", { tool: event.toolName ?? event.name, is_error: !!event.isError, output: preview(event.result ?? event.output) });
  });
  pi.on("agent_message", async (event: any) => {
    emit("message", { role: event.role ?? "assistant", text: preview(event.text ?? event.content) });
  });
}

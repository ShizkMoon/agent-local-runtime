// aica-pi events：把 pi 的事件流逐条 append 到节点目录的 events.jsonl
// 生成式 UI 与 DS-Bot 进度卡片的唯一数据面（骨架；挂钩 pi 事件 API 后填实）
import { appendFileSync } from "node:fs";
import { join } from "node:path";

const NODE_DIR = process.cwd();
const EVENTS = join(NODE_DIR, "events.jsonl");

export function emit(kind: string, data: Record<string, unknown>): void {
  appendFileSync(EVENTS, JSON.stringify({ ts: new Date().toISOString(), kind, data }) + "\n", "utf8");
}

// TODO: 注册到 pi 的 extension 事件钩子：
// onToolCall(t) → emit("tool_call", {name, args_preview})
// onFileEdit(f) → emit("file_edit", {path, diff_preview})
// onMessage(m)  → emit("message", {role, text_preview})
// onCheckpoint  → emit("checkpoint", {...})

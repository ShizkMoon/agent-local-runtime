// 信封类型：spec.json / result.json / events.jsonl 的 TypeScript 契约
// 与 docs/multi-agent-runtime.md §4 对齐；v0 用手写类型，schema 校验后续换 TypeBox
import { createHash } from "node:crypto";

export type NodeStatus = "done" | "waiting" | "me" | "blocked" | "failed" | "split" | "spec";
export type AgentKind = "pi" | "claude" | "codex" | "dsh" | string;
export type NodeMode = "execute" | "diverge" | "converge";

export interface SpecInput {
  ref: string;            // art:// 或绝对路径
  sha256?: string;
  trust?: "user" | "system" | "untrusted";
}

export interface SpecEnvelope {
  id: string;             // node:<root>/<path>
  parent?: string;
  depends?: string[];
  plan_version?: number;
  type: "assign" | "expand";
  agent?: AgentKind;      // Worker 类型，默认 "pi"
  profile?: "worker" | "orchestrator";
  model?: string;         // 模型 ID（如 "opencode-pool/deepseek-v4.1-flash"），缺省走 AICA_PI_MODEL/内置默认
  mode?: { shape: NodeMode; axis?: string; n?: number; stop_when?: string; why?: string };
  goal: string;           // 节点目标（渲染进 worker 上下文）
  inputs?: SpecInput[];
  accept: string[];       // 至少一条可执行检查
  budget?: { tokens?: number; minutes?: number; depth_left?: number };
  already_known?: string[];
  tools?: string[];       // 授予的工具面（未声明则不授 ar 等敏感工具）
  reply?: { text: string; ts: string }[];  // ar reply 注入的人工回复
}

export interface ResultEnvelope {
  id: string;
  type: "result";
  status: NodeStatus;
  summary: string;
  refs?: string[];
  checks?: { cmd: string; exit: number }[];
  children?: { kind: string; subject: string }[];  // 仅 status=split
  spent?: { tokens?: number; minutes?: number };
  finished_at: string;
}

export interface EventRecord {
  ts: string;
  kind: "tool_call" | "tool_execution" | "agent_message" | "file_edit" | "message" | "checkpoint" | "spawn" | "exit" | "gate";
  data: Record<string, unknown>;
}

export function nodeId(rootId: string, path: string): string {
  return `node:${rootId}/${path}`;
}

// uuid5(task.uuid, rule, attempt) 同款：sha1 截位伪 uuid5，足够单机幂等
export function stableId(...parts: string[]): string {
  const h = createHash("sha1").update(parts.join(":")).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

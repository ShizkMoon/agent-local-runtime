// 信封类型：spec.json / result.json / events.jsonl 的 TypeScript 契约
// 与 docs/multi-agent-runtime.md §4 对齐；v0 用手写类型，schema 校验后续换 TypeBox
import { createHash } from "node:crypto";

export type NodeStatus = "done" | "waiting" | "me" | "blocked" | "failed" | "split" | "spec";
export type AgentKind = "pi" | "claude" | "codex" | "dsh" | string;
export type NodeMode = "execute" | "diverge" | "converge";
// 审批档位（映射 T3 三档）：supervised=写+执行都问 / edits=只问执行 / full=不问；S4 gate.ts 消费
export type PermissionMode = "supervised" | "edits" | "full";

export interface SpecInput {
  ref: string;            // art:// 或绝对路径
  sha256?: string;
  trust?: "user" | "system" | "untrusted";
}

/** @file 引用的基准目录候选：repo(env) → runs 祖先里的仓库根 → 节点目录（见 daemon.atRefBases） */

/** R3：profile 闭集（入口校验 + 运行期兜底共用；orchestrator/advisor 是 S11 遗留角色槽，不在入口闭集里） */
export const PROFILES = ["worker", "plan", "reviewer"] as const;
export type Profile = (typeof PROFILES)[number];
export function isProfile(x: unknown): x is Profile {
  return typeof x === "string" && (PROFILES as readonly string[]).includes(x);
}

export interface SpecEnvelope {
  id: string;             // node:<root>/<path>
  parent?: string;
  depends?: string[];
  plan_version?: number;
  type: "assign" | "expand";
  agent?: AgentKind;      // Worker 类型，默认 "pi"
  profile?: "worker" | "orchestrator" | "reviewer" | "advisor" | "plan";  // reviewer/advisor=S11 角色槽；plan=R3 D5 只读规划档
  model?: string;         // 模型 ID（如 "opencode-pool/deepseek-v4.1-flash"），缺省走 AICA_PI_MODEL/内置默认
  mode?: { shape: NodeMode; axis?: string; n?: number; stop_when?: string; why?: string };
  goal: string;           // 节点目标（渲染进 worker 上下文）
  inputs?: SpecInput[];
  accept: string[];       // 至少一条可执行检查
  budget?: { tokens?: number; minutes?: number; depth_left?: number };
  already_known?: string[];
  tools?: string[];       // 授予的工具面（未声明则不授 ar 等敏感工具）
  reply?: { text: string; ts: string }[];  // ar reply 注入的人工回复
  accept_idx?: number;    // 节点挂在 run 级 accept 条目（根 spec.accept）的下标，chips 投影用
  // ---- S1 审批/守门/挂载面（S4 gate.ts 消费；本步只扩字段无行为变化） ----
  permission?: PermissionMode;
  approve?: string[];     // 需审批的工具名/前缀模式（命中才弹 gate）
  deny?: string[];        // 恒拒工具模式：命中即 block，不弹窗
  deny_paths?: string[];  // protected paths：args 里路径命中即 block（敏感目录恒守门）
  // S19：必问且不可 session 记住（与 deny 是两种语义）；判定序 deny → restricted → grant → approve
  restricted_paths?: string[];
  rules?: { pattern: string; message: string }[];  // args 正则守门：命中 → block + message 回注模型
  skills?: string[];      // 显式挂载的 skill 名（daemon 逐条 --skill <aica-pi>/skills/<name>）
}

export interface ResultEnvelope {
  id: string;
  type: "result";
  status: NodeStatus;
  summary: string;
  // 结局原因：闭集里的自由串（budget exceeded / timeout / aborted by user / gate unavailable …），
  // 与 status 配合成「结局 = 状态 + 原因」；view/工作台用它显示人话，不拿它做分支判断
  reason?: string;
  refs?: string[];
  checks?: { cmd: string; exit: number }[];
  children?: { kind: string; subject: string }[];  // 仅 status=split
  spent?: { tokens?: number; minutes?: number };
  wait_on?: string[];     // status=waiting 时挂起等待的子节点 path 列表（S7 join 原语）
  /** R3 §9.5：本节点产出的自进化提案（slug 或 proposals/<slug> 目录路径）。
   *  node_settled hook 读到它 → 登记 <STATE>/proposals/index.jsonl + 节点写 learn 事件；缺省行为不变。 */
  proposal?: string;
  output?: unknown;       // 结构化回传（G21 预留，R2 才加 schema 校验）
  finished_at: string;
}

export interface EventRecord {
  ts: string;
  // daemon 转写器追加 turn/turn_end/agent_end/_raw 及 pi 事件 type 透传，故放开为 string
  kind: "tool_call" | "tool_execution" | "agent_message" | "file_edit" | "message" | "checkpoint" | "spawn" | "exit" | "gate"
      | "turn" | "turn_end" | "agent_end" | "_raw"
      // S1 新增：delta 流/工具更新/重试/压缩/中止/审批审计对/计划项/循环守门（transcribe.ts 已有 kind 全保留）
      | "agent_delta" | "tool_update" | "retry" | "compaction" | "abort"
      | "approve_ask" | "approve_decide" | "todo" | "loop" | (string & {});
  data: Record<string, unknown>;
}

export function nodeId(rootId: string, path: string): string {
  return `node:${rootId}/${path}`;
}

// ---- S19 审批协议：gate.ts 写 gate-req.json（卡 + 服务端生成的 opts），
//      应答者（workbench）写 gate-ans.json。决策闭集是唯一真相，运行时值在 gate.ts::GATE_DECISIONS。
//      记住的是「这次命中的资源」{tool,tier,target}，不是整个工具名。
export type GateDecision = "allowed-once" | "rejected" | "cancelled" | "unavailable";
export type ApprovalTier = "read" | "write" | "exec";

export interface GateGrant {
  tool: string;           // 命中的工具（不是通配工具族）
  tier: ApprovalTier;     // 记录当时的档位：写授权不覆盖执行
  target: string;         // 命中的资源：命令串（整串相等）或归一化路径（目录级前缀）
  ts?: string;
}

/** 卡上的动作：由 gate 生成，前端只渲染不硬编码 */
export interface GateOpt {
  label: string;
  decision: GateDecision;
  remember?: GateGrant | null;   // 仅「记住这类」有；文案必须写清记住什么
  hint?: string;
}

export interface GateRequest {
  v?: number;
  call_id: string;
  tool: string;
  tier: ApprovalTier;
  target: string;
  restricted: boolean;     // 必问且不可记住（控制面 / restricted_paths）
  rememberable: boolean;
  reason: string;          // 卡上「为什么要跑它」一行
  hit?: string;
  args?: unknown;
  targets?: string[];
  opts: GateOpt[];
  asked_at: string;
}

export interface GateAnswer {
  decision: GateDecision;  // 闭集；坏值/缺失一律按 unavailable 处理（fail-closed）
  feedback?: string;       // rejected 时原样回注模型（不要写 "denied"）
  remember?: GateGrant | null;
  by?: string;
  at?: string;
}

// uuid5(task.uuid, rule, attempt) 同款：sha1 截位伪 uuid5，足够单机幂等
export function stableId(...parts: string[]): string {
  const h = createHash("sha1").update(parts.join(":")).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

// aica-pi tools：注入 Worker 的五个工具（骨架；pi extension API 定型后按签名对接）
// 契约：大输出一律"全文落盘 artifacts/ + 回 ref 与预览"（噪音防火墙档 1）
import { execFileSync } from "node:child_process";

function sh(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { encoding: "utf8", timeout: 120_000 });
}

export const tools = {
  /** ev：写回任务库状态（done/fail/me/summary） */
  ev(args: { action: "done" | "fail"; summary: string }) {
    return sh("ev", [args.action, "--summary", args.summary]);
  },
  /** kn：知识检索，top-k 分块返回（kb 环入口） */
  kn(args: { query: string; k?: number }) {
    return sh("kn", ["recall", args.query, "--k", String(args.k ?? 5)]);
  },
  /** agent-desktop：UIA 树读取与 ref 语义动作（headless 不抢焦点） */
  agentDesktop(args: { argv: string[] }) {
    return sh("agent-desktop", args.argv);
  },
  /** ego-browser：stdin 提交 Node.js 流程，隔离 Space 网页操作 */
  egoBrowser(args: { script: string }) {
    return sh("ego-browser", ["nodejs", "-e", args.script]);
  },
  /** ar：子节点派发（仅 spec.tools 声明时授予；run 环入口可另加 ar read） */
  ar(args: { argv: string[] }) {
    return sh("ar", args.argv);
  },
};

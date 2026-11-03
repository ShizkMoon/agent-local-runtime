// aica-pi · tools：注入 Worker 的五个工具（kb/run 环入口 + GUI/网页能力）
// 契约：大输出一律"全文落盘 artifacts/ + 回 ref 与预览"（噪音防火墙档 1）
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Type } from "typebox";

const ART = join(process.cwd(), "artifacts");
const PREVIEW = 2000;

function sh(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { encoding: "utf8", timeout: 120_000, windowsHide: true });
}

// 全文落盘 → 返回 ref + 预览（噪音防火墙契约）
function spill(content: string, hint: string): string {
  mkdirSync(ART, { recursive: true });
  const name = `${hint}-${createHash("sha1").update(content).digest("hex").slice(0, 8)}.txt`;
  writeFileSync(join(ART, name), content, "utf8");
  const head = content.length > PREVIEW ? content.slice(0, PREVIEW) + `\n…[截断，全文 ${content.length} 字符]` : content;
  return `ref=artifacts/${name}\n${head}`;
}

export default function (pi: any) {
  pi.registerTool({
    name: "ev_done",
    description: "任务完成：写 result 并把一句话执行摘要回写任务库。Worker 结束时必须调用。",
    parameters: Type.Object({ summary: Type.String({ description: "一句话执行摘要，附产物路径" }) }),
    async execute(_id: string, args: any) {
      return sh("ar", ["done", "--summary", args.summary]);
    },
  });

  pi.registerTool({
    name: "ev_fail",
    description: "任务失败：写 result 并上报失败原因。",
    parameters: Type.Object({ summary: Type.String() }),
    async execute(_id: string, args: any) {
      return sh("ar", ["fail", "--summary", args.summary]);
    },
  });

  pi.registerTool({
    name: "kn_recall",
    description: "知识检索（kb 环）：查任务历史、文档、会话记录。返回 top-k 分块。",
    parameters: Type.Object({ query: Type.String(), k: Type.Optional(Type.Number()) }),
    async execute(_id: string, args: any) {
      return sh("kn", ["recall", args.query, "--k", String(args.k ?? 5)]);
    },
  });

  pi.registerTool({
    name: "ar_read",
    description: "run 环：读同树兄弟节点的 result 摘要（不含 transcript）。",
    parameters: Type.Object({ node: Type.String({ description: "节点路径，如 root/01" }) }),
    async execute(_id: string, args: any) {
      return sh("ar", ["check", "--run", process.env.AR_ROOT_ID!, "--node", args.node]);
    },
  });

  pi.registerTool({
    name: "ar_dispatch",
    description: "派发子节点（仅 spec.tools 声明 ar 时可用）。",
    parameters: Type.Object({
      goal: Type.String(),
      accept: Type.Optional(Type.Array(Type.String())),
      agent: Type.Optional(Type.String()),
    }),
    async execute(_id: string, args: any) {
      const a = ["node-create", "--run", process.env.AR_ROOT_ID!, "--parent", `node:${process.env.AR_ROOT_ID}/${process.env.AR_NODE_PATH}`, "--goal", args.goal];
      if (args.agent) a.push("--agent", args.agent);
      if (args.accept) a.push("--accept", args.accept.join(";"));
      return sh("ar", a);
    },
  });

  pi.registerTool({
    name: "agent_desktop",
    description: "Windows 桌面 GUI 自动化（UIA）：snapshot 读无障碍树，ref 语义动作。大快照自动落盘回 ref。用法文档：先跑 ['skills','get','desktop']。",
    parameters: Type.Object({ argv: Type.Array(Type.String(), { description: "agent-desktop 参数，如 ['snapshot','--app','X','-i']" }) }),
    async execute(_id: string, args: any) {
      return spill(sh("agent-desktop", args.argv), "ad");
    },
  });

  pi.registerTool({
    name: "ego_browser",
    description: "网页自动化（ego Space，沿用登录态、不抢焦点）。提交 Node.js 片段，可用 taskSpace/page.snapshot/page.click 等 helper。",
    parameters: Type.Object({ script: Type.String() }),
    async execute(_id: string, args: any) {
      return spill(sh("ego-browser", ["nodejs", "-e", args.script]), "ego");
    },
  });
}

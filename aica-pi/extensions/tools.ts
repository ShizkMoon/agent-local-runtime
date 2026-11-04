// aica-pi · tools：注入 Worker 的七个工具（kb/run 环入口 + GUI/网页能力）
// 契约：大输出一律"全文落盘 artifacts/ + 回 ref 与预览"（噪音防火墙档 1）
// API 依据 pi-coding-agent@1.5.0：registerTool({name,label,description,parameters(TypeBox),
//   execute(toolCallId, params, signal, onUpdate, ctx) → {content:[{type:"text",text}], details, terminate?}})
import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, existsSync, mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Type } from "typebox";
import { resolveBin } from "./paths.ts";
// S28：提案白名单/落盘与 CLI 共用一份实现（避免工具与 ar propose 两套判定漂移）
import { createProposal } from "../../src/proposals.ts";

const ART = join(process.cwd(), "artifacts");
const PREVIEW = 2000;
// daemon 注入 cli.ts 绝对路径；ar 不在 PATH 时用 node 直跑（Windows 无 .cmd 解析问题）
const AR_CLI = process.env.AR_CLI;

function sh(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { encoding: "utf8", timeout: 120_000, windowsHide: true });
}

function ar(args: string[]): string {
  return AR_CLI ? sh(process.execPath, [AR_CLI, ...args]) : sh("ar", args);
}

/** 带 stdin 的 ar 调用（spawn 的 JSON 载荷走 stdin，避免命令行长度/转义问题）
 *  G-1 之后 CLI 失败会非 0 退出：envelope 仍在 stdout，交给调用方按 ok:false 处理 */
function arIn(args: string[], input: string): string {
  const bin = AR_CLI ? process.execPath : "ar";
  const argv = AR_CLI ? [AR_CLI, ...args] : args;
  try {
    return execFileSync(bin, argv, { input, encoding: "utf8", timeout: 120_000, windowsHide: true });
  } catch (e) {
    const stdout = String((e as { stdout?: string | Buffer }).stdout ?? "");
    if (stdout.trim()) return stdout;
    throw e;
  }
}

// AgentToolResult：content 是模型可见文本，details 留给 UI/日志
function ok(text: string, extra?: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text: text.trim() || "(no output)" }], details: {}, ...extra };
}

// 非致命失败：模型看到可读错误文本可继续推进（比 execFile ENOENT 原始堆栈友好）
function err(text: string) {
  return { content: [{ type: "text" as const, text }], details: {}, isError: true };
}

// 全文落盘 → 返回 ref + 预览（噪音防火墙契约）
function spill(content: string, hint: string): string {
  mkdirSync(ART, { recursive: true });
  const name = `${hint}-${createHash("sha1").update(content).digest("hex").slice(0, 8)}.txt`;
  writeFileSync(join(ART, name), content, "utf8");
  const head = content.length > PREVIEW ? content.slice(0, PREVIEW) + `\n…[截断，全文 ${content.length} 字符]` : content;
  return `ref=artifacts/${name}\n${head}`;
}

// ---- ev_learn：经验沉淀到 <AICA_STATE>/memory/learned.md（S12，对齐 OMP learned.md 契约） ----
const LEARN_MAX_ENTRIES = 50;    // 文件 ≤50 条
const LEARN_ENTRY_CAP = 2000;    // 每条 ≤2000 字
// 条目格式：`## <iso ts> · sha1:<h10>\n<text>`，段间空行；新→旧（prepend）

function parseLearned(cur: string): { sha: string; block: string }[] {
  return cur.split(/^## /m).filter((b) => b.trim()).map((b) => {
    const sha = b.match(/^[^\n]*sha1:(\w+)/)?.[1] ?? "";
    return { sha, block: "## " + b.trimEnd() };
  });
}

/** 新条目 prepend + sha1 去重 + 截 ≤50 条；返回给模型看的回执 */
function learn(state: string, text: string): string {
  const dir = join(state, "memory");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "learned.md");
  const body = text.trim().slice(0, LEARN_ENTRY_CAP);
  const sha = createHash("sha1").update(body).digest("hex").slice(0, 10);
  const old = existsSync(file) ? parseLearned(readFileSync(file, "utf8")) : [];
  if (old.some((e) => e.sha === sha)) return `learned: 已有同内容条目（sha1:${sha}），未重复记录`;
  const entry = `## ${new Date().toISOString()} · sha1:${sha}\n${body}`;
  const entries = [entry, ...old.map((e) => e.block)].slice(0, LEARN_MAX_ENTRIES);
  writeFileSync(file, entries.join("\n\n") + "\n", "utf8");
  return `learned: 已记录（sha1:${sha}，共 ${entries.length} 条）`;
}

export default function (pi: any) {
  pi.registerTool({
    name: "ev_done",
    label: "Ev Done",
    description: "任务完成：写 result 并把一句话执行摘要回写任务库。Worker 结束时必须调用。",
    parameters: Type.Object({
      summary: Type.String({ description: "一句话执行摘要，附产物路径" }),
      spent_tokens: Type.Optional(Type.Number({ description: "本次任务累计 token 数（缺省由 daemon 按 usage.json 兜底）" })),
    }),
    async execute(_id: string, args: any) {
      const a = ["done", "--summary", args.summary];
      if (typeof args.spent_tokens === "number" && args.spent_tokens > 0) a.push("--spent-tokens", String(args.spent_tokens));
      // terminate：提示 pi 在本批工具调用后收口，不再多做一轮
      return ok(ar(a), { terminate: true });
    },
  });

  pi.registerTool({
    name: "ev_fail",
    label: "Ev Fail",
    description: "任务失败：写 result 并上报失败原因。",
    parameters: Type.Object({
      summary: Type.String(),
      spent_tokens: Type.Optional(Type.Number({ description: "本次任务累计 token 数（缺省由 daemon 按 usage.json 兜底）" })),
    }),
    async execute(_id: string, args: any) {
      const a = ["fail", "--summary", args.summary];
      if (typeof args.spent_tokens === "number" && args.spent_tokens > 0) a.push("--spent-tokens", String(args.spent_tokens));
      return ok(ar(a), { terminate: true });
    },
  });

  pi.registerTool({
    name: "ev_gate",
    label: "Ev Gate",
    description: "人工闸门：向人工提问并挂起节点（status=waiting）。options 给可选答复文案；人工回复后节点自动恢复执行。",
    parameters: Type.Object({
      question: Type.String({ description: "要向人工确认的问题" }),
      options: Type.Optional(Type.Array(Type.String(), { description: "可选答复文案，如 ['同意','拒绝']" })),
    }),
    async execute(_id: string, args: any) {
      const a = ["gate", "--question", args.question];
      if (args.options?.length) a.push("--opts", args.options.join(";"));
      // terminate：节点已挂起等人工，提示 pi 收口本轮
      return ok(ar(a), { terminate: true });
    },
  });

  pi.registerTool({
    name: "ev_wait",
    label: "Ev Wait",
    description: "挂起等子节点：paths 填子节点 path 列表（如 ['root/a','root/b']）。全部 done 后系统自动复活本节点并把各子摘要注入上下文；派完子节点后用它收口，不要轮询。",
    parameters: Type.Object({ paths: Type.Array(Type.String(), { description: "要等待的子节点 path 列表" }) }),
    async execute(_id: string, args: any) {
      // terminate：节点已挂起等 join，提示 pi 收口本轮
      return ok(ar(["wait", "--on", (args.paths ?? []).join(",")]), { terminate: true });
    },
  });

  pi.registerTool({
    name: "ev_todo",
    label: "Ev Todo",
    description: "更新本节点任务清单（checklist 实时投影到工作台）。items 每项 {text, done?}，全量覆盖写；做完一项就重发一次保持投影新鲜。",
    parameters: Type.Object({
      items: Type.Array(Type.Object({
        text: Type.String({ description: "清单项文本" }),
        done: Type.Optional(Type.Boolean({ description: "是否已完成" })),
      }), { description: "全量清单（覆盖式）" }),
    }),
    async execute(_id: string, args: any) {
      // 节点目录 = process.cwd()：todo.json + todo 事件都直接落盘（投影走文件态）
      const items = (args.items ?? []).map((it: any) => ({ text: String(it?.text ?? ""), done: !!it?.done }));
      const ts = new Date().toISOString();
      writeFileSync(join(process.cwd(), "todo.json"), JSON.stringify({ items, ts }, null, 2) + "\n", "utf8");
      appendFileSync(join(process.cwd(), "events.jsonl"), JSON.stringify({ ts, kind: "todo", data: { items } }) + "\n", "utf8");
      return ok(`清单已更新：${items.length} 项（${items.filter((i: any) => i.done).length} 完成）`);
    },
  });

  pi.registerTool({
    name: "ev_learn",
    label: "Ev Learn",
    description: "经验回传：把一条跨任务可复用的经验/坑写进全局 learned.md（新→旧、sha1 去重、≤2000字），后续所有任务的上下文会携带。写「情境→结论」一两句，别写任务细节流水账。",
    parameters: Type.Object({ text: Type.String({ description: "经验教训正文，≤2000 字" }) }),
    async execute(_id: string, args: any) {
      const st = process.env.AICA_STATE;
      if (!st) return err("AICA_STATE 未设置，无法写 learned.md");
      return ok(learn(st, String(args.text ?? "")));
    },
  });

  pi.registerTool({
    name: "kn_recall",
    label: "Kn Recall",
    description: "知识检索（kb 环）：查任务历史、文档、会话记录。返回 top-k 分块。",
    parameters: Type.Object({ query: Type.String(), k: Type.Optional(Type.Number()) }),
    async execute(_id: string, args: any) {
      const kn = resolveBin("kn");
      if (!kn) {
        // 知识库 CLI 仍在设计阶段：不报错，让模型当作"召回为空"继续并在摘要注明
        return ok("(kn 未安装：知识库功能尚未实现，本次无可召回内容。请凭节点上下文与 already_known 继续，并在执行摘要中注明未做知识检索。)");
      }
      return ok(sh(kn, ["recall", args.query, "--k", String(args.k ?? 5)]));
    },
  });

  pi.registerTool({
    name: "ar_read",
    label: "Ar Read",
    description: "run 环：读本 Run 各节点的 result 摘要（不含 transcript）。",
    parameters: Type.Object({}),
    async execute() {
      return ok(ar(["check", "--run", process.env.AR_ROOT_ID!]));
    },
  });

  pi.registerTool({
    name: "ar_dispatch",
    label: "Ar Dispatch",
    description: "派发子节点（仅 spec.tools 声明时可用）。",
    parameters: Type.Object({
      goal: Type.String(),
      accept: Type.Optional(Type.Array(Type.String())),
      agent: Type.Optional(Type.String()),
    }),
    async execute(_id: string, args: any) {
      const a = ["node-create", "--run", process.env.AR_ROOT_ID!, "--parent", `node:${process.env.AR_ROOT_ID}/${process.env.AR_NODE_PATH}`, "--goal", args.goal];
      if (args.agent) a.push("--agent", args.agent);
      if (args.accept) a.push("--accept", args.accept.join(";"));
      return ok(ar(a));
    },
  });

  pi.registerTool({
    name: "agent_desktop",
    label: "Agent Desktop",
    description: "Windows 桌面 GUI 自动化（UIA）：snapshot 读无障碍树，ref 语义动作。大快照自动落盘回 ref。用法文档：先跑 ['skills','get','desktop']。",
    parameters: Type.Object({ argv: Type.Array(Type.String(), { description: "agent-desktop 参数，如 ['snapshot','--app','X','-i']" }) }),
    async execute(_id: string, args: any) {
      const bin = resolveBin("agent-desktop");
      if (!bin) return err("agent-desktop 未找到（PATH 与已知安装位均无）。可设 AICA_AGENT_DESKTOP 指向 agent-desktop.exe。");
      return ok(spill(sh(bin, args.argv), "ad"));
    },
  });

  pi.registerTool({
    name: "ego_browser",
    label: "Ego Browser",
    description: "网页自动化（ego Space，沿用登录态、不抢焦点）。提交 Node.js 片段，可用 taskSpace/page.snapshot/page.click 等 helper。",
    parameters: Type.Object({ script: Type.String() }),
    async execute(_id: string, args: any) {
      const bin = resolveBin("ego-browser");
      if (!bin) return err("ego-browser 未找到（PATH 与已知安装位均无）。可设 AICA_EGO_BROWSER 指向 ego-browser.exe。");
      // execFile argv 不经 shell：script 作为单个 argv 传给 ego，无 cmd 转义/截断问题
      // （上限约 32k 字符的 Windows 命令行；大输出仍走 artifact 落盘契约）
      return ok(spill(sh(bin, ["nodejs", "-e", args.script]), "ego"));
    },
  });

  pi.registerTool({
    name: "spawn",
    label: "Spawn",
    description: "派子节点（命名/寻址/隔离）：写子节点 spec 并返回 node_id。path 相对本节点（fetch-a → root/fetch-a）；budget.depth_left 自动 -1；继承父节点的审批/工具面。spawn 本身要过审批门。",
    parameters: Type.Object({
      path: Type.String({ description: "子节点名（相对本节点，字母数字 . _ -，可含 / 表示更深一层）" }),
      goal: Type.String({ description: "子任务目标（子节点 worker 的 goal）" }),
      accept: Type.Optional(Type.Array(Type.String(), { description: "验收条文；缺省 ['输出一句话执行摘要']" })),
      agent: Type.Optional(Type.String({ description: "缺省继承父节点（pi）" })),
      profile: Type.Optional(Type.String({ description: "worker/reviewer/orchestrator/advisor；缺省继承父节点" })),
      budget: Type.Optional(Type.Object({
        tokens: Type.Optional(Type.Number({ description: "token 预算（daemon turn 边界拦截）" })),
        minutes: Type.Optional(Type.Number({ description: "墙钟预算（超时 abort）" })),
        parallel: Type.Optional(Type.Number({ description: "该子任务自己再派子节点时的并发上限" })),
      })),
    }),
    async execute(_id: string, args: any) {
      const run = process.env.AR_ROOT_ID;
      const parent = process.env.AR_NODE_PATH;
      if (!run || !parent) return err("spawn 只能在 worker 内使用（缺 AR_ROOT_ID/AR_NODE_PATH）");
      try {
        const env = JSON.parse(arIn(["spawn"], JSON.stringify({ ...args, run, parent })));
        if (!env?.ok) return err(`spawn 失败：${env?.error?.code ?? "?"} ${env?.error?.message ?? ""}`.trim());
        const d = env.data ?? {};
        return ok(`node_id=${d.node_id}\npath=${d.path}\nparent=${d.parent}\ndepth_left=${d.depth_left}`);
      } catch (e) {
        return err(`spawn 失败：${String((e as Error)?.message ?? e)}`);
      }
    },
  });

  pi.registerTool({
    name: "ev_propose",
    label: "Ev Propose",
    description: "自进化提案（S28）：只写 proposals/<slug>/{proposal.md,patch.diff,verify.json,meta.json}，不直接改仓库。白名单外路径直接报错；应用要人工 `ar propose apply`（high 需 --force）。",
    parameters: Type.Object({
      slug: Type.String({ description: "提案名（字母数字 . _ -，≤64）" }),
      proposal: Type.String({ description: "proposal.md：动机 / 预期效果 / 风险 / 影响的文件" }),
      patch: Type.String({ description: "unified diff（---/+++/@@），只允许白名单路径" }),
      verify_cmd: Type.Optional(Type.String({ description: "校验命令，缺省 node --test workbench/test" })),
      verify_timeout_ms: Type.Optional(Type.Number({ description: "校验超时，缺省 180000" })),
    }),
    async execute(_id: string, args: any) {
      try {
        const rec = createProposal({
          slug: args.slug,
          proposal: args.proposal,
          patch: args.patch,
          verify: {
            ...(args.verify_cmd ? { cmd: args.verify_cmd } : {}),
            ...(args.verify_timeout_ms ? { timeout_ms: args.verify_timeout_ms } : {}),
          },
          root: join(process.cwd(), "proposals"),
          ...(process.env.AR_ROOT_ID ? { source: { root_id: process.env.AR_ROOT_ID, path: process.env.AR_NODE_PATH ?? "root" } } : {}),
        });
        const files = rec.meta.files.map((f) => `${f.path}${f.action === "create" ? "（新建）" : f.action === "delete" ? "（删除）" : ""}`).join("\n  ");
        return ok(`提案已写入：${rec.dir}\nrisk=${rec.risk}\n影响文件:\n  ${files}\n应用：ar propose apply ${rec.slug}${rec.risk === "high" ? " --force" : ""}`);
      } catch (e) {
        const pe = e as { code?: string; message?: string };
        return err(`ev_propose 拒绝：${pe?.code ?? "ERROR"} ${pe?.message ?? String(e)}`);
      }
    },
  });
}

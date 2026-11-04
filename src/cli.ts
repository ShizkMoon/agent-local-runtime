#!/usr/bin/env node
// ar CLI：无状态命令面。evd/受限入口/人工共用，统一 JSON envelope 输出
import { createRun, writeSpec, readSpec, transitResult, checkRun, appendEvent, appendCmdOnce, readEventsSince, writeGate, abortWorker, forkNode, queueReply, RUNS_DIR, runsDir, latestRunForCwd, resumeRun, appendLearnedEntry } from "./runs.ts";
import { daemonLoop } from "./daemon.ts";
import { listProposals, showProposal, applyProposal, rejectProposal, createProposal, ProposalError } from "./proposals.ts";
import type { SpecEnvelope, NodeStatus } from "./envelope.ts";
import { PROFILES, isProfile } from "./envelope.ts";
import { listCommands } from "./commands.ts";
import { readFileSync } from "node:fs";

function out(ok: boolean, command: string, data?: unknown, error?: unknown): void {
  // 失败时也允许带 data（如 propose apply 的 verify 输出摘要）；error 仍是机器可判的 code/message
  const payload = { version: "1.0", ok, command, ...(ok ? { data } : { error }), ...(!ok && data !== undefined ? { data } : {}) };
  process.stdout.write(JSON.stringify(payload) + "\n");
  // G-1 严格态：坏输入/失败不许"退出码 0 假装成功"；用法错误 2，其余失败 1
  if (!ok) process.exitCode = (error as { code?: string } | undefined)?.code === "USAGE" ? 2 : 1;
}

/** 用法错误：结构化 USAGE + 退出码 2 */
function usage(command: string, message: string, hint?: string): void {
  out(false, command, undefined, { code: "USAGE", message, ...(hint ? { hint } : {}) });
}

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function readStdin(): Promise<string> {
  return new Promise((res) => {
    let s = "";
    process.stdin.on("data", (c) => (s += c));
    process.stdin.on("end", () => res(s));
    process.stdin.isTTY && res("");
  });
}

/** --rules 解析：优先 JSON 数组；否则 `pattern=>message;pattern2=>msg2`（无 => 时给默认 reason） */
function parseRules(raw: string | undefined): SpecEnvelope["rules"] {
  if (!raw) return undefined;
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v : undefined; }
  catch {
    return raw.split(";").filter(Boolean).map((p) => {
      const i = p.indexOf("=>");
      return i >= 0 ? { pattern: p.slice(0, i), message: p.slice(i + 2) } : { pattern: p, message: "blocked by spec rule" };
    });
  }
}

/** S22：spawn 的子路径归一（相对父节点、禁止逃逸/绝对路径/超深）；null = 非法 */
function childPathOf(parent: string, raw: unknown): string | null {
  const p = String(raw ?? "").trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!p) return null;
  if (p.startsWith("/") || /^[a-zA-Z]:/.test(p)) return null;
  const segs = p.split("/");
  if (segs.some((s) => !s || s === "." || s === ".." || !/^[A-Za-z0-9._-]+$/.test(s))) return null;
  const full = p.startsWith(parent + "/") ? p : `${parent}/${p}`;
  if (!full.startsWith(parent + "/")) return null;
  if (full.split("/").length > 6) return null;
  return full;
}

/** 读文件参数：--flag <path|->；缺省时按需读 stdin */
async function readFileArg(flag: string, fallbackStdin: boolean): Promise<string> {
  const v = arg(flag);
  if (!v) return fallbackStdin ? await readStdin() : "";
  if (v === "-") return await readStdin();
  try { return readFileSync(v, "utf8"); } catch { return ""; }
}

const cmd = process.argv[2];

async function main(): Promise<void> {
  switch (cmd) {
    case "run-create": {
      const subject = (arg("--subject") ?? (await readStdin()).trim()).trim();
      if (!subject) return usage(cmd, "缺任务描述", "ar run-create --subject <文本>（或 stdin 传非空文本）");
      const { rootId, dir } = createRun({ kind: arg("--kind"), subject });
      return out(true, cmd, { root_id: rootId, dir });
    }
    case "dispatch": {
      // evd 适配器入口：stdin 收任务 JSON → 建 Run + 根节点 spec → 立即返回（异步投递模式）
      let task: Record<string, any>;
      try { task = JSON.parse((await readStdin()) || "{}"); }
      catch (e) { return out(false, cmd, undefined, { code: "BAD_INPUT", message: `stdin 不是合法 JSON：${String((e as Error).message).split("\n")[0].slice(0, 200)}` }); }
      const subject = String(task?.subject ?? task?.description ?? "").trim();
      if (!subject) return usage(cmd, "缺 subject / description", 'dispatch 需要 stdin JSON，例如 {"subject":"任务","goal":"..."}');
      if (task.profile !== undefined && task.profile !== null && !isProfile(task.profile)) {
        return out(false, cmd, undefined, { code: "BAD_INPUT", field: "profile", message: `profile 只接受 ${PROFILES.join("|")}，收到 ${JSON.stringify(task.profile)}` });
      }
      const { rootId } = createRun({ kind: task.kind, subject, cwd: task.cwd });
      writeSpec(rootId, "root", {
        type: "assign",
        agent: task.agent ?? "pi",
        profile: task.profile,
        model: task.model ?? arg("--model"),
        goal: task.subject ?? task.description ?? "",
        inputs: task.payload ? [{ ref: task.payload }] : [],
        accept: task.accept ?? ["输出一句话执行摘要"],
        budget: task.budget ?? { depth_left: 2 },
        tools: task.tools,
        // S1 审批/守门/挂载面透传
        permission: task.permission,
        approve: task.approve,
        deny: task.deny,
        deny_paths: task.deny_paths,
        rules: task.rules,
        skills: task.skills,
      });
      return out(true, cmd, { root_id: rootId, node: `node:${rootId}/root`, ev_id: task.ev_id });
    }
    case "node-create": {
      const rootId = arg("--run");
      if (!rootId) return usage(cmd, "缺 --run", "ar node-create --run <root> [--path root/a] --goal <文本>");
      const profileArg = arg("--profile");
      if (profileArg && !isProfile(profileArg)) {
        return out(false, cmd, undefined, { code: "BAD_INPUT", field: "profile", message: `profile 只接受 ${PROFILES.join("|")}，收到 ${JSON.stringify(profileArg)}` });
      }
      writeSpec(rootId, arg("--path") ?? `${Date.now().toString(36)}`, {
        type: "assign",
        agent: arg("--agent") ?? "pi",
        profile: arg("--profile") as SpecEnvelope["profile"],
        model: arg("--model"),
        goal: arg("--goal") ?? (await readStdin()).trim(),
        parent: arg("--parent"),
        depends: arg("--deps")?.split(","),
        accept: arg("--accept")?.split(";") ?? ["输出一句话执行摘要"],
        budget: {
          depth_left: Number(arg("--depth") ?? 2),
          ...(arg("--minutes") ? { minutes: Number(arg("--minutes")) } : {}),
          // S22：并发策略与 token 预算透传（spawn 工具用）
          ...(arg("--tokens") ? { tokens: Number(arg("--tokens")) } : {}),
          ...(arg("--parallel") ? { parallel: Number(arg("--parallel")) } : {}),
          // R6：上下文窗口覆盖（压缩阈值 = 该值 × 80%）
          ...(arg("--context-tokens") ? { context_tokens: Number(arg("--context-tokens")) } : {}),
        },
        tools: arg("--tools")?.split(","),
        // S1 新字段：--approve/--deny/--deny-paths/--skills 分号分隔，--permission 档位，--rules JSON 或 pattern=>message;…
        permission: arg("--permission") as SpecEnvelope["permission"],
        approve: arg("--approve")?.split(";").filter(Boolean),
        deny: arg("--deny")?.split(";").filter(Boolean),
        deny_paths: arg("--deny-paths")?.split(";").filter(Boolean),
        rules: parseRules(arg("--rules")),
        skills: arg("--skills")?.split(";").filter(Boolean),
      });
      return out(true, cmd, { root_id: rootId });
    }
    case "resume": {
      // R6：接着上次干 —— 不给 --run 就按 cwd 找该目录最近一次 run（run.json.cwd）
      const cwd = arg("--cwd") ?? process.cwd();
      let rootId = arg("--run");
      let matchedBy = "run";
      if (!rootId) {
        const hit = latestRunForCwd(cwd);
        if (!hit) {
          return out(false, "resume", undefined, {
            code: "NOT_FOUND",
            message: `在 ${cwd} 找不到可恢复的 run（按 run.json.cwd 匹配）`,
            hint: "ar resume --run <id> 指定，或 ar run-create 先建一个",
          });
        }
        rootId = hit.rootId;
        matchedBy = `cwd:${cwd}`;
      }
      if (!readSpec(rootId, "root")) {
        return out(false, "resume", undefined, { code: "NOT_FOUND", message: `run ${rootId} 没有根节点 spec`, hint: "用 --run 指定一个有 root 节点的 run" });
      }
      const text = arg("--text") ?? "继续上次任务（ar resume）";
      const r = resumeRun(rootId, text);
      return out(true, "resume", { ...r, matched_by: matchedBy });
    }
    case "check": {
      const rootId = arg("--run") ?? process.argv[3];
      if (!rootId) return usage(cmd, "缺 --run", "ar check --run <root>");
      return out(true, cmd, checkRun(rootId));
    }
    case "reply": {
      const rootId = arg("--run");
      if (!rootId) return usage(cmd, "缺 --run", "ar reply --run <root> [--node root] --text <文本> [--mode queue|interrupt]");
      const path = arg("--node") ?? "root";
      const text = arg("--text") ?? (await readStdin()).trim();
      // R4 A6：steer（真插话）需要 pi RPC，当前版本明确不支持——不假装成功
      const modeArg = arg("--mode");
      if (modeArg === "steer") {
        return out(false, cmd, { node: `node:${rootId}/${path}` }, {
          code: "UNSUPPORTED",
          message: "真插话需要 pi RPC，当前版本用 interrupt（打断重拉）或 queue（下一轮生效）",
        });
      }
      // S22：running 节点只排队（本轮结束后送达）；waiting/done 照旧；interrupt = 打断并重拉（显式人操作）
      const mode = modeArg === "interrupt" ? "interrupt" : "queue";
      let r: ReturnType<typeof queueReply>;
      try { r = queueReply(rootId, path, text, mode); }
      catch (e) { return out(false, cmd, undefined, { code: "NO_NODE", path, message: String((e as Error).message) }); }
      // S21：命令回执幂等 —— 同一条回复重放不会刷出第二条 cmd 事件（spec.reply 里仍逐条留痕）
      const fresh = appendCmdOnce(rootId, path, "reply", { text });
      return out(true, cmd, { node: r.node, resumed: r.resumed, delivery: r.delivery, pid: r.pid, receipt: fresh });
    }
    case "gate": {
      // Worker 侧调用（ev_gate 工具）：写 waiting result + gate.json，节点挂起等人工回复
      const rootId = process.env.AR_ROOT_ID ?? arg("--run");
      if (!rootId) return usage(cmd, "缺 --run（或 AR_ROOT_ID）", "ar gate --run <root> --question <文本>");
      const path = process.env.AR_NODE_PATH ?? arg("--node") ?? "root";
      const question = arg("--question") ?? (await readStdin()).trim();
      if (!question) return usage(cmd, "缺 --question", "ar gate --run <root> --question <文本> [--opts 同意;拒绝]");
      const opts = arg("--opts")?.split(";").filter(Boolean);
      // G-2：先判迁移再落 gate，避免在终止态节点上留下孤儿 gate.json
      const tr = transitResult(rootId, path, { status: "waiting", summary: question }, { source: `ar ${cmd}` });
      if (!tr.ok) return out(false, cmd, { from: tr.from, to: tr.to }, { code: "ILLEGAL_TRANSITION", from: tr.from, to: tr.to, message: `${tr.from} → waiting 非法（${tr.from} 为终止态）；旧状态保留` });
      writeGate(rootId, path, { question, ...(opts?.length ? { opts } : {}) });
      appendCmdOnce(rootId, path, "gate", { question, opts: opts ?? [] });
      return out(true, cmd, tr.result);
    }
    case "done":
    case "fail": {
      // Worker 侧调用：写 result.json（evd 协议外的那一层，worker 进程内执行）
      const rootId = process.env.AR_ROOT_ID ?? arg("--run");
      if (!rootId) return usage(cmd, "缺 --run（或 AR_ROOT_ID）", `ar ${cmd} --run <root> --summary <文本>`);
      const path = process.env.AR_NODE_PATH ?? arg("--node") ?? "root";
      const status: NodeStatus = cmd === "done" ? "done" : "failed";
      // S6：worker 自报累计 token；缺省由 daemon 在 worker 退出时按 usage.json 兜底
      const st = Number(arg("--spent-tokens"));
      const summary = arg("--summary") ?? process.argv[3] ?? "";
      // G-2：done/fail 走状态机；终止态不可覆写 → ILLEGAL_TRANSITION，旧状态保留
      const tr = transitResult(rootId, path, {
        status, summary,
        ...(Number.isFinite(st) && st > 0 ? { spent: { tokens: st } } : {}),
      }, { source: `ar ${cmd}` });
      if (!tr.ok) {
        return out(false, cmd, { from: tr.from, to: tr.to }, {
          code: "ILLEGAL_TRANSITION", from: tr.from, to: tr.to,
          message: `${tr.from} → ${tr.to} 非法（${tr.from} 为终止态）；旧状态保留`,
        });
      }
      // S21：同一条 done/fail 重放 → 只留一条 cmd 回执（result 本身早就幂等）
      appendCmdOnce(rootId, path, cmd, { status, summary });
      return out(true, cmd, tr.result);
    }
    case "wait": {
      // Worker 侧调用（ev_wait 工具）：写 waiting result + wait_on + gate.json；
      // 全部子节点 done 后 pendingNodes 自动归档并注入子摘要复活（无需人工回复）
      const rootId = process.env.AR_ROOT_ID ?? arg("--run");
      if (!rootId) return usage(cmd, "缺 --run（或 AR_ROOT_ID）", "ar wait --run <root> --on root/a,root/b");
      const path = process.env.AR_NODE_PATH ?? arg("--node") ?? "root";
      const on = (arg("--on") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      const tr = transitResult(rootId, path, { status: "waiting", summary: `等待子节点：${on.join(", ") || "(空)"}`, wait_on: on }, { source: `ar ${cmd}` });
      if (!tr.ok) return out(false, cmd, { from: tr.from, to: tr.to }, { code: "ILLEGAL_TRANSITION", from: tr.from, to: tr.to, message: `${tr.from} → waiting 非法（${tr.from} 为终止态）；旧状态保留` });
      writeGate(rootId, path, { question: "等待子节点", opts: [] });
      appendCmdOnce(rootId, path, "wait", { on });
      return out(true, cmd, tr.result);
    }
    case "event": {
      const rootId = process.env.AR_ROOT_ID ?? arg("--run");
      if (!rootId) return usage(cmd, "缺 --run（或 AR_ROOT_ID）", "ar event --run <root> --kind <name>");
      const path = process.env.AR_NODE_PATH ?? arg("--node") ?? "root";
      appendEvent(rootId, path, { kind: (arg("--kind") as never) ?? "checkpoint", data: { text: process.argv[3] ?? "" } });
      return out(true, cmd, {});
    }
    case "abort": {
      // 中止 live worker：读 worker.json → taskkill 进程树 → 幂等 failed("aborted by user") + abort 事件
      const rootId = process.env.AR_ROOT_ID ?? arg("--run");
      if (!rootId) return usage(cmd, "缺 --run（或 AR_ROOT_ID）", "ar abort --run <root> [--node root]");
      const path = process.env.AR_NODE_PATH ?? arg("--node") ?? "root";
      return out(true, cmd, abortWorker(rootId, path, "aborted by user"));
    }
    case "events": {
      // S21：事件增量读（since = seq 游标；纯老文件退回行号语义，mode 字段自证）
      const rootId = arg("--run") ?? process.argv[3];
      const path = arg("--node") ?? "root";
      const since = Math.max(0, Number(arg("--since") ?? 0) || 0);
      if (!rootId) return usage(cmd, "缺 --run", "ar events --run <root> [--node root] [--since N]");
      return out(true, cmd, readEventsSince(rootId, path, since));
    }
    case "fork": {
      // S21：把一个节点复制成新 run（spec 保留、result/events 清空、forked_from 记来源）
      const rootId = arg("--run") ?? process.argv[3];
      const path = arg("--node") ?? "root";
      if (!rootId) return usage(cmd, "缺 --run", "ar fork --run <root> [--node root]");
      const forked = forkNode(rootId, path);
      return forked ? out(true, cmd, forked) : out(false, cmd, undefined, { code: "NOT_FOUND", path, message: `节点不存在：${path}` });
    }
    case "spawn": {
      // S22 子代理原语（spawn 工具走这里）：stdin JSON → 子节点 spec。
      // 继承父节点的审批/工具面（子节点不能因 spawn 绕开 supervised/deny），depth_left 严格 -1。
      let req: any;
      try { req = JSON.parse((await readStdin()) || "{}"); }
      catch { return out(false, cmd, undefined, { code: "USAGE", message: "stdin 需要 JSON 对象" }); }
      const rootId = String(req.run ?? process.env.AR_ROOT_ID ?? "");
      const parentPath = String(req.parent ?? process.env.AR_NODE_PATH ?? "root");
      if (!rootId) return out(false, cmd, undefined, { code: "USAGE", message: "缺 run（或 AR_ROOT_ID）" });
      const parentSpec = readSpec(rootId, parentPath);
      if (!parentSpec) return out(false, cmd, undefined, { code: "NO_PARENT", parent: parentPath });
      const childPath = childPathOf(parentPath, req.path);
      if (!childPath) return out(false, cmd, undefined, { code: "BAD_PATH", path: req.path, message: "path 必须是父节点之下的相对名（字母数字._-，≤6 段）" });
      const goal = String(req.goal ?? "").trim();
      if (!goal) return out(false, cmd, undefined, { code: "USAGE", message: "缺 goal" });
      if (readSpec(rootId, childPath)) return out(false, cmd, undefined, { code: "EXISTS", path: childPath });
      const parentDepth = Number(parentSpec.budget?.depth_left ?? 0);
      if (!(parentDepth >= 1)) return out(false, cmd, undefined, { code: "DEPTH", depth_left: parentDepth, message: "depth_left=0：不能再派子节点" });
      // R3：profile 闭集（子节点显式指定的必须合法；继承父节点的旧值留给 daemon 兜底）
      if (req.profile !== undefined && req.profile !== null && !isProfile(req.profile)) {
        return out(false, cmd, undefined, { code: "BAD_INPUT", field: "profile", message: `profile 只接受 ${PROFILES.join("|")}，收到 ${JSON.stringify(req.profile)}` });
      }
      const b = (req.budget ?? {}) as Record<string, unknown>;
      const spec = writeSpec(rootId, childPath, {
        type: "assign",
        agent: String(req.agent ?? parentSpec.agent ?? "pi"),
        profile: (req.profile ?? parentSpec.profile) as SpecEnvelope["profile"],
        model: req.model ?? parentSpec.model,
        goal,
        parent: parentSpec.id,
        accept: Array.isArray(req.accept) && req.accept.length ? req.accept.map(String) : ["输出一句话执行摘要"],
        budget: {
          depth_left: parentDepth - 1,
          ...(Number(b.minutes) > 0 ? { minutes: Number(b.minutes) } : {}),
          ...(Number(b.tokens) > 0 ? { tokens: Number(b.tokens) } : {}),
          ...(Number(b.parallel) > 0 ? { parallel: Number(b.parallel) } : {}),
        },
        permission: parentSpec.permission,
        tools: parentSpec.tools,
        deny: parentSpec.deny,
        deny_paths: parentSpec.deny_paths,
        restricted_paths: parentSpec.restricted_paths,
        rules: parentSpec.rules,
        skills: parentSpec.skills,
      });
      appendEvent(rootId, parentPath, { kind: "spawn", data: { path: childPath, node_id: spec.id, goal: spec.goal } });
      return out(true, cmd, { node_id: spec.id, path: childPath, parent: parentSpec.id, depth_left: spec.budget?.depth_left });
    }
    case "propose": {
      // S28 审阅面（§9.3）：list / show / apply [--force] / reject --reason / new
      const sub = process.argv[3] ?? "list";
      const fail = (e: unknown) => {
        const pe = e as ProposalError;
        return out(false, `propose:${sub}`, undefined, {
          code: pe?.code ?? "ERROR", message: String(pe?.message ?? e),
          ...(pe?.detail ? { detail: pe.detail } : {}),
        });
      };
      try {
        if (sub === "list") return out(true, "propose:list", { proposals: listProposals() });
        if (sub === "show") {
          const slug = process.argv[4];
          if (!slug) return out(false, "propose:show", undefined, { code: "USAGE", message: "ar propose show <slug>" });
          const p = showProposal(slug);
          return p ? out(true, "propose:show", { proposal: p }) : out(false, "propose:show", undefined, { code: "NOT_FOUND", slug });
        }
        if (sub === "apply") {
          const slug = process.argv[4];
          if (!slug) return out(false, "propose:apply", undefined, { code: "USAGE", message: "ar propose apply <slug> [--force]" });
          const r = applyProposal(slug, { force: process.argv.includes("--force") });
          // R6 learned 闭环：提案落地后追一条学习条目（下一次 worker 拉起会注入）
          if (r.ok) {
            try { appendLearnedEntry(`[proposal] ${slug} 已应用（risk=${r.risk ?? "?"}${r.auto ? "，auto" : ""}${r.files?.length ? `，files=${r.files.map((f) => f.path).join(",")}` : ""}）`); } catch { /* 记账失败不影响应用结果 */ }
          }
          return r.ok ? out(true, "propose:apply", r) : out(false, "propose:apply", { result: r }, { code: r.code ?? "APPLY_FAILED", message: r.message });
        }
        if (sub === "reject") {
          const slug = process.argv[4];
          if (!slug) return out(false, "propose:reject", undefined, { code: "USAGE", message: "ar propose reject <slug> --reason <text>" });
          const reason = arg("--reason") ?? "";
          const r = rejectProposal(slug, reason);
          if (r.ok) {
            try { appendLearnedEntry(`[proposal] ${slug} 被拒（${reason || "未给原因"}）`); } catch { /* 同上 */ }
          }
          return r.ok ? out(true, "propose:reject", r) : out(false, "propose:reject", undefined, { code: r.code ?? "REJECT_FAILED", message: r.message });
        }
        if (sub === "new") {
          const slug = arg("--slug") ?? process.argv[4];
          if (!slug) return out(false, "propose:new", undefined, { code: "USAGE", message: "ar propose new --slug <slug> [--patch <file|->] [--proposal <file|->]" });
          const patch = await readFileArg("--patch", true);
          const proposal = await readFileArg("--proposal", false);
          const verify = (arg("--verify-cmd") || arg("--verify-timeout"))
            ? { ...(arg("--verify-cmd") ? { cmd: arg("--verify-cmd")! } : {}), ...(arg("--verify-timeout") ? { timeout_ms: Number(arg("--verify-timeout")) } : {}) }
            : undefined;
          const rec = createProposal({
            slug, patch, proposal, verify,
            ...(arg("--root") ? { root: arg("--root")! } : {}),
            ...(arg("--run") ? { source: { root_id: arg("--run"), path: arg("--node") ?? "root" } } : {}),
          });
          return out(true, "propose:new", { slug: rec.slug, dir: rec.dir, risk: rec.risk, files: rec.meta.files, verify: rec.verify });
        }
        return out(false, "propose", undefined, {
          code: "USAGE",
          subcommands: ["list", "show <slug>", "apply <slug> [--force]", "reject <slug> --reason <text>", "new --slug <slug> [--patch <file|->]"],
        });
      } catch (e) { return fail(e); }
    }
    case "daemon": {
      runsDir();
      await daemonLoop({
        once: process.argv.includes("--once"),
        timeoutMs: Number(arg("--timeout-ms") ?? process.env.AR_DAEMON_TIMEOUT_MS ?? 0) || undefined,
      });
      return;
    }
    case "cmd": {
      const sub = String(process.argv[3] ?? "").toLowerCase();
      if (sub !== "list") return usage("cmd", `未知子命令：${sub || "(空)"}`, "ar cmd list");
      const commands = listCommands();
      return out(true, "cmd:list", { count: commands.length, commands });
    }
    case "version":
      return out(true, cmd, { version: "0.1.0", runs: RUNS_DIR });
    default:
      return out(false, "help", undefined, {
        code: "USAGE",
        commands: ["run-create", "dispatch", "node-create", "resume", "spawn", "check", "reply", "gate", "done", "fail", "wait", "event", "events", "fork", "abort", "propose", "cmd", "daemon", "version"],
      });
  }
}

// G-1：意外异常也只回 envelope（INTERNAL + 首行 message，无裸栈），退出码 1
main().catch((e) => {
  const msg = String((e as Error)?.message ?? e).split("\n")[0].slice(0, 400);
  out(false, cmd ?? "?", undefined, { code: "INTERNAL", message: msg || "internal error" });
});

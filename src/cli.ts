#!/usr/bin/env node
// ar CLI：无状态命令面。evd/受限入口/人工共用，统一 JSON envelope 输出
import { createRun, writeSpec, readSpec, readResult, writeResult, checkRun, appendEvent, appendCmdOnce, readEventsSince, writeGate, resolveWaiting, abortWorker, forkNode, RUNS_DIR, runsDir } from "./runs.ts";
import { daemonLoop } from "./daemon.ts";
import type { SpecEnvelope, NodeStatus } from "./envelope.ts";

function out(ok: boolean, command: string, data?: unknown, error?: unknown): void {
  process.stdout.write(JSON.stringify({ version: "1.0", ok, command, ...(ok ? { data } : { error }) }) + "\n");
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

const cmd = process.argv[2];

async function main(): Promise<void> {
  switch (cmd) {
    case "run-create": {
      const subject = arg("--subject") ?? (await readStdin()).trim();
      const { rootId, dir } = createRun({ kind: arg("--kind"), subject });
      return out(true, cmd, { root_id: rootId, dir });
    }
    case "dispatch": {
      // evd 适配器入口：stdin 收任务 JSON → 建 Run + 根节点 spec → 立即返回（异步投递模式）
      const task = JSON.parse(await readStdin() || "{}");
      const { rootId } = createRun({ kind: task.kind, subject: task.subject ?? task.description });
      writeSpec(rootId, "root", {
        type: "assign",
        agent: task.agent ?? "pi",
        profile: task.profile,
        model: task.model,
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
      const rootId = arg("--run")!;
      writeSpec(rootId, arg("--path") ?? `${Date.now().toString(36)}`, {
        type: "assign",
        agent: arg("--agent") ?? "pi",
        profile: arg("--profile") as SpecEnvelope["profile"],
        model: arg("--model"),
        goal: arg("--goal") ?? (await readStdin()).trim(),
        parent: arg("--parent"),
        depends: arg("--deps")?.split(","),
        accept: arg("--accept")?.split(";") ?? ["输出一句话执行摘要"],
        budget: { depth_left: Number(arg("--depth") ?? 2), ...(arg("--minutes") ? { minutes: Number(arg("--minutes")) } : {}) },
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
    case "check": {
      const rootId = arg("--run") ?? process.argv[3];
      return out(true, cmd, checkRun(rootId));
    }
    case "reply": {
      const rootId = arg("--run")!;
      const path = arg("--node") ?? "root";
      const spec = readSpec(rootId, path);
      if (!spec) return out(false, cmd, undefined, { code: "NO_NODE", path });
      const text = arg("--text") ?? (await readStdin()).trim();
      spec.reply = [...(spec.reply ?? []), { text, ts: new Date().toISOString() }];
      writeSpec(rootId, path, spec);
      // 隐式 resume：waiting 节点的 result 归档为 result.resolved.json，daemon 下一轮重新拉起
      const resumed = resolveWaiting(rootId, path);
      // S21：命令回执幂等 —— 同一条回复重放不会刷出第二条 cmd 事件（spec.reply 里仍逐条留痕）
      const fresh = appendCmdOnce(rootId, path, "reply", { text });
      return out(true, cmd, { node: spec.id, resumed, receipt: fresh });
    }
    case "gate": {
      // Worker 侧调用（ev_gate 工具）：写 waiting result + gate.json，节点挂起等人工回复
      const rootId = process.env.AR_ROOT_ID ?? arg("--run")!;
      const path = process.env.AR_NODE_PATH ?? arg("--node") ?? "root";
      const question = arg("--question") ?? (await readStdin()).trim();
      const opts = arg("--opts")?.split(";").filter(Boolean);
      writeGate(rootId, path, { question, ...(opts?.length ? { opts } : {}) });
      const r = writeResult(rootId, path, { status: "waiting", summary: question });
      appendCmdOnce(rootId, path, "gate", { question, opts: opts ?? [] });
      return out(true, cmd, r);
    }
    case "done":
    case "fail": {
      // Worker 侧调用：写 result.json（evd 协议外的那一层，worker 进程内执行）
      const rootId = process.env.AR_ROOT_ID ?? arg("--run")!;
      const path = process.env.AR_NODE_PATH ?? arg("--node") ?? "root";
      const status: NodeStatus = cmd === "done" ? "done" : "failed";
      // S6：worker 自报累计 token；缺省由 daemon 在 worker 退出时按 usage.json 兜底
      const st = Number(arg("--spent-tokens"));
      const r = writeResult(rootId, path, {
        status, summary: arg("--summary") ?? process.argv[3] ?? "",
        ...(Number.isFinite(st) && st > 0 ? { spent: { tokens: st } } : {}),
      });
      // S21：同一条 done/fail 重放 → 只留一条 cmd 回执（result 本身早就幂等）
      appendCmdOnce(rootId, path, cmd, { status, summary: arg("--summary") ?? process.argv[3] ?? "" });
      return out(true, cmd, r);
    }
    case "wait": {
      // Worker 侧调用（ev_wait 工具）：写 waiting result + wait_on + gate.json；
      // 全部子节点 done 后 pendingNodes 自动归档并注入子摘要复活（无需人工回复）
      const rootId = process.env.AR_ROOT_ID ?? arg("--run")!;
      const path = process.env.AR_NODE_PATH ?? arg("--node") ?? "root";
      const on = (arg("--on") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      writeGate(rootId, path, { question: "等待子节点", opts: [] });
      const r = writeResult(rootId, path, { status: "waiting", summary: `等待子节点：${on.join(", ") || "(空)"}`, wait_on: on });
      appendCmdOnce(rootId, path, "wait", { on });
      return out(true, cmd, r);
    }
    case "event": {
      const rootId = process.env.AR_ROOT_ID ?? arg("--run")!;
      const path = process.env.AR_NODE_PATH ?? arg("--node") ?? "root";
      appendEvent(rootId, path, { kind: (arg("--kind") as never) ?? "checkpoint", data: { text: process.argv[3] ?? "" } });
      return out(true, cmd, {});
    }
    case "abort": {
      // 中止 live worker：读 worker.json → taskkill 进程树 → 幂等 failed("aborted by user") + abort 事件
      const rootId = process.env.AR_ROOT_ID ?? arg("--run")!;
      const path = process.env.AR_NODE_PATH ?? arg("--node") ?? "root";
      return out(true, cmd, abortWorker(rootId, path, "aborted by user"));
    }
    case "events": {
      // S21：事件增量读（since = seq 游标；纯老文件退回行号语义，mode 字段自证）
      const rootId = arg("--run") ?? process.argv[3];
      const path = arg("--node") ?? "root";
      const since = Math.max(0, Number(arg("--since") ?? 0) || 0);
      if (!rootId) return out(false, cmd, undefined, { code: "USAGE", hint: "ar events --run <root> [--node root] [--since N]" });
      return out(true, cmd, readEventsSince(rootId, path, since));
    }
    case "fork": {
      // S21：把一个节点复制成新 run（spec 保留、result/events 清空、forked_from 记来源）
      const rootId = arg("--run") ?? process.argv[3];
      const path = arg("--node") ?? "root";
      if (!rootId) return out(false, cmd, undefined, { code: "USAGE", hint: "ar fork --run <root> [--node root]" });
      const forked = forkNode(rootId, path);
      return forked ? out(true, cmd, forked) : out(false, cmd, undefined, { code: "NO_NODE", path });
    }
    case "daemon": {
      runsDir();
      await daemonLoop({
        once: process.argv.includes("--once"),
        timeoutMs: Number(arg("--timeout-ms") ?? process.env.AR_DAEMON_TIMEOUT_MS ?? 0) || undefined,
      });
      return;
    }
    case "version":
      return out(true, cmd, { version: "0.1.0", runs: RUNS_DIR });
    default:
      return out(false, "help", undefined, {
        code: "USAGE",
        commands: ["run-create", "dispatch", "node-create", "check", "reply", "gate", "done", "fail", "wait", "event", "events", "fork", "abort", "daemon", "version"],
      });
  }
}

main().catch((e) => out(false, cmd ?? "?", undefined, { code: "FATAL", message: String(e?.stack ?? e) }));

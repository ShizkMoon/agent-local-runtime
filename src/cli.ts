#!/usr/bin/env node
// ar CLI：无状态命令面。evd/受限入口/人工共用，统一 JSON envelope 输出
import { createRun, writeSpec, readSpec, readResult, writeResult, checkRun, appendEvent, RUNS_DIR, runsDir } from "./runs.ts";
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
        goal: task.subject ?? task.description ?? "",
        inputs: task.payload ? [{ ref: task.payload }] : [],
        accept: task.accept ?? ["输出一句话执行摘要"],
        budget: task.budget ?? { depth_left: 2 },
      });
      return out(true, cmd, { root_id: rootId, node: `node:${rootId}/root`, ev_id: task.ev_id });
    }
    case "node-create": {
      const rootId = arg("--run")!;
      writeSpec(rootId, arg("--path") ?? `${Date.now().toString(36)}`, {
        type: "assign",
        agent: arg("--agent") ?? "pi",
        goal: arg("--goal") ?? (await readStdin()).trim(),
        parent: arg("--parent"),
        depends: arg("--deps")?.split(","),
        accept: arg("--accept")?.split(";") ?? ["输出一句话执行摘要"],
        budget: { depth_left: Number(arg("--depth") ?? 2) },
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
      spec.reply = [...(spec.reply ?? []), { text: arg("--text") ?? (await readStdin()).trim(), ts: new Date().toISOString() }];
      writeSpec(rootId, path, spec);
      return out(true, cmd, { node: spec.id });
    }
    case "done":
    case "fail": {
      // Worker 侧调用：写 result.json（evd 协议外的那一层，worker 进程内执行）
      const rootId = process.env.AR_ROOT_ID ?? arg("--run")!;
      const path = process.env.AR_NODE_PATH ?? arg("--node") ?? "root";
      const status: NodeStatus = cmd === "done" ? "done" : "failed";
      const r = writeResult(rootId, path, { status, summary: arg("--summary") ?? process.argv[3] ?? "" });
      return out(true, cmd, r);
    }
    case "event": {
      const rootId = process.env.AR_ROOT_ID ?? arg("--run")!;
      const path = process.env.AR_NODE_PATH ?? arg("--node") ?? "root";
      appendEvent(rootId, path, { kind: (arg("--kind") as never) ?? "checkpoint", data: { text: process.argv[3] ?? "" } });
      return out(true, cmd, {});
    }
    case "daemon": {
      runsDir();
      return daemonLoop();
    }
    case "version":
      return out(true, cmd, { version: "0.1.0", runs: RUNS_DIR });
    default:
      return out(false, "help", undefined, {
        code: "USAGE",
        commands: ["run-create", "dispatch", "node-create", "check", "reply", "done", "fail", "event", "daemon", "version"],
      });
  }
}

main().catch((e) => out(false, cmd ?? "?", undefined, { code: "FATAL", message: String(e?.stack ?? e) }));

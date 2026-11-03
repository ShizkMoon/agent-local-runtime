// ar daemon：用户会话常驻宿主，消费派发意图、拉起与回收 Worker 进程
// 会话边界原因：Session 0 服务碰不到桌面，agent-desktop/ego 只能在交互会话工作
import { spawn } from "node:child_process";
import { appendFileSync, openSync } from "node:fs";
import { join } from "node:path";
import { pendingNodes, appendEvent, writeResult, RUNS_DIR } from "./runs.ts";
import type { SpecEnvelope } from "./envelope.ts";

const POLL_MS = Number(process.env.AR_POLL_MS ?? 2000);
const MAX_WORKERS = Number(process.env.AR_MAX_WORKERS ?? 2);
const running = new Set<string>();

/** Worker 拉起命令：按 spec.agent 选 launcher；env 注入节点上下文 */
function launcher(spec: SpecEnvelope, nodeDir: string): { cmd: string; args: string[] } {
  switch (spec.agent ?? "pi") {
    case "pi":
      // -p 非交互跑完即退；aica-pi 经 -e 加载；工具面按 spec.tools 裁剪
      const pkg = process.env.AICA_PI_PKG ?? new URL("../aica-pi", import.meta.url).pathname;
      const piArgs = ["-p", "--mode", "json", "-e", join(pkg, "extensions", "events.ts"), "-e", join(pkg, "extensions", "tools.ts")];
      if (spec.tools?.length) piArgs.push("--tools", spec.tools.join(","));
      return { cmd: "pi", args: [...piArgs, spec.goal] };
    case "claude":
      return { cmd: "claude", args: ["-p", spec.goal, "--output-format", "json"] };
    case "codex":
      return { cmd: "codex", args: ["exec", spec.goal, "--json"] };
    default:
      return { cmd: spec.agent!, args: [spec.goal] };
  }
}

async function spawnWorker(rootId: string, path: string, spec: SpecEnvelope): Promise<void> {
  const dir = join(RUNS_DIR, rootId, "nodes", path);
  const { cmd, args } = launcher(spec, dir);
  appendEvent(rootId, path, { kind: "spawn", data: { cmd, agent: spec.agent ?? "pi" } });
  const log = openSync(join(dir, "stdout.log"), "a");
  const child = spawn(cmd, args, {
    cwd: dir,
    stdio: ["ignore", log, log],
    env: { ...process.env, AR_ROOT_ID: rootId, AR_NODE_PATH: path, AICA_STATE: process.env.AICA_STATE ?? "" },
    windowsHide: true,
  });
  running.add(spec.id);
  child.on("exit", (code) => {
    running.delete(spec.id);
    appendEvent(rootId, path, { kind: "exit", data: { code } });
    // Worker 应自己写 result.json；没写则按退出码兜底
    import("./runs.ts").then(({ readResult }) => {
      if (!readResult(rootId, path)) {
        writeResult(rootId, path, {
          status: code === 0 ? "done" : "failed",
          summary: code === 0 ? "Worker 正常退出（未写执行摘要）" : `Worker 退出码 ${code}`,
        });
      }
    });
  });
}

export async function daemonLoop(): Promise<never> {
  appendFileSync(join(RUNS_DIR, "index.jsonl"), JSON.stringify({ ts: new Date().toISOString(), event: "daemon_start" }) + "\n");
  for (;;) {
    try {
      for (const { rootId, path, spec } of pendingNodes()) {
        if (running.size >= MAX_WORKERS || running.has(spec.id)) continue;
        await spawnWorker(rootId, path, spec);
      }
    } catch (e) {
      appendFileSync(join(RUNS_DIR, "index.jsonl"), JSON.stringify({ ts: new Date().toISOString(), event: "daemon_error", error: String(e) }) + "\n");
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

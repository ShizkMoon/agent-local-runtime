#!/usr/bin/env node
// smoke-e2e：ar 派发 → daemon --once 拉起真实 pi worker → 断言产物/事件/result
// 可重复跑：每次 createRun 生成新 root_id；OPENCODE_POOL_KEY 由 daemon 从 HKCU\Environment 自动并入
// 用法：node scripts/smoke-e2e.mjs [--timeout-ms 300000]
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(REPO, "src", "cli.ts");
const STATE = process.env.AICA_STATE || join(process.env.LOCALAPPDATA, "aica", "state");
const RUNS = join(STATE, "runs");
const timeoutMs = Number(process.argv[process.argv.indexOf("--timeout-ms") + 1] || 300_000);

let failures = 0;
const log = (s) => process.stdout.write(s + "\n");
const check = (name, cond, detail = "") => {
  log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};

function ar(args) {
  return JSON.parse(execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: process.env }));
}

log(`smoke-e2e  repo=${REPO}`);
log(`smoke-e2e  state=${STATE}`);

// 1) 建 Run + 根节点（真实模型调用，worker 须写 artifacts/ping.txt 再 ev_done）
const { data: { root_id: rootId } } = ar(["run-create", "--subject", "smoke-e2e"]);
ar(["node-create", "--run", rootId, "--path", "root",
  "--goal", "Write the single word 'pong' into artifacts/ping.txt using your write tool, then call ev_done with a one-line summary."]);
const nodeDir = join(RUNS, rootId, "nodes", "root");
log(`smoke-e2e  run=${rootId}`);

// 2) daemon 单轮模式：跑空队列即退；超时兜底杀
const daemon = spawn(process.execPath, [CLI, "daemon", "--once", "--timeout-ms", String(timeoutMs)],
  { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
let dOut = "";
daemon.stdout.on("data", (c) => (dOut += c));
daemon.stderr.on("data", (c) => (dOut += c));
const exitCode = await new Promise((res) => daemon.on("exit", res));
check("daemon --once exits 0", exitCode === 0, `code=${exitCode}${exitCode !== 0 ? ` out=${dOut.slice(-400)}` : ""}`);

// 3) 断言：result 由 ev_done 写入（非退出码兜底文案）；事件流有 tool_execution + agent_message；产物存在
const result = existsSync(join(nodeDir, "result.json")) ? JSON.parse(readFileSync(join(nodeDir, "result.json"), "utf8")) : null;
check("result.json status=done", result?.status === "done", result?.status);
check("result.json written by ev_done (not exit-code fallback)", !!result && !result.summary.includes("未写执行摘要"), result?.summary);

const events = existsSync(join(nodeDir, "events.jsonl"))
  ? readFileSync(join(nodeDir, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
  : [];
check("events.jsonl has tool_execution", events.some((e) => e.kind === "tool_execution"));
check("events.jsonl has agent_message", events.some((e) => e.kind === "agent_message"));
check("events.jsonl has ev_done call", events.some((e) => e.kind === "tool_execution" && e.data?.tool === "ev_done"));

const ping = join(nodeDir, "artifacts", "ping.txt");
check("artifacts/ping.txt contains 'pong'", existsSync(ping) && readFileSync(ping, "utf8").includes("pong"),
  existsSync(ping) ? JSON.stringify(readFileSync(ping, "utf8").trim()) : "missing");

const chk = ar(["check", "--run", rootId]);
check("ar check reports done", chk.data?.nodes?.some((n) => n.status === "done"), JSON.stringify(chk.data?.nodes));

log(failures === 0 ? `SMOKE PASS  run=${rootId}` : `SMOKE FAIL (${failures})  run=${rootId}  nodeDir=${nodeDir}`);
process.exit(failures === 0 ? 0 : 1);

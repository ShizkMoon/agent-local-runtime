#!/usr/bin/env node
// smoke-tools：派发带 spec.tools=[agent_desktop] 的节点 → daemon --once → 断言真实二进制链路
// 覆盖点：aica-pi/extensions/paths.ts 解析到 agent-desktop.exe、execFile 直拉成功、
//         list-apps 的 JSON 输出经 spill 落盘 artifacts/、tool_execution 无 is_error
// 用法：node scripts/smoke-tools.mjs [--timeout-ms 300000]
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
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

log(`smoke-tools  repo=${REPO}`);
log(`smoke-tools  state=${STATE}`);

// 1) 建 Run + 根节点（真实模型调用：agent_desktop list-apps → ev_done 报数量）
const { data: { root_id: rootId } } = ar(["run-create", "--subject", "smoke-tools"]);
ar(["node-create", "--run", rootId, "--path", "root",
  "--tools", "agent_desktop",
  "--goal", `Call the agent_desktop tool exactly once with argv ["list-apps"]. The tool output is a JSON object with data.apps (a list of running apps). Then call ev_done with a one-line summary stating how many apps were listed. Do not call any other tool.`]);
const nodeDir = join(RUNS, rootId, "nodes", "root");
log(`smoke-tools  run=${rootId}`);

// 2) daemon 单轮模式
const daemon = spawn(process.execPath, [CLI, "daemon", "--once", "--timeout-ms", String(timeoutMs)],
  { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
let dOut = "";
daemon.stdout.on("data", (c) => (dOut += c));
daemon.stderr.on("data", (c) => (dOut += c));
const exitCode = await new Promise((res) => daemon.on("exit", res));
check("daemon --once exits 0", exitCode === 0, `code=${exitCode}${exitCode !== 0 ? ` out=${dOut.slice(-400)}` : ""}`);

// 3) 断言：result 由 ev_done 写入；agent_desktop 调用成功；spill 产物是非平凡 JSON
const result = existsSync(join(nodeDir, "result.json")) ? JSON.parse(readFileSync(join(nodeDir, "result.json"), "utf8")) : null;
check("result.json status=done", result?.status === "done", result?.status);
check("result.json written by ev_done (not exit-code fallback)", !!result && !result.summary.includes("未写执行摘要"), result?.summary);

const events = existsSync(join(nodeDir, "events.jsonl"))
  ? readFileSync(join(nodeDir, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
  : [];
const adEnds = events.filter((e) => e.kind === "tool_execution" && e.data?.tool === "agent_desktop" && e.data?.phase === "end");
check("events.jsonl has agent_desktop tool_execution end", adEnds.length > 0);
check("agent_desktop end without is_error", adEnds.some((e) => !e.data?.is_error),
  adEnds.map((e) => `is_error=${e.data?.is_error}`).join(","));
check("events.jsonl has ev_done call", events.some((e) => e.kind === "tool_execution" && e.data?.tool === "ev_done"));

// spill 产物：artifacts/ad-*.txt 应含可解析 JSON（list-apps → {ok:true, data:{apps:[...]}}）
const artDir = join(nodeDir, "artifacts");
const adFiles = existsSync(artDir) ? readdirSync(artDir).filter((f) => f.startsWith("ad-") && f.endsWith(".txt")) : [];
check("artifacts/ has ad-* spill file", adFiles.length > 0, adFiles.join(","));
let appCount = -1;
for (const f of adFiles) {
  try {
    const json = JSON.parse(readFileSync(join(artDir, f), "utf8").trim());
    if (Array.isArray(json?.data?.apps)) { appCount = json.data.apps.length; break; }
  } catch { /* 试下一个 */ }
}
check("spill artifact parses as list-apps JSON with data.apps", appCount >= 0, `apps=${appCount}`);

const chk = ar(["check", "--run", rootId]);
check("ar check reports done", chk.data?.nodes?.some((n) => n.status === "done"), JSON.stringify(chk.data?.nodes));

log(failures === 0 ? `SMOKE PASS  run=${rootId}` : `SMOKE FAIL (${failures})  run=${rootId}  nodeDir=${nodeDir}`);
process.exit(failures === 0 ? 0 : 1);

#!/usr/bin/env node
// smoke-gate：S4 审批门 + S8 loop guard 端到端验收（真实 pi worker）
//   T1 spec.approve=["bash"]：每条 bash 产 gate-req；先答 deny+feedback → worker 续跑；再答 allow_session → grants.json 生效不再问
//   T2 spec.deny_paths=["secrets"]：args 命中直接 block，全程无 gate-req
//   T3 同 bash 连续 ≥5 次：第 5 次 block + events 记 loop
// 用法：AICA_STATE=<state> node scripts/smoke-gate.mjs [--timeout-ms 480000]
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(REPO, "src", "cli.ts");
const STATE = process.env.AICA_STATE || join(process.env.LOCALAPPDATA, "aica", "state");
const RUNS = join(STATE, "runs");
const MODEL = process.env.AICA_GATE_MODEL || "opencode-pool/deepseek-v4.1-flash-jailbreak";
const TIMEOUT = Number(process.argv[process.argv.indexOf("--timeout-ms") + 1] || 480_000);

let failures = 0;
const log = (s) => process.stdout.write(s + "\n");
const check = (name, cond, detail = "") => {
  log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = (f) => (existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null);
const readEvents = (dir) =>
  existsSync(join(dir, "events.jsonl"))
    ? readFileSync(join(dir, "events.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];

function ar(args) {
  return JSON.parse(execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: process.env }));
}

/** 起一个 daemon --once 后台进程；返回 {proc, out} 供等待 */
function startDaemon() {
  const proc = spawn(process.execPath, [CLI, "daemon", "--once", "--timeout-ms", String(TIMEOUT)],
    { env: process.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const h = { proc, out: "" };
  proc.stdout.on("data", (c) => (h.out += c));
  proc.stderr.on("data", (c) => (h.out += c));
  return h;
}
const waitProc = (proc) => new Promise((res) => proc.on("exit", res));

/** gate-req 应答器：gate-req.json 出现 → 按 policy(req, seq) 写 gate-ans.json；返回 {reqs, stop} */
function answerer(dir, policy) {
  const h = { reqs: [], stop: false };
  const tick = async () => {
    while (!h.stop) {
      const req = readJson(join(dir, "gate-req.json"));
      if (req) {
        h.reqs.push(req);
        const ans = policy(req, h.reqs.length);
        writeFileSync(join(dir, "gate-ans.json"), JSON.stringify({ ...ans, ts: new Date().toISOString() }));
        // 等 gate.ts 消费完再盯下一条
        for (let i = 0; i < 120 && existsSync(join(dir, "gate-req.json")); i++) await sleep(500);
      }
      await sleep(300);
    }
  };
  tick();
  return h;
}

/** 建 run + 节点，跑 daemon --once 到退出 */
async function runNode(subject, nodeArgs, { policy } = {}) {
  const { data: { root_id: rootId } } = ar(["run-create", "--subject", subject]);
  ar(["node-create", "--run", rootId, "--path", "root", "--model", MODEL, ...nodeArgs]);
  const dir = join(RUNS, rootId, "nodes", "root");
  const ans = policy ? answerer(dir, policy) : null;
  const d = startDaemon();
  const code = await waitProc(d.proc);
  if (ans) ans.stop = true;
  const result = readJson(join(dir, "result.json"));
  return { rootId, dir, code, dOut: d.out, reqs: ans?.reqs ?? [], result, events: readEvents(dir) };
}

log(`smoke-gate  state=${STATE}  model=${MODEL}`);
mkdirSync(RUNS, { recursive: true });

// ---------- T1：approve 门（deny+feedback 续跑 → allow_session 记 grants） ----------
{
  log("\n== T1 approve=['bash'] deny-feedback → allow_session ==");
  const goal =
    "Run these two bash commands, one bash call each, in order: `echo GA1` then `echo GA2`. " +
    "If a call is blocked with feedback, follow the feedback and keep going. " +
    "Then call ev_done with a one-line summary.";
  const r = await runNode("smoke-gate-t1", ["--goal", goal, "--approve", "bash"], {
    policy: (_req, seq) => (seq === 1 ? { decision: "deny", feedback: "别删" } : { decision: "allow_session" }),
  });
  check("T1 ≥2 gate-req produced", r.reqs.length >= 2, `reqs=${r.reqs.length}`);
  check("T1 req has callId/tool/targets", !!r.reqs[0]?.callId && r.reqs[0]?.tool === "bash" && Array.isArray(r.reqs[0]?.targets),
    JSON.stringify(r.reqs[0] ?? {}).slice(0, 160));
  check("T1 approve_ask event", r.events.some((e) => e.kind === "approve_ask"));
  check("T1 approve_decide deny+allow_session events",
    r.events.some((e) => e.kind === "approve_decide" && e.data?.decision === "deny") &&
    r.events.some((e) => e.kind === "approve_decide" && e.data?.decision === "allow_session"));
  check("T1 grants.json contains bash (allow_session)", (readJson(join(r.dir, "grants.json"))?.tools ?? []).includes("bash"));
  check("T1 worker continued after deny and finished", !!r.result && r.result.status !== "spec", `status=${r.result?.status} ${r.result?.summary ?? ""}`);
  check("T1 daemon exited 0", r.code === 0, `code=${r.code} ${r.dOut.slice(-200)}`);
}

// ---------- T2：deny_paths 直拒（无 gate-req） ----------
{
  log("\n== T2 deny_paths=['secrets'] ==");
  const goal =
    "Use your bash tool to run exactly: `type C:\\secrets\\token.txt`. " +
    "If the call is blocked, do not retry it — call ev_done and put the block reason in the summary.";
  const r = await runNode("smoke-gate-t2", ["--goal", goal, "--approve", "bash", "--deny-paths", "secrets"], {
    policy: () => ({ decision: "deny", feedback: "should never be asked" }),   // 不该出现 req；出现也拒掉防挂起
  });
  check("T2 no gate-req ever produced (deny_paths 不弹审批)", r.reqs.length === 0, `reqs=${r.reqs.length}`);
  check("T2 gate_deny event", r.events.some((e) => e.kind === "gate_deny"));
  check("T2 block reached model (tool_execution error w/ 'denied by spec' or in summary)",
    r.events.some((e) => e.kind === "tool_execution" && e.data?.isError && String(e.data?.result).includes("denied by spec")) ||
    String(r.result?.summary ?? "").includes("denied by spec"),
    `summary=${r.result?.summary ?? ""}`);
  check("T2 result written", !!r.result, `status=${r.result?.status}`);
}

// ---------- T3：loop guard（同 bash 连 5 次 → 第 5 次 block + loop event） ----------
{
  log("\n== T3 loop guard ==");
  const goal =
    "Call the bash tool with the exact same command `echo LOOPMARK` 8 times in a row, one bash call each, do not change the command. " +
    "If a call is ever blocked, stop immediately and call ev_done describing the block reason in the summary.";
  const r = await runNode("smoke-gate-t3", ["--goal", goal]);
  const loopEv = r.events.filter((e) => e.kind === "loop");
  check("T3 loop event recorded (warn at n=5)", loopEv.some((e) => e.data?.n >= 5), JSON.stringify(loopEv).slice(0, 200));
  check("T3 loop.json written with n>=5", (readJson(join(r.dir, "loop.json"))?.n ?? 0) >= 5,
    JSON.stringify(readJson(join(r.dir, "loop.json"))));
  check("T3 worker stopped looping and wrote result", !!r.result, `status=${r.result?.status} ${r.result?.summary ?? ""}`);
}

log(failures === 0 ? "\nSMOKE-GATE PASS" : `\nSMOKE-GATE FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);

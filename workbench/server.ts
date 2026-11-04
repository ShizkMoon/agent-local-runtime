// aica workbench · v0 桥接服务器
// 桥：把 %LOCALAPPDATA%\aica\state\runs\ 的文件态暴露成 JSON API + SSE，
// 静态托管 public/；POST /api/tasks 经 `ar dispatch` 建 run 并确保常驻 daemon。
// 无依赖（node:http + node:fs + node:child_process），供 Edge --app 壳使用；
// 接口面保持稳定，日后 Tauri 壳只换窗口层、不动此桥。
import { createServer } from "node:http";
import { existsSync, readdirSync, readFileSync, statSync, watch, appendFileSync, mkdirSync, openSync, rmSync, writeFileSync, renameSync } from "node:fs";
import { join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
// S16：视图投影住在 view.ts（纯函数，runsDir 由参数传入）；本文件只做 HTTP 胶水
import { buildView, okId, badSeg, readJson, safeJoinIn, nodePaths, nodeStatus, evHint, runPulse } from "./view.ts";
// S19：审批决策闭集由 gate.ts 持有（唯一真相），桥只做校验与落盘
import { GATE_DECISIONS } from "../aica-pi/extensions/gate.ts";
// S21：事件增量读与 fork 复用 runs.ts 的唯一实现（seq 语义只在一处定义）
import { readEventsSince, forkNode } from "../src/runs.ts";

const PORT = Number(process.env.WB_PORT ?? 4399);
const HOST = "127.0.0.1";
// resolve 成绝对路径：相对 AICA_STATE 会被经 ar 桥拉起的 worker 在各自 cwd 下再解析
const STATE = resolve(process.env.AICA_STATE ?? join(process.env.LOCALAPPDATA!, "aica", "state"));
const RUNS = join(STATE, "runs");
const PUB = fileURLToPath(new URL("./public/", import.meta.url));
const AR_CLI = process.env.AR_CLI ?? fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const ART_CAP = 512 * 1024; // artifact 读取上限
const EVT_CAP = 2000;       // events 单次返回上限

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".map": "application/json",
};

function json(res: any, code: number, data: unknown): void {
  const body = JSON.stringify(data, null, 1);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
}
function err(res: any, code: number, msg: string): void { json(res, code, { error: msg }); }
// 路径安全：拒绝 .. 与绝对路径注入；返回 RUNS 内 resolved 路径或 null（实现见 view.ts）
function safeJoin(...parts: string[]): string | null { return safeJoinIn(RUNS, ...parts); }
// ---- API handlers ----
function apiRuns(res: any): void {
  if (!existsSync(RUNS)) return json(res, 200, { runs: [] });
  const runs = readdirSync(RUNS, { withFileTypes: true })
    .filter(d => d.isDirectory() && okId(d.name))
    .map(d => {
      const meta = readJson<any>(join(RUNS!, d.name, "run.json"));
      const paths = nodePaths(RUNS, d.name);
      const counts: Record<string, number> = {};
      for (const p of paths) counts[nodeStatus(RUNS, d.name, p).status] = (counts[nodeStatus(RUNS, d.name, p).status] ?? 0) + 1;
      const rollup = counts.failed ? "failed" : counts.blocked ? "blocked" : (counts.running || counts.empty || !paths.length) ? "running" : "done";
      const pulse = runPulse(RUNS, d.name, paths);
      return { root_id: d.name, created_at: meta?.created_at ?? null, kind: meta?.kind ?? null,
               subject: meta?.subject ?? null, plan_version: meta?.plan_version ?? null,
               nodes: paths.length, counts, status: rollup,
               last: pulse.last, ended_at: pulse.ended_at };
    })
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  json(res, 200, { runs });
}

function apiTree(res: any, rootId: string): void {
  if (!safeJoin(rootId) || !existsSync(join(RUNS, rootId))) return err(res, 404, "run not found");
  const meta = readJson<any>(join(RUNS, rootId, "run.json"));
  const nodes = nodePaths(RUNS, rootId).map(path => {
    const dir = safeJoin(rootId, "nodes", ...path.split("/"))!;
    const spec = readJson<any>(join(dir, "spec.json"));
    const r = readJson<any>(join(dir, "result.json"));
    const st = nodeStatus(RUNS, rootId, path);
    // spec.parent 形如 node:<root>/<path> → 取末段做父路径
    const parent = typeof spec?.parent === "string" && spec.parent.includes("/") ? spec.parent.split("/").pop() : (spec?.parent ?? null);
    const usage = readJson<any>(join(dir, "usage.json"));
    return { path, goal: spec?.goal ?? null, agent: spec?.agent ?? "pi", type: spec?.type ?? null,
             parent, status: st.status, summary: st.summary ?? null, finished_at: st.finished_at ?? null,
             spent: r?.spent ?? (usage?.tokens ? { tokens: usage.tokens } : null),
             events: existsSync(join(dir, "events.jsonl")) ? statSync(join(dir, "events.jsonl")).size : 0 };
  });
  json(res, 200, { meta, nodes });
}

function apiNode(res: any, rootId: string, path: string): void {
  const dir = safeJoin(rootId, "nodes", ...path.split("/"));
  if (!dir || !existsSync(dir)) return err(res, 404, "node not found");
  const artDir = join(dir, "artifacts");
  const artifacts = existsSync(artDir)
    ? readdirSync(artDir, { withFileTypes: true }).filter(d => d.isFile())
        .map(d => ({ name: d.name, size: statSync(join(artDir, d.name)).size }))
    : [];
  const evFile = join(dir, "events.jsonl");
  const st = nodeStatus(RUNS, rootId, path);
  const spec = readJson<any>(join(dir, "spec.json"));
  json(res, 200, {
    path, status: st.status, spec, result: readJson(join(dir, "result.json")),
    artifacts, has_reply: existsSync(join(dir, "reply.txt")) || (Array.isArray(spec?.reply) && spec.reply.length > 0),
    events_bytes: existsSync(evFile) ? statSync(evFile).size : 0,
  });
}

function apiEvents(res: any, rootId: string, path: string, q: URLSearchParams): void {
  const dir = safeJoin(rootId, "nodes", ...path.split("/"));
  if (!dir || !existsSync(dir)) return err(res, 404, "node not found");
  const since = Math.max(0, Number(q.get("since") ?? 0) || 0);
  const tail = Math.max(0, Number(q.get("tail") ?? 0) || 0);
  // S21：since 是 seq 游标（有 seq 的文件）；纯老文件自动退回行号语义（mode:"index"）保持兼容。
  // worker 直写的事件没有 seq → seq 模式下列不出来，用 unsequenced 计数如实告知（不假装没丢）。
  const r = readEventsSince(rootId, path, since);
  let events = r.events;
  if (tail && since === 0 && events.length > tail) events = events.slice(-tail);
  let next = r.next;
  if (events.length > EVT_CAP) {
    events = events.slice(0, EVT_CAP);
    const last = events[events.length - 1];
    next = r.mode === "seq" ? (last.seq ?? next) : last.i + 1;   // 截断时 next 只承诺"已发完的部分"
  }
  json(res, 200, { events, next, total: r.total, mode: r.mode, unsequenced: r.unsequenced });
}

// ---- S21：fork —— 把一个节点复制成新 run（spec 保留、result/events 清空、forked_from 记来源）----
function apiFork(res: any, rootId: string, path: string): void {
  const dir = safeJoin(rootId, "nodes", ...path.split("/"));
  if (!dir || !existsSync(dir)) return err(res, 404, "node not found");
  const forked = forkNode(rootId, path);
  if (!forked) return err(res, 409, "fork failed：节点没有 spec.json");
  json(res, 200, forked);
}

function apiArtifact(res: any, rootId: string, path: string, name: string): void {  if (badSeg(name) || name.includes("/")) return err(res, 400, "bad artifact name");
  const file = safeJoin(rootId, "nodes", ...path.split("/"), "artifacts", name);
  if (!file || !existsSync(file)) return err(res, 404, "artifact not found");
  const size = statSync(file).size;
  if (size > ART_CAP) {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    return res.end(readFileSync(file).subarray(0, ART_CAP).toString("utf8") + `\n…[truncated ${size - ART_CAP} bytes]`);
  }
  res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
  res.end(readFileSync(file));
}

// ---- /api/v1/view：workbench 视图投影（run 卡片 + 树 + 收件箱 inbox + 已完结 settled）----
// S16：投影本体在 view.ts::buildView（纯函数，runsDir 由参数传入，时间可注入）——
// 本函数只剩 HTTP 胶水，改投影只动 view.ts，不动路由。
function apiView(res: any): void {
  json(res, 200, buildView(RUNS));
}

// ---- ar CLI 桥：dispatch / reply / daemon ----
// ar 路径：node <AR_CLI> <cmd>；env 显式给已解析的 AICA_STATE（空串会让 runs.ts 落相对路径）
let daemonProc: ChildProcess | null = null;
let daemonCache = { at: 0, running: false };

function arEnv(): NodeJS.ProcessEnv { return { ...process.env, AICA_STATE: STATE }; }

/** 本 STATE 的常驻 daemon 是否在跑：以 daemon 自己写的 STATE/daemon.pid 心跳为准
    （进程名匹配会把别的 AICA_STATE 的 daemon 误认成本地的） */
function daemonRunning(): boolean {
  if (Date.now() - daemonCache.at < 3000) return daemonCache.running;
  let running = false;
  try {
    const [pid, ts] = readFileSync(join(STATE, "daemon.pid"), "utf8").trim().split(/\s+/).map(Number);
    if (pid > 0 && Date.now() - ts < 15_000) {
      try { process.kill(pid, 0); running = true; } catch { /* 进程没了或跨用户 */ }
    }
  } catch { /* 无 pidfile */ }
  if (!running) running = daemonProc != null && daemonProc.exitCode === null;
  daemonCache = { at: Date.now(), running };
  return running;
}

/** 确保常驻 daemon 在跑（消费派发意图）；已跑则不动，未跑则 detached 拉起，日志落 STATE/daemon.log */
function ensureDaemon(): boolean {
  if (daemonRunning()) return true;
  try {
    mkdirSync(STATE, { recursive: true });
    const logFd = openSync(join(STATE, "daemon.log"), "a");
    daemonProc = spawn(process.execPath, [AR_CLI, "daemon"], {
      detached: true, stdio: ["ignore", logFd, logFd], windowsHide: true, env: arEnv(),
    });
    daemonProc.unref();
    daemonProc.on("exit", () => { daemonProc = null; });
    daemonCache = { at: Date.now(), running: true };
    return true;
  } catch { return false; }
}

function apiDeleteRun(res: any, rootId: string): void {
  const dir = safeJoin(rootId);
  if (!dir || !existsSync(dir)) return err(res, 404, "run not found");
  // 先 abort live worker：删目录后孤儿进程仍在写盘/占 session
  for (const p of nodePaths(RUNS, rootId)) {
    if (existsSync(join(dir, "nodes", ...p.split("/"), "worker.json"))) {
      try {
        execFileSync(process.execPath, [AR_CLI, "abort", "--run", rootId, "--node", p],
          { env: arEnv(), timeout: 20_000, windowsHide: true });
      } catch { /* 尽力 abort，删除照常 */ }
    }
  }
  try { rmSync(dir, { recursive: true, force: true }); } catch (e) { return err(res, 500, String(e)); }
  json(res, 200, { ok: true });
}

function apiDaemon(res: any): void {
  json(res, 200, { running: daemonRunning(), cli: AR_CLI, spawned: daemonProc?.pid ?? null });
}

/** POST /api/tasks {goal,...} → `ar dispatch`（stdin 收任务 JSON，内部 createRun+写根 spec）→ 确保 daemon */
function apiTask(req: any, res: any): void {
  let body = "";
  req.on("data", (c: Buffer) => { body += c; if (body.length > 256 * 1024) req.destroy(); });
  req.on("end", () => {
    let task: any;
    try { task = JSON.parse(body || "{}"); } catch (e) { return err(res, 400, String(e)); }
    const goal = String(task?.goal ?? "").trim();
    if (!goal) return err(res, 400, "goal required");
    // 权限档位 → 工具面（别透传中文字符串：spec.tools 是数组，字符串会被 spread 成字符）
    const TOOL_SETS: Record<string, string[] | undefined> = {
      "标准": undefined,                                                            // 走 daemon 默认执行面
      "受限": ["read", "ls", "find", "grep"],                                       // 只读
      "开放": ["read", "write", "edit", "bash", "powershell", "ls", "find", "grep",
             "agent-desktop", "ego-browser", "kn_recall", "ar_read", "ar_dispatch"],
    };
    const tools = TOOL_SETS[String(task.tools ?? "标准")];
    const payload = JSON.stringify({
      subject: goal, to: task.to ?? "agent:local", kind: task.kind ?? "task",
      agent: task.agent ?? "pi", ...(task.profile ? { profile: task.profile } : {}),
      ...(task.model ? { model: task.model } : {}), ...(tools ? { tools } : {}),
      ...(task.accept ? { accept: task.accept } : {}), ev_id: `wb-${Date.now().toString(36)}`,
    });
    const child = execFile(process.execPath, [AR_CLI, "dispatch"],
      { env: arEnv(), timeout: 20_000, windowsHide: true, maxBuffer: 1024 * 1024 },
      (e, stdout, stderr) => {
        if (e) return err(res, 500, `ar dispatch: ${String(stderr || e.message || e).slice(0, 400)}`);
        let env1: any;
        try { env1 = JSON.parse(stdout.trim().split("\n").pop()!); }
        catch { return err(res, 500, "bad ar dispatch output"); }
        if (!env1?.ok) return err(res, 500, JSON.stringify(env1?.error ?? env1));
        json(res, 200, { root_id: env1.data.root_id, node: env1.data.node, daemon: ensureDaemon() });
      });
    child.stdin!.end(payload);
  });
}

function apiReply(req: any, res: any, rootId: string, path: string): void {
  const dir = safeJoin(rootId, "nodes", ...path.split("/"));
  if (!dir || !existsSync(dir)) return err(res, 404, "node not found");
  let body = "";
  req.on("data", (c: Buffer) => { body += c; if (body.length > 64 * 1024) req.destroy(); });
  req.on("end", () => {
    try {
      const { text } = JSON.parse(body || "{}");
      if (typeof text !== "string" || !text.trim()) return err(res, 400, "text required");
      // S19 / M4：有未答 gate 时，回复 = 拒绝 + 说明原因（写 gate-ans，不是新消息，也不调 ar reply）
      const pend = pendingApproval(dir);
      if (pend) {
        const w = writeAnswer(dir, { decision: "rejected", feedback: text.trim() });
        if (w.ok) return json(res, 200, { ok: true, mode: "gate", decision: "rejected", gate: pend.call_id ?? null });
        return err(res, 500, w.error ?? "gate answer failed");
      }
      const mark = () => appendFileSync(join(dir, "reply.txt"),
        JSON.stringify({ ts: new Date().toISOString(), text }) + "\n", "utf8");
      // 首选 ar reply（注入 spec.reply，worker 上下文可见）；失败回退写 reply.txt 文件标记
      execFile(process.execPath, [AR_CLI, "reply", "--run", rootId, "--node", path, "--text", text.trim()],
        { env: arEnv(), timeout: 10_000, windowsHide: true, maxBuffer: 512 * 1024 },
        (e, _stdout, stderr) => {
          if (e) {
            try { mark(); return json(res, 200, { ok: true, mode: "file", warn: String(stderr || e).slice(0, 300) }); }
            catch (e2) { return err(res, 500, String(e2)); }
          }
          try { mark(); } catch { /* 标记失败不阻塞 */ }
          ensureDaemon(); // 待拉起节点若因回复而满足条件，保证有消费者
          json(res, 200, { ok: true, mode: "ar" });
        });
    } catch (e) { err(res, 400, String(e)); }
  });
}

// ---- S19 审批桥：gate-req.json（gate 写的卡，含服务端生成的 opts）→ gate-ans.json（闭集决策） ----
const APPROVAL_REQ = "gate-req.json";
const APPROVAL_ANS = "gate-ans.json";
const APPROVAL_TTL_MS = 10 * 60_000;   // 超过按失效过滤：worker 被 kill 时 gate 来不及清 req

interface ApprovalRemember { tool: string; tier: string; target: string }
interface ApprovalOpt { label: string; decision: string; scope?: ApprovalRemember | null; hint?: string }
interface ApprovalReq {
  v?: number; call_id?: string; tool?: string; tier?: string; target?: string;
  restricted?: boolean; rememberable?: boolean; reason?: string; hit?: string;
  args?: unknown; targets?: string[]; opts?: ApprovalOpt[]; asked_at?: string;
}

/** 读未答的 gate-req：文件在、未超过 TTL、且没有「比 req 更新」的 gate-ans（旧 ans 是上一轮的残答） */
function pendingApproval(dir: string): { req: ApprovalReq; age_ms: number } | null {
  const file = join(dir, APPROVAL_REQ);
  if (!existsSync(file)) return null;
  let reqMs = 0;
  try { reqMs = statSync(file).mtimeMs; } catch { return null; }
  const ans = join(dir, APPROVAL_ANS);
  if (existsSync(ans)) {
    try { if (statSync(ans).mtimeMs >= reqMs) return null; } catch { /* ans 刚被清：当未答 */ }
  }
  const age = Date.now() - reqMs;
  if (age > APPROVAL_TTL_MS) return null;
  const req = readJson<ApprovalReq>(file);
  return req && typeof req === "object" ? { req, age_ms: Math.max(0, Math.round(age)) } : null;
}

/** 写 gate-ans：decision 必须落闭集；remember 只认 gate 在 req.opts 里给过的 scope（opts[].scope，前端伪造无效） */
function writeAnswer(dir: string, body: any): { ok: boolean; code?: number; error?: string; decision?: string; remember?: ApprovalRemember | null } {
  const decision = String(body?.decision ?? "");
  if (!(GATE_DECISIONS as readonly string[]).includes(decision)) {
    return { ok: false, code: 400, error: `decision 必须是闭集之一：${GATE_DECISIONS.join(" | ")}` };
  }
  const pend = pendingApproval(dir);
  if (!pend) return { ok: false, code: 404, error: "没有待答的 gate-req（已答或已超时）" };
  const ans: any = { decision, by: "workbench", at: new Date().toISOString() };
  const feedback = typeof body?.feedback === "string" ? body.feedback.trim().slice(0, 2000) : "";
  if (feedback) ans.feedback = feedback;
  const rem = body?.remember;
  if (decision === "allowed-once" && rem && typeof rem === "object") {
    const hit = (pend.req.opts ?? []).find(o => o?.scope
      && o.scope.tool === rem.tool && o.scope.tier === rem.tier && o.scope.target === rem.target);
    if (hit?.scope) ans.remember = { tool: hit.scope.tool, tier: hit.scope.tier, target: hit.scope.target };
  }
  try {
    const file = join(dir, APPROVAL_ANS);
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(ans, null, 2) + "\n", "utf8");
    renameSync(tmp, file);   // 原子替换：gate 每 500ms 读一次，不能读到半截 JSON
  } catch (e) { return { ok: false, code: 500, error: String(e) }; }
  return { ok: true, decision, remember: ans.remember ?? null };
}

/** GET /api/approvals：所有 run 的未答审批卡（gate 生成的内容原样透出，前端只渲染） */
function apiApprovals(res: any): void {
  const approvals: any[] = [];
  if (existsSync(RUNS)) {
    for (const ent of readdirSync(RUNS, { withFileTypes: true })) {
      if (!ent.isDirectory() || !okId(ent.name)) continue;
      for (const p of nodePaths(RUNS, ent.name)) {
        const dir = safeJoin(ent.name, "nodes", ...p.split("/"));
        if (!dir) continue;
        const pend = pendingApproval(dir);
        if (!pend) continue;
        const r = pend.req;
        approvals.push({
          id: `ap:${ent.name}/${p}:${String(r.call_id ?? "")}`,
          run: ent.name, path: p,
          call_id: r.call_id ?? null, tool: r.tool ?? null, tier: r.tier ?? null, target: r.target ?? null,
          restricted: !!r.restricted, reason: r.reason ?? "", args: r.args ?? null, targets: r.targets ?? [],
          opts: Array.isArray(r.opts) ? r.opts : [], asked_at: r.asked_at ?? null, age_ms: pend.age_ms,
        });
      }
    }
  }
  approvals.sort((a, b) => (b.age_ms ?? 0) - (a.age_ms ?? 0));
  json(res, 200, { approvals, count: approvals.length });
}

/** POST .../approve {decision, feedback?, remember?} —— 对应卡上由 gate 生成的 opts */
function apiApprove(req: any, res: any, rootId: string, path: string): void {
  const dir = safeJoin(rootId, "nodes", ...path.split("/"));
  if (!dir || !existsSync(dir)) return err(res, 404, "node not found");
  let body = "";
  req.on("data", (c: Buffer) => { body += c; if (body.length > 32 * 1024) req.destroy(); });
  req.on("end", () => {
    let payload: any;
    try { payload = JSON.parse(body || "{}"); } catch (e) { return err(res, 400, String(e)); }
    const w = writeAnswer(dir, payload);
    if (!w.ok) return err(res, w.code ?? 500, w.error ?? "approve failed");
    json(res, 200, { ok: true, decision: w.decision, remember: w.remember ?? null });
  });
}

/** GET .../transcript：events.jsonl 全量 → 轻量 transcript [{type:"msg"|"tool"|"event", ts, text/tool, data}] */
function apiTranscript(res: any, rootId: string, path: string): void {
  const dir = safeJoin(rootId, "nodes", ...path.split("/"));
  if (!dir || !existsSync(dir)) return err(res, 404, "node not found");
  const file = join(dir, "events.jsonl");
  const lines = existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(l => l.trim()) : [];
  const transcript = lines.map(l => {
    let e: any;
    try { e = JSON.parse(l); } catch { return { type: "event", ts: null, text: l.slice(0, 200) }; }
    const k = String(e.kind ?? ""), d = e.data ?? {};
    if (k === "message" || k === "agent_message" || k === "message_end") {
      return { type: "msg", ts: e.ts ?? null, text: String(d.text ?? evHint(e)).slice(0, 2000) };
    }
    if (k === "tool_call" || k === "tool_execution" || k === "tool_update") {
      return { type: "tool", ts: e.ts ?? null, tool: String(d.tool ?? "?"),
               data: { args: d.args, result: d.result, isError: d.isError, durationMs: d.durationMs, call_id: d.call_id } };
    }
    return { type: "event", ts: e.ts ?? null, kind: k || "event", text: evHint(e), data: d };
  });
  json(res, 200, { transcript, total: transcript.length });
}

/** POST .../retry：删 result.json + result.resolved.json（+残留 gate.json）→ 节点回 pending，session/ 保留即全史重拉 */
function apiRetry(res: any, rootId: string, path: string): void {
  const dir = safeJoin(rootId, "nodes", ...path.split("/"));
  if (!dir || !existsSync(dir) || !existsSync(join(dir, "spec.json"))) return err(res, 404, "node not found");
  if (existsSync(join(dir, "worker.json"))) return err(res, 409, "node still running (abort first)");
  for (const f of ["result.json", "result.resolved.json", "gate.json"]) {
    try { rmSync(join(dir, f), { force: true }); } catch { /* 已不存在 */ }
  }
  try {
    appendFileSync(join(dir, "events.jsonl"),
      JSON.stringify({ ts: new Date().toISOString(), kind: "retry", data: { by: "workbench" } }) + "\n", "utf8");
  } catch { /* 记账失败不阻塞 */ }
  json(res, 200, { ok: true, daemon: ensureDaemon() });
}

/** POST .../abort → `ar abort`（读 worker.json → taskkill /T /F 进程树 → 幂等 failed("aborted by user") + abort 事件） */
function apiAbort(res: any, rootId: string, path: string): void {
  const dir = safeJoin(rootId, "nodes", ...path.split("/"));
  if (!dir || !existsSync(dir)) return err(res, 404, "node not found");
  execFile(process.execPath, [AR_CLI, "abort", "--run", rootId, "--node", path],
    { env: arEnv(), timeout: 20_000, windowsHide: true, maxBuffer: 512 * 1024 },
    (e, stdout, stderr) => {
      if (e) return err(res, 500, `ar abort: ${String(stderr || e.message || e).slice(0, 300)}`);
      let env1: any = null;
      try { env1 = JSON.parse(String(stdout).trim().split("\n").pop()!); } catch { /* 非 JSON 输出按成功兜底 */ }
      if (env1 && env1.ok === false) return err(res, 500, JSON.stringify(env1.error ?? env1));
      json(res, 200, { ok: true, ...(env1?.data ?? {}) });
    });
}

// ---- SSE：runs/ 文件变化推送 ----
const sseClients = new Set<any>();
let debounce: NodeJS.Timeout | null = null;
let pending: string[] = [];
try {
  mkdirSync(RUNS, { recursive: true });
  watch(RUNS, { recursive: true }, (_ev, file) => {
    if (file) pending.push(file.replaceAll(sep, "/"));
    if (debounce) return;
    debounce = setTimeout(() => {
      const files = [...new Set(pending)].slice(0, 20); pending = []; debounce = null;
      const msg = `data: ${JSON.stringify({ type: "change", files })}\n\n`;
      for (const c of sseClients) { try { c.write(msg); } catch { sseClients.delete(c); } }
    }, 200);
  });
} catch { /* runs/ 不可watch时前端可回退轮询 */ }
setInterval(() => {
  for (const c of sseClients) { try { c.write(": hb\n\n"); } catch { sseClients.delete(c); } }
}, 25000).unref();

function apiStream(_req: any, res: any): void {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  res.write(`data: ${JSON.stringify({ type: "hello", runs: RUNS })}\n\n`);
  sseClients.add(res);
  res.on("close", () => sseClients.delete(res));
}

// ---- router ----
const R = {
  node: /^\/api\/runs\/([^/]+)\/node\/(.+)\/events$/,
  art: /^\/api\/runs\/([^/]+)\/node\/(.+)\/artifact\/([^/]+)$/,
  reply: /^\/api\/runs\/([^/]+)\/node\/(.+)\/reply$/,
  approve: /^\/api\/runs\/([^/]+)\/node\/(.+)\/approve$/,
  abort: /^\/api\/runs\/([^/]+)\/node\/(.+)\/abort$/,
  transcript: /^\/api\/runs\/([^/]+)\/node\/(.+)\/transcript$/,
  retry: /^\/api\/runs\/([^/]+)\/node\/(.+)\/retry$/,
  fork: /^\/api\/runs\/([^/]+)\/node\/(.+)\/fork$/,
  detail: /^\/api\/runs\/([^/]+)\/node\/(.+)$/,
  tree: /^\/api\/runs\/([^/]+)\/tree$/,
};

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${HOST}`);
  const p = decodeURIComponent(url.pathname);
  try {
    if (req.method === "GET" && p === "/api/runs") return apiRuns(res);
    if (req.method === "GET" && p === "/api/v1/view") return apiView(res);
    if (req.method === "GET" && p === "/api/stream") return apiStream(req, res);
    if (req.method === "GET" && p === "/api/daemon") return apiDaemon(res);
    if (req.method === "GET" && p === "/api/approvals") return apiApprovals(res);
    if (req.method === "POST" && p === "/api/tasks") return apiTask(req, res);
    if (req.method === "DELETE" && p.match(/^\/api\/runs\/([^/]+)$/)) {
      const id = p.match(/^\/api\/runs\/([^/]+)$/)![1];
      if (!okId(id)) return err(res, 400, "bad id");
      return apiDeleteRun(res, id);
    }
    let m: RegExpMatchArray | null;
    if (req.method === "GET" && (m = p.match(R.tree))) {
      if (!okId(m[1])) return err(res, 400, "bad id");
      return apiTree(res, m[1]);
    }
    if ((m = p.match(R.node))) {
      const [, id, np] = m;
      if (!okId(id) || np.split("/").some(badSeg)) return err(res, 400, "bad path");
      return req.method === "GET" ? apiEvents(res, id, np, url.searchParams) : err(res, 405, "GET only");
    }
    if (req.method === "GET" && (m = p.match(R.art))) {
      const [, id, np, name] = m;
      if (!okId(id) || np.split("/").some(badSeg)) return err(res, 400, "bad path");
      return apiArtifact(res, id, np, name);
    }
    if (req.method === "POST" && (m = p.match(R.reply))) {
      const [, id, np] = m;
      if (!okId(id) || np.split("/").some(badSeg)) return err(res, 400, "bad path");
      return apiReply(req, res, id, np);
    }
    if (req.method === "POST" && (m = p.match(R.approve))) {
      const [, id, np] = m;
      if (!okId(id) || np.split("/").some(badSeg)) return err(res, 400, "bad path");
      return apiApprove(req, res, id, np);
    }
    if (req.method === "POST" && (m = p.match(R.fork))) {
      const [, id, np] = m;
      if (!okId(id) || np.split("/").some(badSeg)) return err(res, 400, "bad path");
      return apiFork(res, id, np);
    }
    if (req.method === "GET" && (m = p.match(R.transcript))) {
      const [, id, np] = m;
      if (!okId(id) || np.split("/").some(badSeg)) return err(res, 400, "bad path");
      return apiTranscript(res, id, np);
    }
    if (req.method === "POST" && (m = p.match(R.abort))) {
      const [, id, np] = m;
      if (!okId(id) || np.split("/").some(badSeg)) return err(res, 400, "bad path");
      return apiAbort(res, id, np);
    }
    if (req.method === "POST" && (m = p.match(R.retry))) {
      const [, id, np] = m;
      if (!okId(id) || np.split("/").some(badSeg)) return err(res, 400, "bad path");
      return apiRetry(res, id, np);
    }
    if (req.method === "GET" && (m = p.match(R.detail))) {
      const [, id, np] = m;
      if (!okId(id) || np.split("/").some(badSeg)) return err(res, 400, "bad path");
      return apiNode(res, id, np);
    }
    if (p.startsWith("/api/")) return err(res, 404, "not found");
    // statics
    if (req.method !== "GET") return err(res, 405, "GET only");
    const rel = p === "/" ? "index.html" : p.slice(1);
    const file = normalize(join(PUB, rel));
    if (!file.startsWith(normalize(PUB)) || !existsSync(file) || !statSync(file).isFile()) return err(res, 404, "not found");
    const ext = file.slice(file.lastIndexOf("."));
    res.writeHead(200, { "content-type": MIME[ext] ?? "application/octet-stream" });
    res.end(readFileSync(file));
  } catch (e) { err(res, 500, String(e)); }
});

server.listen(PORT, HOST, () => console.log(`[workbench] http://${HOST}:${PORT}  runs=${RUNS}`));


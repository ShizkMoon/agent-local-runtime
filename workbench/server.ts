// aica workbench · v0 桥接服务器
// 桥：把 %LOCALAPPDATA%\aica\state\runs\ 的文件态暴露成 JSON API + SSE，
// 静态托管 public/；POST /api/tasks 经 `ar dispatch` 建 run 并确保常驻 daemon。
// 无依赖（node:http + node:fs + node:child_process），供 Edge --app 壳使用；
// 接口面保持稳定，日后 Tauri 壳只换窗口层、不动此桥。
import { createServer } from "node:http";
import { existsSync, readdirSync, readFileSync, statSync, watch, appendFileSync, mkdirSync, openSync, readSync, closeSync, rmSync } from "node:fs";
import { join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";

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
function readJson<T>(file: string): T | null {
  try { return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) as T : null; } catch { return null; }
}
// 路径安全：拒绝 .. 与绝对路径注入；返回 RUNS 内 resolved 路径或 null
function safeJoin(...parts: string[]): string | null {
  const p = normalize(join(RUNS, ...parts));
  return p.startsWith(normalize(RUNS) + sep) || p === normalize(RUNS) ? p : null;
}
const badSeg = (s: string) => !s || s.includes("..") || s.includes("\\") || /[<>:"|?*\x00-\x1f]/.test(s);
const okId = (s: string) => /^[A-Za-z0-9._-]+$/.test(s);

// 节点目录递归扫描（兼容未来 nodes/a/b 嵌套；当前 runs.ts 为扁平单层）
function nodePaths(rootId: string): string[] {
  const nodesRoot = safeJoin(rootId, "nodes");
  if (!nodesRoot || !existsSync(nodesRoot)) return [];
  const out: string[] = [];
  const walk = (dir: string, rel: string, depth: number) => {
    if (depth > 6) return;
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      if (ent.name === "artifacts") continue;
      const childRel = rel ? `${rel}/${ent.name}` : ent.name;
      const childDir = join(dir, ent.name);
      if (existsSync(join(childDir, "spec.json")) || existsSync(join(childDir, "result.json")) || existsSync(join(childDir, "events.jsonl"))) {
        out.push(childRel);
      }
      walk(childDir, childRel, depth + 1); // 节点目录内仍可能有嵌套子节点（path=root/fetch）
    }
  };
  walk(nodesRoot, "", 0);
  return out.sort();
}

function nodeStatus(rootId: string, path: string): { status: string; summary?: string; finished_at?: string } {
  const dir = safeJoin(rootId, "nodes", ...path.split("/"))!;
  const r = readJson<any>(join(dir, "result.json"));
  if (r) return { status: r.status ?? "?", summary: r.summary, finished_at: r.finished_at };
  return { status: existsSync(join(dir, "spec.json")) ? "running" : "empty" };
}

/** 读 events.jsonl 尾部 ~8KB 的最后一条可解析事件（append-only，尾行即最新） */
function tailEvent(file: string): any | null {
  try {
    const size = statSync(file).size;
    if (!size) return null;
    const fd = openSync(file, "r");
    try {
      const buf = Buffer.alloc(Math.min(size, 8192));
      readSync(fd, buf, 0, buf.length, size - buf.length);
      const lines = buf.toString("utf8").split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        const l = lines[i].trim();
        if (!l) continue;
        try { const ev = JSON.parse(l); if (ev?.ts) return ev; } catch { /* 半截首行跳过 */ }
      }
    } finally { closeSync(fd); }
  } catch { /* 读失败当无事件 */ }
  return null;
}

function evHint(ev: any): string {
  const d = ev?.data ?? {};
  if (ev?.kind === "exit") return `Worker 退出（code ${d.code ?? "?"}）${d.error ? " · " + d.error : ""}`;
  if (ev?.kind === "spawn") return "拉起 worker";
  if (ev?.kind === "gate") return String(d.question ?? "等你处理").slice(0, 80);
  const s = d.text ?? d.cmd ?? d.question ?? d.summary ?? d.args ?? d.tool ?? ev?.kind ?? "";
  return String(s).replace(/\s+/g, " ").trim().slice(0, 80);
}

/** run 级最近事件 + 全部节点最晚 finished_at（rail 预览/耗时用） */
function runPulse(rootId: string, paths: string[]): { last: any | null; ended_at: string | null } {
  let best: any = null, ended: string | null = null;
  for (const p of paths) {
    const dir = join(RUNS, rootId, "nodes", ...p.split("/"));
    const ev = tailEvent(join(dir, "events.jsonl"));
    if (ev && (!best || ev.ts > best.ts)) best = ev;
    const r = readJson<any>(join(dir, "result.json"));
    if (r?.finished_at && (!ended || r.finished_at > ended)) ended = r.finished_at;
  }
  return { last: best ? { kind: best.kind, ts: best.ts, hint: evHint(best), tool: best.data?.tool ?? null } : null, ended_at: ended };
}

// ---- API handlers ----
function apiRuns(res: any): void {
  if (!existsSync(RUNS)) return json(res, 200, { runs: [] });
  const runs = readdirSync(RUNS, { withFileTypes: true })
    .filter(d => d.isDirectory() && okId(d.name))
    .map(d => {
      const meta = readJson<any>(join(RUNS!, d.name, "run.json"));
      const paths = nodePaths(d.name);
      const counts: Record<string, number> = {};
      for (const p of paths) counts[nodeStatus(d.name, p).status] = (counts[nodeStatus(d.name, p).status] ?? 0) + 1;
      const rollup = counts.failed ? "failed" : counts.blocked ? "blocked" : (counts.running || counts.empty || !paths.length) ? "running" : "done";
      const pulse = runPulse(d.name, paths);
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
  const nodes = nodePaths(rootId).map(path => {
    const dir = safeJoin(rootId, "nodes", ...path.split("/"))!;
    const spec = readJson<any>(join(dir, "spec.json"));
    const r = readJson<any>(join(dir, "result.json"));
    const st = nodeStatus(rootId, path);
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
  const st = nodeStatus(rootId, path);
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
  const file = join(dir, "events.jsonl");
  const lines = existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(l => l.trim()) : [];
  const since = Math.max(0, Number(q.get("since") ?? 0) || 0);
  const tail = Math.max(0, Number(q.get("tail") ?? 0) || 0);
  let start = since;
  if (tail && start === 0) start = Math.max(0, lines.length - tail);
  const slice = lines.slice(start, start + EVT_CAP);
  const events = slice.map((l, i) => {
    try { return { i: start + i, ...JSON.parse(l) }; }
    catch { return { i: start + i, ts: null, kind: "_raw", data: { raw: l.slice(0, 500) } }; }
  });
  json(res, 200, { events, next: start + events.length, total: lines.length });
}

function apiArtifact(res: any, rootId: string, path: string, name: string): void {
  if (badSeg(name) || name.includes("/")) return err(res, 400, "bad artifact name");
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
const pad2 = (n: number) => String(n).padStart(2, "0");
function mmss(ms: number): string {           // "mm:ss"（分钟可超 59，与原型一致）
  const s = Math.max(0, Math.round(ms / 1000));
  return `${pad2(Math.floor(s / 60))}:${pad2(s % 60)}`;
}
function hhmm(iso: string): string {          // settled 时间戳 "HH:MM"（本地时区）
  const d = new Date(iso);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
function nodeName(rootId: string, path: string): string {   // nm：spec.goal 首行截 20 字，兜底 path 末段
  const spec = readJson<any>(join(RUNS, rootId, "nodes", ...path.split("/"), "spec.json"));
  const first = String(spec?.goal ?? "").split("\n")[0].trim();
  return (first || path.split("/").pop() || path).slice(0, 20);
}
function depDone(rootId: string, dep: string): boolean {    // depends 写兄弟 path 或完整 node:<root>/<path>
  const p = dep.startsWith(`node:${rootId}/`) ? dep.slice(`node:${rootId}/`.length) : dep;
  return readJson<any>(join(RUNS, rootId, "nodes", ...p.split("/"), "result.json"))?.status === "done";
}
// tree 的 st 映射：waiting→input（wait_on 挂起=等子节点，归 dep 不进 inbox）/ 无 result 且 dep 未满足→dep / 无 result（未拉起或跑着）→queued / blocked→dep
function viewStatus(rootId: string, spec: any, r: any): string {
  if (r) {
    if (r.status === "waiting" && Array.isArray(r.wait_on) && r.wait_on.length) return "dep";   // S7 ev_wait join：自动复活，不占人工位
    return ({ waiting: "input", done: "done", failed: "failed", blocked: "dep" } as Record<string, string>)[r.status] ?? "done";
  }
  if (spec?.depends?.length && spec.depends.some((d: string) => !depDone(rootId, d))) return "dep";
  return "queued";
}

function apiView(res: any): void {
  const runs: any[] = [], inbox: any[] = [], settled: any[] = [];
  if (!existsSync(RUNS)) return json(res, 200, { runs, inbox, settled });
  const rootIds = readdirSync(RUNS, { withFileTypes: true })
    .filter(d => d.isDirectory() && okId(d.name)).map(d => d.name)
    .sort((a, b) => String(readJson<any>(join(RUNS, b, "run.json"))?.created_at ?? "")
      .localeCompare(String(readJson<any>(join(RUNS, a, "run.json"))?.created_at ?? ""))); // 新 run 在前（同 /api/runs）
  for (const rootId of rootIds) {
    const meta = readJson<any>(join(RUNS, rootId, "run.json"));
    // 节点级投影：spec + result + 尾事件 + gate
    const nodes = nodePaths(rootId).map(path => {
      const dir = join(RUNS, rootId, "nodes", ...path.split("/"));
      const spec = readJson<any>(join(dir, "spec.json"));
      const r = readJson<any>(join(dir, "result.json"));
      const ev = tailEvent(join(dir, "events.jsonl"));
      const specFile = join(dir, "spec.json");
      const created = existsSync(specFile) ? statSync(specFile).mtimeMs : Date.now(); // 无 spec.created_at，用文件 mtime
      // steps：events.jsonl 尾部事件 → sheet「执行过程」行 {t,a,r,st}
      const evLines = existsSync(join(dir, "events.jsonl"))
        ? readFileSync(join(dir, "events.jsonl"), "utf8").split("\n").filter(l => l.trim()).slice(-12) : [];
      const steps = evLines.map(l => {
        try {
          const e = JSON.parse(l), kind = e.kind ?? "";
          const st = kind === "exit" ? (e.data?.error || (e.data?.code ?? 0) !== 0 ? "err" : "ok")
                   : kind === "gate" ? "wait" : kind === "spawn" ? "run" : "ok";
          return { t: String(e.ts ?? "").slice(11, 19), a: String(kind), r: evHint(e).slice(0, 60), st };
        } catch { return null; }
      }).filter(Boolean);
      const ad = join(dir, "artifacts");
      const out = existsSync(ad) ? readdirSync(ad, { withFileTypes: true }).filter(f => f.isFile()).map(f => f.name) : [];
      const gate = readJson<any>(join(dir, "gate.json"));
      const usage = readJson<any>(join(dir, "usage.json"));
      const todo = readJson<any>(join(dir, "todo.json"));
      return {
        path, spec, r, gate,
        st: viewStatus(rootId, spec, r),
        // S10 控制面投影：live=worker.json 租约在、cur=尾事件工具/动作、spent=token 累计、wait=waiting 原因
        live: existsSync(join(dir, "worker.json")),
        cur: ev?.data?.tool ?? ev?.kind ?? null,
        spent: usage?.tokens ?? r?.spent?.tokens ?? null,
        todo: Array.isArray(todo?.items) ? todo.items : null,   // S9 ev_todo 清单投影
        wait: r?.status === "waiting" ? (gate?.question ?? (Array.isArray(r?.wait_on) ? `等子节点 ${r.wait_on.join(", ")}` : r?.wait_on) ?? null) : null,
        nm: nodeName(rootId, path),
        d: String(r?.summary ?? (ev ? evHint(ev) : "")).split("\n")[0].slice(0, 80),  // 一句话：result.summary 优先，否则尾事件 hint
        sum: r?.summary ?? "",                                                     // sheet 小结
        steps, out,
        el: mmss((r?.finished_at ? Date.parse(r.finished_at) : Date.now()) - created),
      };
    });
    const waiting = nodes.filter(n => n.st === "input");
    const allDone = nodes.length > 0 && nodes.every(n => n.r?.status === "done");
    const ended = nodes.map(n => n.r?.finished_at).filter(Boolean).sort().pop() as string | undefined;
    // run 不自动隐藏：done/failed 也留在 runs 里可打开，只有显式 DELETE 才消失
    const status = allDone ? "done" : waiting.length ? "input"
                 : nodes.some(n => n.r?.status === "failed") ? "failed" : "working";
    if (allDone) settled.push([meta?.subject ?? rootId, hhmm(ended ?? meta?.created_at ?? new Date().toISOString()), rootId]);
    const rootNode = nodes.find(n => n.path === "root") ?? nodes[0];
    // chips：根 spec.accept → [状态,条文]。简化判定：spec.accept_idx===i 的节点 result 存在即 verified、failed 即 failed、无则 pending
    const chips = (rootNode?.spec?.accept ?? []).map((a: string, i: number) => {
      const acx = nodes.find(n => n.spec?.accept_idx === i);
      return [!acx?.r ? "pending" : acx.r.status === "failed" ? "failed" : "verified", a];
    });
    const tree = nodes.filter(n => n.path.split("/").length >= 2)   // l=path 段数；root(l=1) 不进树，子节点 l=2 起
      .map(n => ({ l: n.path.split("/").length, acl: n.spec?.accept_idx ?? 0, st: n.st, nm: n.nm, d: n.d, el: n.el,
                   path: n.path, sum: n.sum, steps: n.steps, out: n.out,   // sheet 用：定位/小结/执行过程/产物
                   live: n.live, cur: n.cur, spent: n.spent, wait: n.wait, todo: n.todo, // S10：live ✕ / Σtok / 回复框；S9：清单
                   wb: n.st === "input" ? "person:answer" : n.st === "dep" ? "dependency" : "" })); // wb=等待对象：等人答/等依赖
    // arts：全部节点 artifacts/ 汇总到 run 级；非 root 节点的 fn 带 path 前缀防重名
    const arts: any[] = [];
    for (const n of nodes) {
      const ad = join(RUNS, rootId, "nodes", ...n.path.split("/"), "artifacts");
      if (!existsSync(ad)) continue;
      for (const f of readdirSync(ad, { withFileTypes: true })) {
        if (!f.isFile()) continue;
        const fp = join(ad, f.name);
        const sz = statSync(fp).size;
        arts.push({ fn: n.path === "root" ? f.name : `${n.path}/${f.name}`,
                    sz: sz >= 1024 ? `${(sz / 1024).toFixed(1).replace(/\.0$/, "")} KB` : `${sz} B`,
                    body: readFileSync(fp).subarray(0, 64 * 1024).toString("utf8") });
      }
    }
    const runIdx = runs.length;
    const last = runPulse(rootId, nodes.map(n => n.path)).last;
    // S6：run 行 Σtok = 各节点 spent（result.spent 或 usage.json）累加
    const spentTotal = nodes.reduce((s, n) => s + (typeof n.spent === "number" ? n.spent : 0), 0);
    runs.push({
      id: rootId, title: meta?.subject ?? rootId, status,
      dur: mmss((ended ? Date.parse(ended) : Date.now()) - Date.parse(meta?.created_at ?? new Date().toISOString())),
      spent: spentTotal || null,
      snippet: last?.hint ?? "",
      req: meta?.subject ?? "",                                          // 原始诉求
      obj: String(rootNode?.spec?.goal ?? "").split("\n")[0].slice(0, 80), // 目标（根 goal 首行）
      sum: rootNode?.r?.summary ?? "",                                   // 摘要（根 result）
      chips, tree, arts,
    });
    // inbox：waiting 节点 → 人工闸门条目（gate.run 指回 runs 数组下标）
    for (const n of waiting) {
      const q = String(n.gate?.question ?? n.r?.summary ?? "");
      const opts = n.gate?.opts?.length
        ? n.gate.opts.map((o: string) => [o, "", `已选择·${o}`])          // [文案, 图标位, 已选后文案]
        : [["同意", "", "已同意"], ["拒绝", "", "已拒绝"]];
      const segs = n.path.split("/");
      const crumb = [meta?.subject ?? rootId, ...segs.map((_, i) => nodeName(rootId, segs.slice(0, i + 1).join("/")))];
      inbox.push({
        id: n.spec?.id ?? `node:${rootId}/${n.path}`,
        t: q.split("\n")[0].slice(0, 80), d: q, crumb, opts,
        gate: { run: runIdx, nm: n.nm, pd: `回复已送达，${n.nm} 恢复执行`, sn: "已回复 · 节点恢复运行" },
      });
    }
  }
  json(res, 200, { runs, inbox, settled });
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
  for (const p of nodePaths(rootId)) {
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
  abort: /^\/api\/runs\/([^/]+)\/node\/(.+)\/abort$/,
  transcript: /^\/api\/runs\/([^/]+)\/node\/(.+)\/transcript$/,
  retry: /^\/api\/runs\/([^/]+)\/node\/(.+)\/retry$/,
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

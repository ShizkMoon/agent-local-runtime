// S27 e2e · 录制回放：把夹具里真实跑出来的 events/result/spec/usage 还原成一个 runs 目录，
// 再喂给产品自己的 projector（workbench/view.ts 的 buildView、src/transcribe.ts 的 turnUsage）。
// 不 mock 投影：断言的是产品代码对同一份磁盘真相的解释。
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildView, clearViewCache, viewCacheStats } from "../../../view.ts";
import { readUsage, turnUsage, usageTokens, recordTurnUsage } from "../../../../src/transcribe.ts";

/** 夹具里非"节点文件"的控制文件，落盘时要跳过 */
const META = new Set(["case.json", "README.md"]);
/** 这些文件属于 run 目录而不是节点目录 */
const RUN_LEVEL = new Set(["plan.v1.json", "run.json"]);

export function readCase(caseDir) {
  const raw = JSON.parse(readFileSync(join(caseDir, "case.json"), "utf8"));
  const c = {
    name: raw.case ?? caseDir.split(/[\\/]/).pop(),
    runId: raw.runId,
    nodePath: raw.nodePath ?? "root",
    subject: raw.subject ?? raw.case ?? "e2e",
    createdAt: raw.createdAt ?? "2026-11-04T00:00:00.000Z",
    now: typeof raw.now === "string" ? Date.parse(raw.now) : (raw.now ?? Date.parse("2026-11-04T12:00:00.000Z")),
    kind: raw.kind ?? "assign",
    note: raw.note ?? "",
    skipTranscribe: !!raw.skipTranscribe,
  };
  if (!c.runId) throw new Error(`case.json 缺 runId：${caseDir}`);
  return c;
}

/** 时间钉死：让 el / dur 这类"跟 mtime 走"的字段可复现（同 view.test.ts 的手法） */
function pinMtimes(dir, when) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) pinMtimes(p, when);
    else utimesSync(p, when, when);
  }
}

export function mkTmp(prefix = "aica-e2e-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * 把目录里所有文件的 mtime 拨到"刚刚"。
 * 服务端（workbench/server.ts 的 pendingApproval）用 Date.now() 判审批 TTL（10min），
 * 夹具里的固定时间对它来说已经过期，所以走 HTTP 的用例必须先 touch 一次。
 */
export function touchRecent(dir, msAgo = 90_000) {
  const when = new Date(Date.now() - msAgo);
  const walk = (d) => {
    for (const ent of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else utimesSync(p, when, when);
    }
  };
  walk(dir);
  return when;
}

/**
 * 夹具 → runs 目录。
 * 夹具是**节点级**的（events/result/spec/usage 这些平铺），这里补上 run.json 与节点目录层级，
 * 因为 buildView 的入参是 STATE/runs（run 的父目录）。
 */
export function materialize(caseDir, runsDir) {
  const c = readCase(caseDir);
  const runDir = join(runsDir, c.runId);
  const nodeDir = join(runDir, "nodes", ...c.nodePath.split("/"));
  mkdirSync(nodeDir, { recursive: true });
  for (const ent of readdirSync(caseDir, { withFileTypes: true })) {
    if (META.has(ent.name)) continue;
    const dest = RUN_LEVEL.has(ent.name) ? join(runDir, ent.name) : join(nodeDir, ent.name);
    cpSync(join(caseDir, ent.name), dest, { recursive: true });
  }
  const runFile = join(runDir, "run.json");
  if (!existsSync(runFile)) {
    writeFileSync(runFile, JSON.stringify({ root_id: c.runId, kind: c.kind, subject: c.subject, created_at: c.createdAt }, null, 2) + "\n", "utf8");
  }
  const pinned = new Date(c.now - 90_000); // 1.5 分钟前建：el 稳定成 01:30，且审批 TTL（10min）不会因为夹具太老而失效
  pinMtimes(runDir, pinned);
  return { case: c, nodeDir, runDir, runsDir };
}

/**
 * 回放一个用例：materialize → buildView(now=夹具里写死的 now)。
 * @returns {{case:object, view:object, run:object|null, node:object|null, dirs:object}}
 */
export function replayView(caseDir, opts = {}) {
  const runsDir = opts.runsDir ?? mkTmp("aica-e2e-replay-");
  const { case: c } = materialize(caseDir, runsDir);
  clearViewCache();
  const view = buildView(runsDir, { now: opts.now ?? c.now });
  const run = view.runs.find((r) => r.id === c.runId) ?? null;
  const node = run ? (run.tree.find((n) => n.path === c.nodePath) ?? (c.nodePath === "root" ? null : undefined)) : undefined;
  return { case: c, view, run, node, dirs: { runsDir } };
}

/**
 * 回放 transcribe：把 stdout.log（pi 的原始 JSONL）按顺序喂给 turnUsage/recordTurnUsage，
 * 断言产物与录制时的 usage.json 一致。这是"转写器可重放"的证明，不是 mock。
 * stdout.log 缺失（审批类夹具）时返回 null，由调用方 skip。
 */
export function replayTranscribe(caseDir) {
  const c = readCase(caseDir);
  const log = join(caseDir, "stdout.log");
  const fixtureUsage = join(caseDir, "usage.json");
  if (!existsSync(log) || !existsSync(fixtureUsage)) return null;
  const dir = mkTmp("aica-e2e-usage-");
  let i = 0;
  let kept = 0;
  for (const line of readFileSync(log, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev?.type !== "turn_end") continue;
    const tu = turnUsage(ev, ++i);
    if (!tu) continue;
    recordTurnUsage(dir, tu);
    kept += 1;
  }
  const ledger = readUsage(dir);
  const fixture = JSON.parse(readFileSync(fixtureUsage, "utf8"));
  rmSync(dir, { recursive: true, force: true });
  return { case: c, ledger, fixture, turns: kept, tokens: usageTokens(ledger), fixtureTokens: usageTokens(fixture) };
}

/** 归一化投影：只保留"语义字段"，去掉时间/绝对路径/artifact 正文这些随机器变的东西 */
export function digestOf(view, opts = {}) {
  const runsDir = (opts.runsDir ?? "").replace(/\\/g, "/");
  const j = (v) => JSON.parse(JSON.stringify(v ?? null));

  const step = (s) => ({
    kind: s.kind, name: s.name, st: s.st, exit: s.exit,
    capped: s.capped, truncated: s.truncated, total: s.total,
    ref: s.ref ? String(s.ref).replace(runsDir, "<runs>") : null,
    out: (s.out ?? []).slice(0, 3).map((l) => String(l).replace(runsDir, "<runs>")),
  });

  const run = (r) => ({
    id: r.id, title: r.title, status: r.status, agg: r.agg, agg_n: r.agg_n,
    turn: j(r.turn),
    chips: j(r.chips),
    steps: (r.steps ?? []).map(step),
    groups: (r.groups ?? []).map((g) => ({ key: g.key, n: g.n, err: g.err })),
    stats: j(r.stats),
    tree: (r.tree ?? []).map((t) => ({
      path: t.path, st: t.st, agg: t.agg, wb: t.wb, l: t.l, acl: t.acl,
      turn: j(t.turn), steps: (t.steps ?? []).length,
      spend: typeof t.spent === "number",         // 具体数字随 usage 变，只钉"有没有"
      todo: t.todo ? t.todo.map((x) => ({ text: x.text, done: x.done })) : null,
      compactions: (t.compactions ?? []).length,
      diffs: (t.diffs ?? []).map((d) => ({ file: d.file, add: d.add, del: d.del, hunks: d.hunks })),
      audits: (t.audits ?? []).map((a) => ({ q: a.question, decision: a.decision, ms: a.ms })),
    })),
    compactions: (r.compactions ?? []).map((x) => ({ before: x.before_tokens, after: x.after_tokens })),
    diffs: (r.diffs ?? []).map((d) => ({ file: d.file, add: d.add, del: d.del })),
    plan: r.plan ? { items: r.plan.items, current: r.plan.current } : null,
    sev: r.sev,
    audits: (r.audits ?? []).map((a) => ({ node: a.node, q: a.question, decision: a.decision })),
    arts: (r.arts ?? []).map((a) => ({ fn: a.fn, sz: a.sz })),
  });

  return {
    runs: (view.runs ?? []).map(run),
    inbox: (view.inbox ?? []).map((i) => ({
      id: i.id, t: i.t, d: i.d, opts: (i.opts ?? []).map((o) => o[0]), crumb: i.crumb,
    })),
    settled: (view.settled ?? []).map((s) => [s[0], "<hh:mm>", s[2]]),
  };
}

export function snapshotFile(store, name) {
  return join(store, `${name}.json`);
}

/** 与 view.test.ts 同一套语义：缺文件即创建；UPDATE_SNAPSHOTS=1 时重写 */
export function matchSnapshot(store, name, actual) {
  const file = snapshotFile(store, name);
  // 行尾归一：仓库里 autocrlf/编辑器会把快照改成 CRLF，语义相同就不该红
  const norm = (s) => String(s).replace(/\r\n/g, "\n");
  if (!existsSync(file) || process.env.UPDATE_SNAPSHOTS === "1") {
    mkdirSync(store, { recursive: true });
    writeFileSync(file, norm(actual) + "\n", "utf8");
    return { created: true, file };
  }
  const want = norm(readFileSync(file, "utf8")).trimEnd();
  const now = norm(actual).trimEnd();
  return { created: false, file, ok: now === want, want };
}

export function statOf(dir) {
  return { size: statSync(dir).size, isDir: statSync(dir).isDirectory() };
}

export { buildView, clearViewCache, viewCacheStats };

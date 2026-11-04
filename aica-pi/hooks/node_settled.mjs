// aica hook · node_settled：节点 result 落定后由 daemon 调用（S15 骨架 → R3 §9.5 提案闭环）
// 契约（照 Claude command-hook 文件态版）：
//   argv[2] = 节点目录；stdin 喂 {spec,result} JSON；5s 超时
//   stdout 输出 JSON，可含 dispatch:[{path,goal,agent?,profile?,accept?}] → daemon 逐个 writeSpec（parent=本节点 id）
//   可含 proposal:{ok, slug, dir, risk, registered} → daemon 记一条 proposal 事件（inbox 类目数据源）
//
// R3 §9.5 提案闭环（本 hook 的唯一新行为）：
//   result.proposal（slug 或 proposals/<slug> 路径）存在 → 找到提案目录 →
//     1) 幂等登记 <STATE>/proposals/index.jsonl（同一 slug+节点只登记一次）
//     2) 节点 events.jsonl 追一条 learn 事件（下一轮 learned.md / 视图可见）
//   没有 proposal 字段时行为与旧版完全一致（只写 hooks.log + dispatch:[]），重复触发不会重复登记。
//
// 信任边界：daemon 只认 <aica-pi>/hooks/ 包内目录的文件，run 目录下同名文件不作 hook 源。
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const STATE = process.env.AICA_STATE || "";

/** 提案目录解析：绝对/相对路径优先，其次按 slug 去找（节点目录 → STATE/proposals） */
function resolveProposal(dir, raw) {
  const p = String(raw ?? "").trim();
  if (!p) return null;
  const looksLikePath = p.includes("/") || p.includes("\\") || p.startsWith(".");
  const candidates = [];
  if (looksLikePath) {
    candidates.push(p, join(dir, p));
    if (STATE) candidates.push(join(STATE, "proposals", p));
  } else {
    candidates.push(join(dir, "proposals", p));
    if (STATE) candidates.push(join(STATE, "proposals", p));
  }
  for (const c of candidates) {
    try { if (existsSync(join(c, "meta.json")) || existsSync(join(c, "patch.diff"))) return { dir: c, slug: p.split(/[\\/]/).filter(Boolean).pop() }; }
    catch { /* 无权限等按未找到处理 */ }
  }
  return null;
}

function readMeta(dir) {
  try { return JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")); } catch { return null; }
}

/** 幂等登记：index.jsonl 里已有同 slug + 同 node 的行就不再写 */
function register(dir, slug, meta, nodeId) {
  if (!STATE) return { ok: false, registered: false, error: "缺 AICA_STATE" };
  const file = join(STATE, "proposals", "index.jsonl");
  const line = JSON.stringify({
    ts: new Date().toISOString(), slug, dir,
    risk: meta?.risk ?? null, status: "pending", node: nodeId ?? null,
    files: Array.isArray(meta?.files) ? meta.files.map((f) => f?.path).filter(Boolean) : [],
    source: "node_settled",
  });
  try {
    if (existsSync(file)) {
      for (const l of readFileSync(file, "utf8").split("\n")) {
        if (!l.trim()) continue;
        try {
          const j = JSON.parse(l);
          if (j?.slug === slug && (j?.node ?? null) === (nodeId ?? null)) return { ok: true, registered: false, index: file };
        } catch { /* 坏行跳过 */ }
      }
    }
    mkdirSync(join(STATE, "proposals"), { recursive: true });
    appendFileSync(file, line + "\n", "utf8");
    return { ok: true, registered: true, index: file };
  } catch (e) {
    return { ok: false, registered: false, error: String(e?.message ?? e) };
  }
}

/** 节点 learn 事件：直写 events.jsonl（runs.readEvents 容忍无 seq 的外部追加，S21 已覆盖）。
 *  幂等：同一 slug 的 learn 已存在就不重复写（重复触发 hook 不污染时间线）。 */
function learnEvent(dir, slug, meta) {
  try {
    const f = join(dir, "events.jsonl");
    if (existsSync(f)) {
      for (const l of readFileSync(f, "utf8").split("\n")) {
        if (!l.trim()) continue;
        try {
          const j = JSON.parse(l);
          if (j?.kind === "learn" && j?.data?.proposal === slug) return false;
        } catch { /* 坏行跳过 */ }
      }
    }
    const ev = { ts: new Date().toISOString(), kind: "learn", data: { proposal: slug, risk: meta?.risk ?? null, project: "proposal" } };
    appendFileSync(f, JSON.stringify(ev) + "\n", "utf8");
    return true;
  } catch { return false; }
}

let raw = "";
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  let ctx = {};
  try { ctx = JSON.parse(raw); } catch { /* 喂进来的 JSON 坏了也照常收尾 */ }
  const dir = process.argv[2] ?? ".";
  const nodeId = ctx?.spec?.id ?? null;
  const line = `${new Date().toISOString()} node_settled ${nodeId ?? "?"} status=${ctx?.result?.status ?? "?"} ${String(ctx?.result?.summary ?? "").split("\n")[0]}\n`;
  try { appendFileSync(join(dir, "hooks.log"), line); } catch { /* 目录不可写不阻塞 */ }

  // R3 §9.5：提案登记（无 proposal 字段 → 完全跳过，行为不变）
  let proposal = null;
  const rawProposal = ctx?.result?.proposal;
  if (typeof rawProposal === "string" && rawProposal.trim()) {
    const hit = resolveProposal(dir, rawProposal);
    if (!hit) {
      proposal = { ok: false, error: `提案未找到：${rawProposal.slice(0, 120)}` };
    } else {
      const meta = readMeta(hit.dir);
      const reg = register(hit.dir, hit.slug, meta, nodeId);
      const learned = learnEvent(dir, hit.slug, meta);
      // ok = 登记这条链路成功（幂等重复触发也是 ok；registered 才表示"这次真的新增了"）
      proposal = { ok: !!reg.ok, slug: hit.slug, dir: hit.dir, risk: meta?.risk ?? null, registered: reg.registered, learned, index: reg.index ?? null, ...(reg.error ? { error: reg.error } : {}) };
    }
  }

  // 要派后续节点时把对象放进 dispatch；每个 {path,goal,agent?,profile?,accept?}
  process.stdout.write(JSON.stringify({ dispatch: [], ...(proposal ? { proposal } : {}) }) + "\n");
});

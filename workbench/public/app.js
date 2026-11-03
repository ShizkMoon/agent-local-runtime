// aica workbench · 前端控制器（ESM，无构建）
// 形态：左 rail run 列表 | 中央会话流（全节点事件归并）| 右侧详情 sheet | 底部 composer
import { esc, chip, fmtTs, relTime, fmtDur, md } from "./cards.js";
import { mergeStream, streamHtml } from "./stream.js";

const $ = (s) => document.querySelector(s);
const api = async (p, opt) => {
  const r = await fetch(p, opt);
  if (!r.ok) { let m = r.status; try { m = (await r.json()).error ?? m; } catch {} throw new Error(m); }
  return r.json();
};
const enc = encodeURIComponent;
const np = (path) => path.split("/").map(enc).join("/");

const S = {
  run: null, nodeFilter: null, sending: false,
  meta: null, nodes: [], items: [],
  evBuf: new Map(),    // path → 已收事件数组
  evtNext: new Map(),  // path → 下一增量下标
  expanded: new Set(), // tool 卡展开态（item.skey）
  drafts: new Map(),   // gate 回复草稿（item.skey → text）
  seen: new Set(),     // 已渲染 item.skey（追加动画用，selectRun 重置）
  nodeInfo: null,      // nodeFilter 节点的 detail（spec/result/artifacts）
  runs: [],            // 最近一次 /api/runs 缓存（rail 运行中 tick 用）
};

const DOT = { done: "st-done", failed: "st-failed", running: "st-run", waiting: "st-wait", blocked: "st-blk", split: "st-split" };
const dot = (st) => `<span class="dot ${DOT[st] ?? ""}"></span>`;
const KIND_GLYPH = { tool_execution: "⚙", tool_call: "⚙", agent_message: "💬", message: "💬", spawn: "▶", exit: "■", gate: "◆", checkpoint: "📌", file_edit: "✏" };

// ---------- 左 rail：run 列表 ----------
async function loadRuns() {
  const { runs } = await api("/api/runs");
  S.runs = runs;
  $("#run-list").innerHTML = runs.map(r => {
    const dur = r.status === "running" ? fmtDur(r.created_at) : fmtDur(r.created_at, r.ended_at);
    const hint = r.last ? `<div class="r3"><span class="rk">${KIND_GLYPH[r.last.kind] ?? "·"}</span><span class="rh-int">${esc(r.last.tool ? `${r.last.tool} — ${r.last.hint}` : r.last.hint)}</span></div>` : "";
    return `<div class="ritem ${S.run === r.root_id ? "sel" : ""}" data-id="${esc(r.root_id)}">
      <div class="r1">${dot(r.status)}<span class="rsubj">${esc(r.subject ?? r.root_id)}</span></div>
      <div class="r2"><span>${relTime(r.created_at)}前</span><span>·</span><span>${r.nodes}节点</span>${dur ? `<span>·</span><span>${dur}</span>` : ""}
        ${r.counts?.failed ? `<span class="mini mini-err">${r.counts.failed}✕</span>` : ""}
        ${r.counts?.split ? `<span class="mini mini-split">${r.counts.split}⑃</span>` : ""}
        ${r.counts?.waiting || r.counts?.blocked ? `<span class="mini mini-wait">gate</span>` : ""}
      </div>${hint}
    </div>`;
  }).join("") || `<div class="dim" style="padding:12px">无 run — 在下方输入任务开跑</div>`;
  $("#run-list").querySelectorAll(".ritem").forEach(el =>
    el.onclick = () => selectRun(el.dataset.id));
  return runs;
}

async function selectRun(id) {
  if (S.run === id) return;
  S.run = id; S.nodeFilter = null; S.nodeInfo = null;
  S.evBuf.clear(); S.evtNext.clear(); S.expanded.clear(); S.drafts.clear(); S.seen.clear();
  await Promise.all([loadRuns(), refreshRun(true)]);
}

// ---------- run 头：subject + 状态 + 聚合统计 + node pills + 节点条 ----------
function streamStats() {
  const toks = S.items.reduce((a, it) => a + (it.tokens ?? 0), 0);
  const evs = [...S.evtNext.values()].reduce((a, n) => a + n, 0);
  const first = S.items[0]?.ts, last = S.items[S.items.length - 1]?.ts ?? S.meta?.created_at;
  const dur = fmtDur(S.meta?.created_at ?? first, ["running", "blocked", "waiting"].includes(rollupStatus()) ? undefined : last);
  return { toks, evs, dur };
}

function renderHead() {
  if (!S.run) {
    $("#run-head").innerHTML = `<div class="rh-top dim">← 左侧选择 run，或在下方输入新任务</div>`;
    return;
  }
  const subject = S.meta?.subject ?? S.run;
  const agg = rollupStatus();
  const st = streamStats();
  const pills = [`<button class="pill ${!S.nodeFilter ? "on" : ""}" data-p="">全部</button>`]
    .concat(S.nodes.map(n =>
      `<button class="pill ${S.nodeFilter === n.path ? "on" : ""}" data-p="${esc(n.path)}" title="${esc(n.goal ?? n.path)}">${dot(n.status)}${esc(n.path)}</button>`));
  $("#run-head").innerHTML = `
    <div class="rh-top">${dot(agg)}<b class="rh-subj" title="${esc(subject)}">${esc(subject)}</b>
      ${chip(agg)}
      <span class="rh-stats dim">${esc(S.run)} · ${st.evs} 事件${st.toks ? ` · ${st.toks.toLocaleString()} tok` : ""}${st.dur ? ` · ${st.dur}` : ""}</span>
      <span class="spacer"></span>
      <button id="rh-spec" class="ghost" title="run.json">meta</button></div>
    <div class="pills">${pills.join("")}</div>
    <div id="node-strip" ${S.nodeFilter ? "" : "hidden"}></div>`;
  $("#run-head").querySelectorAll(".pill").forEach(b => b.onclick = () => {
    S.nodeFilter = b.dataset.p || null; S.nodeInfo = null;
    renderHead(); renderStream();
    if (S.nodeFilter) loadNodeInfo();
  });
  $("#rh-spec").onclick = () =>
    openSheet("run.json", `<pre class="json">${esc(JSON.stringify(S.meta, null, 2))}</pre>`);
  if (S.nodeFilter) renderNodeStrip();
}

function rollupStatus() {
  const c = {};
  for (const n of S.nodes) c[n.status] = (c[n.status] ?? 0) + 1;
  return c.failed ? "failed" : c.blocked ? "blocked" : c.waiting ? "waiting"
    : (c.running || c.empty || !S.nodes.length) ? "running" : c.split && !c.done ? "split" : "done";
}

/** node strip：filtered 节点的 status/agent/goal + spec/result 按钮 + artifact chips + reply */
async function loadNodeInfo() {
  if (!S.run || !S.nodeFilter) return;
  try {
    S.nodeInfo = await api(`/api/runs/${enc(S.run)}/node/${np(S.nodeFilter)}`);
    renderNodeStrip();
  } catch { /* 节点可能刚被清理 */ }
}

function renderNodeStrip() {
  const el = $("#node-strip");
  if (!el || !S.nodeFilter) return;
  const d = S.nodeInfo;
  const n = S.nodes.find(x => x.path === S.nodeFilter);
  if (!d) { el.innerHTML = `<span class="dim">加载节点…</span>`; return; }
  const needReply = ["waiting", "blocked"].includes(d.status) || d.has_reply;
  el.innerHTML = `
    ${chip(d.status)} <span class="dim">[${esc(n?.agent ?? d.spec?.agent ?? "?")}]</span>
    <span class="ns-goal">${esc(d.spec?.goal ?? S.nodeFilter)}</span>
    ${d.result?.spent?.tokens ? `<span class="dim">${d.result.spent.tokens} tok</span>` : ""}
    <span class="spacer"></span>
    <button class="ghost" data-ns="spec">spec</button>
    <button class="ghost" data-ns="result">result</button>
    <button class="ghost" data-ns="events">raw</button>
    ${needReply ? `<button class="ghost" data-ns="reply">回复</button>` : ""}
    <div class="ns-art">${(d.artifacts ?? []).map(a =>
      `<span class="chip art" data-name="${esc(a.name)}">📎 ${esc(a.name)} <span class="dim">${(a.size / 1024).toFixed(1)}K</span></span>`).join("")}</div>`;
  el.querySelectorAll("[data-ns]").forEach(b => b.onclick = () => nodeSheet(b.dataset.ns));
  el.querySelectorAll(".chip.art").forEach(c => c.onclick = () => openArtifact(S.nodeFilter, c.dataset.name));
}

async function nodeSheet(kind) {
  const d = S.nodeInfo; if (!d) return;
  if (kind === "events") {
    const evs = S.evBuf.get(S.nodeFilter) ?? [];
    return openSheet(`${S.nodeFilter} · events.jsonl`,
      `<pre class="json">${esc(evs.map(e => JSON.stringify(e)).join("\n"))}</pre>`);
  }
  if (kind === "reply") return openReplySheet();
  openSheet(`${S.nodeFilter} · ${kind}.json`,
    `<pre class="json">${esc(JSON.stringify(d[kind] ?? `（无 ${kind}.json）`, null, 2))}</pre>`);
}

// ---------- stream ----------
async function refreshRun(scroll = false) {
  if (!S.run) return;
  try {
    const { meta, nodes } = await api(`/api/runs/${enc(S.run)}/tree`);
    S.meta = meta; S.nodes = nodes;
    // 增量拉各节点事件
    await Promise.all(nodes.map(async n => {
      const since = S.evtNext.get(n.path) ?? 0;
      const { events, next } = await api(`/api/runs/${enc(S.run)}/node/${np(n.path)}/events?since=${since}`);
      if (events.length) {
        const buf = S.evBuf.get(n.path) ?? [];
        buf.push(...events); S.evBuf.set(n.path, buf);
      }
      S.evtNext.set(n.path, next);
    }));
    S.items = mergeStream(S.nodes.map(n => ({ path: n.path, events: S.evBuf.get(n.path) ?? [] })));
    renderHead();
    renderStream(scroll);
    if (S.nodeFilter) loadNodeInfo();
  } catch (e) {
    if (String(e).includes("404")) { S.run = null; renderHead(); renderStream(); }
    else toast(`刷新失败：${e.message ?? e}`, true);
  }
}

const nearBottom = () => {
  const el = $("#stream");
  return el.scrollHeight - el.scrollTop - el.clientHeight < 90;
};

function renderStream(scroll = false) {
  const el = $("#stream");
  document.body.classList.toggle("hero", !S.run);
  if (!S.run) { el.innerHTML = heroHtml(); $("#jump").hidden = true; return; }
  const stick = scroll || nearBottom();
  el.innerHTML = streamHtml(S.items, { expanded: S.expanded, drafts: S.drafts, seen: S.seen, nodeFilter: S.nodeFilter });
  if (stick) el.scrollTop = el.scrollHeight;
  $("#jump").hidden = nearBottom();
}

$("#stream").addEventListener("scroll", () => { $("#jump").hidden = nearBottom(); });
$("#jump").onclick = () => $("#stream").scrollTo({ top: $("#stream").scrollHeight, behavior: "smooth" });

const heroHtml = () => `
  <div class="hero">
    <div class="hero-logo">◈</div>
    <h1>aica workbench</h1>
    <p class="hero-sub">输入任务目标 — <code>ar dispatch</code> → daemon → pi worker，事件流在这里实时展开</p>
    <div class="hero-sugg">
      ${["用 bash 执行 echo hello-aica，然后 ev_done 汇报输出",
         "列出当前目录文件，ev_done 汇报文件数",
         "写 artifacts/note.md 记一句运行笔记，然后 ev_done"].map(g =>
        `<button class="sugg" data-act="sugg" data-goal="${esc(g)}">${esc(g)}</button>`).join("")}
    </div>
  </div>`;

// stream 事件委托
$("#stream").addEventListener("click", (e) => {
  const actEl = e.target.closest("[data-act]");
  if (!actEl) {
    const head = e.target.closest(".tc-head");
    if (head) toggleTool(head.parentElement.dataset.key);
    return;
  }
  const act = actEl.dataset.act;
  if (act === "toggle") toggleTool(actEl.closest(".tc")?.dataset.key);
  else if (act === "sheet") openToolSheet(Number(actEl.dataset.key));
  else if (act === "art") openArtifact(actEl.dataset.node, actEl.dataset.name);
  else if (act === "sugg") { $("#composer-text").value = actEl.dataset.goal; $("#composer-text").focus(); }
  else if (act === "gate-opt") sendReply(actEl.dataset.node, actEl.dataset.text);
  else if (act === "gate-send") {
    const input = $("#stream").querySelector(`.ginput[data-node="${CSS.escape(actEl.dataset.node)}"]`);
    if (input?.value.trim()) sendReply(actEl.dataset.node, input.value.trim());
  }
});
$("#stream").addEventListener("input", (e) => {
  if (!e.target.classList?.contains("ginput")) return;
  const key = e.target.closest(".gate")?.dataset.key;
  if (key != null) S.drafts.set(key, e.target.value);
});

function toggleTool(skey) {
  if (skey == null) return;
  S.expanded.has(skey) ? S.expanded.delete(skey) : S.expanded.add(skey);
  renderStream();
}

function openToolSheet(key) {
  const it = S.items[key];
  if (!it) return;
  openSheet(`${it.node} · ${it.tool ?? it.type}`,
    `<pre class="json">${esc(it.raw.map(e => JSON.stringify(e, null, 2)).join("\n\n"))}</pre>`);
}

async function sendReply(nodePath, text) {
  try {
    await api(`/api/runs/${enc(S.run)}/node/${np(nodePath)}/reply`,
      { method: "POST", body: JSON.stringify({ text }) });
    toast(`已回复 ${nodePath}`);
    refreshRun();
  } catch (e) { toast(`回复失败：${e.message ?? e}`, true); }
}

// ---------- artifact / sheet ----------
async function openArtifact(nodePath, name) {
  const r = await fetch(`/api/runs/${enc(S.run)}/node/${np(nodePath)}/artifact/${enc(name)}`);
  if (!r.ok) return toast(`artifact 读取失败：${r.status}`, true);
  const text = await r.text();
  openSheet(`${nodePath} · ${name}`, /\.(md|markdown)$/i.test(name) && window.marked
    ? `<div class="md">${md(text)}</div>` : `<pre class="json">${esc(text)}</pre>`);
}

function openReplySheet() {
  openSheet(`回复 ${S.nodeFilter}`, `
    <div class="sheet-reply">
      <textarea id="sheet-reply-text" placeholder="注入 spec.reply，worker 下次拉起可见…"></textarea>
      <button id="sheet-reply-send">发送回复</button>
    </div>`);
  $("#sheet-reply-send").onclick = () => {
    const t = $("#sheet-reply-text").value.trim();
    if (t) sendReply(S.nodeFilter, t).then(() => closeSheet());
  };
}

function openSheet(title, html) {
  $("#sheet-title").textContent = title;
  $("#sheet-body").innerHTML = html;
  document.body.classList.add("sheet-on");
}
function closeSheet() { document.body.classList.remove("sheet-on"); }
$("#sheet-close").onclick = closeSheet;
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeSheet(); });

// ---------- composer ----------
async function sendTask() {
  const goal = $("#composer-text").value.trim();
  if (!goal || S.sending) return;
  S.sending = true;
  $("#composer-send").disabled = true; $("#composer-text").disabled = true;
  $("#composer-hint").textContent = "dispatch 中…";
  try {
    const { root_id } = await api("/api/tasks", { method: "POST", body: JSON.stringify({ goal }) });
    $("#composer-text").value = ""; $("#composer-text").style.height = "auto";
    $("#composer-hint").textContent = `已派发 → ${root_id}`;
    S.run = null; // 强制 selectRun 重置缓冲
    await loadRuns();
    await selectRun(root_id);
    refreshDaemon();
  } catch (e) {
    $("#composer-hint").textContent = `派发失败：${e.message ?? e}`;
  } finally {
    S.sending = false;
    $("#composer-send").disabled = false; $("#composer-text").disabled = false;
    $("#composer-text").focus();
  }
}
$("#composer-send").onclick = sendTask;
$("#composer-text").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendTask(); }
});
$("#composer-text").addEventListener("input", (e) => {
  const t = e.target; t.style.height = "auto"; t.style.height = Math.min(t.scrollHeight, 180) + "px";
});

// ---------- header / daemon / SSE ----------
function toast(msg, isErr = false) {
  const t = $("#toast");
  t.textContent = msg; t.className = isErr ? "toast-err show" : "toast-ok show";
  t.hidden = false;
  clearTimeout(t._tm); t._tm = setTimeout(() => { t.classList.remove("show"); setTimeout(() => t.hidden = true, 250); }, 3600);
}

async function refreshDaemon() {
  try {
    const d = await api("/api/daemon");
    $("#daemon").className = `chip ${d.running ? "chip-ok" : "chip-err"}`;
    $("#daemon").textContent = d.running ? "daemon ●" : "daemon ○";
    $("#daemon").title = d.running ? `ar daemon 运行中 (cli: ${d.cli})` : "daemon 未运行 — 发任务时会自动拉起";
  } catch { $("#daemon").textContent = "daemon ?"; }
}

$("#refresh").onclick = () => { loadRuns(); refreshRun(true); refreshDaemon(); };

let refreshTimer = null;
const es = new EventSource("/api/stream");
es.onopen = () => { $("#conn").className = "chip chip-ok"; $("#conn").textContent = "live"; };
es.onerror = () => { $("#conn").className = "chip chip-err"; $("#conn").textContent = "断线·重连中"; };
es.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.type !== "change") return;
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => { loadRuns(); if (S.run) refreshRun(); }, 300);
};

// rail 耗时 tick：有 running run 时每 15s 重取列表（顺带刷 preview/elapsed）
setInterval(() => { if (S.runs.some(r => r.status === "running")) loadRuns(); }, 15000);

// ---------- 启动 ----------
(async () => {
  refreshDaemon();
  const runs = await loadRuns();
  if (runs.length) await selectRun(runs[0].root_id);
  else renderStream();
  $("#composer-text").focus();
})();

// aica workbench · 前端控制器（ESM，无构建）
// 依据 docs/workbench-ui.md §7：rail(可折叠+系统态) | 单流 | sheet(tab) | composer(模式槽)
// 五态：空 hero / 加载 skeleton / 失败 err卡+红点 / 等待 gate卡+置顶条 / 断开 红条+退避重连
import { esc, chip, fmtTs, relTime, fmtDur, md, skeletonHtml } from "./cards.js";
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
  run: null, nodeFilter: null, sending: false, loading: false,
  meta: null, nodes: [], items: [],
  evBuf: new Map(),    // path → 已收事件数组
  evtNext: new Map(),  // path → 下一增量下标
  expanded: new Set(), // 用户展开态（item.skey）
  touched: new Set(),  // 手动 toggle 过的卡（此后不再自动展开/折叠）
  drafts: new Map(),   // gate 回复草稿（item.skey → text）
  seen: new Set(),     // 已渲染 item.skey（追加动画用，selectRun 重置）
  nodeInfo: null,      // nodeFilter 节点的 detail
  runs: [],            // /api/runs 缓存
  mode: "task",        // composer 模式：task | tools | orch
  sheet: null,         // {node, tab} sheet 上下文
  gateNodes: [],       // 未解除 gate 的节点 path（banner 用）
  connDown: false,
};

const DOT = { done: "st-ok", failed: "st-err", running: "st-run", waiting: "st-info", blocked: "st-warn", split: "st-info" };
const dot = (st) => `<span class="dot ${DOT[st] ?? ""}"></span>`;
const KIND_GLYPH = { tool_execution: "⚙", tool_call: "⚙", agent_message: "💬", message: "💬", spawn: "▶", exit: "■", gate: "◆", checkpoint: "📌", file_edit: "✏" };

// ---------- 左 rail：run 列表 + 折叠 + 系统态 ----------
async function loadRuns() {
  try {
    const { runs } = await api("/api/runs");
    S.runs = runs;
    setConn(true);
  } catch (e) { setConn(false); return S.runs; }
  $("#run-list").innerHTML = S.runs.map(r => {
    const dur = r.status === "running" ? fmtDur(r.created_at) : fmtDur(r.created_at, r.ended_at);
    const hint = r.last ? `<div class="r3"><span class="rk">${KIND_GLYPH[r.last.kind] ?? "·"}</span><span class="rh-int">${esc(r.last.tool ? `${r.last.tool} — ${r.last.hint}` : r.last.hint)}</span></div>` : "";
    return `<div class="ritem ${S.run === r.root_id ? "sel" : ""}" data-id="${esc(r.root_id)}" title="${esc(r.subject ?? r.root_id)}">
      <div class="ravatar">${dot(r.status)}<span>${esc((r.subject ?? r.root_id).slice(0, 1).toUpperCase())}</span></div>
      <div class="rmain">
        <div class="r1"><span class="rsubj">${esc(r.subject ?? r.root_id)}</span></div>
        <div class="r2">${dot(r.status)}<span>${r.nodes}节点</span><span>·</span><span>${relTime(r.created_at)}前</span>${dur ? `<span>·</span><span>${dur}</span>` : ""}
          ${r.counts?.failed ? `<span class="mini mini-err">${r.counts.failed}✕</span>` : ""}
          ${r.counts?.split ? `<span class="mini mini-split">${r.counts.split}⑃</span>` : ""}
          ${r.counts?.waiting || r.counts?.blocked ? `<span class="mini mini-wait">gate</span>` : ""}
        </div>${hint}
      </div>
    </div>`;
  }).join("") || `<div class="dim" style="padding:12px">无 run — 在下方输入任务开跑</div>`;
  $("#run-list").querySelectorAll(".ritem").forEach(el =>
    el.onclick = () => selectRun(el.dataset.id));
  return S.runs;
}

$("#rail-toggle").onclick = () => {
  document.body.classList.toggle("rail-mini");
  $("#rail-toggle").textContent = document.body.classList.contains("rail-mini") ? "⟩" : "⟨";
};

// ---------- 系统态：server / daemon / 断开条 ----------
function setConn(up) {
  const was = S.connDown;
  S.connDown = !up;
  $("#conn-dot").className = `dot ${up ? "st-ok" : "st-err"}`;
  $("#conn").className = `chip ${up ? "chip-ok" : "chip-err"}`;
  $("#conn").textContent = up ? "live" : "断开";
  $("#conn-bar").hidden = up;
  if (!up && !was) toast("与 server 的连接断开，自动重试中…", true);
  if (up && was) toast("连接已恢复");
}

let daemonInfo = null;
async function refreshDaemon() {
  try {
    daemonInfo = await api("/api/daemon");
    $("#daemon-dot").className = `dot ${daemonInfo.running ? "st-ok" : "st-err"}`;
    $("#daemon").className = `chip ${daemonInfo.running ? "chip-ok" : "chip-err"}`;
    $("#daemon").textContent = daemonInfo.running ? `pid ${daemonInfo.spawned ?? "ext"}` : "stopped";
    $("#sys-daemon").title = daemonInfo.running ? `ar daemon 运行中 (${daemonInfo.cli})` : "daemon 未运行 — 发任务时会自动拉起";
  } catch {
    $("#daemon").className = "chip"; $("#daemon").textContent = "?"; $("#daemon-dot").className = "dot";
  }
}
setInterval(refreshDaemon, 10_000);

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

async function loadNodeInfo() {
  if (!S.run || !S.nodeFilter) return;
  try {
    S.nodeInfo = await api(`/api/runs/${enc(S.run)}/node/${np(S.nodeFilter)}`);
    renderNodeStrip();
    if (S.sheet?.node === S.nodeFilter) renderSheetBody();
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
    <button class="ghost" data-ns="sheet">详情 ⇗</button>
    ${needReply ? `<button class="ghost" data-ns="reply">回复</button>` : ""}
    <div class="ns-art">${(d.artifacts ?? []).map(a =>
      `<span class="chip art" data-name="${esc(a.name)}">📎 ${esc(a.name)} <span class="dim">${(a.size / 1024).toFixed(1)}K</span></span>`).join("")}</div>`;
  el.querySelectorAll("[data-ns]").forEach(b => b.onclick = () => {
    if (b.dataset.ns === "sheet") openNodeSheet(S.nodeFilter, "detail");
    else if (b.dataset.ns === "reply") openNodeSheet(S.nodeFilter, "reply");
  });
  el.querySelectorAll(".chip.art").forEach(c => c.onclick = () => openArtifact(S.nodeFilter, c.dataset.name));
}

// ---------- stream ----------
async function selectRun(id) {
  if (S.run === id) return;
  S.run = id; S.nodeFilter = null; S.nodeInfo = null; S.loading = true;
  S.evBuf.clear(); S.evtNext.clear(); S.expanded.clear(); S.drafts.clear(); S.seen.clear(); S.touched.clear();
  await Promise.all([loadRuns(), refreshRun(true)]);
}

async function refreshRun(scroll = false) {
  if (!S.run) return;
  try {
    const { meta, nodes } = await api(`/api/runs/${enc(S.run)}/tree`);
    S.meta = meta; S.nodes = nodes;
    await Promise.all(nodes.map(async n => {
      const since = S.evtNext.get(n.path) ?? 0;
      const { events, next } = await api(`/api/runs/${enc(S.run)}/node/${np(n.path)}/events?since=${since}`);
      if (events.length) {
        const buf = S.evBuf.get(n.path) ?? [];
        buf.push(...events); S.evBuf.set(n.path, buf);
      }
      S.evtNext.set(n.path, next);
    }));
    S.items = mergeStream(S.nodes.map(n => ({ path: n.path, events: S.evBuf.get(n.path) ?? [] })), nodes);
    S.gateNodes = nodes.filter(n => {
      if (["done", "failed", "split"].includes(n.status)) return false;
      return (S.evBuf.get(n.path) ?? []).some(e => e.kind === "gate");
    }).map(n => n.path);
    S.loading = false;
    renderHead(); renderGateBanner(); renderStream(scroll);
    if (S.nodeFilter) loadNodeInfo();
  } catch (e) {
    S.loading = false;
    if (String(e).includes("404")) { S.run = null; renderHead(); renderStream(); }
    else { setConn(false); toast(`刷新失败：${e.message ?? e}`, true); }
  }
}

/** 等待态：未解除 gate → 流顶置顶细条 */
function renderGateBanner() {
  const el = $("#gate-banner");
  $("#stream-wrap").classList.toggle("has-gate", S.gateNodes.length > 0);
  if (!S.gateNodes.length) { el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = `◆ ${S.gateNodes.length} 个节点等待回复 — ${esc(S.gateNodes.join("、"))}
    <button class="ghost" data-gb="focus">定位</button>`;
  el.querySelector("[data-gb]").onclick = () => {
    S.nodeFilter = S.gateNodes[0]; S.nodeInfo = null;
    renderHead(); renderStream(); loadNodeInfo();
  };
}

const nearBottom = () => {
  const el = $("#stream");
  return el.scrollHeight - el.scrollTop - el.clientHeight < 90;
};

function renderStream(scroll = false) {
  const el = $("#stream");
  document.body.classList.toggle("hero", !S.run);
  if (!S.run) { el.innerHTML = heroHtml(); $("#jump").hidden = true; return; }
  if (S.loading && !S.items.length) { el.innerHTML = skeletonHtml(); $("#jump").hidden = true; return; }
  const stick = scroll || nearBottom();
  el.innerHTML = streamHtml(S.items, { expanded: S.expanded, touched: S.touched, drafts: S.drafts, seen: S.seen, nodeFilter: S.nodeFilter });
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
  S.touched.add(skey); // 手动接管后不再自动展开/折叠
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

// ---------- sheet：freeform 或 node 上下文（详情/产物/spec/result tab） ----------
function openSheet(title, html) {
  S.sheet = null;
  $("#sheet-title").textContent = title;
  $("#sheet-tabs").innerHTML = "";
  $("#sheet-body").innerHTML = html;
  document.body.classList.add("sheet-on");
}

const SHEET_TABS = [["detail", "详情"], ["artifacts", "产物"], ["spec", "spec"], ["result", "result"], ["reply", "回复"]];

async function openNodeSheet(nodePath, tab = "detail") {
  S.sheet = { node: nodePath, tab };
  document.body.classList.add("sheet-on");
  $("#sheet-title").textContent = nodePath;
  $("#sheet-tabs").innerHTML = SHEET_TABS.map(([k, l]) =>
    `<button class="stab ${k === tab ? "on" : ""}" data-t="${k}">${l}</button>`).join("");
  $("#sheet-tabs").querySelectorAll(".stab").forEach(b =>
    b.onclick = () => { S.sheet.tab = b.dataset.t; renderSheetBody();
      $("#sheet-tabs").querySelectorAll(".stab").forEach(x => x.classList.toggle("on", x === b)); });
  try { S.nodeInfo = await api(`/api/runs/${enc(S.run)}/node/${np(nodePath)}`); } catch {}
  renderSheetBody();
  if (S.nodeFilter === nodePath) renderNodeStrip();
}

async function renderSheetBody() {
  const sh = S.sheet; if (!sh) return;
  const d = S.nodeInfo;
  $("#sheet-title").textContent = sh.node;
  if (sh.tab === "detail") {
    if (!d) { $("#sheet-body").innerHTML = `<div class="dim">加载中…</div>`; return; }
    $("#sheet-body").innerHTML = `
      <div class="sd">${chip(d.status)} <span class="dim">node</span></div>
      <div class="sd-label">goal</div><div class="sd-v">${esc(d.spec?.goal ?? "—")}</div>
      <div class="sd-label">agent / profile / model</div>
      <div class="sd-v mono">${esc(d.spec?.agent ?? "?")} / ${esc(d.spec?.profile ?? "worker")} / ${esc(d.spec?.model ?? "default")}</div>
      ${d.result?.summary ? `<div class="sd-label">summary</div><div class="sd-v">${esc(d.result.summary)}</div>` : ""}
      ${d.result?.spent?.tokens ? `<div class="sd-label">spent</div><div class="sd-v mono">${d.result.spent.tokens} tok</div>` : ""}
      <div class="sd-label">accept</div><div class="sd-v">${(d.spec?.accept ?? []).map(a => `· ${esc(a)}`).join("<br>") || "—"}</div>
      <div class="sd-label">replies</div><div class="sd-v">${(d.spec?.reply ?? []).map(r => `[${esc(r.ts?.slice(11, 19))}] ${esc(r.text)}`).join("<br>") || "—"}</div>`;
  } else if (sh.tab === "artifacts") {
    const arts = d?.artifacts ?? [];
    $("#sheet-body").innerHTML = arts.length
      ? `<div class="sd-list">${arts.map(a => `<div class="sd-art" data-name="${esc(a.name)}">📎 ${esc(a.name)} <span class="dim">${(a.size / 1024).toFixed(1)}K</span></div>`).join("")}</div><div id="art-prev"></div>`
      : `<div class="dim">无产物</div>`;
    $("#sheet-body").querySelectorAll(".sd-art").forEach(el => el.onclick = async () => {
      const r = await fetch(`/api/runs/${enc(S.run)}/node/${np(sh.node)}/artifact/${enc(el.dataset.name)}`);
      const text = await r.text();
      $("#art-prev").innerHTML = `<div class="sd-label">${esc(el.dataset.name)}</div>` +
        (/\.(md|markdown)$/i.test(el.dataset.name) && window.marked ? `<div class="md">${md(text)}</div>` : `<pre class="json">${esc(text)}</pre>`);
    });
  } else if (sh.tab === "spec" || sh.tab === "result") {
    $("#sheet-body").innerHTML = `<pre class="json">${esc(JSON.stringify(d?.[sh.tab] ?? `（无 ${sh.tab}.json）`, null, 2))}</pre>`;
  } else if (sh.tab === "reply") {
    $("#sheet-body").innerHTML = `
      <div class="sheet-reply">
        <textarea id="sheet-reply-text" placeholder="注入 spec.reply，worker 下次拉起可见…"></textarea>
        <button id="sheet-reply-send">发送回复（ar reply）</button>
      </div>`;
    $("#sheet-reply-send").onclick = () => {
      const t = $("#sheet-reply-text").value.trim();
      if (t) sendReply(sh.node, t).then(() => { $("#sheet-reply-text").value = ""; });
    };
  }
}

async function openArtifact(nodePath, name) {
  await openNodeSheet(nodePath, "artifacts");
  const el = $("#sheet-body").querySelector(`.sd-art[data-name="${CSS.escape(name)}"]`);
  el?.click();
}

function closeSheet() { document.body.classList.remove("sheet-on"); S.sheet = null; }
$("#sheet-close").onclick = closeSheet;
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeSheet(); });

// ---------- composer + 模式槽 ----------
$("#modes").querySelectorAll(".seg").forEach(b => b.onclick = () => {
  S.mode = b.dataset.mode;
  $("#modes").querySelectorAll(".seg").forEach(x => x.classList.toggle("on", x === b));
  $("#composer-hint").textContent = S.mode === "tools" ? "授权 agent_desktop / ego_browser / ar_dispatch"
    : S.mode === "orch" ? "profile=orchestrator · 可拆子节点"
    : "Enter 发送 · Shift+Enter 换行 · / 聚焦";
});

async function sendTask() {
  const goal = $("#composer-text").value.trim();
  if (!goal || S.sending) return;
  S.sending = true;
  $("#composer-send").disabled = true; $("#composer-text").disabled = true;
  $("#composer-send").classList.add("sending");
  $("#composer-hint").textContent = "dispatch 中…";
  try {
    const task = { goal };
    if (S.mode === "tools") task.tools = ["agent_desktop", "ego_browser", "ar_dispatch"];
    if (S.mode === "orch") task.profile = "orchestrator";
    const { root_id } = await api("/api/tasks", { method: "POST", body: JSON.stringify(task) });
    $("#composer-text").value = ""; $("#composer-text").style.height = "auto";
    $("#composer-hint").textContent = `已派发 → ${root_id}`;
    S.run = null;
    await loadRuns();
    await selectRun(root_id);
    refreshDaemon();
  } catch (e) {
    $("#composer-hint").textContent = `派发失败：${e.message ?? e}`;
  } finally {
    S.sending = false;
    $("#composer-send").disabled = false; $("#composer-text").disabled = false;
    $("#composer-send").classList.remove("sending");
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

// ---------- 键盘 ----------
document.addEventListener("keydown", (e) => {
  if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
  e.preventDefault();
  $("#composer-text").focus();
});

// ---------- toast / refresh ----------
function toast(msg, isErr = false) {
  const t = $("#toast");
  t.textContent = msg; t.className = isErr ? "toast-err show" : "toast-ok show";
  t.hidden = false;
  clearTimeout(t._tm); t._tm = setTimeout(() => { t.classList.remove("show"); setTimeout(() => t.hidden = true, 250); }, 3600);
}

$("#refresh").onclick = () => { loadRuns(); refreshRun(true); refreshDaemon(); };

// ---------- SSE：手动退避重连（1s→2s→…→5s 封顶，成功复位） ----------
let refreshTimer = null, es = null, esBackoff = 1000;
function connectSSE() {
  es?.close();
  es = new EventSource("/api/stream");
  es.onopen = () => { esBackoff = 1000; setConn(true); };
  es.onerror = () => {
    setConn(false);
    es.close();
    setTimeout(connectSSE, esBackoff);
    esBackoff = Math.min(esBackoff * 2, 5000);
  };
  es.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.type !== "change") return;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => { loadRuns(); if (S.run) refreshRun(); }, 300);
  };
}
connectSSE();

// rail 耗时 tick：有 running run 时每 15s 重取列表
setInterval(() => { if (S.runs.some(r => r.status === "running")) loadRuns(); }, 15000);

// ---------- 启动 ----------
(async () => {
  refreshDaemon();
  const runs = await loadRuns();
  if (runs.length) await selectRun(runs[0].root_id);
  else renderStream();
  $("#composer-text").focus();
})();

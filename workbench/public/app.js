// aica workbench · 前端（ESM，无构建）
// 三栏：run 列表 | 节点树 | 事件时间线 + spec/result/artifact
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const api = async (p, opt) => { const r = await fetch(p, opt); if (!r.ok) throw new Error((await r.json()).error ?? r.status); return r.json(); };
const enc = encodeURIComponent;

const S = { run: null, node: null, evtNext: 0, nodes: [] };
const CHIP = { done: "chip-ok", failed: "chip-err", running: "chip-warn", waiting: "chip-wait", blocked: "chip-blk", split: "chip-split", me: "chip-wait", spec: "", empty: "" };
const chip = (st) => `<span class="chip ${CHIP[st] ?? ""}">${esc(st)}</span>`;
const fmtTs = (ts) => ts ? String(ts).replace("T", " ").slice(5, 19) : "";

// ---------- run list ----------
async function loadRuns() {
  const { runs } = await api("/api/runs");
  $("#run-list").innerHTML = runs.map(r => `
    <div class="item ${S.run === r.root_id ? "sel" : ""}" data-id="${esc(r.root_id)}">
      <div>${chip(r.status)} <b>${esc(r.subject ?? r.root_id)}</b></div>
      <div class="t">${esc(r.root_id)} · ${r.nodes}节点 · ${fmtTs(r.created_at)}</div>
    </div>`).join("") || `<div class="dim" style="padding:8px">无 run</div>`;
  $("#run-list").querySelectorAll(".item").forEach(el =>
    el.onclick = () => { S.run = el.dataset.id; S.node = null; S.evtNext = 0; loadRuns(); loadTree(); });
}

// ---------- node tree ----------
async function loadTree() {
  if (!S.run) { $("#node-tree").innerHTML = ""; return; }
  const { meta, nodes } = await api(`/api/runs/${enc(S.run)}/tree`);
  S.nodes = nodes;
  $("#run-meta").textContent = meta?.subject ? `${meta.subject}` : "";
  const byPath = new Map(nodes.map(n => [n.path, n]));
  const roots = nodes.filter(n => !n.parent || !byPath.has(n.parent));
  const render = (n, depth) => `
    <div class="item ${S.node === n.path ? "sel" : ""}" data-path="${esc(n.path)}" style="margin-left:${depth * 14}px">
      ${chip(n.status)} <span class="dim">[${esc(n.agent)}]</span> ${esc(n.goal ?? n.path)}
      <div class="t">${esc(n.path)}${n.spent?.tokens ? ` · ${n.spent.tokens}tok` : ""}${n.events ? ` · ${(n.events / 1024).toFixed(1)}KB` : ""}</div>
    </div>` + nodes.filter(c => c.parent === n.path).map(c => render(c, depth + 1)).join("");
  $("#node-tree").innerHTML = roots.map(n => render(n, 0)).join("") || `<div class="dim" style="padding:8px">无节点</div>`;
  $("#node-tree").querySelectorAll(".item").forEach(el =>
    el.onclick = () => { S.node = el.dataset.path; S.evtNext = 0; loadTree(); loadNode(); });
}

// ---------- node detail ----------
async function loadNode() {
  if (!S.run || !S.node) return;
  const d = await api(`/api/runs/${enc(S.run)}/node/${S.node.split("/").map(enc).join("/")}`);
  $("#node-head").innerHTML = `${chip(d.status)} <b>${esc(d.spec?.goal ?? S.node)}</b>
    <span class="dim"> ${esc(S.node)} · ${esc(d.spec?.agent ?? "?")} · ${(d.events_bytes / 1024).toFixed(1)}KB 事件</span>`;
  $("#pane-spec").textContent = d.spec ? JSON.stringify(d.spec, null, 2) : "（无 spec.json）";
  $("#pane-result").textContent = d.result ? JSON.stringify(d.result, null, 2) : "（无 result.json，节点未结束）";
  $("#art-bar").innerHTML = d.artifacts.map(a =>
    `<span class="chip" data-name="${esc(a.name)}">📎 ${esc(a.name)} <span class="dim">${(a.size / 1024).toFixed(1)}K</span></span>`).join("");
  $("#art-bar").querySelectorAll(".chip").forEach(el => el.onclick = () => openArtifact(el.dataset.name));
  $("#reply-bar").hidden = !(d.status === "waiting" || d.status === "blocked" || d.has_reply);
  await loadEvents();
}

async function loadEvents() {
  if (!S.run || !S.node) return;
  const np = S.node.split("/").map(enc).join("/");
  const { events, next } = await api(`/api/runs/${enc(S.run)}/node/${np}/events?since=${S.evtNext}`);
  if (S.evtNext === 0) $("#timeline").innerHTML = "";
  S.evtNext = next;
  $("#evt-count").textContent = `${next} 事件`;
  for (const ev of events) $("#timeline").insertAdjacentHTML("beforeend", evCard(ev));
  $("#timeline").querySelectorAll(".ev-head").forEach(h => h.onclick = () => h.parentElement.classList.toggle("open"));
  $("#timeline").lastElementChild?.scrollIntoView({ block: "nearest" });
}

const KIND_LABEL = { tool_call: "🔧 调用", tool_result: "📤 结果", message: "💬 消息", spawn: "▶ 拉起", exit: "■ 退出", checkpoint: "📌 checkpoint", gate: "🚧 gate", file_edit: "✏ 编辑", _raw: "⚠ 原始" };
function evCard(ev) {
  const k = ev.kind ?? "?";
  const d = ev.data ?? {};
  let title = KIND_LABEL[k] ?? k, body = "", cls = "";
  if (k === "tool_call") { title += ` <b>${esc(d.tool)}</b>`; body = esc(d.args ?? JSON.stringify(d)); cls = "ev-tool"; }
  else if (k === "tool_result") { title += ` <b>${esc(d.tool)}</b>${d.is_error ? ' <span class="chip chip-err">error</span>' : ""}`; body = esc(d.output ?? JSON.stringify(d)); cls = "ev-tool" + (d.is_error ? " ev-err" : ""); }
  else if (k === "message") { title += ` ${esc(d.role)}`; body = esc(d.text ?? JSON.stringify(d)); cls = "ev-msg"; }
  else { body = esc(JSON.stringify(d, null, 1)); cls = "ev-sys"; }
  return `<div class="ev ${cls}"><div class="ev-head"><span class="k">${title}</span><span class="spacer"></span><span>${fmtTs(ev.ts)}</span></div><div class="ev-body"><pre>${body}</pre></div></div>`;
}

// ---------- artifacts ----------
async function openArtifact(name) {
  const np = S.node.split("/").map(enc).join("/");
  const r = await fetch(`/api/runs/${enc(S.run)}/node/${np}/artifact/${enc(name)}`);
  const text = await r.text();
  $("#art-name").textContent = name;
  const md = /\.(md|markdown)$/i.test(name);
  $("#art-body").innerHTML = (md && window.marked) ? marked.parse(text) : `<pre>${esc(text)}</pre>`;
  $("#art-view").hidden = false;
}
$("#art-close").onclick = () => $("#art-view").hidden = true;

// ---------- reply ----------
$("#reply-send").onclick = async () => {
  const text = $("#reply-text").value.trim(); if (!text || !S.run || !S.node) return;
  const np = S.node.split("/").map(enc).join("/");
  await api(`/api/runs/${enc(S.run)}/node/${np}/reply`, { method: "POST", body: JSON.stringify({ text }) });
  $("#reply-text").value = ""; loadNode();
};

// ---------- tabs / refresh / SSE ----------
$("#tabs").querySelectorAll("button").forEach(b => b.onclick = () => {
  $("#tabs").querySelectorAll("button").forEach(x => x.classList.toggle("on", x === b));
  document.querySelectorAll(".tabpane").forEach(p => p.classList.toggle("on", p.id === "pane-" + b.dataset.tab));
});
$("#refresh").onclick = () => { loadRuns(); loadTree(); if (S.node) loadNode(); };

let refreshTimer = null;
const es = new EventSource("/api/stream");
es.onopen = () => { $("#conn").className = "chip chip-ok"; $("#conn").textContent = "live"; };
es.onerror = () => { $("#conn").className = "chip chip-err"; $("#conn").textContent = "断线·重连中"; };
es.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.type !== "change") return;
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => { loadRuns(); if (S.run) loadTree(); if (S.node) loadNode(); }, 250);
};

loadRuns();

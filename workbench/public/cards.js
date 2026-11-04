// aica workbench · 渲染单元：共享小工具 + stream item → HTML（纯函数，无状态）
// 依据 docs/workbench-ui.md §7.3：MessageBubble 非气泡、GateCard 确认分级、ToolCard 左缘工具色条
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g,
  c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export const CHIP = {
  done: "chip-ok", failed: "chip-err", running: "chip-run", waiting: "chip-info",
  blocked: "chip-warn", split: "chip-info", me: "chip-info", spec: "", empty: "",
};
export const chip = (st) => `<span class="chip ${CHIP[st] ?? ""}">${esc(st)}</span>`;

export const fmtTs = (ts) => ts ? String(ts).replace("T", " ").slice(11, 19) : "";

export function relTime(ts) {
  if (!ts) return "";
  const s = (Date.now() - new Date(ts).getTime()) / 1000;
  if (isNaN(s)) return "";
  if (s < 0) return "刚刚";
  if (s < 60) return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/** a→b 时长（b 缺省 = now）："3.2s" / "1m 24s" / "2h 7m" */
export function fmtDur(a, b) {
  if (!a) return "";
  const ms = new Date(b ?? Date.now()) - new Date(a);
  if (isNaN(ms) || ms < 0) return "";
  const s = ms / 1000;
  if (s < 10) return `${s.toFixed(1)}s`;
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${Math.floor(s % 60)}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

export const md = (text) =>
  (window.marked ? window.marked.parse(String(text ?? "")) : `<pre>${esc(text)}</pre>`);

const trunc = (s, n = 90) => { s = String(s ?? "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n) + "…" : s; };

// ---- 工具 meta：kind → 图标/色类（工具色仅用于卡左缘 3px + icon）----
const TOOL_KIND = {
  file: { i: "🗎", cls: "tk-file" }, bash: { i: "$", cls: "tk-bash" },
  powershell: { i: "❯", cls: "tk-ps" }, desktop: { i: "🖥", cls: "tk-desktop" },
  browser: { i: "🌐", cls: "tk-browser" }, kn: { i: "◈", cls: "tk-kn" },
  ar: { i: "▣", cls: "tk-ar" }, ev: { i: "⚑", cls: "tk-ev" }, tool: { i: "⚙", cls: "tk-misc" },
};
const TOOL_MAP = {
  read: "file", write: "file", edit: "file", ls: "file", find: "file", glob: "file", grep: "file",
  bash: "bash", sh: "bash", powershell: "powershell", pwsh: "powershell", cmd: "powershell",
  desktop: "desktop", agent_desktop: "desktop", browser: "browser", ego_browser: "browser",
  webfetch: "browser", web_search: "browser",
  kn_recall: "kn", kn_save: "kn", kn_search: "kn",
  ar_read: "ar", ar_dispatch: "ar", ar_check: "ar", ar_reply: "ar", node_create: "ar",
  ev_done: "ev", ev_fail: "ev", ev_event: "ev",
};
const toolKind = (t) => TOOL_MAP[t] ?? (/^(read|write|edit|ls|find|grep|glob)/.test(t) ? "file" : "tool");

/** 从 args JSON 里挑最有信息量的字段做一行预览 */
function argsPreview(args) {
  if (args == null) return "";
  try {
    const o = typeof args === "string" ? JSON.parse(args) : args;
    if (o && typeof o === "object") {
      for (const k of ["command", "cmd", "path", "file_path", "text", "summary", "query", "goal", "content", "url", "pattern"])
        if (o[k] != null) return trunc(o[k]);
      const first = Object.values(o).find(v => typeof v === "string" && v.trim());
      return first ? trunc(first) : trunc(JSON.stringify(o), 60);
    }
  } catch { /* 非 JSON 直接截断 */ }
  return trunc(args);
}

const pretty = (v) => {
  if (v == null) return "";
  try { const o = typeof v === "string" ? JSON.parse(v) : v; return JSON.stringify(o, null, 1); }
  catch { return String(v); }
};

/** args/output 里 artifacts/xx 引用 → 可点 artifact chip */
function artRefs(...texts) {
  const names = new Set();
  for (const t of texts)
    for (const m of String(t ?? "").matchAll(/artifacts[/\\]([^"'\s\\]+)/g))
      if (!m[1].includes("..")) names.add(m[1]);
  return [...names];
}

// ---- item renderers（fresh → .enter 追加动画）----

/** ToolCard：头部单行 icon+名+args 预览+时长+chip；默认折叠；live(运行中)呼吸+自动展开 */
export function toolCard(it, open, fresh) {
  const { i, cls } = TOOL_KIND[toolKind(it.tool ?? "")];
  const st = it.done ? (it.is_error ? "err" : "ok") : "run";
  const stChip = st === "ok" ? `<span class="chip chip-ok">ok</span>`
    : st === "err" ? `<span class="chip chip-err">error</span>`
    : `<span class="chip chip-run">running</span>`;
  const dur = it.duration_ms != null ? `<span class="dur">${it.duration_ms}ms</span>` : "";
  const arts = artRefs(it.args, it.output);
  return `<div class="tc ${cls} ${st === "err" ? "tc-err" : ""} ${st === "run" ? "live" : ""} ${open ? "open" : ""} ${fresh ? "enter" : ""}" data-key="${it.skey}">
    <div class="tc-head" data-act="toggle">
      <span class="tico">${i}</span><b class="tname">${esc(it.tool)}</b>
      <span class="targs">${esc(argsPreview(it.args))}</span><span class="spacer"></span>
      ${stChip}${dur}<span class="ntag">${esc(it.node)}</span><time>${fmtTs(it.ts)}</time>
    </div>
    <div class="tc-body"><div class="tc-inner">
      ${it.args ? `<div class="tc-label">args</div><pre>${esc(trunc(pretty(it.args), 3000))}</pre>` : ""}
      <div class="tc-label">result</div>
      ${it.output ? `<pre>${esc(trunc(it.output, 4000))}</pre>` : `<pre class="dim">（执行中…）</pre>`}
      ${arts.length ? `<div class="tc-arts">${arts.map(a =>
        `<span class="chip art" data-act="art" data-node="${esc(it.node)}" data-name="${esc(a)}">📎 ${esc(a)}</span>`).join("")}</div>` : ""}
      <div class="tc-acts"><button data-act="sheet" data-key="${it.key}">完整事件 ⇗</button></div>
    </div></div>
  </div>`;
}

/** MessageBubble（§7.3）：assistant = prose 直排 + 左缘 accent 细线（非气泡）；
    user/system = 浅底小框右对齐 */
export function msgBubble(it, fresh) {
  const meta = [it.tokens ? `${it.tokens} tok` : "", it.stop && it.stop !== "endTurn" ? it.stop : ""]
    .filter(Boolean).join(" · ");
  if (it.role && it.role !== "assistant")
    return `<div class="umsg ${fresh ? "enter" : ""}" data-key="${it.skey}">
      <div class="mhead"><span class="mrole">${esc(it.role)}</span><span class="ntag">${esc(it.node)}</span><time>${fmtTs(it.ts)}</time></div>
      <div class="mbody md">${md(it.text)}</div></div>`;
  return `<div class="amsg ${fresh ? "enter" : ""}" data-key="${it.skey}">
    <div class="mhead"><span class="mrole">${esc(it.role ?? "agent")}</span>
      <span class="ntag">${esc(it.node)}</span>${meta ? `<span class="dim">${esc(meta)}</span>` : ""}
      <time>${fmtTs(it.ts)}</time></div>
    <div class="mbody md">${md(it.text)}</div>
  </div>`;
}

const MARK = {
  spawn: { i: "▶", cls: "mk-spawn" },
  exit: { i: "■", cls: "mk-exit" },
  checkpoint: { i: "📌", cls: "mk-cp" },
  file_edit: { i: "✏", cls: "mk-edit" },
  split: { i: "⑃", cls: "mk-split" },
  message: { i: "💬", cls: "mk-msg" },
  _raw: { i: "⚠", cls: "mk-raw" },
};

function markText(it) {
  const d = it.data ?? {};
  switch (it.mkind) {
    case "spawn": return `拉起 ${esc(d.agent ?? "?")} — ${esc(trunc(d.cmd ?? "", 110))}`;
    case "exit": return `退出 code=${d.code ?? "?"}${d.error ? ` · ${esc(trunc(d.error, 80))}` : ""}`;
    case "checkpoint": case "file_edit": case "message":
      return esc(trunc(d.text ?? d.path ?? JSON.stringify(d), 140));
    case "_raw": return esc(trunc(d.raw ?? "", 140));
    default: return `${esc(it.mkind)} ${esc(trunc(JSON.stringify(d), 110))}`;
  }
}

/** 细分隔标记 */
export function markRow(it, fresh) {
  const m = MARK[it.mkind] ?? { i: "·", cls: "" };
  const exitErr = it.mkind === "exit" && it.data?.code && it.data.code !== 0;
  return `<div class="mk ${m.cls} ${exitErr ? "mk-err" : ""} ${fresh ? "enter" : ""}" data-key="${it.skey}">
    <span class="mki">${m.i}</span><span class="mkt">${markText(it)}</span>
    <span class="ntag">${esc(it.node)}</span><time>${fmtTs(it.ts)}</time>
  </div>`;
}

/** 节点失败卡：result.status=failed 的流内 err 卡（五态之失败态） */
export function errCard(it, fresh) {
  const d = it.data ?? {};
  return `<div class="errcard ${fresh ? "enter" : ""}" data-key="${it.skey}">
    <div class="ec-head"><span class="mki">✕</span><b>节点失败</b><span class="ntag">${esc(it.node)}</span>
      <span class="spacer"></span><time>${fmtTs(it.ts)}</time></div>
    <div class="ec-body">${esc(d.summary ?? "（无摘要）")}</div>
  </div>`;
}

/** GateCard 确认分级（ADR 0002）：付款/删除/对外发布 → --err 描边 + 明示后果按钮 */
export function gateTier(d) {
  const kind = String(d?.confirm_kind ?? d?.kind ?? "").toLowerCase();
  if (["pay", "payment", "delete", "publish", "payment_confirm"].includes(kind)) return "err";
  const text = [d?.question, ...(Array.isArray(d?.options) ? d.options : [])].join(" ");
  return /付款|支付|删除|对外发布|发布|外传|publish|delete|pay\b/i.test(text) ? "err" : "warn";
}

export function gateCard(it, draft, fresh) {
  const d = it.data ?? {};
  const opts = Array.isArray(d.options) ? d.options : [];
  const tier = gateTier(d);
  return `<div class="gate ${tier === "err" ? "gate-err" : ""} ${fresh ? "enter" : ""}" data-key="${it.skey}">
    <div class="ghead"><span class="mki">◆</span><b>gate${tier === "err" ? " · 高风险确认" : ""}</b>
      <span class="ntag">${esc(it.node)}</span><span class="spacer"></span><time>${fmtTs(it.ts)}</time></div>
    <div class="gq">${esc(d.question ?? "等待人工输入")}</div>
    ${opts.length ? `<div class="gopts">${opts.map(o =>
      `<button class="gopt ${tier === "err" ? "gopt-err" : ""}" data-act="gate-opt" data-node="${esc(it.node)}" data-text="${esc(o)}">${tier === "err" ? "确认：" : ""}${esc(o)}</button>`).join("")}</div>` : ""}
    <div class="greply">
      <input class="ginput" data-node="${esc(it.node)}" placeholder="${tier === "err" ? "输入确认指令（将按原样执行后果操作）…" : "回复该节点…"}" value="${esc(draft ?? "")}">
      <button data-act="gate-send" data-node="${esc(it.node)}">发送</button>
    </div>
  </div>`;
}

/** skeleton shimmer：流首载占位（加载态） */
export const skeletonHtml = () => `
  <div class="skel"><div class="skel-line" style="width:38%"></div><div class="skel-line" style="width:72%"></div><div class="skel-line" style="width:56%"></div></div>
  <div class="skel"><div class="skel-line" style="width:64%"></div><div class="skel-line" style="width:30%"></div></div>`;

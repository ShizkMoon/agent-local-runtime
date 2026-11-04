package main

// preload.go —— 注入到工作台页面的极小脚本（WindowOptions.Page.PreloadScript）。
//
// 为什么走 preload 而不是改 index.html：
//   - 本任务写域只有 workbench/shell/**，前端由其他人改；
//   - MyGo 保证 preload 在页面自己的脚本之前、window.mygo 建立之后执行，
//     因此可以在页面不知情的情况下装好「拖拽 → @path」与「更新提示」。
//
// 三个职责：
//  1. 拖拽兜底：dragover/drop 一律 preventDefault，WebView2 永远不会把窗口
//     导航到被拖入的 file:// 文件；真正的插入走 MyGo 的 mygo:file-drop 事件
//     （它带绝对路径，DOM 的 File 对象在 WebView2 里拿不到 path）。
//  2. @path 插入：优先 #cText（工作台 composer 的 textarea），插入后派发
//     input 事件，让页面的 autogrow/发送逻辑看到新值。
//  3. 更新提示：启动时由 Go 侧算好 notice，这里在底部渲染一次性 pill。

import (
	"encoding/json"
	"strings"
)

// updateNotice 是壳启动时对「磁盘代码 vs 运行中桥」的判定结果。
type updateNotice struct {
	Running string `json:"running"`
	Disk    string `json:"disk"`
}

// buildPreload 生成注入脚本。notice 为 nil 表示不需要提示。
func buildPreload(notice *updateNotice) string {
	payload := "null"
	if notice != nil {
		if raw, err := json.Marshal(notice); err == nil {
			payload = string(raw)
		}
	}
	// 用占位符替换而不是 Sprintf：模板里有 left:50% 这类 CSS 百分号，
	// 走格式化字符串会被当成动词吃掉。
	return strings.ReplaceAll(preloadTemplate, "/*__NOTICE__*/null", payload)
}

// preloadTemplate 里 /*__NOTICE__*/null 会被替换成 notice 的 JSON。
// 脚本必须自包含、幂等，且不能抛异常（页面脚本不该因为壳的注入而中断）。
const preloadTemplate = `(() => {
  "use strict";
  if (window.__aicaShell) return;
  window.__aicaShell = { version: 1 };

  const NOTICE = /*__NOTICE__*/null;

  // ---- 1. 拖拽兜底：任何情况下都不让 WebView2 把窗口导航到被拖入的文件 ----
  const hasFiles = (e) => {
    try {
      const dt = e.dataTransfer;
      if (!dt) return false;
      if (dt.types && Array.from(dt.types).indexOf("Files") >= 0) return true;
      return !!(dt.files && dt.files.length);
    } catch (_) { return false; }
  };
  const guard = (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (e.type === "dragover" || e.type === "dragenter") {
      try { e.dataTransfer.dropEffect = "copy"; } catch (_) {}
    }
    // 注意：不 stopPropagation —— 页面将来自己的 drop UI 仍然能收到事件。
  };
  window.addEventListener("dragenter", guard, true);
  window.addEventListener("dragover", guard, true);
  window.addEventListener("drop", guard, true);

  // ---- 2. 把绝对路径以 @path 插进 composer ----
  const editor = () => {
    const el = document.getElementById("cText");
    if (el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT")) return el;
    const active = document.activeElement;
    if (active && (active.tagName === "TEXTAREA" || active.tagName === "INPUT")) return active;
    return document.querySelector("textarea, input[type=text]");
  };

  const quote = (p) => (/[\s"]/.test(p) ? '@"' + p + '"' : "@" + p);

  const insert = (paths) => {
    if (!Array.isArray(paths) || paths.length === 0) return false;
    const el = editor();
    if (!el) return false;
    const text = paths.map(String).map(quote).join(" ");
    const start = typeof el.selectionStart === "number" ? el.selectionStart : el.value.length;
    const end = typeof el.selectionEnd === "number" ? el.selectionEnd : start;
    const before = el.value.slice(0, start);
    const after = el.value.slice(end);
    const lead = before && !/\s$/.test(before) ? " " : "";
    const tail = after && !/^\s/.test(after) ? " " : "";
    el.value = before + lead + text + tail + after;
    const caret = (before + lead + text).length;
    try { el.selectionStart = el.selectionEnd = caret; } catch (_) {}
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.focus();
    return true;
  };

  // MyGo 的原生文件拖放事件：payload = { paths: string[], x, y }。
  // 只有被 PageOptions.TrustedOrigins 信任的页面才会收到它（壳已配置）。
  try {
    const api = window.mygo;
    if (api && typeof api.on === "function") {
      api.on("mygo:file-drop", (e) => {
        if (!e) return;
        // 页面自己接管了拖放就尊重它，避免双插。
        if (window.__aicaHandlesDrop === true) return;
        insert(e.paths || []);
      });
    }
  } catch (_) {}

  // 页面可主动取用：window.__aicaInsertPaths([...])。
  window.__aicaInsertPaths = insert;

  // ---- 3. 「新建任务」：托盘发 #new=<ts>，这里聚焦 composer ----
  const focusComposer = () => {
    // 等一帧，交给页面自己的渲染/hash 处理。
    requestAnimationFrame(() => {
      const el = editor();
      if (el) { el.focus(); try { el.scrollIntoView({ block: "nearest" }); } catch (_) {} }
    });
  };
  window.__aicaFocusComposer = focusComposer;
  if (location.hash.indexOf("#new") === 0) focusComposer();
  window.addEventListener("hashchange", () => {
    if (location.hash.indexOf("#new") === 0) focusComposer();
  });

  // ---- 4. 更新提示：底部一次性 pill ----
  const showNotice = () => {
    if (!NOTICE) return;
    if (document.getElementById("aica-update-pill")) return;
    const text = NOTICE.disk && NOTICE.disk !== NOTICE.running
      ? "代码已更新（运行 " + NOTICE.running + " / 磁盘 " + NOTICE.disk + "），重启工作台后生效"
      : "代码已更新，重启工作台后生效";
    const el = document.createElement("div");
    el.id = "aica-update-pill";
    el.textContent = text + "  ×";
    el.title = "点击关闭；不会自动重启";
    el.style.cssText = [
      "position:fixed", "left:50%", "bottom:112px", "transform:translateX(-50%)",
      "z-index:2147483647", "max-width:calc(100vw - 32px)",
      "padding:6px 12px", "border-radius:999px",
      "background:rgba(24,24,27,.94)", "color:#fafafa",
      "font:12px/1.4 system-ui,'Segoe UI',sans-serif",
      "box-shadow:0 4px 16px rgba(0,0,0,.35)", "cursor:pointer",
      "white-space:nowrap", "overflow:hidden", "text-overflow:ellipsis",
    ].join(";");
    el.addEventListener("click", () => el.remove());
    document.body.appendChild(el);
    setTimeout(() => { try { el.remove(); } catch (_) {} }, 15000);
  };
  const ready = () => { try { showNotice(); } catch (_) {} };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", ready, { once: true });
  } else {
    ready();
  }
})();
`

// aica workbench · stream 合成：把 run 内所有节点的 events.jsonl 合并成
// 一条按时间排序的会话流（tool start/end 配对成单卡，空 agent_message 降噪）。
// 兼容两套事件词汇：pi 扩展发 tool_execution/agent_message；夹具发 tool_call+tool_result/message。
import { toolCard, msgBubble, markRow, gateCard } from "./cards.js";

/** nodeEvts: [{path, events:[{i,ts,kind,data}]}] → 有序 item 列表（item.key 稳定） */
export function mergeStream(nodeEvts) {
  const items = [];
  const byCall = new Map();   // `${path}|${call_id}` → tool item
  const lastCall = new Map(); // `${path}|${tool}`    → 未配对 tool_call item
  let seq = 0;

  const push = (it) => { it.key = seq++; items.push(it); return it; };

  for (const { path, events } of nodeEvts) {
    for (const ev of events) {
      const k = ev.kind ?? "_raw", d = ev.data ?? {};
      if (k === "tool_execution") {
        const cid = `${path}|${d.call_id ?? `e${ev.i}`}`;
        let it = byCall.get(cid);
        if (!it) {
          it = push({ type: "tool", node: path, ts: ev.ts, tool: d.tool, args: d.args, done: false, raw: [] });
          byCall.set(cid, it);
        }
        it.raw.push(ev);
        if (d.phase === "end") {
          it.done = true; it.is_error = !!d.is_error;
          it.duration_ms = d.duration_ms; it.output = d.output; it.tsEnd = ev.ts;
        } else if (d.args != null) { it.args = d.args; }
      } else if (k === "tool_call") {
        const it = push({ type: "tool", node: path, ts: ev.ts, tool: d.tool, args: d.args, done: false, raw: [ev] });
        lastCall.set(`${path}|${d.tool}`, it);
      } else if (k === "tool_result") {
        const it = lastCall.get(`${path}|${d.tool}`);
        if (it && !it.done) {
          it.done = true; it.is_error = !!d.is_error; it.output = d.output; it.tsEnd = ev.ts;
          it.raw.push(ev); lastCall.delete(`${path}|${d.tool}`);
        } else {
          push({ type: "tool", node: path, ts: ev.ts, tool: d.tool, done: true,
                 is_error: !!d.is_error, output: d.output, raw: [ev] });
        }
      } else if (k === "agent_message" || (k === "message" && d.role === "assistant")) {
        if (!String(d.text ?? "").trim()) continue; // toolUse 空消息降噪
        push({ type: "msg", node: path, ts: ev.ts, role: d.role, text: d.text, stop: d.stop, tokens: d.tokens, raw: [ev] });
      } else if (k === "gate") {
        push({ type: "gate", node: path, ts: ev.ts, data: d, raw: [ev] });
      } else if (k === "message") {
        push({ type: "mark", mkind: "message", node: path, ts: ev.ts, data: { text: `${d.role}: ${d.text ?? ""}` }, raw: [ev] });
      } else {
        push({ type: "mark", mkind: k, node: path, ts: ev.ts, data: d, raw: [ev] });
      }
    }
  }
  // 跨节点按 ts 归并；同 ts 保持出现顺序
  items.sort((a, b) => String(a.ts).localeCompare(String(b.ts)) || a.key - b.key);
  items.forEach((it, idx) => {
    it.key = idx; // 数组下标：sheet 回查用
    it.skey = `${it.node}#${it.raw?.[0]?.i ?? idx}`; // 稳定键：展开/草稿态跨归并保持
  });
  return items;
}

/** 渲染整流（调用方负责 scroll 锚定与 expanded/draft 状态；seen 集合跨渲染保持，
    未在 seen 中的 item 获得 .enter 追加动画并被记录） */
export function streamHtml(items, { expanded = new Set(), drafts = new Map(), seen = new Set(), nodeFilter = null } = {}) {
  const list = nodeFilter ? items.filter(it => it.node === nodeFilter) : items;
  if (!list.length) return `<div class="dim stream-empty">（暂无事件 — worker 拉起中或节点未产出）</div>`;
  return list.map(it => {
    const fresh = !seen.has(it.skey);
    seen.add(it.skey);
    if (it.type === "tool") return toolCard(it, expanded.has(it.skey), fresh);
    if (it.type === "msg") return msgBubble(it, fresh);
    if (it.type === "gate") return gateCard(it, drafts.get(it.skey), fresh);
    return markRow(it, fresh);
  }).join("");
}

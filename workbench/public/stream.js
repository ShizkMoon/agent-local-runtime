// aica workbench · stream 合成：把 run 内所有节点的 events.jsonl 合并成
// 一条按时间排序的会话流（tool start/end 配对成单卡，空 agent_message 降噪，
// result.status=failed 合成流内 err 卡）。
// 兼容两套事件词汇：pi 扩展发 tool_execution/agent_message；夹具发 tool_call+tool_result/message。
import { toolCard, msgBubble, markRow, gateCard, errCard } from "./cards.js";

/** nodeEvts: [{path, events:[{i,ts,kind,data}]}]；nodes: tree 节点数组（取 result 态合成失败卡） */
export function mergeStream(nodeEvts, nodes = []) {
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
        push({ type: "msg", node: path, ts: ev.ts, role: d.role ?? "user", text: d.text ?? "", raw: [ev] });
      } else {
        push({ type: "mark", mkind: k, node: path, ts: ev.ts, data: d, raw: [ev] });
      }
    }
  }
  // result.status=failed → 流内 err 卡（挂在 finished_at 时间点）
  for (const n of nodes) {
    if (n.status !== "failed") continue;
    push({ type: "errcard", node: n.path, ts: n.finished_at ?? "9999", data: { summary: n.summary },
           raw: [{ i: -1, ts: n.finished_at, kind: "result", data: { status: "failed", summary: n.summary } }] });
  }
  // 跨节点按 ts 归并；同 ts 保持出现顺序
  items.sort((a, b) => String(a.ts).localeCompare(String(b.ts)) || a.key - b.key);
  items.forEach((it, idx) => {
    it.key = idx; // 数组下标：sheet 回查用
    it.skey = `${it.node}#${it.raw?.[0]?.i ?? idx}`; // 稳定键：展开/草稿态跨归并保持
  });
  return items;
}

/** 渲染整流。open 判定：用户手动 toggle 过的卡按 expanded 集合；
    未触碰过的工具卡：运行中自动展开（活着感），完成后回折叠。 */
export function streamHtml(items, { expanded = new Set(), touched = new Set(), drafts = new Map(), seen = new Set(), nodeFilter = null } = {}) {
  const list = nodeFilter ? items.filter(it => it.node === nodeFilter) : items;
  if (!list.length) return `<div class="dim stream-empty">（暂无事件 — worker 拉起中或节点未产出）</div>`;
  return list.map(it => {
    const fresh = !seen.has(it.skey);
    seen.add(it.skey);
    if (it.type === "tool") {
      const open = touched.has(it.skey) ? expanded.has(it.skey) : (!it.done || expanded.has(it.skey));
      return toolCard(it, open, fresh);
    }
    if (it.type === "msg") return msgBubble(it, fresh);
    if (it.type === "gate") return gateCard(it, drafts.get(it.skey), fresh);
    if (it.type === "errcard") return errCard(it, fresh);
    return markRow(it, fresh);
  }).join("");
}

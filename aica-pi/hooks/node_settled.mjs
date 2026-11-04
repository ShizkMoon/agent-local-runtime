// aica hook · node_settled：节点 result 落定后由 daemon 调用（G37 骨架示例/默认实现）
// 契约（照 Claude command-hook 文件态版）：
//   argv[2] = 节点目录；stdin 喂 {spec,result} JSON；5s 超时
//   stdout 输出 JSON，可含 dispatch:[{path,goal,agent?,profile?,accept?}] → daemon 逐个 writeSpec（parent=本节点 id）
// 默认行为：在节点目录 hooks.log 追加一行见证记录，不派任何后续（dispatch:[]）。
// 信任边界：daemon 只认 <aica-pi>/hooks/ 包内目录的文件，run 目录下同名文件不作 hook 源。
import { appendFileSync } from "node:fs";
import { join } from "node:path";

let raw = "";
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  let ctx = {};
  try { ctx = JSON.parse(raw); } catch { /* 喂进来的 JSON 坏了也照常收尾 */ }
  const dir = process.argv[2] ?? ".";
  const line = `${new Date().toISOString()} node_settled ${ctx?.spec?.id ?? "?"} status=${ctx?.result?.status ?? "?"} ${String(ctx?.result?.summary ?? "").split("\n")[0]}\n`;
  try { appendFileSync(join(dir, "hooks.log"), line); } catch { /* 目录不可写不阻塞 */ }
  // 要派后续节点时把对象放进 dispatch；每个 {path,goal,agent?,profile?,accept?}
  process.stdout.write(JSON.stringify({ dispatch: [] }) + "\n");
});

# 快照夹具（S16）

`runs/` 下的三个目录是**真实 run 目录的副本**，取自本机 `%LOCALAPPDATA%\aica\state\runs`，
按体积取最短的三个（2026-11-04 取样）：

| 目录 | 原体积 | 覆盖的场景 |
|---|---|---|
| `ef2706d6-2a3c` | 0.2 KB | 退化态：只有 run.json，没有 nodes/ —— 空 run 不崩 |
| `wb-fixture-demo1` | 6.9 KB | 4 个节点（root split + fetch done + summarize failed + review failed）、tool_call/tool_result 配对、artifacts、gate、reply.txt |
| `372ce026-be1f` | 37.6 KB | 真实 worker 轨迹：agent_desktop 工具 + `ref=artifacts/...` 溢写引用 + ev_done 收口 |

**只删了 `stdout.log`**（34 KB，视图投影不读它），其余文件逐字节保留。

快照里的不确定性由 `view.test.ts` 处理：

- `spec.json` 的 mtime 被**固定**到 `2026-11-03T00:00:00Z`（`el` 耗时依赖它）；
- `now` 显式注入 `2026-11-04T00:00:00Z`（`dur`/`el` 依赖它）；
- `settled` 的 `HH:MM` 依赖本机时区，快照里归一成 `<hh:mm>`，另有一条断言保证它确实是 `HH:MM` 形状。

更新快照：`$env:UPDATE_SNAPSHOTS='1'; node --test workbench/test`（改动投影后**先读 diff 再提交**）。

# node:testr1/root — 验收证据

## 环境与输入（只读核对）
- spec.json: goal="root goal", accept=["a1"]（a1 无附加断言，按"节点可被正常派发、执行、收口"判定）
- worker.json: pid=29880, cmd=pi (opencode-pool/deepseek-v4.1-flash)
- 运行时 node v26.13.0 可用（`node -e` 退出码 0）

## 同 run 状态快照
| 节点 | 状态 | 依据 |
|---|---|---|
| node:testr1/root/sub1 | done / summary="pong" | sub1/result.json、sub1/hooks.log `node_settled ... status=done` |
| node:testr1/root/live1 | 运行中（sleep forever） | live1/events.jsonl 最后一条 tool_execution 2026-11-04T05:26:22.832Z |

## 验收自证
- a1：本节点 worker 启动 → 派发信封可读（spec.json/worker.json）→ 工具链可用（ls/bash/read/write 均返回 is_error=false）→ 产出本 artifact → 调用 ev_done 收口。
  - 证据命令：`ls -la`（退出码 0）、`node -e`（退出码 0）、`cat sub1/result.json`（status=done）
- 未越权：未写 sub1/live1 目录，未改任务库。

## 建议（不在本节点范围内执行）
- live1 的 "sleep forever" 需由上层设置超时或取消，否则 run 永不 settle。

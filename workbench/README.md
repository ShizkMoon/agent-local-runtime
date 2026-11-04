# workbench — aica v0 任务驾驶舱

桥（`server.ts`，node:http+fs+child_process 零依赖）把 `%LOCALAPPDATA%\aica\state\runs\`
暴露成 JSON API + SSE，配 `public/` 静态前端；`workbench.cmd` 起服务后用
Edge `--app=` 开无框窗口（无 Edge 回退默认浏览器）。
界面规范以 `ai-collab-assistant/docs/workbench-ui.md` §7 为定稿（设计令牌/组件/五态）。

## 启动

```
workbench\workbench.cmd        # 或 node workbench\server.ts (WB_PORT 改端口)
```

## UI 形态（§7.1–7.4）

- **左 rail（260px，可折 56px 图标轨）**：三行制 run item（subject / 状态点+节点数+相对时间+耗时 /
  last-event 斜体片段）；rail 底部钉住系统态区（server live / daemon pid / 断开红条）。
- **中央 stream**：全节点事件按时间归并单流 — assistant 消息 prose 直排 + accent 细左线
  （非气泡；user 消息浅底右对齐）；tool_execution 按 call_id 配对成 ToolCard
  （3px 工具色左缘 + icon + args 单行预览 + 时长 + chip，点展开 args/result 全文 +
  `artifacts/` 引用 chip）；spawn/exit/checkpoint/file_edit 细分隔；GateCard
  warn 常态、**付款/删除/对外发布 → err 描边 + 明示后果按钮**（ADR 0002）；
  节点 failed → 流内 err 卡。run 头：subject + 聚合状态 + 事件数/Σtok/时长 + node pills
  （点击过滤 + 节点条：详情 ⇗ / 回复 / artifact chips）。未解除 gate → 流顶置顶细条+定位。
- **右 sheet（400px grid 推挤，Esc 关）**：节点上下文开 Tab 头
  （详情/产物/spec/result/回复），产物 tab 列 artifacts 并就地预览（marked）。
- **Composer（悬浮 ≤720px 居中）**：模式槽 `任务 | 带工具(tools 授权) | 编排(profile=orchestrator)`；
  Enter 派发 → `POST /api/tasks` → `ar dispatch` → ensureDaemon（detached，
  日志 `state/daemon.log`，进程表去重，`--once` 不算）。
- **五态**：空（◈ hero + 建议片）/ 加载（skeleton shimmer）/ 失败（err 卡 + rail 红点）/
  等待（gate 卡 + 置顶条）/ 断开（左下红条 + toast，SSE 退避重连 1s→…→5s）。
- **活着感**：running 工具卡自动展开 + breathe 脉冲，end 后回折叠（手动 toggle 后不干预）；
  新增 item `.enter` 入场；近底吸附，离底 >90px 浮 `↓ 最新`。
- **键盘**：`/` 聚焦 composer、`Esc` 关 sheet、`Enter` 发送。

## API

| 端点 | 说明 |
|---|---|
| `GET /api/runs` | run 列表（meta + 状态汇总 + `last` 尾部事件 + `ended_at`） |
| `GET /api/runs/<id>/tree` | 节点树（path/goal/agent/parent/status/spent） |
| `GET /api/runs/<id>/node/<path>` | spec + result + artifacts + has_reply |
| `GET /api/runs/<id>/node/<path>/events?since=&tail=` | events.jsonl 增量 |
| `GET /api/runs/<id>/node/<path>/artifact/<name>` | artifact 文本（≤512KB） |
| `POST /api/tasks` | `{goal, agent?, model?, profile?, tools?, accept?}` → `ar dispatch` + ensureDaemon → `{root_id, node, daemon}` |
| `POST .../reply` | `ar reply --run --node --text` 注入 spec.reply；失败回退 reply.txt；ensureDaemon |
| `GET /api/daemon` | `{running, cli, spawned}` 常驻 daemon 探活（3s 缓存） |
| `GET /api/stream` | SSE：`runs/` 文件变更推送 |

前端模块：`app.js`（状态/控制器）+ `stream.js`（事件归并）+ `cards.js`（渲染单元）。
数据契约见 `src/envelope.ts`；本目录不改 `src/`。

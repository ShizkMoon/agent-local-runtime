# workbench — aica v0 运行观察台（chat-first）

桥（`server.ts`，node:http+fs+child_process 零依赖）把 `%LOCALAPPDATA%\aica\state\runs\`
暴露成 JSON API + SSE，配 `public/` 静态前端；`workbench.cmd` 起服务后用
Edge `--app=` 开无框窗口（无 Edge 回退默认浏览器）。选 Edge 而非 Tauri：
本机无 Rust/MSVC 工具链；桥/渲染分层已隔离，后续换壳只动窗口层。

## 启动

```
workbench\workbench.cmd        # 或 node workbench\server.ts (WB_PORT 改端口)
```

## UI 形态（综合 T3Code / Grok / Codex Desktop / DSBot 的视觉与功能）

- **左 rail（262px）**：run 列表 — 状态点（running 脉环动画 / done 绿 / failed 红 /
  split 紫）、subject、相对时间 + 节点数 + 耗时、**最后一行事件预览**
  （`last_event` 尾部读取）；SSE 驱动刷新，有 running run 时 15s tick 刷耗时。
- **中央 stream**：选中 run 的全部节点事件按时间归并成一条会话流 —
  `agent_message` 渲染为 markdown 气泡（prose 字体）；`tool_execution`（及旧词汇
  tool_call/tool_result）按 call_id 配对成紧凑工具卡：kind 色左边框 + icon +
  name + args 单行预览 + 时长 + 状态 chip，点击 **grid-rows 平滑展开** args/result
  全文 + `artifacts/` 引用自动变可点 chip；`spawn`/`exit`/`checkpoint`/`file_edit`
  为细分隔标记；`gate` 渲染带选项按钮与回复输入的卡片。
  新增 item 追加时 `.enter` fade-slide 动画；近底自动吸附，离开底部出现悬浮
  「↓ 最新」跳转钮。run 头部：subject + 聚合状态 + **聚合统计**（事件数 /
  Σ tokens / 时长）+ node pills（点击过滤流并展开节点条：spec/result/raw +
  artifact chips + 回复）。无选中 run 时显示 **hero 空态**（logo + 说明 +
  建议任务快捷 chips 填入 composer）。
- **右 sheet（388px，可关）**：点工具卡「完整事件」/ artifact chip / spec|result /
  run meta 按钮打开；markdown artifact 经 vendored marked 渲染，其余 pretty
  JSON；Esc 关闭，环境阴影 + grid 过渡滑入。
- **底部 composer**：浮起圆角大卡（focus 光环），Enter 派发（Shift+Enter 换行）→
  `POST /api/tasks` → `ar dispatch`（stdin 收任务 JSON，内部 createRun + 写根
  spec）→ 确保常驻 `ar daemon`（detached，日志
  `%LOCALAPPDATA%\aica\state\daemon.log`；PowerShell 进程表去重，`--once` 不算）。

## API

| 端点 | 说明 |
|---|---|
| `GET /api/runs` | run 列表（meta + 状态汇总 + `last` 尾部事件预览 + `ended_at`） |
| `GET /api/runs/<id>/tree` | 节点树（path/goal/agent/parent/status/spent） |
| `GET /api/runs/<id>/node/<path>` | spec + result + artifacts 清单 + has_reply |
| `GET /api/runs/<id>/node/<path>/events?since=&tail=` | events.jsonl 增量读取 |
| `GET /api/runs/<id>/node/<path>/artifact/<name>` | artifact 文本（≤512KB） |
| `POST /api/tasks` | `{goal, agent?, model?, tools?, accept?}` → `ar dispatch` + ensureDaemon → `{root_id, node, daemon}` |
| `POST .../reply` | `ar reply --run --node --text` 注入 spec.reply；失败回退写 reply.txt；成功后 ensureDaemon |
| `GET /api/daemon` | `{running, cli, spawned}` — 常驻 daemon 探活（3s 缓存） |
| `GET /api/stream` | SSE：`runs/` 文件变更推送 |

前端模块：`app.js`（状态/控制器）+ `stream.js`（事件归并）+ `cards.js`（渲染单元）。
数据契约见 `src/envelope.ts`；本目录不改 `src/`。

# workbench — aica v0 运行观察台

只读桥（`server.ts`，node:http+fs 零依赖）把 `%LOCALAPPDATA%\aica\state\runs\`
暴露成 JSON API + SSE，配 `public/` 静态前端；`workbench.cmd` 起服务后用
Edge `--app=` 开无框窗口（无 Edge 回退默认浏览器）。选 Edge 而非 Tauri：
本机无 Rust/MSVC 工具链；桥/渲染分层已隔离，后续换壳只动窗口层。

## 启动

```
workbench\workbench.cmd        # 或 node workbench\server.ts (WB_PORT 改端口)
```

## API

| 端点 | 说明 |
|---|---|
| `GET /api/runs` | run 列表（meta + 状态汇总） |
| `GET /api/runs/<id>/tree` | 节点树（path/goal/agent/parent/status/spent） |
| `GET /api/runs/<id>/node/<path>` | spec + result + artifacts 清单 |
| `GET /api/runs/<id>/node/<path>/events?since=&tail=` | events.jsonl 增量读取 |
| `GET /api/runs/<id>/node/<path>/artifact/<name>` | artifact 文本（≤512KB） |
| `POST .../reply` | 写 `reply.txt`（v0.1 接 gate 注入 spec.reply） |
| `GET /api/stream` | SSE：`runs/` 文件变更推送 |

数据契约见 `src/envelope.ts`；本目录不改 `src/`。

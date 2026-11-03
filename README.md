# ar — agent:local 运行时（v0 骨架）

`agent:local` 执行器的命令面与宿主。设计见 ai-collab-assistant 仓 `docs/agent-local-runtime.md`（协议见 `docs/multi-agent-runtime.md`）。

## 组件

- `src/cli.ts` — `ar` CLI（无状态）：`run-create` / `dispatch`（evd stdin 入口）/ `node-create` / `check` / `reply` / `done` / `fail` / `event` / `daemon` / `version`，统一 JSON envelope 输出
- `src/runs.ts` — `runs/<root_id>/` 运行目录读写（spec.json / result.json / events.jsonl / index.jsonl）
- `src/daemon.ts` — 用户会话宿主：扫"有 spec 无 result"的节点，按 `spec.agent` 选 launcher 拉起 Worker 进程，回收写 result
- `src/envelope.ts` — 信封类型（v0 手写类型，后续换 TypeBox）
- `aica-pi/` — Worker 的 pi package 骨架：`extensions/tools.ts`（ev/kn/agent-desktop/ego-browser/ar 五工具）、`extensions/events.ts`（events.jsonl 事件流，待挂钩 pi 事件 API）

## 运行

```bash
node src/cli.ts version        # Node ≥22.19，type stripping 直跑 TS
node src/cli.ts daemon         # 拉起宿主循环（用户会话内，非服务）
```

状态目录：`%LOCALAPPDATA%\aica\state\runs\`（可用 `AICA_STATE` 覆盖）。

## v0 边界

- Worker launcher 仅接 `pi`/`claude`/`codex` 三个 spawn 适配器，Worker 未写 result 时按退出码兜底
- `aica-pi` 扩展是骨架：`events.ts` 待对接 pi extension 事件钩子，`tools.ts` 待按 pi 签名注册
- 待做：worktree 管理、terminal create/wait、orchestration gate、依赖 DAG 调度（v1）

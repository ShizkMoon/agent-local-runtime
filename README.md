# agent-local-runtime · AICA 工作台

> **这是一个半成品。** 能跑、能用、每天在用，但离"完工"还差一截——文末「已知未完成」把这些缺口逐条列出来了，
> 不粉饰、不写成 roadmap 里的"即将支持"。仓库公开是为了留个可核对的过程，不是发布产品。

一个本地优先的 Agent 运行时 + Windows 客户端。核心是 `ar`（运行时 CLI）与 `aica-pi`（Pi 的扩展包），
上面是工作台（WebView2 客户端 + 本地桥 + 单页 UI）。设计目标是：**看得懂、能干预、可解释、可自进化**。

## 设计初衷

1. **Agent 应该有个"工作台"，而不是一个聊天框。** 三栏：左边是任务，中间是这件事怎么发生的，
   右边是"现在需要你做什么"。中间永远结论在前、过程在后——先看到结果，想追问再展开命令。
2. **审批要能被解释，而不是弹一个"允许/拒绝"。** 每张卡说清楚"要做什么、为什么、影响谁"，
   动作由服务端生成（闭集），危险路径（`rm -rf /`、家目录、控制面文件）直接硬拒，不进审批。
3. **薄核心 + 扩展。** 照 Pi 的哲学：agent loop 与基础工具之外，能力都放在
   `extensions/`（工具与门禁）、`skills/`（做法）、`hooks/`（生命周期）、`prompts/`（角色）里，
   加能力不改核心。
4. **可自进化。** Agent 可以对自己的仓库提"提案"（`ev_propose`）——提案是文件（diff + 验收命令），
   必须人审、必须跑验收、必须能字节级回滚。它不能直接改自己；它能提议，人来批。
5. **可恢复。** 进程会死、桥会断、机器会重启。孤儿节点不会重放（标 `orphaned`），
   事件带 `seq`，中断后能从 checkpoint 接着走，分叉走 fork。

## 现在有什么（可用）

| 面 | 能力 |
|---|---|
| 运行时 | `ar` CLI 20+ 子命令、JSON 信封 + 稳定错误码与退出码；daemon 扫描并拉起 worker；run/节点目录即真相（`spec/result/events/usage/worker`） |
| 启动 | 桌面「AICA 工作台」快捷方式，GUI 子系统无控制台；单实例；托盘（显示/新建任务/退出）；`Ctrl+Alt+A` 全局热键；关闭即收起 |
| 工作台 | 三栏；工具时间线（人形摘要 + 展开原文 + 退出码/耗时）；结论优先；diff 呈现；计划条；审批卡（500ms 防误批）；投递三态（queue / interrupt / steer 不支持）；Git 页签；通知与未读；命令面板 `Ctrl+K`；设置 `Ctrl+,` |
| 权限 | 三档模式（只读 / 可编辑 / 全权限）；gate 闭集 `allowed-once/rejected/cancelled/unavailable`；deny/restricted/grant 分离；危险路径硬拒；审批 TTL |
| 上下文 | AGENTS.md/CLAUDE.md 注入；`@file` 引用；压缩事件与用量账本；`learned.md`；斜杠命令（`ar cmd list`） |
| 编辑 | `apply_patch` 多文件 unified diff（上下文不匹配整次失败、read-before-edit） |
| 扩展 | MCP（HTTP JSON-RPC + stdio，fail-closed 白名单）；spawn 子代理与并发；5 个 skills；`ev_propose` → `ar propose apply`（临时树验真 + 字节级回滚 + stale 保护） |
| 质量 | 268 条测试（`node --test workbench/test`，264 pass / 4 skip）；e2e 夹具 + 故障注入；500 run warm p50 ≈ 40ms |

## 已知未完成（这就是"半成品"的部分）

- **steer 没有实现**：真插话要 Pi 的 RPC，现在是 `UNSUPPORTED`，UI 里置灰并说明。
- **MCP 只有基础能力**：HTTP/stdio 注册与调用、超时降级可用；没有工具变更通知、没有重连。
- **自进化的"自动应用"很保守**：只对 `risk=low` 且开关打开时才自动，没有评分模型判断"改得好不好"。
- **UI 只完成 P0/P1 的体验修正**，设计 token 已落地（`tokens.css`）但 `index.html` 还没换装；
  字号/间距/焦点态仍是旧值，P2 的四条（设置遮住决策队列、标度、骨架屏、焦点可见）没做。
- **子代理体系**：`spawn` 与并发上限可用，但"子代理产出如何回灌父节点上下文"只做了最简版。
- **测试有 4 条显式 skip**（无浏览器环境的 UI 断言、部分夹具无 stdout 等），原因都写在测试里。
- **没有 LICENSE**；仓库暂时"源码公开、权利保留"。要真正开源请先加 LICENSE。

## 快速开始

需要 Node ≥ 22.19（直接跑 `.ts`，不需要构建）。

```bash
# 1) 拉起宿主（用户会话内，不是系统服务）
node src/cli.ts daemon

# 2) 起工作台桥 + 页面（也可直接用桌面快捷方式）
node workbench/server.ts          # 默认 http://127.0.0.1:4399

# 3) 构建 Windows 客户端（可选）
cd workbench/shell
go build -ldflags "-H windowsgui -s -w" -o "dist/windows-amd64/AICA 工作台.exe" .
```

状态目录：`%LOCALAPPDATA%\aica\state`（`AICA_STATE` 可覆盖）；日志在同目录 `workbench-shell.log` / `workbench-server.log`。

派一条任务（真机链路）：

```bash
curl -X POST http://127.0.0.1:4399/api/tasks -H "content-type: application/json" \
  -d '{"goal":"用 bash 执行 echo hi，然后调用 ev_done 汇报","kind":"task","profile":"worker"}'
```

## 目录

```
src/            ar 运行时（cli / daemon / runs / 信封 / 审批相关 / patch / mcp / proposals）
aica-pi/        Pi 扩展包：extensions（工具与 gate）、skills、hooks、prompts
workbench/      工作台：server.ts（桥）、view.ts（投影）、public/v1（UI）、shell（Windows 客户端）
docs/           PRD v3、研究稿、UI 规范、审计
workbench/test/ 单测 + e2e 夹具与故障注入
```

## 依据

- 设计文档：`docs/prd-workbench-v3.md`（能力基线、质量属性、机制吸收表、UI P1–P20）
- 七家 Agent 的源码级研究：`docs/research/`（DeepSeekHarness / Claude Code / Codex / T3 Code / OpenCode / Oh My Pi / Misaka-Agent / Cindy）
- 可用度审计：`docs/ux-audit-r5.md`

## 安全

这个程序会执行 shell 命令、读写文件、调用外部模型。默认档是"可编辑 + 监督审批"，
危险路径有硬拒；但**它仍是半成品，别拿它跑你赔不起的东西**。所有破坏性动作都应经审批卡，
如果你发现某条路能绕过审批，那是 bug，请提 issue。

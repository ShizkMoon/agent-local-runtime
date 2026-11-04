# agent-local-runtime

本地 Agent 运行时与 Windows 工作台。

**状态：半成品。** 日常在用，但不完整——「没做完的」一节列了具体缺口。

## 为什么做这个

现有 CLI Agent（Codex、Claude Code 这类）能力很强，但有两个问题：工具调用与审批过程基本不可见、不可干预；
想改它的行为只能等上游。这个项目的出发点是：

- **过程可读**：一次任务先给结论，再按需展开每一步的命令、参数、输出、耗时、退出码。
- **审批可解释**：每个待批准的动作说清楚要做什么、为什么、影响什么；危险路径（删根目录、家目录、控制面文件）直接拒绝，不弹卡。
- **核心小、能力外挂**：按 Pi 的做法，工具、做法（skills）、生命周期（hooks）、角色提示词都放在扩展包里，加能力不动核心。
- **能改自己**：Agent 可以对仓库提交改动提案（diff + 验收命令），人审后应用，验收不过自动回滚。
- **中断可续**：进程死了不重放已执行的副作用，事件带序号，可以从断点继续或分叉。

## 能用的

| 模块 | 说明 |
|---|---|
| 运行时 `src/` | `ar` CLI（20+ 子命令，JSON 信封 + 稳定错误码）、daemon 拉起 worker、run/节点目录即真相 |
| 客户端 `workbench/shell` | 桌面快捷方式启动、无控制台、单实例、托盘、`Ctrl+Alt+A` 全局热键、窗口位置记忆、文件拖放 |
| 工作台 `workbench/` | 三栏界面；工具时间线；结论优先；diff；计划条；审批卡；投递（排队/打断）；Git 页签；通知未读；命令面板；设置 |
| 权限 | 只读/可编辑/全权限三档；审批决策闭集；deny/restricted/grant 分离；危险路径硬拒 |
| 上下文 | AGENTS.md 注入、`@file` 引用、用量账本与压缩事件、`learned.md`、斜杠命令 |
| 编辑 | `apply_patch` 多文件补丁（上下文不匹配整次失败；未读文件先拒） |
| 扩展 | MCP（HTTP 与 stdio，白名单外不可调用）、子代理 spawn 与并发、5 个 skills、提案流水线 |
| 测试 | `node --test workbench/test`：268 条，264 通过 / 4 跳过；含 e2e 夹具与故障注入 |

## 没做完的

- **steer 未实现**：真插话需要 Pi 的 RPC，现在返回 `UNSUPPORTED`，界面里置灰说明。
- **MCP 只有基础功能**：注册、调用、超时降级可用；没有工具变更通知与重连。
- **提案自动应用很保守**：只对低风险提案自动应用，没有质量评分。
- **界面只做到 P0/P1 修正**：设计 token 已有（`tokens.css`），`index.html` 尚未换装；骨架屏、焦点态、字号标度仍是旧值。
- **子代理回灌**：spawn 与并发可用，子节点产出回传父节点上下文只做了最简版。
- **4 条测试跳过**（无浏览器环境、部分夹具缺 stdout），原因写在测试里。
- **没有 LICENSE**：源码公开，权利保留。

## 运行

需要 Node ≥ 22.19（直接执行 `.ts`，无需构建）。

```bash
node src/cli.ts daemon            # 宿主循环（用户会话内，不是系统服务）
node workbench/server.ts          # 工作台桥，默认 http://127.0.0.1:4399
```

构建 Windows 客户端：

```bash
cd workbench/shell
go build -ldflags "-H windowsgui -s -w" -o "dist/windows-amd64/AICA 工作台.exe" .
```

状态目录 `%LOCALAPPDATA%\aica\state`（可用 `AICA_STATE` 覆盖），日志在同目录。

派一条任务：

```bash
curl -X POST http://127.0.0.1:4399/api/tasks -H "content-type: application/json" \
  -d '{"goal":"用 bash 执行 echo hi，然后调用 ev_done 汇报","kind":"task","profile":"worker"}'
```

## 目录

```
src/            ar 运行时：cli、daemon、runs、信封、审批、patch、mcp、proposals
aica-pi/        Pi 扩展包：extensions（工具与 gate）、skills、hooks、prompts
workbench/      工作台：server.ts（桥）、view.ts（投影）、public/v1（页面）、shell（Windows 客户端）
docs/           PRD、研究稿、UI 规范、可用度审计
workbench/test/ 单元测试与 e2e 夹具
```

## 文档

- 设计：`docs/prd-workbench-v3.md`
- 七家 Agent 源码调研：`docs/research/`
- 可用度审计：`docs/ux-audit-r5.md`

## 注意

程序会执行 shell 命令、读写文件、调用外部模型。默认档为监督审批，危险路径有硬拒；
但这是半成品，没有做安全加固，不建议直接用在重要环境。发现可以绕过审批的路径，请提 issue。

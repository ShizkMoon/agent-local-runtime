# aica Workbench v1 PRD — 本机单人多 agent 工作台

> 状态：草案 v1 · 调研基准日 2025-11（以仓内源码 + 各竞品一手源码/官方文档为准）
> 相关文档：ai-collab-assistant 仓 `docs/agent-local-runtime.md`（设计）、`docs/multi-agent-runtime.md`（协议）、`docs/workbench-ui.md` §7（UI 定稿）
> 本文回答一个问题：**要把 workbench 从「能跑通闭环的 v0」做到「日常可依赖的 v1」，差什么、先补什么、怎么验收。**

---

## 1. 定位与目标

**一句话定位**：本机单人的多 agent 工作台 —— `dir-6` 视觉标准 + `ar` 文件态运行时 + `pi` worker 的组合，对标 Codex 桌面应用 / Claude Code / OpenCode TUI / T3 Code 控制面这一类产品，但坚持两条独有原则：

1. **文件态是唯一真相源**。`%LOCALAPPDATA%\aica\state\runs\<root>\nodes\<path>\{spec,result,gate,events.jsonl,artifacts,stdout.log}` 既存储又通信，UI 只是投影，daemon 只是消费者。进程可以死，状态不丢（`src/runs.ts`、`workbench/server.ts:1-5` 注释）。
2. **信封即契约**。每个节点一份 `spec.json`（goal/accept/budget/tools/parent），worker 只写 `result.json`，人工只写 `spec.reply`/gate 答复。编排（orchestrator）与执行（worker）共用同一信封协议（`src/envelope.ts`、`aica-pi/prompts/*.md`）。

**v1 目标**：单人日常可用 —— 发任务、看进度、批闸门、拿产物，且做到三件事：

- **看得见**：turn 级消息流（模型在想什么、调了什么、出了什么）实时投影进 UI，而不是只有 12 条粗事件。
- **拦得住**：单次工具调用级的人机闸门（approve/deny），不必为一条危险命令挂起整个节点。
- **续得上**：gate/reply/失败重试都不丢 worker 上下文；父节点能等子节点并拿到回传。

**非目标**（v1 明确不做）：多人协作、云端执行、远程访问、移动端、git worktree 隔离、sandbox 边界（与 pi 现状对齐，见 §5-G25）。

---

## 2. 研究对象一手画像

每条只写与 v1 决策有关的事实，出处用一手链接/本地文件。

### 2.1 Pi（`earendil-works/pi`，本机 `@earendil-works/pi-coding-agent@1.5.0`）

我们的 worker 引擎。刻意极简："small extensible core"，几乎一切能力走 TypeScript extension。

- **执行模型**：同一 session 引擎五个入口 —— interactive TUI / `-p` print / `--mode json`（JSONL 事件流）/ `--mode rpc`（stdin 命令 + stdout 事件，长驻）/ SDK `createAgentSession`。`docs/how-pi-works.md:33-39`、`docs/json.md`、`docs/rpc.md`。
- **子代理**：**无内置**。官方示例 `examples/extensions/subagent` 用 spawn 子 pi 进程实现 single/parallel/chain 派发、JSON 模式回收结构化输出（本机 `…/examples/extensions/subagent/index.ts` 头注释）。即「子代理=扩展点」是 pi 的官方姿势。
- **人机闸门**：**无内置审批**（`docs/security.md:3` 明说 "does not ask for approval before every tool call"）。但扩展 `pi.on("tool_call")` 可 `block`/改参，配合 `ctx.ui.confirm` 即审批门（`docs/extensions.md` quickstart 示例正是此用例）；headless 下 RPC 模式把 `select/confirm/input/editor` 对话框转成 `extension_ui_request/response` 记录交给宿主应答（`docs/rpc-extension-ui.md`）—— **T3 Code 正是靠这个 hook 给 pi 加权限模式的**（`t3code/docs/user/providers-pi.md`："applies the composer permission mode through Pi's blocking tool hook"）。
- **上下文/产物**：session = JSONL 树（branch/fork/clone），active branch 供历史；自动+手动 compaction 写 CompactionEntry 不删原始条目（`docs/sessions.md`、`docs/compaction.md`）；context files（AGENTS.md/CLAUDE.md）；skills 描述进 system prompt、SKILL.md 全文按需加载（`docs/skills.md:43-45`）。
- **工具面**：内建 `read/bash/edit/write` + 内置扩展 `codemode`/`tool_search`；`--tools`/`--exclude-tools`/`defaultTools`；MCP 有**四级曝光**（direct/codemode/deferred/hidden）+ `toolExposure` 通配 + OAuth 全套（`docs/mcp.md:193-236`）。
- **持久化**：`~/.pi/agent/sessions/` 按 cwd 分组的 JSONL session；`--continue/--resume/--session <path|id>/--session-id <id>/--session-dir`（`docs/cli.md:86-98`）；`--no-session` 即本仓现状（`src/daemon.ts:88`）。
- **事件流**：`--mode json` 已发全套 turn 级事件 —— `message_update` 携 `text_delta`/`thinking_delta`/`toolcall_delta`、`tool_execution_start/update/end`、`turn_start/end`、`auto_retry_*`、`compaction_*`（`docs/json.md:50-170`）。RPC 命令面有 `steer`/`follow_up`/`abort`/`clear_queue`/`get_state`/`fork`（`docs/rpc-commands.md`）。
- **自进化**：extension 可注册 tools/commands/shortcuts/flags/providers/MCP/renderers/UI 并订阅 ~40 个生命周期事件（`docs/extensions.md`）；skills 遵循 Agent Skills 规范；prompt templates；pi packages 经 npm/git 分发。

### 2.2 Oh My Pi（`can1357/oh-my-pi`，omp.sh）

pi 的 batteries-included 硬分叉（Stencil Labs）。~80k 行 Rust 核 + 31 内建工具 + 60+ provider。README 一手特性：

- **执行模型**：`omp` TUI / `omp -p` / `--mode rpc`（NDJSON in/out，含 `prompt`/`set_model`/`abort`）/ Node SDK（`createAgentSession`/`SessionManager`）/ `omp acp`（ACP over JSON-RPC）。`eval` 工具是持久 Python+JS kernel，可回调 agent 工具。
- **子代理（一等公民）**：`task` 工具并行 fan-out，**可选 workspace 隔离**（pi-iso crate：apfs/btrfs/zfs/reflink/overlayfs/projfs），返回 schema 校验过的 typed 结果；`agent://<id>/<jsonpath>` 直接抽子代理产物字段；`wait` 阻塞至后台结果/对等消息；`orchestrate`/`workflowz` magic words；`/vibe` director 模式驱动 read-only worker 池。**Agent Hub（Alt+A）**：所有 subagent 的 roster、实时 transcript、steer 输入、revive、kill —— 这是本项目树视图对标的 UI。
- **人机闸门**：破坏性工具弹权限卡（"answer once and forget"）；`ask` 工具=轮内结构化选择器（同样经 ACP `session/request_permission` 透出）；**advisor 角色**——第二个模型逐轮审查主 agent 输出并内联注入意见。
- **上下文/产物**：sessions+/fork/resume；`checkpoint`/`rewind` 剪枝探索上下文；**memory 工具组**（`retain/recall/reflect/memory_edit` + `learn`→可提升为 managed skill）；`snapcompact` 图像帧压缩；**stream rules**：正则命中即 abort 流、注入规则、同点重试（穿越 compaction 存活）。
- **工具面**：31 内建（`read/write/edit`(hashline)/`ast_edit`/`ast_grep`/`grep`/`glob`/`bash`(内嵌 bash5.3+58 coreutils，会话持久)/`eval`/`lsp`(14 ops)/`debug`(DAP 28 ops)/`security_scan`/`task`/`wait`/`todo`/`ask`/`browser`/`computer`/`web_search`(23 后端链)/`github`/`generate_image`/`tts`/memory 组）；`xd://` 发现式设备工具；`--tools` pin。
- **模型面**：9 个 model roles（default/smol/slow/plan/commit/vision/task/advisor/tiny）按意图路由 + fallback chains + path-scoped models + round-robin 凭据。
- **自进化**：同 pi 的 extension/skills/hooks 面 + `learn`→managed skill 的自写回路 + plugin marketplace/npm 分发；开仓即继承 `.claude/.cursor/.codex/.gemini/.cline/.windsurf` 等 8 家配置。

### 2.3 Codex（`openai/codex`）

- **执行模型**：Rust；TUI + `codex exec` 非交互 `--json`（事件：`thread.started/turn.started/turn.completed/turn.failed/item.started/item.updated/item.completed/error`；item 类型 `agent_message/command_execution/reasoning/file_change/mcp_tool_call/web_search/plan_update/todo_list` —— `codex-rs/exec/src/exec_events.rs` + developers.openai.com/codex/noninteractive）；`--output-schema` 结构化产出；`-o` 尾消息落盘；`codex resume`/`exec resume <thread_id>`；rollout JSONL `~/.codex/sessions/`。
- **子代理**：`[features] multi_agent=true` 实验特性 —— `[agents]` 配角色（各自 model/instructions/**sandbox**/MCP），内建 `spawn_agent/wait_agent/close_agent/send_input` + `spawn_agents_on_csv` 批量，`max_threads`(默认6)/`max_depth`(默认1)/`job_max_runtime_seconds`；结果汇总回主线程，子代理间不能互发消息（`codex-rs/core/templates/collab/experimental_prompt.md` 一手 + learn.chatgpt.com/docs/agent-configuration/subagents）。
- **人机闸门（最强）**：**双轴** —— `sandbox_mode`（read-only/workspace-write/danger-full-access，OS 级 Landlock/seatbelt 真边界，网络默认断）× `approval_policy`（on-request/on-failure/never；untrusted 已退役）；目录 trust 决定默认档；`/approvals` 切换；`--approve-for-me` 自动评审；`--dangerously-bypass-approvals-and-sandbox` 兜底；`execpolicy` 规则文件（`docs/sandbox.md` + `codex-rs/utils/cli/src/shared_options.rs`）。
- **上下文**：`AGENTS.md` 指令文件发现；rollout 持久化；compact；`plan_update` item 类型。
- **持久化/恢复**：session rollout 文件 + `exec resume --fork`；云端 tasks 走 Codex Cloud（独立环境）。
- **自进化**：`AGENTS.md`、skills、`config.toml` profiles、MCP servers（`[mcp_servers]` TOML）、execpolicy；无 Claude Code 式 hook 体系。

### 2.4 Claude Code（Anthropic，官方文档 code.claude.com/docs）

- **执行模型**：CLI TUI / `-p` print / `--output-format stream-json` / Agent SDK / IDE 扩展 / Desktop / web 会话；`--continue/--resume/--fork-session`。
- **子代理**：Task 工具 + `.claude/agents/*.md` 自定义子代理（frontmatter：`tools/model/permissionMode/skills/hooks`）；**agent teams**（teammates + `TeammateIdle` hook）；plan 模式下只读 **Plan subagent** 做调研；子代理独立上下文、可独立权限档（`docs/en/sub-agents`）。
- **人机闸门（最细）**：三层 —— ① `allow/ask/deny` 规则（settings.json，**评估顺序 deny→ask→allow**，裸名 deny=工具从上下文消失，带模式 deny=调用时拦截），"don't ask again" 写回 `settings.local.json`；② **permission modes**：`default/acceptEdits/plan/auto(分类器评审)/bypassPermissions/dontAsk`；③ `PermissionRequest` hook 事件 + 批准时可 Tab 附言（`docs/en/permissions`、`docs/en/permission-modes`）。
- **hooks（最全的自进化面）**：~30 个事件 —— `SessionStart/End`、`UserPromptSubmit`、`PreToolUse`（可返 `permissionDecision: allow/deny/ask`）/`PostToolUse`/`PostToolBatch`、`SubagentStart/Stop`、`TaskCreated/Completed`、`PreCompact/PostCompact`、`Notification`、`FileChanged`、`CwdChanged`、`WorktreeCreate/Remove`、`Elicitation`（MCP 服务器向用户提问！）、`PreModelSwitch` 等；handler 形态 = shell 命令(stdin JSON→stdout JSON 决策)/HTTP endpoint/MCP tool/LLM prompt/subagent；skill 与 subagent frontmatter 可直接内嵌 hooks（`docs/en/hooks`）。
- **上下文**：`CLAUDE.md` + `.claude/rules/*.md`（`InstructionsLoaded` hook 可见加载）；SKILL.md 渐进披露；auto-compact（`PreCompact/PostCompact`）；TaskCreate/TaskCompleted 任务清单。
- **自进化**：hooks + skills + subagents + slash commands + plugins/mods（JS 函数级 hook，可画 UI）+ MCP。

### 2.5 OpenCode（`sst/opencode`，opencode.ai）

- **执行模型**：**server-first** —— TUI 只是 `opencode serve` HTTP server 的客户端；OpenAPI 3.1 spec + SSE `/event` + 生成的 SDK；`opencode run`/`web`/desktop/IDE。`docs/server/`、`docs/cli/`。
- **子代理**：`opencode.json` 里 agent 声明 `mode: primary|subagent`（各自 model/prompt/permission），task 工具派发；`.opencode/agents/*.md` 也支持（`docs/agents/`）。
- **人机闸门**：per-agent `permission` 配置，每个 key `ask|allow|deny`：read/edit/bash/glob/grep/list/task/todowrite/**external_directory**/webfetch/websearch/lsp/skill/question/**doom_loop**（防循环）等；`--auto` 自动批准非 deny 项。
- **持久化**：sessions + `session list/export/import --sanitize`；`--continue/--session/--fork`。
- **自进化**：`opencode.json`（agents/commands/MCP/LSP/formatter/watcher/plugins/permissions）+ `.opencode/plugins/*.ts`（JS/TS 模块 hook 事件 + 自定义工具 + plugin RPC）+ npm plugin 包。
- **特色**：provider 池最大（models.dev 目录 + OpenCode Zen 订阅路由）；`opencode github` 装 GitHub Actions agent。

### 2.6 DeepSeek Harness（`deepseek-ai/deepseek-harness`，`dsh`）

DeepSeek 官方 harness，"Everything is a Plugin"（Cordis 组合树）。`envelope.ts:6` 的 `AgentKind` 里已预留 `"dsh"`。

- **执行模型**：`npx @deepseek-ai/dsh web` → Web UI（127.0.0.1:3080）+ Desktop；examples：`headless-agent`/`jsonrpc-agent`/**`acp-agent`**（session+permission+cancellation 的 ACP 服务）/`web-cordis`；Python SDK `DeepSeekHarness(...).run()`。
- **工具管线（最值得抄）**：`docs/tool-execution-pipeline.md` —— `tools/pre-execute` waterfall（hooks/permission/sandbox）→ **monotonic guards**（deny 或弃权，身份保护）→ `tools/execute` waterfall（timeout/retry/metrics）→ `fs/write-intent`/`fs/edit-intent` 文件守门 → `tools/post-execute`（accept/block/replace）→ `tools/result` 同步通知。PTC 模式（`run_code` 带子调用父 token）走同一管线。
- **人机闸门**：`docs/subsystems/approval.md` —— `ctx.approval.request(req)` 一次性问答，闭集 outcome **`allowed-once|rejected|cancelled|unavailable` 全部 fail-closed**；answerer waterfall（UI/ACP 均可注册 answerer）；per-session `ask|never` policy（never=CI 严格无头）；`approval/asked`+`approval/decided` 审计对（**只进日志不进模型 transcript**）；`callId` 把审批问题挂到已流出的工具调用上。
- **子代理**：`docs/subsystems/subagent.md` —— subagent tree（local Session 子代理 + 外部执行后端统一 activation API）；`sendMessage` 到运行中目标=**Steer**，到离线目标=**cold resume**；`parent|caller` 两种结果投递；`outputSchema` 结构化产出；`maxDepth`；`drainDescendants` 等整树收尾；`agent-team.md` 共享任务 + task policy。
- **持久化**：session = durable event log（commit/replay 边界）；compaction/spill/session-projection/session-query/session-telemetry/persistence catalog 各自是子系统。
- **其他子系统**：plan、worktrees、jobs/schedule、webhook、liveshare、user-questions、todo、skills、mcp、sandbox、terminal —— 每个都是独立插件包（`docs/subsystems/` 60+ 篇，全部源码生成目录）。

### 2.7 T3 Code（`pingdotgg/t3code`，t3.codes）

**与本项目同构** —— "agent harness control surface"：Node WebSocket server 包住各家 provider CLI，服务 web/desktop/mobile 三端。支持 Codex/Claude/Cursor/Grok/OpenCode/Antigravity/**Pi**/fx/Muse/Kiro/ACP registry。

- **执行模型**：thread = provider session；每 thread 独立分支；`delegate_task` 建 durable 子 thread（共享 subagent UI，**子代理的审批请求冒泡到父会话显示并可就地答复** —— `docs/user/permission-modes.md`）。
- **人机闸门**：thread 级 permission modes —— **Supervised / Auto-accept edits / Auto(用 provider 自己的评审器)/Full access**，逐 provider 映射（Pi→blocking tool hook；Claude→permission modes；Codex→approval policy）；审批挂起时**发文字回复=拒绝并给 agent 反馈**；managed policy 可压低可用档位上限。
- **上下文**：用 provider 原生 session 文件做 resume/rollback/fork（Pi 接入文档明说 "threads use Pi's native session files"）+ portable handoffs + composer context meter。
- **工具面**：provider 自带工具 + terminal 面板 + source-control（diff review、**一键 commit/push/PR**、stack/amend）+ dev-server preview。
- **持久化/远程**：服务端 thread 存储；remote-ready（LAN/Tailscale/T3 Connect 隧道）；`t3 service install` 常驻；mobile notifications + guest links。
- **对我们的启发**：它证明了「pi + blocking tool hook + RPC extension UI」就能撑起完整审批面 —— 我们不需要换引擎。

---

## 3. 对比矩阵

单元格 = 一句话能力描述。**本项目**列前缀判定：✅ 已具备 / ⚠️ 部分具备或骨架 / ❌ 缺失。

| 维度 | Pi（引擎） | Oh My Pi | Codex | Claude Code | OpenCode | DeepSeek Harness | T3 Code（控制面） | **本项目现状** |
|---|---|---|---|---|---|---|---|---|
| 执行模型 | TUI/-p/json/rpc/SDK 五入口同一引擎 | 同 pi + ACP + 持久 eval kernel | TUI + exec --json + cloud | CLI/-p/stream-json/SDK/IDE/桌面 | server-first：TUI 是 HTTP 客户端 | Cordis 插件树，web/ACP/SDK/headless | WS server 包各家 CLI | ⚠️ ar CLI + daemon 文件态消费 + 一次性 `pi -p` worker |
| 子代理机制 | ❌ 内置无；官方 subagent 扩展示例 | ✅ task/worktree 隔离/typed 结果/Agent Hub | ✅ multi_agent 角色+spawn/wait/close | ✅ Task+.claude/agents+teams | ✅ agent mode=subagent+task | ✅ subagent tree+steer/cold-resume | ✅ delegate_task 子 thread | ⚠️ ar_dispatch 派生+spec.parent 链+depends DAG，**无 join/无结构化回传** |
| 人机闸门(approval) | ⚠️ 无内置；tool_call 可 block + ctx.ui/RPC UI | ✅ 破坏性工具三档 + ask 工具 + advisor | ✅ sandbox×approval 双轴 + trust + 自动评审 | ✅ allow/ask/deny + 6 modes + PermissionRequest hook | ✅ per-key ask/allow/deny | ✅ ctx.approval fail-closed + audit 对 | ✅ 4 档映射各 provider | ⚠️ ev_gate 整节点挂起-回复-复活可用，**无调用级审批** |
| 上下文与产物 | session 树+compaction+context files+skills 按需 | +memory 工具/checkpoint/rewind/stream rules | AGENTS.md+rollout+plan_update | CLAUDE.md+SKILL.md+auto-compact+tasks | sessions+export/import | session log+compaction+spill+projection | provider 原生 session+portable handoffs | ⚠️ spec 信封+artifacts 落盘回 ref+events.jsonl；**事件粗粒度截断、transcript 不入 UI、resume 丢上下文** |
| 工具面与权限 | read/bash/edit/write+codemode+MCP 分级曝光 | 31 内建+xd://+web_search 链 | exec/apply_patch/web/MCP+OS sandbox | 全家桶+hooks 可决策+MCP | 内建+plugin RPC+MCP | 管线化 pre/post waterfall+guards+PTC | provider 工具+terminal+source-control | ⚠️ spec.tools 白名单+三档授权+8 个 ev/ar/GUI 工具；**无 call 级审批/sandbox/MCP** |
| UI 范式 | pi-tui 组件系统+扩展 renderer | TUI 卡片+diff preview+Agent Hub | TUI+IDE+桌面+cloud tasks | 终端+IDE+Desktop+web | TUI(客户端)+web+desktop+/tui API | Web UI+desktop | web/desktop/mobile 三端 | ⚠️ dir-6 workbench（run 卡/chips/tree/sheet/inbox/SSE/Edge-app）；**无 turn 流/diff/终端/中止** |
| 持久化与会话恢复 | ~/.pi sessions，continue/resume/session-id | sessions+fork+memory bank | rollout JSONL+exec resume | ~/.claude sessions+fork-session | sessions+export/import | durable event log+cold resume | 服务端 thread 存储+remote | ⚠️ runs/ 文件态耐重启 ✅；**worker --no-session 不持久、gate 复活=新进程** ❌ |
| 自进化 | extensions/skills/templates/themes/packages | +learn→skill+marketplace+stream rules | AGENTS.md/skills/profiles/MCP/execpolicy | hooks(~30 事件)+skills+subagents+plugins/mods | opencode.json+plugins+skills | everything-is-plugin+60+ 子系统 | provider 原生 skills+managed policy | ❌ aica-pi 包骨架在（skills/ 空、无 hook 面、worker 锁死 --no-*） |

**矩阵结论**：本项目与竞品的真实差距集中在四块 —— ①worker 会话生命周期（丢上下文/不能 steer/不能杀）；②审批粒度（节点级→调用级）；③事件投影粒度（粗事件→turn 级流）；④父-子协同（能派不能等）。UI 框架本身（dir-6 + 文件态投影）反而超前于多数终端类竞品，不需要推倒。

---

## 4. 本项目现状基线（代码级）

| 层 | 文件 | 现状 |
|---|---|---|
| 命令面 | `src/cli.ts` | run-create/dispatch/node-create/check/reply/gate/done/fail/event/daemon/version；统一 JSON envelope |
| 状态层 | `src/runs.ts` | runs/<root>/{run.json,plan.v1.json,nodes/<p>/{spec,result,gate,events,artifacts}}；pendingNodes 递归收集+waiting 复活判定+depends 闸门；**checkRun 只扫一层**(:153) |
| 宿主 | `src/daemon.ts` | 2s 轮询 pendingNodes → MAX_WORKERS=2 → spawn `pi -p --mode json --no-session --no-extensions --no-context-files --no-skills --no-prompt-templates --no-mcp` + `--append-system-prompt worker.md` + `--tools` + `-e events.ts -e tools.ts`；stdout→stdout.log；退出码兜底 result；pidfile 心跳 |
| 信封 | `src/envelope.ts` | SpecEnvelope/ResultEnvelope/EventRecord 手写类型；`spent`/`budget.minutes`/`mode`/`art://` ref 声明未使用 |
| Worker 工具 | `aica-pi/extensions/tools.ts` | ev_done/ev_fail/ev_gate(恒授)/kn_recall(stub)/ar_read/ar_dispatch(白名单才给)/agent_desktop/ego_browser；大输出落盘 artifacts+ref |
| Worker 事件 | `aica-pi/extensions/events.ts` | pi `tool_execution_start/end`→events.jsonl（300 字符 preview）；`message_end`→agent_message（带 usage.totalTokens）；**无 delta/无 file_edit/无 retry/compaction 事件** |
| Worker 提示 | `aica-pi/prompts/{worker,orchestrator}.md` | worker：信封真相/上下文纪律/验收自证/ev_done 收口/越权边界；orchestrator：只写 spec 不执行 |
| 桥 | `workbench/server.ts` | node:http 零依赖；`/api/v1/view`（run 卡+chips+tree+inbox+settled）+ events/tree/node/artifact GET + tasks/reply POST + DELETE run + SSE watch + ensureDaemon |
| 前端 | `workbench/public/v1/index.html` | 1162 行单文件；左 rail run 列表 / 中栏目标+验收 chips+子代理树 / 右栏 inbox+子代理页 / sheet 详情（执行过程 steps+产物预览）/ composer（任务/带工具/编排三槽） |

---

## 5. 缺口清单

每条标注：现状出处（仓内文件:行）+ 竞品参照（一手链接/文档）。

### P0 — 不修没法日常用

| # | 缺口 | 现状出处 | 竞品参照 | 判 |
|---|---|---|---|---|
| G1 | **gate/reply 复活丢全部上下文**：ev_gate→waiting→reply→resolveWaiting→**新 pi 进程**，只有 spec+reply 进 userMessage；此前几十轮工具结果、读过的文件、推理全丢。这是目前所有等待-恢复链路的根因伤。 | `src/daemon.ts:88`（--no-session）、`src/cli.ts:78-80`、`src/daemon.ts:61-76`（userMessage 只有 spec+reply） | pi `--session-id/--session-dir`（docs/cli.md:90-98）；T3 "threads use Pi's native session files"（t3code/docs/user/providers-pi.md）；dsh cold resume（subagent.md）；codex exec resume | ❌ |
| G2 | **无 turn 级消息流进 UI**：pi `--mode json` 完整流（text_delta/tool_execution_update/retry/compaction）写进 stdout.log 后**没人读**；events.jsonl 只有 tool start/end + 截 300 字符的 message_end；UI 每节点只见 12 条粗 steps。 | `src/daemon.ts:137`（stdout→log）、`aica-pi/extensions/events.ts:11,19-23,48-53`、`workbench/server.ts:243-251` | pi docs/json.md 全事件表；codex `item.updated`（exec_events.rs）；claude stream-json；OMP 实时 tool 卡 | ❌ |
| G3 | **无工具调用级审批**：权限只有静态 `spec.tools` 白名单（要么全程放开 bash，要么不给）；付款/删除/发布级操作只能靠 worker.md 口头禁令（"返回失败并注明需要人工"——模型自觉，无强制）。 | `src/daemon.ts:19-23,55-58`、`workbench/server.ts:384-389`（三档授权）、`aica-pi/prompts/worker.md:7` | claude allow/ask/deny+PermissionRequest（docs/en/permissions）；dsh ctx.approval allowed-once（approval.md）；codex approval_policy（sandbox.md）；T3 Pi blocking tool hook；pi tool_call 可 block（extensions.md） | ❌ |
| G4 | **无中止/超时/取消**：running 节点杀不掉（UI 无按钮、CLI 无命令、daemon 不记 pid）；`budget.minutes` 是死字段；卡死的 worker 永远卡。 | `src/daemon.ts`（无 pid 管理/无 kill 路径）、`src/envelope.ts:28` | pi rpc `abort`（rpc-commands.md）；opencode doom_loop 权限；dsh signal 语义；OMP Agent Hub kill；T3 各端中止 | ❌ |
| G5 | **孤儿 worker**（重复拉起是特性不是 bug：多轮研究重拉是设计，还提升缓存命中率）：daemon 崩了重启，旧 worker 可能还活着 → 两个进程写同一节点目录/artifacts；`running` 只在内存无法识别。 | `src/runs.ts:107-146`（无锁判定）、`src/daemon.ts:16` | 任意 harness 的进程管理（dsh subprocess 子系统；codex job timeout） | ⚠️ |
| G6 | **父节点等不了子节点（无 join）**：orchestrator 用 ar_dispatch 派完子节点，自己只能 done 或 ev_gate 挂起等**人工**——子节点全部 done 不会自动复活父节点；worker 也没有"等待子结果"的工具，编排环是断的。 | `aica-pi/extensions/tools.ts:107-122`（ar_dispatch 无 wait）、`src/runs.ts:141`（depends 只管 spec 拉起）、`aica-pi/prompts/orchestrator.md` | dsh `drainDescendants`+parent delivery（subagent.md）；codex `wait_agent`；OMP `wait` 工具；claude SubagentStop | ❌ |
| G7 | **spent/成本不落账**：`ResultEnvelope.spent` 定义了没人写；events.ts 其实抓到了 `m.usage.totalTokens` 但没聚合；run 头 Σtok 数据面是空的。 | `src/envelope.ts:43`、`aica-pi/extensions/events.ts:52`、`workbench/README.md:23` | pi message_end usage（json.md）；OMP Agent Hub per-subagent cost；dsh token-meter 子系统 | ❌ |
| G8 | **`ar check` 漏嵌套节点**：checkRun 只 `readdirSync` 一层，`nodes/root/a` 这类深层节点从 `ar check`（也是 worker `ar_read` 的真相源）里消失；server.ts 的 nodePaths 反而有递归 walk——两个视图不一致。 | `src/runs.ts:149-158` vs `workbench/server.ts:45-64`、`src/runs.ts:115-124` | — | ❌（bug） |
| G9 | **claude/codex worker 是摆设**：launcher 只裸 `claude -p`/`codex exec --json`——`workerEnv` 虽注入了 `AR_CLI/AR_ROOT_ID/AR_NODE_PATH`（`src/daemon.ts:110-122`），模型理论上能 `bash` 调 `ar done`，但没有 `--append-system-prompt` 等价物告诉它协议（goal 里也没有 node_id/accept/收口指令），实际上必然走退出码兜底出"未写执行摘要"；也调不了 gate、派不了子节点。要么补齐适配要么别暴露。 | `src/daemon.ts:100-103,110-122`、`src/envelope.ts:6` | codex exec item.* 事件可直接转写 events.jsonl（exec_events.rs）；claude stream-json | ⚠️ |

### P1 — 体验差距

| # | 缺口 | 现状出处 | 竞品参照 |
|---|---|---|---|
| G10 | **计划态无生命**：`plan.v1.json` 写一次永不更新，`plan_version` 是死字段；无 plan→exec→replan 循环（orchestrator 只能靠人工 gate 续命）。 | `src/runs.ts:50` | claude plan mode+ExitPlanMode；dsh plan 子系统；codex plan_update |
| G11 | **不能 steer 运行中 worker**：reply 只对 waiting 节点生效；跑着的节点想纠正方向只能等死或删除。 | `workbench/server.ts:411-436`、前端无入口 | pi `steer`/`follow_up`（rpc-commands.md:46-90）；dsh sendMessage→Steer；OMP Agent Hub 打字 steer；T3 挂起时文字回复=反馈 |
| G12 | **transcript 不可见**：完整对话在 stdout.log（--mode json 全量），但 API/UI 没有入口；sheet 只能看 12 条 events 尾巴。 | `src/daemon.ts:137`、`workbench/server.ts`（无 transcript 端点） | 所有竞品的会话详情视图；OMP live transcript |
| G13 | **file_edit 事件定义了没人发**：EventRecord.kind 有 file_edit 但没有发射点 → 无文件变更视图、无 diff。 | `src/envelope.ts:49`、`aica-pi/extensions/events.ts` | codex `file_change` item；OMP ast_edit proposed/accept 卡；T3 source-control diff review |
| G14 | **skills/hooks 扩展点未开**：worker 启动锁死 `--no-skills --no-context-files --no-prompt-templates`，`aica-pi/skills/` 是空目录；aica 没有"run 级 hook"概念（如每轮前注入、tool_call 统一守门）。 | `src/daemon.ts:90`、`aica-pi/skills/`、`aica-pi/package.json`（pi.skills 已声明但没货） | pi skills.md（Agent Skills 规范）+extensions.md；claude hooks(~30 事件)/skills；OMP learn→managed skill |
| G15 | **MCP 未接**：`--no-mcp`；外部知识/工具接入只能靠 kn_recall stub（还没实现）。pi 的 exposure 分级（direct/codemode/deferred/hidden）其实正适合 per-node 授权。 | `src/daemon.ts:90`、`aica-pi/extensions/paths.ts`（kn KNOWN 空） | pi mcp.md（exposure/toolExposure/OAuth）；claude/dsh/opencode 全接 MCP |
| G16 | **模型路由只有单点**：spec.model→`--model` 直通可用，但无角色概念（worker/orchestrator/评审各用啥模型）、无 fallback、无成本档位。 | `src/daemon.ts:14,85` | OMP 9 model roles+fallback chains+path-scope；opencode per-agent model；dsh provider 池 |
| G17 | **无完成/等待通知**：gate 弹进 inbox 只在窗口里；窗口关了就没有任何提醒（这是单人不离座场景的真实痛点）。 | — | claude `Notification` hook；T3 mobile-notifications；OMP ctx.ui.notify |
| G18 | **inputs `art://` 引用不解析**：SpecInput.ref 声明了 art:// scheme，但没有物化逻辑——worker 只拿到 ref 字符串，要自己猜去哪读。 | `src/envelope.ts:10`、`src/daemon.ts:65` | OMP `agent://`/`pr://` 等 16 个 scheme 在 FS 工具里透明解析；dsh attachment 子系统 |
| G19 | **UI 无写路径控制面**：不能对单个节点 abort/重试/删除（只有 DELETE 整 run 和 reply）；running 节点没有操作。 | `workbench/server.ts:483-487` | OMP Agent Hub kill/revive；T3 各端 abort；opencode session delete |

### P2 — 进阶

| # | 缺口 | 竞品参照 |
|---|---|---|
| G20 | **worktree 隔离**：节点 cwd 即节点目录，任务改代码=直接改用户的仓，无 git worktree 分支隔离 | codex cloud tasks；OMP pi-iso crate+task 隔离选项；claude WorktreeCreate hook；dsh worktrees 子系统 |
| G21 | **结构化子节点产出**：children 只能回 summary 文本+refs，无 outputSchema | dsh outputSchema（subagent.md）；codex --output-schema；OMP typed task 结果+`agent://` 字段抽取 |
| G22 | **记忆/知识**：kn_recall 是 stub，无跨 run 记忆 | OMP retain/recall/learn/reflect/memory_edit；dsh mcp-memory 示例；claude CLAUDE.md 持久记忆 |
| G23 | **远程/多端**：127.0.0.1:4399 单机窗口 | T3 remote-access（LAN/Tailscale/T3 Connect）+mobile；opencode serve+SDK |
| G24 | **调度/触发**：无 cron/webhook/定时跑批 | dsh jobs/schedule/webhook 子系统；claude cloud sessions |
| G25 | **安全边界**：worker 全用户权限无 sandbox（与 pi/OMP 一致，比 codex 弱一档）——v1 明确不做但要在文档写清风险 | codex OS sandbox；pi security.md 明说不内置；dsh sandbox 子系统 |
| G26 | **导出/分享**：无 session export/sanitize/share | pi /export /share；opencode session export --sanitize；T3 guest-links |
| G27 | **envelope 无 schema 校验**：手写类型 + 注释自认"后续换 TypeBox" | `src/envelope.ts:2`；aica-pi 已依赖 typebox |
| G28 | **eval/质量基线**：无 | dsh benchmarks/ |

---

## 6. 落地路线

三个里程碑。**R1 全部不动 worker 进程模型**（还是 spawn 一次性 `pi -p`），用文件协议补齐 P0；**R2 才考虑迁 `--mode rpc` 长驻**，那一步把 steer/approve/abort 从"文件轮询"升级成"协议原语"并拿到真实 abort。**诚实说明**：R1.3 的文件轮询审批会在工具内阻塞等待（有超时兜底 deny），能跑通但不如 RPC 干净——先落地再置换。

### R1 · 机制闭环（P0，约 1-2 周）

**R1.1 节点会话持久化 —— 补 G1（也顺手改善 G6 恢复质量）**
- `src/daemon.ts` `launcher()`：去 `--no-session`，加 `--session-dir <nodedir>/.pi-sessions --session-id node-<rootId>-<path 的 fs 安全转写>`。同一节点每次拉起都是**同一 session**——gate 后 reply 重拉时 pi 自动恢复完整历史（含此前全部工具结果）。
- 验证点：-p print 模式是否吃 `--session-id`（docs/cli.md:92-98 表明 sessions 通用于各模式，冒烟确认；若 -p 不吃则直接跳到 R2.1 的 rpc 方案，session 用 rpc `switch_session` 恢复）。
- 冒烟：worker 第一轮读文件 A → ev_gate → reply 后第二轮，问"A 文件第 3 行是什么"答得出来。

**R1.2 turn 级流投影 —— 补 G2**
- `src/daemon.ts` `spawnWorker()`：stdout 不再整段重定向进 log，改成 `stdio: ["ignore", "pipe", log]`，daemon 边读边做两件事：①原样追加 stdout.log（保留原始证据）；②**转写**进 `events.jsonl`：`message_update` 的 `text_delta`→`{kind:"agent_delta",data:{delta}}`（或按 message 聚合后更新一条 `agent_message` 的 in-progress 行），`tool_execution_update`→`{kind:"tool_update"}`，`turn_start/end`、`auto_retry_*`、`compaction_*`→同名透传，`turn.completed`→usage 进 spent 聚合（见 R1.6）。
- `src/envelope.ts` EventRecord.kind 扩 `"agent_delta"|"tool_update"|"turn"|"retry"|"compaction"`。
- `workbench/server.ts` apiView steps：从"尾 12 条"升级为"最近 N 条 + 尾部进行中块"；前端把 agent_delta 归并进同一气泡（call/message id 配对逻辑照抄 tool_call 卡）。
- 出处对齐：pi docs/json.md 的 delta→message_end 替换语义（"replace reconstructed data with completed content"）。

**R1.3 调用级审批门 —— 补 G3**
- `src/envelope.ts`：spec 新增 `approve?: string[]`（要走闸门的工具名/前缀模式）、`deny?: string[]`（恒拒，从 --tools 里剔除并写进 userMessage 告知模型）。
- `aica-pi/extensions/` 新增 `gate.ts`（或并入 tools.ts）：`pi.on("tool_call")` → 命中 `spec.approve` 模式时：写 `gate-req.json{callId,tool,args,reason,ts}` → **在 handler 内轮询** `gate-ans.json`（500ms，超时 5min→`{block:true,reason:"approval timeout"}`）→ 收到 `{"decision":"allow"}` 放行、`"deny"` 返回 block。fail-closed：写不出 gate-req 直接 block。
- `workbench/server.ts`：apiView inbox 增加 `kind:"approve"` 卡（tool+args 渲染+opts=[同意一次,拒绝]）；新增 `POST /api/runs/<id>/node/<p>/approve` 写 gate-ans.json（复用 reply 的目录约定）。
- 语义对齐 dsh：一次性 `allowed-once`、不持久化规则（v1 不做"以后别问了"记忆，那是 P2 的 settings.local.json 模式）。
- 备选（更优但后置）：R2.1 RPC 化后改为 `ctx.ui.confirm` → `extension_ui_request` 直通 workbench，免轮询——T3 Code 已验证此路。

**R1.4 节点锁 + 中止 + 超时 —— 补 G4/G5**
- `src/daemon.ts` `spawnWorker()`：spawn 成功后写 `worker.json{pid,started_at,cmd}`；finish 时删。
- `src/runs.ts` `pendingNodes()`：节点目录有 worker.json 且 `process.kill(pid,0)` 成立 → 跳过（不管有没有 result——正在跑的节点不重复拉）。daemon 启动时扫一遍：pid 死了但 worker.json 还在 → 视为崩溃，删 worker.json 按正常 pending 重拉。
- `src/cli.ts` 新命令 `abort --run --node`：读 worker.json→`taskkill /PID <pid> /T /F`（win32）→ 写 result failed("aborted by user")（finish 兜底会再写一次，writeResult 幂等以先写为准需加 guard：已存在 result 不覆写）。
- `budget.minutes`：spawnWorker 时 `setTimeout(minutes*60e3)` 到点同 abort 路径，result failed("timeout")；写进 events `kind:"abort"`。
- `workbench/server.ts`：`POST /api/runs/<id>/node/<p>/abort`→`ar abort`；前端 running 节点行内 ✕；DELETE run 前先 abort 其全部 live worker（否则删目录留孤儿进程写盘）。

**R1.5 join/等待子节点 —— 补 G6**
- `src/cli.ts` 新命令 `wait --on <path,path,...>`（worker 侧经新工具 `ev_wait` 调用）：写 `result.json{status:"waiting", wait_on:[...], summary:"等待子节点"}` + gate.json（kind:"wait"，不进人工 inbox——或进但标记自动）。
- `src/runs.ts` `pendingNodes()` waiting 分支扩：result.wait_on 全部 done → 视同"人工回复已到达"自动 resolveWaiting 重拉；此时把各子 result 摘要拼进**新的 reply 条目**（`spec.reply += {text:"[系统] 子节点结果: <path>: <summary>", ts}`）让重拉的 worker 直接看见回传——配合 R1.1 的 session，父上下文完整。
- `aica-pi/extensions/tools.ts` 注册 `ev_wait{paths:string[]}`；`prompts/orchestrator.md` 补一条"派发后调 ev_wait 挂起，子节点全部 done 会自动复活你"。
- 语义对齐：dsh drainDescendants + subagent-settled 系统消息（subagent.md）；codex wait_agent；OMP wait 工具。

**R1.6 spent 落账 —— 补 G7**
- R1.2 的转写器顺带累计 `turn_completed.usage`/`message_end.usage.totalTokens`；`ev_done`/`ev_fail`/`ar done` 接受 `--spent-tokens/--spent-minutes` 可选参数；daemon `finish()` 兜底：result 无 spent 时从 events.jsonl 聚合写入。
- `workbench/server.ts` apiView：run 头 `dur` 旁显示 Σtok（数据已在 r.spent + tree 节点 spent）。
- 文件：`src/daemon.ts`、`src/envelope.ts`（无需改结构，字段已有）、`aica-pi/extensions/tools.ts`、`workbench/server.ts`。

**R1.7 checkRun 修嵌套 —— 补 G8**
- `src/runs.ts` `checkRun()` 复用 pendingNodes 里的 walk（抽个 `listNodePaths(rootId)` 供 runs/server/daemon 三处共用）。

**R1.8 agent 面收敛 —— 补 G9**
- v1 把 claude/codex launcher 标记 experimental：dispatch 时 `agent!=pi` → spec 落 `experimental:true`，view 投影给节点打 `exp` 徽标 + worker.md 注明"该 agent 无 ev_* 协议工具，result 由退出码兜底"。**诚实路线**：不假装能用。codex 的补齐成本其实不高（exec --json 的 item.* 直接映射进 events.jsonl，result.summary 取最后 agent_message）——排进 R2 可选。

### R2 · 体验（P1，约 2-4 周）

**R2.1 worker RPC 化（可选强推荐）**：`pi --mode rpc` 长驻，daemon 从"拉起-退出"变"session host"——`running: Map<nodeId,{proc,stdin}>`；reply→`steer`/`follow_up`；abort→rpc `abort`；R1.3 审批改成 `extension_ui_request` 直通（丢轮询）；crash 后 `switch_session`/`fork` 恢复。改 `src/daemon.ts` launcher/spawnWorker、`src/cli.ts`（reply/abort 转发给 daemon——需要 daemon 一个本地控制通道：socket/named pipe/或 STATE/daemon-cmd.jsonl 追加式命令文件，保持文件态风格建议后者）。**这是 R1 的升级版不是前置**——R1 全部收益在 -p 模式下已成立。

**R2.2 transcript 可视化 —— 补 G12**：`GET /api/runs/<id>/node/<p>/transcript`（tail stdout.log 解析 JSONL 行→message/tool 视图）；sheet 加 transcript tab。

**R2.3 file_edit + diff —— 补 G13**：events.ts 对 `edit`/`write` 的 tool_execution_start 读 args（path/old_string/new_string/content）emit `file_edit{path,preview}`；前端 sheet/steps 里渲染 unified diff（前端自算 LCS 或小 difflib，零依赖原则下自己写 ~80 行）。

**R2.4 skills/hooks/MCP —— 补 G14/G15**：
- `aica-pi/skills/` 填首批（desktop 使用说明已在 agent_desktop 描述里被引用：`skills get desktop`——把它落成真 SKILL.md）；daemon 去掉 `--no-skills`，加 `spec.skills?: string[]` 白名单→`--tools`/`--skills` 或 skills-dir 隔离。
- "aica hook" = 新扩展文件按 `pi.on` 订阅（参照 examples/extensions/file-trigger.ts/git-checkpoint.ts/confirm-destructive.ts 的姿势）：`turn_end` 追加 checkpoint、`tool_call` 守门（G3 的闸门本体）、`session_start` 注入 already_known。
- MCP：`spec.mcp?: string[]` → daemon 在节点目录生成 `.pi/mcp.json`（只含白名单 server+exposure:"deferred"）→ 去掉 `--no-mcp`。

**R2.5 模型角色 —— 补 G16**：`aica-pi/roles.json{worker,orchestrator,reviewer}`→daemon 按 spec.profile 取默认；`spec.model` 仍最高优先。fallback：pi 无原生链（OMP 特性），v1 只做"daemon 重试时换下一候选 model"这一档。

**R2.6 通知 —— 补 G17**：server.ts apiView 已聚合 waiting；前端 SSE change→`new Notification`（Edge --app 下 Web Notification API 可用，需要 http://localhost 权限上下文——localhost 算 secure context，可行）；可选 daemon 侧 PowerShell toast。

**R2.7 inputs 物化 —— 补 G18**：`art://<root>/<nodepath>/<filename>` → daemon 在拉起前把文件复制进节点 `inputs/` 并把 userMessage 里 ref 改写成相对路径；绝对路径 inputs 校验存在性。

**R2.8 UI 控制面 —— 补 G19**：running 节点行内 ✕（abort）+ 回复框（先复用 reply 通道：对 running 节点 reply 直接 append spec.reply，R2.1 RPC 化后升级为真 steer）；node 级 DELETE。

### R3 · 进阶（P2，按需）

worktree（R3.1）、outputSchema 结构化回传（R3.2）、kn 记忆接入（R3.3）、远程访问（R3.4：tailscale+只读 view 先行）、jobs/schedule（R3.5）、export/share（R3.6）、TypeBox 化 envelope（R3.7）、sandbox 评估（R3.8：Windows 下 codex 式 sandbox 没有现成原语，诚实结论=短期靠 approve 门+白名单）。

---

## 7. 验收标准

| 缺口 | 可验证指标 | 验证方式 |
|---|---|---|
| G1 | gate→reply 后 worker 能引用本轮 gate 之前读到的文件内容/工具结果（不依赖 already_known 复述） | e2e：派单"读 X→gate 问→答后总结 X 细节"，断言第二轮 transcript 含第一轮 tool result 或行为正确 |
| G2 | 运行中节点在 UI 里可见 ≥1 条/2s 的增量（delta/tool_update）事件；steps 不再是 12 条截断；stdout.log 与 events.jsonl 事件数对账误差=0 | 派 3 分钟任务，期间抓 /api/v1/view 两次 diff；对账脚本数两边 tool_execution 条数 |
| G3 | `spec.approve:["bash"]` 的任务，每条 bash 调用产生 inbox approve 卡；答"拒绝"→工具返回 block 错误且 worker 续跑（不挂起）；超时未答→deny；approve 判定日志（gate-req/gate-ans）成对落盘 | e2e：approve 列表任务跑通"问-批-跑"与"问-拒-绕"两条路 |
| G4 | running 节点 UI ✕→10s 内 result=failed("aborted")，进程树无残留；`budget.minutes:1` 任务 65s 内被杀标 timeout | e2e + `Get-Process`/`tasklist` 对账 |
| G5 | daemon 在 worker 运行中被 kill，重启后同一节点**不被二次拉起**（worker.json 锁生效）；worker 也崩了的场景能正常重拉 | 混沌脚本：spawn 中杀 daemon→重启→数 events spawn 次数=1 |
| G6 | orchestrator 派 3 子节点后 ev_wait：三节点全 done → 父节点自动复活（无人工介入），新 turn 的 transcript 含三条子 summary | e2e 编排任务端到端计时+断言父 result 引用子结果 |
| G7 | done 节点 result.spent.tokens>0；run 头 Σtok=各节点 spent 之和±0 | 对账 events.jsonl usage 合计 vs result.spent |
| G8 | `nodes/root/a` 出现在 `ar check` 输出 | 建两层节点跑 check |
| G9 | `agent:"codex"` 任务在 UI 标 exp 徽标；文档说明能力边界 | 视觉+文档检查 |
| G11/R2 | 对 running 节点发 steer，当前 turn 结束后 steer 进上下文（transcript 可见 user steering message） | RPC 冒烟 |
| G12 | sheet transcript tab 显示完整对话 ≥90% 覆盖 stdout.log 消息数 | API 对账 |
| G13 | edit/write 调用产生 file_edit 事件且 UI 显示 diff | e2e 触发一次 edit |
| G14 | `spec.skills:["desktop"]` 的任务 SKILL.md 进上下文（transcript 见 skill 加载）；aica hook 扩展在 events.jsonl 留痕 | 派引用 skill 的任务 |
| G15 | `spec.mcp:["docs"]` 的 worker 可调 `mcp__docs__*` | e2e 挂一个本地 echo MCP |
| G17 | gate 产生时 OS 通知触达（窗口失焦场景） | 手测 |
| G18 | `inputs:[{ref:"art://r/root/a.md"}]` 的任务 worker 在 inputs/ 看到文件 | e2e |

---

## 附录 · 一手出处索引

**本仓**：`src/cli.ts`、`src/runs.ts`、`src/daemon.ts`、`src/envelope.ts`、`workbench/server.ts`、`workbench/public/v1/index.html`、`aica-pi/extensions/{tools,events,paths}.ts`、`aica-pi/prompts/{worker,orchestrator}.md`、`workbench/README.md`（行号见正文引用）。

**pi（本机 node_modules docs，亦见 github.com/earendil-works/pi/tree/main/docs）**：how-pi-works.md、extensions.md（tool_call block/ctx.ui/事件生命周期）、json.md（事件流规范）、rpc.md+rpc-commands.md+rpc-extension-ui.md（steer/abort/extension UI）、sessions.md+session-format.md+cli.md（--session-id/--session-dir）、skills.md（Agent Skills）、mcp.md（exposure 分级）、custom-provider.md、sdk.md、security.md（无内置 sandbox/审批）、compaction.md、`examples/extensions/subagent/`（官方子代理示例）。

**Oh My Pi**：github.com/can1357/oh-my-pi README（task/Agent Hub/ask/advisor/stream rules/memory/xd://；docs/agent-hub.md、docs/vibe-mode.md）。

**Codex**：github.com/openai/codex —— docs/sandbox.md（双轴审批）、codex-rs/exec/src/exec_events.rs（JSON 事件枚举）、codex-rs/core/templates/collab/experimental_prompt.md（spawn/wait/close_agent）、codex-rs/utils/cli/src/shared_options.rs（--approve-for-me/--yolo）、developers.openai.com/codex/noninteractive、learn.chatgpt.com/docs/agent-configuration/subagents。

**Claude Code**：code.claude.com/docs —— /en/hooks（~30 事件+JSON 契约）、/en/permissions（allow/ask/deny+评估序）、/en/permission-modes（6 档+auto 分类器）、/en/sub-agents（frontmatter 契约）、/en/features-overview。

**OpenCode**：opencode.ai/docs —— /config（8 层优先级）、/agents（primary/subagent+permission）、/server（OpenAPI+SSE+SDK）、/cli（serve/agent create/--auto）。

**DeepSeek Harness**：github.com/deepseek-ai/deepseek-harness —— docs/tool-execution-pipeline.md（pre/guards/execute/post/result 管线）、docs/subsystems/{approval,subagent,agent-team,permission-presets,session,persistence,plan,worktrees,jobs,schedule,webhook,skills,mcp,sandbox,spill,user-questions,token-meter}.md、examples/{acp-agent,headless-agent,jsonrpc-agent,mcp-memory}、docs/user/guide/python-sdk.md。

**T3 Code**：github.com/pingdotgg/t3code —— README/AGENTS.md（控制面定位）、docs/user/{permission-modes,providers-pi,install,remote-access,source-control,terminal,mobile-notifications,guest-links,portable-handoffs,managed-policy}.md。

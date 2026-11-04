# aica Workbench v2 PRD — 六家 harness 深调研与吸收路线

> 状态：草案 v2 · 调研基准日 2026-05（全部一手源码/官方文档；v1 保留于 `prd-workbench-v1.md` 不动）
> 对象变更：v1 的 Pi/OpenCode/DeepSeek Harness 本轮不再重复画像（见 v1 §2.1/2.5/2.6）；本轮六家 = **Claude Code、Codex、T3 Code、Misaka-Agent、Cindy、Oh My Pi**。
> 同名消歧：
> - **MisakaAgent → `github.com/Luciole-Studio/Misaka-Agent`**（Python，DAG 多代理研究系统，242★，Apache-2.0）。同名另有 `Ikalus1988/MisakaNet`（MCP 失败记忆服务，非 harness）与若干个人 skills 仓，均不采。
> - **Cindy → `github.com/makecindy/cindy`**（TS pnpm monorepo，harness-agnostic 客户端，9.2k★，Apache-2.0）。同名歧义较多，按「最近活跃 + agent harness」判据锁定此仓。
>
> 本文回答：**这六家的 harness 设计里，哪些是 ar/workbench/aica-pi 应该吸收的、吸收成什么形态、R1 先落哪些。**

---

## 1. 六家画像（一句话定位 + 能力面）

每条只写与本项目决策有关的事实，出处给一手链接；本仓文件给 `path:line`。

### 1.1 Claude Code（Anthropic）—— **hook 即扩展面的集大成者：~32 个生命周期事件 + 六档权限 + plan mode**

- **执行模型**：CLI TUI / `-p` / `--output-format stream-json` / Agent SDK / IDE / Desktop / 云会话；`--continue/--resume/--fork-session`。
- **审批**：三层 —— ① `allow/ask/deny` 规则（评估序 deny→ask→allow）；② **六档 permission modes**：`default`(Manual)/`acceptEdits`/`plan`/`auto`/**`dontAsk`**/`bypassPermissions` —— `auto` 用第二模型分类器后台评审，v2.1.283 起是交互会话默认起始档；`dontAsk` 是 CI 档（会弹的一律拒）；③ `PermissionRequest` hook 可代答 + 批准时附言。任何档都不自动放行：ask 规则命中项、`AskUserQuestion`、关键路径 `rm`、越工作目录读写（`blockReads/WritesOutsideWorkingDirectories`）。（docs/en/permission-modes、docs/en/permissions）
- **子代理**：Task 工具 + `.claude/agents/*.md` frontmatter（`tools/model/permissionMode/skills/hooks`）+ agent teams（`TeammateIdle` hook）；plan 模式挂只读 Plan subagent。
- **上下文/session**：`CLAUDE.md` + `.claude/rules/*.md` 层级（`InstructionsLoaded` hook 可见加载）；SKILL.md 渐进披露；auto-compact（`PreCompact/PostCompact`）；transcript JSON 异步落盘（hooks 拿 `transcript_path` 但提示可能滞后当轮）。
- **工具面**：全家桶 + hooks 决策 + MCP（`Elicitation`/`ElicitationResult`：MCP 服务器可反向向用户提问）。
- **事件流**：stream-json + **hooks = 最全自进化面**：32 个事件（`SessionStart/End`、`Setup`、`UserPromptSubmit/Expansion`、`PreToolUse`、`PermissionRequest`、`PermissionDenied`(auto 拒后可 `retry:true`)、`PostToolUse/Failure`、`PostToolBatch`、`SubagentStart/Stop`、`TaskCreated/Completed`、`Stop/StopFailure`、`TeammateIdle`、`InstructionsLoaded`、`ConfigChange`、`CwdChanged`、`DirectoryAdded`、`FileChanged`、`WorktreeCreate/Remove`、`PreCompact/PostCompact`、`Pre/PostModelSwitch`、`Elicitation(/Result)`、`Notification`、`MessageDisplay`）。决策契约：`PreToolUse` 返 `hookSpecificOutput.permissionDecision: allow|deny|ask|defer` + `updatedInput` 改参 + `additionalContext` 注入 system-reminder；`SubagentStop` 可 block 阻止收口；handler 形态 = shell(stdin JSON→stdout JSON)/HTTP/MCP tool/LLM prompt/subagent；`async:true` 后台 hook；`if` 条件按子命令模式预筛（`Bash(rm *)`）。（docs/en/hooks）
- **自进化**：hooks + skills + subagents + slash commands + plugins/mods（JS 函数级 hook 可画 UI）+ MCP。

### 1.2 Codex（`openai/codex`）—— **事件模型最干净的 exec 协议 + 双轴审批 + 刚收敛到 Claude 兼容 hooks**

- **执行模型**：Rust；TUI + `codex exec --json` 非交互 + App/SDK + Cloud tasks；`codex exec resume [--last|<id>]`（`--fork` 可分叉）；rollout JSONL `~/.codex/sessions/`；ChatGPT 桌面端**定时任务**（本地项目或隔离 worktree，RFC 5545 RRULE，chat 内任务可回原 thread 续上下文）。
- **审批**：`sandbox_mode`（read-only/workspace-write/danger-full-access，OS 级边界）× `approval_policy` —— **`untrusted` 已退役、`on-failure` 已弃用**，现剩 `on-request` | `never` | `{ granular = {...} }`（部分类别保持交互、其余自动拒）；目录 `trust_level` 决定默认档；`execpolicy` 规则文件；managed 配置可 `allowed_approval_policies` 封顶。（developers.openai.com/codex/config-reference、learn.chatgpt.com config-reference）
- **子代理**：`agents.*` 已转正（默认 enabled）：`agents.<role>` 自定义角色（各自 config_file/description），`default_subagent_model/effort`、`max_concurrent_threads_per_session`、`interrupt_message`；内建 `spawn_agent/send_input/wait/close_agent`，子代理状态 `PendingInit/Running/Interrupted/Completed/Errored/Shutdown`。
- **上下文/session**：`AGENTS.md`；rollout；compact；`codex exec` 可 `--output-schema` 结构化产出。
- **工具面**：exec/apply_patch/web/MCP + sandbox；`codex-plugin-cc` 证明可被外部 harness（Claude Code）当子代理调用。
- **事件流（参照系）**：`thread.started` / `turn.started|completed|failed` / `item.started|updated|completed` / `error`；item 类型 = `agent_message|reasoning|command_execution|file_change|mcp_tool_call|collab_tool_call|web_search|todo_list|error`；`command_execution.status` 含 **`declined`**（审批拒绝也进流）；`collab_tool_call` 携 `agents_states` map；`turn.completed` 携 5 段 usage（含 cache_read/write、reasoning）。`todo_list` item = `{items:[{text,completed}]}` 计划投影。（`codex-rs/exec/src/exec_events.rs` 一手）
- **自进化**：**hooks 已转正（v0.124，2026-04）**：Claude Code 兼容事件名与 JSON 契约（`PreToolUse/PermissionRequest/PostToolUse/PreCompact/PostCompact/UserPromptSubmit/SubagentStart/Stop/Stop/SessionStart/End`）；发现源 = 各配置层的 `hooks.json` + `config.toml` 内联 `[hooks]` + 插件 hooks + `requirements.toml` managed hooks（`allow_managed_hooks_only`）；非 managed 命令 hook 须信任评审后才跑。（developers.openai.com/codex/hooks、PR #18893）

### 1.3 T3 Code（`pingdotgg/t3code`）—— **event-sourced 多 provider 控制面：意图先落盘、副作用后行**

- **执行模型**：Node WS server 包各家 CLI，web/desktop/mobile 三端经认证 RPC 控制；**orchestration v2 = 事件溯源**：`Orchestrator` 序列化命令、只决定事件不做 I/O → `EventSink` 单事务提交事件+投影+命令回执+outbox → `EffectWorker` 在意图落盘后执行副作用。ack=意图已提交≠工作完成；事件日志只留 ~1 天做重放。（docs/internals/overview.md）
- **审批**：thread 级四档 —— **Supervised / Auto-accept edits / Auto(用 provider 自带评审器)/Full access**，逐 provider 映射（Pi→blocking tool hook；Claude→permission modes；Codex→approval policy）；**子代理审批冒泡进父会话、就地答复**；**审批挂起时发文字 = 拒绝并给反馈**；managed policy 封顶档位。（docs/user/permission-modes.md）
- **子代理**：`delegate_task` 建 durable 子 thread，共享 subagent UI；Pi 侧经 blocking hook 实现权限，原生 session 文件做 resume/rollback/fork。（docs/user/providers-pi.md）
- **上下文/session**：provider 原生 session + **portable handoffs**：换 provider/重启时按预算选人话消息迁移（默认 16k token 上限，`T3CODE_CONTEXT_HANDOFF_TOKEN_CAP`，1 token/byte 保守计），被省略历史留引用 + thread-reading tool 可取回；用户新输入永不裁短。
- **工具面**：provider 工具 + terminal + source-control（diff review/一键 commit/push/PR/stack）+ dev-server preview + **checkpoint = hidden git refs** 抓工作区状态（revert 须同步 provider 会话回滚）。
- **事件流**：RPC 订阅制（看哪个 thread 才付哪个的历史）；PR 链接/结算为 server 投影。
- **自进化**：provider 原生 skills + managed policy + 项目设置；`t3 service install` 常驻；mobile notifications + guest links。

### 1.4 Misaka-Agent（`Luciole-Studio/Misaka-Agent`）—— **DAG 研究图：节点 = 独立小队（协调者+专家+红队），可能性只开一次**

- **执行模型**：Python 3.12+；TUI panel（每节点一个 tab、每个 agent 一个 pane 可进入对话）；`misaka research` CLI；run 可 stop/resume；项目目录即 git 仓，全部计划/卡片/结论/评审落 Markdown，**只在用户审阅并同意后 commit**。
- **审批**：**plan approval**——每个计划（含层间 reconciliation）默认等人工普通对话确认；改题目本身必等；可全局放开；每节点可 skip/cancel。
- **子代理**：Last Order（协调）+ Sisters（专家，各自专长/skills/**模型**：Claude/GPT/Gemini/本地，Claude Code 与 Codex 可作成员）+ 每节点专属 red team；**专家像 skills 一样分级曝光**——协调者上下文只放 `DESCRIBE.md` 摘要，规划时才读全介绍；`SOUL.md`+技能正文只在专家自己 session。
- **上下文/session**：**新节点从父节点 session fork、继承全部推理史**；卡片声明式回传（claim 类型 fact/inference/interpretation/value + 文件页码 + 引文）；citation 可溯到页+字符偏移；errata 沿图向下传播。
- **工具面**：rg/fd/poppler 检索栈 + Sisters 自带技能；非编码域。
- **事件流**：节点七段流水线 —— Plan（含 **coverage table**：子问题×卡片映射，空格=声明缺口）→ Cards（并行，follow-up 轮次有上限）→ Conclusion → Red-team review → Response（每条异议恰好一次回应：revise/rebut/concede/refer/park/decide）→ Divergence review（分「可被本节点补的缺口」与「前提遮蔽的方向」）→ Decision（每条未走之路记 open/covered/declined+理由）。**paths list 记录全部可能性及归宿——同一问题被多条线提出只研究一次**；层间 reconciliation 合并/对质收敛线。（README §Inside a node）
- **自进化**：run 参数面（depth/node-parallel/card-parallel/follow-ups/revisions/max-nodes/plan-approval/compaction-threshold/output-limit）+ Sister 定义文件 + 失败卡片自动重试≤3。

### 1.5 Cindy（`makecindy/cindy`）—— **与我们最同构的 pi 宿主：maker-core 统一抽象 + cindy-bridge 拦截式审批 + Orca 全员会话制多代理**

- **执行模型**：pnpm monorepo；Electron desktop + Expo mobile；**`packages/maker-core` 不依赖 Electron**：`BaseAgent` 统一抽象（不支持的能力抛 `NotSupportedError`，`AgentSessionHandle` 只暴露 provider-neutral 面），`ClaudeCodeAgent`/`CodexAgent`/`PiAgent` 三个 adapter + 事件 translator → 统一 `AgentEvent`。（`packages/maker-core/src/agents/base-agent.ts`、各 adapter 头注释）
- **审批（pi 侧，与我们路径相同）**：pi 原生无审批 → 注入 `cindy-bridge.ts` 扩展 `pi.on('tool_call')` 拦截 → `extension_ui_request` 子协议冒泡 → host `InteractionRequest` → 审批 UI；**权限档写 `<agentHome>/runtime/perm-<sessionId>.json`、bridge 每次 tool_call 现读（热切换）**；Full access 契约诚实写明「非沙箱，凭证可被读」，唯写 agent home 恒需确认。（docs/dev-rules/pi-harness.md）
- **子代理**：**Orca = Lead session + 多个 Worker session（完整会话非一次性 subagent）**，三者 harness 皆可；控制面走 `cindy_orca`/`orca_worker_bridge` MCP server，**per-session 身份经 `?session=` URL / `_meta.threadId` / `getLiziMcpSessionContext` 路由**；worker 有 worktree、soft/hard limit、archive、auto-bridge 回报 + `send_to_lead`；Split view Lead/Worker。（docs/dev-rules/orca-team-architecture.md）
- **上下文/session**：pi 侧 `--session-dir` 指共享 sessions、`switch_session` resume、fork/rollback；启动失败清理契约（未确认退出不放目录租约）。
- **工具面**：**MCP 网关两 schema 设计**——模型只见 `cindy_mcp_list_tools`/`cindy_mcp_call_tool` 两个稳定网关工具，完整目录留 bridge 内；分页 50 条/描述 240 字符；**未披露 schema 的调用在弹权限前即 fail-closed**；按会话+schema 指纹记账（pi 升级不作废未变披露）；compaction 后注入一次性已披露清单提醒防重复发现。（docs/dev-rules/pi-harness.md §MCP 桥）
- **事件流**：translator → AgentEvent；**ToolLoopGuard 防死循环**——完全相同 name+args+output 连 4 次=疑似、连 30 次=硬断；相同结果持续 60min=硬顶；只读轮转窗口（128 调用≤32 指纹且≥90%重复）判定；节奏轮询（≥30s 间隔）不计；疑似不交主循环而交**辅助模型复核**（`ToolLoopMonitor`，CONTINUE/STOP，每 turn≤3 次、20s 超时放行），复核上下文先脱敏（凭证整类删）再截断。（docs/dev-rules/maker-core-and-agent-behavior.md）
- **自进化**：memory/skills/automation(定时)/MCP/plugins 五件套；memory 多 harness 共用一份；`--append-system-prompt` 追加产品段（保留 pi 默认 prompt、前缀稳定对齐缓存；文本写文件传路径防 Windows 命令行上限）。

### 1.6 Oh My Pi（`can1357/oh-my-pi`）—— **batteries-included 的 pi 硬分叉：把「运行时纠偏」做成一等原语**

- **执行模型**：`omp` TUI / `-p` / `--mode rpc` / Node SDK / `omp acp` / collab 会话共享；~80k Rust 核 + Bun。
- **审批**：**三输入解析**——①工具自报 tier（`read|write|exec`，未报=exec）②工具 policy（`allow|deny|prompt`+`override`+`policyKey`）③用户 policy（`tools.approval.<tool>`）；四档 mode：`always-ask` / **`always-ask-cached`（问并记：Approve File/Dir(仅一层)/Once + 跨会话写 `approval-cache.db`；grant 记 tier，写授权覆盖读）** / `write` / `yolo`；`restrictedFolders` 任何档必问（headless=拒）；bash 危险模式强 override（`rm -rf /`、fork 弹、curl|sh、写 `/etc/passwd`）；扩展改参后**按最终参数重新解析**。（docs/approval-mode.md）
- **子代理**：`task` fan-out（可选 worktree 隔离）+ **agent 定义文件** frontmatter：`tools/spawns(谁能再派)/model 列表/thinkingLevel/output/blocking/structured/autoloadSkills/readSummarize/prewalk/advisor`；`structured`+`yield` 工具给 schema 校验回传；**`prewalk`：探索用贵模型起步、首次 edit/write 切 `@smol` 便宜模型**（反向也可）；角色别名 `@review`→`modelRoles.review`。（docs/task-agent-discovery.md）
- **上下文/session**：sessions+fork/resume；`checkpoint/rewind`；`agent://<id>`=子代理产出物/`history://<id>`=transcript/`proc://`=后台 job/`memory://`=记忆件，`write agent://<id>`=steer、`agent://all`=广播。
- **工具面**：31 内建（read/write/edit(hashline)/ast_edit/ast_grep/grep/glob/bash(内嵌 bash5.3+coreutils)/eval(持久 Python+JS kernel 可回调 agent 工具)/lsp(14)/debug(DAP 28)/task/wait/todo/ask/browser/computer/web_search(23 后端)/github/记忆组）。
- **事件流**：`message_update` delta 级 + **TTSR stream rules**——规则沉睡直到模型脱稿：condition(regex)/astCondition(ast-grep)/question(LLM 判) 三型条件，scope=text/thinking/tool/具名工具+路径 glob，增量匹配（不能跨行的规则只重扫本行）；命中即**流中 abort→注入规则为 system reminder→同点重试**，注入穿越 compaction 存活；`repeatMode/repeatGap` 防复读。（docs/ttsr-injection-lifecycle.md）
- **人机闸门**：`ask` 工具轮内结构化提问；**advisor 子系统**——第二模型逐轮评审主 transcript，注入 `<advisory severity>` 笔记：`nit`(非打断旁注，攒到轮界)/`concern`(可打断转向)/`blocker`(必打断，终答也拦不住)；EmissionGuard 每次更新≤4 条非 blocker、severity 去重防复读、`immuneTurns` 冷却；`WATCHDOG.yml` roster 多 advisor（各自 model/reviewMode(turn|agent-end)/reviewInterval/syncBacklog(off|N|strict)/tools）；独立 ToolSession 默认只给 read/grep/glob；advisor 自己不审批。（docs/advisor-watchdog.md）
- **Agent Hub（Alt+A）**：子代理 roster（status/model/activity/cost/tokens/parent，flat|tree 切换）+ inspector（当前工具+参数、上下文用量、worktree 分支）+ live transcript + **打字 steer + r=revive（杀掉的从盘上 transcript 全史复活）+ x=kill** + activity log（过滤/搜索/追尾）；`display.pinnedAgents` 编辑器上方钉跳表。（docs/agent-hub.md）
- **记忆**：5 backend（off/local/hindsight/mnemopi/sharpshooter）；local = **两段管线**：phase1 逐 session 模型抽取（决策/约束/已解失败/惯例）→ phase2 汇聚产 `MEMORY.md`+`memory_summary.md`(启动注入)+`skills/` playbook（lease+heartbeat 防双跑，写盘前密钥脱敏）；`learn` 工具（`autolearn.enabled`）→ `learned.md`（新→旧、去重、≤100 条、≤2000 字，下一会话注入，不动当前前缀）；mnemopi 给 `retain/recall/reflect/memory_edit`+`memory://<id>` 全行。（docs/memory.md）
- **自进化**：extensions/skills/hooks + learn→managed skill + marketplace + 开仓继承 8 家配置；9 个 model roles + fallback chains + path-scoped + 凭据轮转。

---

## 2. 值得吸收的能力清单

格式：**能力 → 一手出处 → 本项目缺口 → 吸收形态**（落到 ar/workbench/aica-pi 的具体位置）。按预估收益排序，★=R1 内落。

### 2.1 审批与守门（本轮最大富矿）

1. ★**`pi.on("tool_call")` 拦截 → 文件态审批门** —— Cindy `cindy-bridge.ts`（pi-harness.md §权限执行）+ T3「applies the composer permission mode through Pi's blocking tool hook」（providers-pi.md）+ pi `extensions.md:971-986`（`{block,reason,terminate}` 契约，handler 可 async 阻塞）→ **G3** → 新扩展 `aica-pi/extensions/gate.ts`：命中 `spec.approve` 模式写 `gate-req.json`→handler 内轮询 `gate-ans.json`→allow/deny。**Cindy 与 T3 双实证：不换引擎就有调用级审批。**
2. ★**OMP 三输入审批模型** —— docs/approval-mode.md：工具 tier(read/write/exec)×tool policy×user policy；档位 `always-ask/write/yolo` → **G3** → `spec.permission: "supervised"|"edits"|"full"`（映射 T3 三档：Supervised=写+执行都问、edits=只问执行、full=不问）+ `spec.approve[]`(模式白名单) + `spec.deny[]`（恒拒并从 `--tools` 剔除）。“Auto”档（模型评审器）=G34 advisor 就绪后再开。
3. ★**restrictedFolders / protected paths** —— OMP `tools.restrictedFolders`（任何档必问、headless 拒）；Claude `blockWritesOutsideWorkingDirectories`+protected paths 永不自动批 → **新增 G33** → `spec.deny_paths[]`（默认含 `.env`、`*.pem`、`~/.ssh`、`$AICA_STATE` 之外系统目录），gate.ts 解析 args 里的 path 参数命中即 `{block:true}`——**规则守门不弹窗，是 stream-rules 的对偶面**。
4. ★**pending 文字回复 = deny+反馈** —— T3 permission-modes.md（"type a text reply to decline that request and give feedback"）→ **新增 G36** → workbench：节点有待答 approve/gate 卡时收到自由文本 reply → 写 `gate-ans.json{decision:"deny",feedback}`，worker 续跑。零新机制，纯语义复用。
5. **ask-and-remember grant** —— OMP `always-ask-cached`（file/dir/once 三粒度 + `approval-cache.db` 跨会话；grant 记 tier 写覆盖读）→ **G3 增强（G30）** → R1 只落 `grant:"session"`（节点级 `grants.json`，spawn 时清理）；跨会话 db 留 R2。
6. **审批审计对** —— dsh `approval/asked`+`approval/decided`（v1）；OMP grant 每次现读 db → **G36** → gate-req/gate-ans 双文件 + `events.jsonl` 写 `approve_ask/approve_decide` 两条，进 UI steps 但不进 worker.md 提示（防提示膨胀）。
7. **Codex `declined` 状态进事件流** —— exec_events.rs `CommandExecutionStatus::Declined` → **G2 投影语义** → 被 deny 的调用在 steps 显示为 `st:"deny"` 而非失败。

### 2.2 运行时纠偏（OMP/Cindy 独有，本项目完全空白）

8. ★**stream rules（TTSR）→ R1 落「args 守门」子集** —— docs/ttsr-injection-lifecycle.md（regex 命中→abort→注入 reminder→同点重试）→ **新增 G31** → R1 只能在 `tool_call` 层做：`spec.rules:[{pattern,message}]`，args JSON 正则命中→`{block:true,reason:message}`（pi 把 block reason 回给模型=注入等效）。**文本流中 abort 需 RPC/引擎内钩子 → R2**。
9. ★**doom-loop guard** —— Cindy `ToolLoopGuard`（同 name+args+output 连 4=疑似/连 30=硬断；60min 同结果硬顶；辅助模型 CONTINUE/STOP 复核）+ OpenCode `doom_loop` 权限 → **新增 G32** → gate.ts 计数 `(toolName+sha1(args))` 连续相同：≥5 次 `{block:true,reason:"疑似循环：…"}`；≥15 次直接写 `result failed("loop")`+进程退出建议。辅助模型复核留 R2。
10. **advisor 评审模型** —— docs/advisor-watchdog.md（severity nit/concern/blocker、immuneTurns、WATCHDOG.yml roster、独立 ToolSession）+ Cindy toolLoopReviewer + Misaka 红队 → **新增 G34** → R1 落**节点级 reviewer**：`profile:"reviewer"` + `prompts/reviewer.md` + 编排器派一个子节点专做验收评审（利用已有 depends+accept_idx）。**轮内 inline advisor（第二 pi 进程读 events.jsonl 写 spec.reply）留 R2**——文件态反而天然支持：advisor 进程只需 tail 节点目录。
11. **model roles + prewalk** —— OMP `modelRoles`（default/smol/plan/task/advisor…）+ `prewalk`（起步贵模型、首次写盘切便宜模型）+ Misaka 每 Sister 各自模型 → **G16 扩展** → `aica-pi/roles.json{worker,orchestrator,reviewer,advisor}`，daemon 按 `spec.profile` 取默认模型；prewalk 式「探索-写盘分模型」留 R2（需 mid-session 切模型=RPC `set_model`）。

### 2.3 事件与投影

12. ★**Codex exec item 模型** —— exec_events.rs：`item.started|updated|completed` + item 类型枚举（含 `todo_list`、`collab_tool_call`、`declined`）→ **G2** → daemon 转写器把 pi `--mode json` 事件映射成同一三段式（start/update/end 共用一个 call_id），`agent_delta` 增量文本、`todo` 计划项、`abort`/`retry`/`compaction` 透传——**与 codex item 对齐后，未来接 codex worker 时投影免改**。
13. ★**todo/plan item 投影** —— exec_events.rs `TodoListItem{text,completed}` + Claude `TaskCreate/TaskCompleted` → **新增 G35** → `ev_todo` 工具写 `todo.json`（worker 自律计划）→ apiView 投影成 checklist；orchestrator 的 `plan.v1.json` 同构渲染（顺带激活 G10 死字段）。
14. **T3 意图-事件-副作用三段式** —— internals/overview.md（Orchestrator 只决定事件、EventSink 单事务提交、EffectWorker 后行）→ **架构确认非新缺口**：我们的 `spec.json 落盘=意图提交、daemon=effect worker、events.jsonl=事件日志`已同构；PRD 记录该对齐，R1 补的是「命令回执」——`writeSpec` 已返回 id，无改动。
15. **hidden-ref checkpoint** —— T3 CheckpointStore（git hidden refs 抓工作区）+ OMP `checkpoint/rewind` → **新增 G40** → R2+：节点 `artifacts/` 有产物但用户仓无隔离；先做「节点目录快照」cheap 版（`node-checkpoint` 命令 tar 节点目录），worktree 版随 G20。

### 2.4 子代理与编排

16. ★**Agent Hub 式节点控制面** —— docs/agent-hub.md（roster: status/model/cost/当前工具/parent；steer/revive/kill；revive=盘上 transcript 全史重开）→ **新增 G36+G19 合体** → apiView 树行补 `live`（worker.json pid 存在）、`cur`（尾事件工具名）、`spent`；行内 ✕abort + 回复框；sheet 加 transcript tab（tail events.jsonl）。**revive 我们天然有：session 持久化后重拉=全史恢复（G1 已修的红利）。**
17. ★**join/wait 原语** —— OMP `wait` 工具、Codex `wait_agent`+`collab_tool_call.agents_states`、dsh `drainDescendants`、Misaka 层间 reconciliation（本级全完才开下级）→ **G6** → `ev_wait{paths}` 工具 → `result{status:"waiting",wait_on}` → pendingNodes 判定全 done 自动复活并把子 summary 拼进 `spec.reply`（v1 R1.5 设计不变，仍是 R1）。
18. **子代理定义即数据（frontmatter 式）** —— OMP agent 定义（`tools/spawns/model/blocking/structured/prewalk/advisor`）+ Claude `.claude/agents/*.md` + Misaka Sister（DESCRIBE.md 分级曝光）→ **spec 演进方向** → `ar_dispatch` 参数面扩 `tools/model/blocking/structured`；`spawns`（子代理可否再派=depth 控制）我们已有 `budget.depth_left` 对应物；**分级曝光=spec.goal 只放摘要、`already_known` 放详情**——orchestrator.md 提示词层即可吸收。
19. **结构化回传** —— OMP `structured`+`yield`+`output` schema、Codex `--output-schema`、dsh `outputSchema` → **G21**（P2 保留）→ result.json 加 `output` 字段+JSON Schema 校验放 R2；R1 先约定 `accept` 里写「产出 JSON 于 artifacts/x.json」。
20. **审批冒泡到父会话** —— T3「subagent approval requests appear in the parent conversation」→ **G36** → apiView inbox 已带 `crumb` 面包屑（server.ts:316）；R1 只需 approve 卡同样带 crumb，天然满足。
21. **Misaka 计划审批 + coverage table + paths list** —— README 七段流水线 → **G10 扩展** → `plan.v1.json` schema 增 `coverage:[{subquestion,card:path}]`+`paths:[{option,disposition,reason}]`（声明式缺口=空格）；orchestrator.md 提示词补「覆盖表必填、可能性只开一次、未走之路记 disposition」——**提示词层收益最大成本最低的一条**。
22. **红队/发散评审阶段化** —— Misaka §4-6（红队→回应（每异议恰一次）→发散评审（补内缺口 vs 开新方向））→ **G34** → reviewer profile 提示词分两段：verify（验收条目核对）+ diverge（列出被前提遮蔽的方向供父节点开新 spec）——接进已有 `mode.shape: diverge|converge`（envelope.ts:24 死字段激活）。

### 2.5 上下文与记忆

23. **portable handoff** —— T3 portable-handoffs.md（预算化选人话消息迁移 + 省略历史留引用 + thread-reading tool 回取；用户输入永不裁短）→ **新增 G39** → R2：跨 agent/profile 换模型或 session 损坏时，从 events.jsonl+session JSONL 选（原始诉求+最近 N 轮+result 摘要）写进新 spec.already_known，`ar_read` 工具已提供「回取历史」通道。
24. **learn→lessons 管线** —— docs/memory.md（`learn`→`learned.md` 新→旧去重≤100、下一会话注入不动当前前缀；两段式抽取-汇聚产 MEMORY.md/skills）→ **G22 扩展** → R1 cheap 版：`ev_learn{text}` 工具 → `STATE/memory/learned.md` append+去重；daemon userMessage 末段注入「## 经验教训」≤2000 字。两段式模型汇聚留 R2。
25. **Cindy MCP 网关两 schema** —— pi-harness.md §MCP 桥（模型只见 list_tools/call_tool，未披露 schema 的调用 fail-closed、按 schema 指纹记账、compaction 后一次性清单提醒）→ **G15 的实现蓝图** → R2 接 MCP 时不直接透传，而写 `aica_mcp` 网关扩展复刻此模式（防工具目录吃光上下文 + 天然审批点）。
26. **post-compaction 上下文续命** —— Cindy「compaction 后注入一次性已披露工具清单」+ Claude `PreCompact/PostCompact` hook + OMP TTSR「注入穿越 compaction 存活」→ **G2 投影细节** → `compaction_end` 事件进 steps 显示「上下文已压缩」；rules/经验注入放 userMessage 尾部（pi compaction 不动 user 消息）。

### 2.6 hooks 与自进化

27. ★**Claude Code hooks 子集 → aica lifecycle hooks** —— docs/en/hooks 全表 + Codex 已收敛同契约（v0.124）→ **G14 扩展（新增 G37）** → R1 落 4 个文件态 hook 点：`node_start`（spawn 前，可注入 already_known）、`pre_tool`（=gate.ts 已有）、`node_settled`（result 写后，可派后续 spec）、`gate_raised`（gate/approve 卡产生，可发通知）。形态：`aica-pi/hooks/<event>.mjs` 存在即跑，stdin 喂 JSON、stdout 收 JSON——**直接照抄 Claude command-hook 契约，未来换引擎不重写**。
28. **hook 信任评审** —— Codex hooks（非 managed hook 须评审+trust）→ **G37 备注** → hooks 目录必须显式存在于 aica-pi 包内或 spec.hooks 白名单声明；run 目录下的文件不作 hook 源（防 worker 自己写 hook 提权）。
29. **skill 显式挂载** —— pi `cli.md:202`「`--no-skills` 下 `--skill <path>` 仍加载」→ **G14** → `spec.skills[]`→daemon 逐条 `--skill <aica-pi/skills/x>`；首个 SKILL.md = desktop（tools.ts:127 已引用 `skills get desktop`）。
30. **Codex managed/policy 层** —— `allowed_approval_policies` + T3 managed policy 封顶档位 → **G30** → `aica-pi/policy.json{max_permission:"supervised"}` 全局封顶：spec.permission 求更高档时被压低并记 events。

---

**吸收清单 top 一句话**：R1 真正要写的是三个文件 —— `daemon 转写器`（事件投影）、`gate.ts`（审批+规则+路径+循环四合一守门）、`ev_wait`（join）；UI 侧两个面 —— approve 卡 + 节点控制行。其余全是提示词与 schema 工作。

---

## 3. v2 缺口总表

G1–G28 状态按最新源码核验；新增 G29+ 续编号。判：✅已修 / 🔶特性化或部分 / ❌未修 / ⏸降级。

### P0

| # | 缺口 | v2 状态 | 依据 |
|---|---|---|---|
| G1 | gate/reply 复活丢上下文 | ✅ | `src/daemon.ts:90` `--session-dir <node>/session --session-id aica`，持久 session 实测可用 |
| G2 | 无 turn 级流进 UI | ❌ P0 | `src/daemon.ts:139,156` stdout 仍整段进 log 无人读；`events.ts` 无 delta 订阅 |
| G3 | 无调用级审批 | ❌ P0 | 仍只有 `spec.tools` 静态白名单（`server.ts:387-392` 三档、`worker.md:7` 口头禁令） |
| G4 | 无中止/超时/取消 | ❌ P0 | daemon 不记 pid、无 kill 路径、`budget.minutes` 死字段（envelope.ts:28） |
| G5 | 孤儿 worker/重复拉起 | 🔶特性化 | 「多轮重拉」定性为设计（缓存友好）；**残留真风险拆为 G29** |
| G6 | 父等不了子（无 join） | ❌ P0 | `tools.ts:107-122` 无 wait；depends 只管拉起（runs.ts:145） |
| G7 | spent 不落账 | ❌ P0 | `envelope.ts:43` 字段空挂；`events.ts:52` 抓到 usage 没聚合 |
| G8 | check 漏嵌套节点 | ✅ | `runs.ts:107-122` `listNodePaths` 递归，`pendingNodes`/`checkRun`/`server.ts` 共用走法 |
| G9 | claude/codex worker 摆设 | ⚠️ P0→P1 | 未动；v1 R1.8 的 experimental 徽标仍未落 |
| G29 | **节点 worker 锁**（新） | ❌ P0 | session 持久化后双写同一会话目录代价变大；daemon 崩溃→孤儿 worker 仍在写 → 需 `worker.json{pid}` 租约（v1 R1.4 设计的独立缺口化） |

### P1

| # | 缺口 | v2 状态 |
|---|---|---|
| G10 | 计划态无生命 | ❌ 保留；R1 借 ev_todo+plan schema 激活（§2.3-13、§2.4-21） |
| G11 | 不能 steer 运行中 worker | 🔶 部分：reply 对 running 节点会写 spec.reply 但当前进程看不到；真 steer 留 R2 RPC |
| G12 | transcript 不可见 | ❌ 保留；R1 落轻量版（events 投影已够，stdout.log 解析留 R2） |
| G13 | file_edit 定义了没人发 | ❌ 保留；R1 转写器顺带从 tool_execution_start(args) 发 |
| G14 | skills/hooks 未开 | 🔶 skills 有低成路径（`--skill` 显式挂载）；hooks 拆 G37 |
| G15 | MCP 未接 | ❌ 保留 R2；蓝图换 Cindy 网关模式（§2.5-25） |
| G16 | 模型路由单点 | 🔶 `spec.model`+实测 deepseek-v4.1-flash 可用；roles.json/fallback 保留 |
| G17 | 无完成/等待通知 | ❌ 保留；R1 落 Web Notification+可选 toast |
| G18 | `art://` 不解析 | ❌ 保留 R1 |
| G19 | UI 无写路径控制面 | ❌ 与 G36 合体：abort/回复/重试进节点行 |
| G30 | **approval grant + managed 封顶**（新） | ❌ P1：approve 答「本次会话都同意」写 grants.json；policy.json 封顶档位 |
| G31 | **stream-rules-lite**（新） | ❌ P1：spec.rules 正则守门 args；文本流内 abort 留 R2 |
| G32 | **doom-loop guard**（新） | ❌ P1：签名计数 block；辅助模型复核留 R2 |
| G33 | **protected paths**（新） | ❌ P1：spec.deny_paths+默认敏感表，tool_call arg 路径解析 |
| G34 | **reviewer/advisor 角色**（新） | ❌ P1：profile=reviewer 节点级先行；inline advisor 留 R2 |
| G35 | **todo/plan item**（新） | ❌ P1：ev_todo→todo.json→checklist 投影 |
| G36 | **approve 卡语义**（新） | ❌ P1：crumb 冒泡、pending 文字=deny+反馈、审计对 |
| G37 | **aica lifecycle hooks**（新，自 G14 拆出） | ❌ P1→P2：4 个文件态 hook 点+信任边界 |

### P2

| # | 缺口 | v2 状态 |
|---|---|---|
| G20 | worktree 隔离 | ⏸ 保留（v1 已排 R3） |
| G21 | 结构化子节点产出 | ⏸ 保留 R2（OMP yield/schema 为参照） |
| G22 | 记忆/知识 | 🔶 升级：R1 落 learn→learned.md 注入 cheap 版；kn 管线 R2 |
| G23 | 远程/多端 | ⏸ 保留（T3/Cindy device-link 均证可行，非本期） |
| G24 | 调度/触发 | ⏸ 保留（Codex app RRULE、dsh jobs 为参照） |
| G25 | 安全边界 | ⏸ 文档化（Cindy Full access 契约的诚实写法值得抄进 README） |
| G26 | 导出/分享 | ⏸ 保留 |
| G27 | envelope 无 schema 校验 | ⏸ 保留（typebox 已在 aica-pi 依赖） |
| G28 | eval/质量基线 | ⏸ 保留 |
| G38 | **learn/lessons 管线全量**（新） | ⏸ P2：两段式汇聚+skills 生成（OMP local backend 全形） |
| G39 | **portable handoff**（新） | ⏸ P2：跨 agent/模型切换的预算化上下文迁移 |
| G40 | **checkpoint/revert**（新） | ⏸ P2：节点目录快照 cheap 版→hidden git refs 完整版 |

---

## 4. 执行计划 R1（自动化可执行粒度）

原则：**零新依赖、Node 26 type-stripping、Windows 优先、文件态唯一真相、worker 进程模型不变**（仍 spawn `pi -p --mode json`；RPC 迁移= R2.1）。每步给：改动文件 → 机制 → 验收命令/断言。依赖序即编号序。

### S1 · 信封扩字段（前置，无行为变化）

- `src/envelope.ts`：
  - `SpecEnvelope` 增 `permission?: "supervised"|"edits"|"full"`、`approve?: string[]`（工具名/前缀模式）、`deny?: string[]`、`deny_paths?: string[]`、`rules?: {pattern:string;message:string}[]`、`skills?: string[]`。
  - `ResultEnvelope` 增 `wait_on?: string[]`、`output?: unknown`。
  - `EventRecord.kind` 增 `"agent_delta"|"tool_update"|"turn"|"retry"|"compaction"|"abort"|"approve_ask"|"approve_decide"|"todo"|"loop"`。
- `src/cli.ts` `dispatch`/`node-create` 透传新字段（`--permission/--approve/--deny/--deps` 已部分在）。
- 验收：`node src/cli.ts version` 通过；`tsc --noEmit`（若有）无新错。

### S2 · turn 级流转写器（G2+G13 底）

- `src/daemon.ts` `spawnWorker()`：`stdio:["ignore","pipe",log]` 改 `"pipe"` 接出 stdout —— `child.stdout` 按行 readline：①原样 append stdout.log（证据）；②JSON.parse 后按类型转写 `events.jsonl`：
  - `message_update.assistantMessageEvent.text_delta` → `agent_delta{delta}`（每 ~200ms 或 ≥500 字符 flush 聚批，防 1 字符 1 行）
  - `tool_execution_start/end/update` → `tool_execution{phase,call_id,tool,args/output preview}`（events.ts 扩展已在发同类，**二选一：daemon 转写为权威，events.ts 保留 message_end usage 捕获**；防双写=events.ts 里注释掉 tool_execution 两个 handler 或 daemon 侧以 `source:"daemon"` 标记去重）
  - `tool_execution_start` 且 tool∈{edit,write} → 额外发 `file_edit{path,preview}`（G13）
  - `turn_start/turn_end`、`auto_retry_*`、`compaction_*`、`agent_settled` → 同名透传 `turn/retry/compaction`
  - `message_end.usage` → 内存累计（供 S6）
- `workbench/server.ts` apiView steps：尾 12 条 → 尾 30 条 + 进行中 delta 合并（同 call_id 折叠）。
- `workbench/public/v1/index.html`：`stepHtml` 认 `agent_delta`（渲染为淡灰流式气泡）、`file_edit`、`deny`。
- 验收：跑 3 分钟任务，`GET /api/runs/<r>/node/<p>/events` 期间两次返回 diff>0 且含 `agent_delta`；对账：events.jsonl 的 tool_execution 条数 = stdout.log 的 tool_execution_start 条数。

### S3 · worker.json 锁 + abort + 超时（G29+G4）

- `src/daemon.ts` `spawnWorker()`：spawn 成功写 `worker.json{pid,started_at,cmd}`；finish 删。
- `src/runs.ts` `pendingNodes()`：worker.json 存在且 `process.kill(pid,0)` 成立 → skip；pid 死但文件在 → 删文件按 pending 重拉（崩溃恢复）。
- `src/cli.ts` 新命令 `abort --run --node`：读 worker.json → win32 `taskkill /PID <pid> /T /F` → `writeResult` 前先查已存在不覆写（`writeResult` 加 `if(existsSync result.json) return` 幂等 guard）→ result `failed("aborted by user")` + event `abort`。
- `budget.minutes`：spawnWorker `setTimeout` 到点走同 abort 路径，summary 改 "timeout"。
- `workbench/server.ts`：`POST /api/runs/<id>/node/<p>/abort` → `ar abort`；`apiView` 节点行加 `live:!!worker.json`；DELETE run 前先遍历 abort live worker。
- 前端：running 节点行内 ✕。
- 验收：running 节点 POST abort → ≤10s result=failed("aborted")，`tasklist` 无 pi node 进程；`budget.minutes:1` 任务 ~60s 标 timeout；daemon 在 worker 运行中被杀重启后同节点不二次拉起（events spawn 数=1）。

### S4 · gate.ts 审批门（G3 核心 + G30/G33/G36）

- `aica-pi/extensions/gate.ts`（新文件，daemon `-e` 挂载）：
  - `pi.on("tool_call")` handler，顺序：**deny 检查**（tool∈spec.deny 或 args 路径命中 deny_paths → `{block:true,reason:"denied by spec"}`）→ **rules**（spec.rules 正则命中 JSON.stringify(args) → `{block:true,reason:message}`）→ **grant 检查**（`grants.json` 里 tool 在列 → 放行）→ **approve 检查**（permission 档+approve 模式命中 → 进审批）。
  - 审批：写 `gate-req.json{callId,tool,args,ts,targets:[解析出的文件/目录路径]}` + `appendEvent approve_ask` → **handler 内 await 轮询** `gate-ans.json`（500ms，超时 5min → `{block:true,reason:"approval timeout"}`）→ `allow_once` 放行 / `allow_session` 放行+写 grants.json / `deny{feedback}` → `{block:true,reason:feedback||"denied"}` + event `approve_decide`。写不出 gate-req → fail-closed block。
  - spec 文件读法：`process.env.AR_NODE_PATH`+`AICA_STATE` 定位 spec.json（与 tools.ts 同机制）；`perm-<ts>.json` 支持热切换（仿 Cindy perm 文件现读）。
- `src/envelope.ts` 无新改（S1 已备）。
- 验收：`spec.approve:["bash"]` 任务每条 bash 产 gate-req；写 `{"decision":"deny","feedback":"别删"}` → 工具返 block 且 worker 续跑；超时 deny；`spec.deny_paths:["secrets"]` 命中即 block 无 gate-req。

### S5 · workbench approve 卡 + pending-reply 语义（G36+G30）

- `workbench/server.ts` apiView inbox：扫节点 `gate-req.json`（有 req 无 ans）→ `kind:"approve"` 卡：`t=tool`、`d=args 摘要+targets 列表`、`crumb` 冒泡父链、opts=[同意一次/本次会话都同意/拒绝]。
- `POST /api/runs/<id>/node/<p>/approve`：写 `gate-ans.json{decision,ts}`。
- apiReply 增强：节点有未答 gate-req 且收到自由文本 → 写 `gate-ans.json{decision:"deny",feedback:text}`（T3 语义）。
- `policy.json`：`aica-pi/policy.json{max_permission}` 存在则 spec.permission 超档压低+记 event。
- 前端：approve 卡渲染工具名+命令/路径+三按钮。
- 验收：approve 卡出现在 inbox；「本次会话都同意」后同工具不再产 req（grants.json 生效）；挂起卡上发文字 → worker 收 deny+feedback 续跑。

### S6 · spent 聚合（G7）

- S2 转写器累计 `message_end.usage.totalTokens`+`turn.completed usage` → worker 退出时 daemon 兜底：`result.spent` 无值则从累计写入 `{tokens,minutes}`。
- `tools.ts` `ev_done/ev_fail` 增可选 `spent_tokens` 参数透传 `ar done --spent-tokens`（cli done/fail 收参写 result）。
- apiView run 头 `dur` 旁显 Σtok；tree 行显 spent。
- 验收：done 节点 result.spent.tokens>0；run 头 Σtok=Σ各节点 spent。

### S7 · ev_wait join（G6）

- `tools.ts` 注册 `ev_wait{paths:string[]}` → `ar wait --on <csv>`。
- `src/cli.ts` `wait`：`writeResult{status:"waiting",wait_on:[…]}` + `writeGate{question:"等待子节点",opts:[]}`（gate kind=wait，inbox 标 `auto` 不要求人答）。
- `src/runs.ts` `pendingNodes()` waiting 分支：`r.wait_on` 全 done → `resolveWaiting` + 把各子 result 摘要 append 进 `spec.reply[{text:"[系统] 子节点 <path>: <summary>",ts}]` → resumed 拉起（S1 持久 session 让父看到全史）。
- `prompts/orchestrator.md` 补「派发后 ev_wait 挂起，子节点全 done 自动复活你」。
- 验收：orchestrator 派 3 子+ev_wait → 三子全 done 后父自动复活（无人工），父新 turn 上下文含三 summary（transcript/events 断言）。

### S8 · loop guard（G32）

- gate.ts 内 `Map<sig,{n,firstTs}>`（sig=tool+sha1(stableArgs)）：
  - 连续相同 ≥5 → `{block:true,reason:"loop-guard: 相同调用已连续 N 次，换方法或 ev_gate 求助"}`
  - 连续相同 ≥15 或 60min 同结果 → `{block:true,reason:"loop-guard: hard stop",terminate:true}` + event `loop`
- 计数写入 gate-req 同目录 `loop.json`（重启重置=简单策略，对齐 Cindy「启发式非证明」）。
- 验收：脚本让 worker 重复同一 bash ≥5 次 → 第 5 次 block，events 有 loop 记录，worker 改道或 gate。

### S9 · ev_todo + plan 投影（G35+G10）

- `tools.ts` `ev_todo{items:[{text,done?}]}` → 写 `todo.json{items,ts}` + event `todo`。
- apiView 节点行/ sheet 加 checklist 渲染（st=done 划掉）。
- orchestrator 写 plan：`plan.v1.json` 增 `coverage/paths` 字段（schema 先松，orchestrator.md 提示词约束必填）。
- 验收：worker 调 ev_todo → sheet 出现 checklist 且随更新变化。

### S10 · Agent Hub lite 节点控制面（G36+G19+G12 轻量）

- apiView 树行补：`live`（worker.json）、`cur`（尾事件 tool）、`spent`、`wait:waiting 原因`。
- 前端节点行：live 行显 ✕abort + 回复框（reply 通道）；done 行显 ⟲（`POST .../retry` = 删 result+result.resolved→pending 重拉，session 还在）。
- `GET /api/runs/<id>/node/<p>/transcript`：events.jsonl 全量解析成 message/tool 视图（轻量 transcript 先吃自家事件，stdout.log 全量解析留 R2.2）。
- 验收：running 行有 ✕+输入框；回复进 spec.reply 且下轮 spawn 可见；done 行 ⟲ 触发重拉且 session 历史继承。

### S11 · reviewer profile（G34）

- `aica-pi/prompts/reviewer.md`：两段职责 —— verify（对 accept 逐条核证）+ diverge（列被前提遮蔽的方向，供父开新 spec）。
- `src/daemon.ts` launcher：`spec.profile:"reviewer"` 映射 prompt+默认只读工具面（`read/ls/find/grep/ar_read/ev_done/ev_fail/ev_gate`）。
- `roles.json`（S13）给 reviewer 配独立模型槽。
- 验收：`profile:"reviewer"` 节点拉起用 reviewer.md；产出含 verify/diverge 两段。

### S12 · learn/经验 cheap 版（G22 半）

- `tools.ts` `ev_learn{text}` → append `STATE/memory/learned.md`（新→旧、sha1 去重、截 ≤2000 字/条、文件 ≤50 条）。
- `src/daemon.ts` `userMessage()`：末段注入「## 经验教训」读 learned.md 前 2000 字。
- 验收：run A ev_learn → run B userMessage 含该条（看 spawn cmd 或 transcript）。

### S13 · roles.json + 通知（G16 半 + G17）

- `aica-pi/roles.json{worker,orchestrator,reviewer,advisor}` → daemon `spec.model ?? roles[profile] ?? AICA_PI_MODEL ?? DEFAULT`；fallback：spawn 失败重试时取 `fallback[]` 下一候选。
- 前端 SSE change 且 inbox 增 → `new Notification("aica",{body:问题首行})`（localhost=secure context 可用）；daemon 侧可选 `powershell New-BurntToast`/msg 简化版：写 `STATE/notify.log` 供外部 watcher。
- 验收：roles.json 改 reviewer 模型 → reviewer 节点 spawn cmd 含该 model；窗口失焦时 gate 触发 OS 通知。

### S14 · art:// 物化 + skills 挂载（G18+G14 半）

- `src/daemon.ts` spawnWorker 前：`spec.inputs[].ref` 以 `art://<root>/<path>/<file>` → 复制进节点 `inputs/`、`userMessage` 改相对路径；绝对路径校验存在。
- `spec.skills[]` → 逐条 `--skill <AICA_PI>/skills/<name>`（`--no-skills` 下显式 --skill 仍载，cli.md:202-203）；写 `aica-pi/skills/desktop/SKILL.md` 首篇。
- 验收：art:// 任务 inputs/ 有文件；spec.skills:["desktop"] 的 worker transcript 见 skill 加载。

### S15 · aica hooks 骨架（G37 轻量）

- `aica-pi/hooks/` 目录约定：`node_settled.mjs`（daemon finish 后若存在则 `node <hook> <node_dir>`，stdin 喂 `{spec,result}`，stdout JSON `{dispatch:[...spec]}` 可派后续）——只落这一个最值钱的点（自动派验收/reviewer 节点）；信任边界：只认 aica-pi 包内目录。
- 验收：放一个 echo hook → result 写后被调用，返回 dispatch 生成新 spec。

### R2（预告，不进 R1）

RPC 化（steer/真 abort/extension_ui_request 直通审批免轮询）、文本流 TTSR、inline advisor、MCP 网关、memory 两段式、handoff、checkpoint/git-refs、多 agent 适配补齐、导出分享。

---

## 5. 验收

| 步骤 | 可验证指标 | 方式 |
|---|---|---|
| S2 | 运行中 ≥1 事件/2s 进 events.jsonl；tool_execution 对账=stdout.log 条数；UI steps 见 delta | e2e + 对账脚本 |
| S3 | abort ≤10s 生效无残留；timeout 准点；daemon 重启不重拉 live 节点 | e2e + tasklist |
| S4 | approve 模式任务逐调用产 req；deny 反馈续跑；超时 deny；deny_paths 直 block | e2e 双路径 |
| S5 | grant 生效后不再问；挂起卡发文字=deny+feedback | e2e |
| S6 | spent.tokens>0 且 run Σ=Σ节点 | 对账 |
| S7 | 3 子 ev_wait 全 done→父自动复活含子 summary | e2e 编排 |
| S8 | 同调用 ≥5 block 且 worker 改道/求助 | 注入重复调用 |
| S9 | ev_todo → checklist 可见且更新 | e2e |
| S10 | live 行 ✕/回复/⟲ 可用；transcript 覆盖 events ≥95% | UI+API |
| S11 | reviewer 节点用 reviewer.md、产出两段式 | spawn cmd+result 断言 |
| S12 | learned.md 跨 run 注入 | e2e 双 run |
| S13 | 角色模型路由正确；失焦通知触达 | spawn cmd+手测 |
| S14 | art:// 文件落 inputs/；--skill 进 spawn cmd | e2e |
| S15 | hook 触发且 dispatch 生效 | 放 hook e2e |

---

## 附录 · 一手出处索引（本轮新增）

**本仓**：`src/{cli,runs,daemon,envelope}.ts`、`workbench/{server.ts,public/v1/index.html}`、`aica-pi/{extensions/{tools,events,paths}.ts,prompts/{worker,orchestrator}.md}`。

**pi 1.5.0（本机 `%APPDATA%\npm\node_modules\@earendil-works\pi-coding-agent\docs`）**：extensions.md（tool_call `{block,reason,terminate}`:971-986、fail-safe:3233、UI 事件:699）、json.md（事件全表:37-212）、cli.md（`--skill` 在 `--no-skills` 下仍载:202-203、`--tools` 语法:119-138）、rpc*.md、sessions.md、mcp.md。

**Claude Code**：code.claude.com/docs/en/{hooks（32 事件表+decision 契约）,permission-modes（六档含 auto 默认化/dontAsk）,permissions,sub-agents}。

**Codex**：`codex-rs/exec/src/exec_events.rs`（ThreadEvent/ThreadItemDetails 全枚举：CollabToolCall+TodoListItem+Declined）；developers.openai.com/codex/{hooks（v0.124 转正、Claude 兼容契约）、config-reference（approval_policy on-request/never/granular；agents.*）、noninteractive}；PR #18893（hooks TOML/managed）。

**T3 Code**：docs/internals/overview.md（Orchestrator→EventSink 单事务→EffectWorker；checkpoint=hidden git refs；settlement server-owned）；docs/user/{permission-modes,providers-pi,portable-handoffs}.md。

**Misaka-Agent**：README.md §Core design/Inside a node（七段流水线、coverage table、paths list、plan approval、fork-继承史、DESCRIBE/SOUL 分级）；docs/guide/{research,team,panel}.md。

**Cindy**：docs/dev-rules/{pi-harness.md（cindy-bridge 拦截、perm 文件热读、MCP 网关两 schema+指纹门+compaction 清单、append-system-prompt 走文件）、maker-core-and-agent-behavior.md（ToolLoopGuard+辅助模型复核）、orca-team-architecture.md（Lead/Worker 全会话、?session= 身份路由、worktree per worker）}；packages/maker-core/src/agents/{base-agent.ts,pi/index.ts,codex/index.ts}。

**Oh My Pi**：docs/{ttsr-injection-lifecycle.md（stream rules 全生命周期）、approval-mode.md（三输入+四档+grants db+restrictedFolders+safety override）、advisor-watchdog.md（severity/EmissionGuard/WATCHDOG.yml roster）、agent-hub.md（roster/steer/revive/kill + agent://history://proc://）、task-agent-discovery.md（frontmatter/spawns/blocking/structured/prewalk/@role）、memory.md（5 backend+两段管线+learn→learned.md）、collab.md}。

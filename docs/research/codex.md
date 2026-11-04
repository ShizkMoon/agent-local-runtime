# Codex（openai/codex）源码级复核 —— 事件模型、双轴审批、guardian、hooks

> 复核对象：`github.com/openai/codex`，本地 `--depth 1` clone 于 `C:\Users\Administrator\ego\research\codex`
> 复核 commit：`93b4e5b4c6474cdbf12614c4ac3acbd006fbee89`（2026-11-04 05:59 +0000，`Stop TUI voice calls when the OS session locks (#59330)`）
> 证据层级：本文除特别标注外，全部为**公开源码**，给 `codex-rs/<crate>/src/<file>:<line>`；官方文档另注 URL。
> 与 v2 的关系：v2 §1.2 的每一条在 §1.3 表里判「确认 / 修正 / 新增」，修正处附源码行。
> 写作约定：`需要复核` 标记我未能从源码/文档直接证实、只由命名或注释推断的点。

---

## 0 出处

**一手源码（本次逐行读过）**

| 主题 | 文件 | 关键行 |
|---|---|---|
| exec 事件协议全枚举 | `codex-rs/exec/src/exec_events.rs` | 11-37（ThreadEvent）、61-73（Usage）、107-133（ThreadItemDetails）、150-157（CommandExecutionStatus）、223-241（CollabTool/CollabAgentStatus）、252-259（CollabToolCallItem）、314-323（TodoList） |
| 审批策略双轴（第二轴） | `codex-rs/protocol/src/protocol.rs` | 1163-1186（AskForApproval）、1188-1204（GranularApprovalConfig）、4465-4500（ReviewDecision）、4588-4595（TurnAbortReason） |
| 沙箱档（第一轴） | `codex-rs/protocol/src/config_types.rs` | 98-113（SandboxMode，`ReadOnly` 为 default） |
| 审批请求事件本体 | `codex-rs/protocol/src/approvals.rs` | 87-270（guardian 全套）、273-356（ExecApprovalRequestEvent） |
| hooks 事件/处理器/来源/信任 | `codex-rs/protocol/src/protocol.rs` | 1802-1819（HookEventName 14 个）、1821-1828（HookHandlerType 4 种）、1830-1842（Sync/Async、Thread/Turn）、1844-1868（HookSource 11、HookTrustStatus 4）、1870-1878（HookRunStatus） |
| hooks 运行时 | `codex-rs/hooks/src/{types.rs,events/*.rs,engine/*.rs}` | types.rs:12-30（HookResult 三态）、62-72（HookPayload）、90-97（HookEvent） |
| 会话主循环操作面 | `codex-rs/protocol/src/protocol.rs` | 705+（`Op` 枚举）、1105-1141（`Op::kind()` 全表） |
| 压缩 | `codex-rs/core/src/compact.rs` | 63（`COMPACT_USER_MESSAGE_MAX_TOKENS = 20_000`）、117（inline auto compact task）、417（auto compact window 推进） |
| AGENTS.md 注入 | `codex-rs/core/src/agents_md.rs`、`core/src/agents_md_manager.rs`、`core/src/context/world_state/agents_md.rs` | 文件存在 + 快照测试目录 `world_state/snapshots/` |
| 落盘/恢复 | `codex-rs/rollout/src/recorder.rs` | 1（rollout 目的注释）、79-80（`~/.codex/sessions/rollout-<ts>-<uuid>.jsonl`）、98-99（revert 生成 `_<rollout_id>` 新文件） |
| CLI 动词 | `codex-rs/exec/src/cli.rs` | 52-53（`--output-schema`）、63-70（`--json`）、72-79（`--output-last-message`）、174-178（`Resume`/`Fork`）、206-214（`--last`） |
| TUI 审批/差异 | `codex-rs/tui/src/bottom_pane/approval_overlay.rs`、`tui/src/{diff_model.rs,diff_render.rs,approval_events.rs}`、`tui/src/app/file_change_approvals.rs` | approval_overlay.rs:1-13（模块契约） |

**机器可验证命令**（任意一次复核可复现）

```powershell
git -C C:\Users\Administrator\ego\research\codex log -1 --format='%H|%ad|%s' --date=iso
Get-Content C:\Users\Administrator\ego\research\codex\codex-rs\exec\src\exec_events.rs | Select-Object -Skip 145 -First 15
```

**官方文档（仅作旁证）**：`developers.openai.com/codex/config-reference`、`developers.openai.com/codex/hooks`、`developers.openai.com/codex/noninteractive`。本次未逐页抓取，凡涉文档而未对源码的结论一律标 `需要复核`。

---

## 1 定位与体感

Codex 是「把 agent 会话做成一份可订阅的事件流水」的样本。它的价值不在于模型能力，而在于**三件事的分层特别干净**：

1. **协议层**（`codex-rs/protocol`）：会话的所有输入是 `Op`（意图），所有输出是 `EventMsg`（事实）。`Op::kind()` 在 `protocol.rs:1105-1141` 把 33 个意图列成常量字符串——意图是可枚举、可审计、可回放的。
2. **执行层**（`codex-rs/exec`）：非交互模式把这套事件压成 8 种 JSONL 事件（`exec_events.rs:11-37`），跨语言消费方只认这 8 种 + 9 种 item。
3. **表现层**（`codex-rs/tui`）：TUI 不做安全判断，只把审批请求翻成选项列表并路由用户决定（`tui/src/bottom_pane/approval_overlay.rs:1-13` 的模块注释明说 "This module does not evaluate whether an action is safe to run; it only presents choices and routes user decisions"）。

体感上它是一个「重协议、轻提示词」的 harness：模型提示词改动频繁，但事件契约和审批契约稳定到能导出 TypeScript 类型（全仓 `#[derive(TS)]`，`exec_events.rs:6`）。这正是我们 `events.jsonl` 想要而还没做到的。

### 1.3 对 v2 §1.2 的逐条复核

| v2 原文结论 | 本次判定 | 证据 / 说明 |
|---|---|---|
| `sandbox_mode`（read-only/workspace-write/danger-full-access）OS 级边界 | **确认** | `config_types.rs:98-113`，三档，`ReadOnly` 是 `#[default]`。注意默认是只读，不是 workspace-write。 |
| `approval_policy` 中 **`untrusted` 已退役** | **修正** | `protocol.rs:1166-1168` 仍有 `UnlessTrusted`，serde 名 `"untrusted"`，注释："Internal policy for projects marked untrusted. Commands require approval unless an explicit exec policy rule allows them." 它是**内部策略档**而非下线档。 |
| **`on-failure` 已弃用** | **修正（更精确）** | `protocol.rs:1171` `#[serde(alias = "on-failure")] OnRequest`——`on-failure` 仍被接受，只是映射到 `on-request`，即「旧名兼容」而非「删除」。 |
| 现剩 `on-request \| never \| { granular = {...} }` | **确认 + 补充** | 枚举四值：`untrusted` / `on-request`(default) / `granular` / `never`（`protocol.rs:1163-1186`）。`GranularApprovalConfig` 恰 5 个 bool：`sandbox_approval`、`rules`、`skill_approval`、`request_permissions`、`mcp_elicitations`（`:1188-1204`），false = 该类请求**自动拒**而不是问人。 |
| 目录 `trust_level` 决定默认档 | **未展开（保留 v2）** | 本次只读到 hooks 侧的 `HookTrustStatus`（`protocol.rs:1861-1868`）与 `HookSource::Untrusted`，仓库里另有 `user-verification` crate；`trust_level → approval_policy` 的映射链未逐行读，标 `需要复核`。 |
| `execpolicy` 规则文件 | **确认（存在）** | `codex-rs/execpolicy` crate 存在；`ExecPolicyAmendment`（`approvals.rs:42-44`）把「批准即追加 prefix_rule」做成可回传对象——**批准行为本身是数据**，这是 v2 没写的关键点。 |
| managed 配置可 `allowed_approval_policies` 封顶 | `需要复核` | 未在本次读到的文件中命中该键名；`HookSource` 有 11 个来源（含 `CloudManagedConfig`/`LegacyManagedConfigMdm`），managed 通道确实存在，但键名需对着 config-schema 再确认。 |
| `agents.*` 已转正 + `spawn_agent/send_input/wait/close_agent` + 子代理 6 态 | **确认（并修正枚举）** | `exec_events.rs:223-228` `CollabTool{SpawnAgent,SendInput,Wait,CloseAgent}`；`:233-241` `CollabAgentStatus{PendingInit,Running,Interrupted,Completed,Errored,Shutdown,NotFound}` —— 是 **7 态**（v2 漏 `NotFound`）。每个 collab 调用还带 `agents_states: HashMap<thread_id, {status,message}>`（`:252-259`）。 |
| exec 事件 = `thread.started / turn.* / item.* / error`，item 9 类，`command_execution.status` 含 `declined`，`turn.completed` 5 段 usage，`todo_list` = `{items:[{text,completed}]}` | **确认（全部对）** | `:11-37`、`:107-133`、`:156`（`Declined`）、`:61-73`（input/cached_input/cache_write_input/output/reasoning_output 五段）、`:316-323`。line 级无误。 |
| hooks 已转正（v0.124），Claude 兼容事件名 11 个 | **修正** | 实际 **14** 个：`PreToolUse, PermissionRequest, PostToolUse, PreCompact, PostCompact, SessionStart, SessionEnd, UserPromptSubmit, SubagentStart, SubagentStop, Stop, Interrupt, PreModelRequest, PostModelRequest`（`protocol.rs:1802-1819`）。比 Claude 多 `Interrupt` 与一对 `Pre/PostModelRequest`；比 Claude **少** `PostToolUseFailure/PostToolBatch/PermissionDenied/TaskCreated/TaskCompleted/TeammateIdle/InstructionsLoaded/FileChanged/…`。 |
| 发现源 = `hooks.json` + `config.toml [hooks]` + 插件 + `requirements.toml` | **修正（换成源码枚举）** | `HookSource` 11 值：`System, User, Project, Mdm, SessionFlags, Plugin, CloudRequirements, CloudManagedConfig, LegacyManagedConfigFile, LegacyManagedConfigMdm, Unknown`（`:1844-1859`）。"层"的概念是有的，但不是 v2 那 4 个文件名——文件名层要再看 `hooks/src/engine/discovery.rs`（`需要复核`）。 |
| 非 managed 命令 hook 须信任评审才跑 | **确认 + 精确化** | `HookTrustStatus{Managed,Untrusted,Trusted,Modified}`（`:1861-1868`）+ `hooks/src/engine/plugin_trust.rs`。注意还有 `Modified`：**被改过的 hook 重新回到待评审**，这才是防「批准后又改文件」的那一手。 |
| — | **新增** | **guardian：内置的自动审批评审子系统**，v2 全文未提。见 §3.3.4。 |
| — | **新增** | `ExecApprovalKind::HumanCommand`：**必须现问人**、自动审批与可复用批准一律无效。见 §3.3.5。 |
| — | **新增** | `ReviewDecision` 8 档（含 `ApprovedForSession`/`ApprovedExecpolicyAmendment`/`NetworkPolicyAmendment`/`TimedOut`/`Abort`）。见 §3.3.6。 |
| — | **新增** | rollout 的 `revert` 用**新文件**表达回滚（`_<rollout_id>` 后缀），旧的不可变。见 §3.7.2。 |

---

## 2 架构

### 2.1 分层与 crate 边界（读 `codex-rs/` 目录结构得出）

```
codex-rs/
├── protocol/            # 协议：Op / EventMsg / AskForApproval / ReviewDecision / Hook* 枚举，全部 derive(TS)
├── core/                # 会话状态机：codex.rs、tasks/*、compact*、agents_md*、context/world_state/*
├── exec/                # 非交互入口：把 core 事件压成 exec_events.rs 的 8 种 JSONL
├── tui/                 # 表现层：bottom_pane/approval_overlay.rs、diff_render.rs、exec_cell/*
├── hooks/               # hooks 引擎：discovery/matcher/dispatcher/command_runner/mcp_runner/output_parser/plugin_trust
├── rollout/             # 会话落盘：rollout-<ts>-<uuid>.jsonl，可 zstd 压缩
├── execpolicy/          # 命令前缀规则引擎（批准后可追加 prefix_rule）
├── sandboxing/ windows-sandbox-rs/ linux-sandbox/ bwrap/   # OS 级沙箱
├── app-server/ app-server-protocol/  # 给 GUI/IDE 的长连接协议（比 exec 更全）
├── agent-graph-store/ agent-roles/ message-board/ thread-store/   # 多 agent 与 thread 元数据
├── memories/ skills/ plugin/ worktree/ guardian-context/          # 记忆、技能、插件、worktree、guardian 上下文
└── otel/ otel-trace-websocket/ analytics/                         # 观测
```

对 AICA 的启示不是「抄架构」，而是**协议 crate 独立存在**这件事：我们的 `src/envelope.ts` 事实上就是协议层，但它既被 daemon 又被人手 CLI 直接改字段，没有「导出给 UI 的类型」这一步。

**我们怎么改**：在 `src/envelope.ts` 之上加一层纯类型导出（`src/contracts.ts`，只放 `Spec`/`Result`/`EventRecord` 的判别联合 + 一个 `EVENT_KINDS` 常量数组），`workbench/server.ts` 与 `index.html` 只消费它；S1「信封扩字段」先落这个文件，后续换引擎时 UI 不改。成本约 1 个文件，收益是后面 S2/S8/S9 全都只加 case。

### 2.2 一次 turn 的形状

```
Op::TurnInput ──► core 会话循环 ──► EventMsg（细粒度，30+ 变体）
                        │                    │
                        │                    ├─► TUI 直接渲染
                        │                    └─► exec 压缩成 8 种 ThreadEvent（item.* 三段式）
                        └─► rollout recorder 逐条 append 到 rollout-*.jsonl
```

三层视图（`Op` / `EventMsg` / `ThreadEvent`）中，**只有 `ThreadEvent` 是对外契约**。`EventMsg` 是内部细粒度事实（`protocol.rs:1536+`，含 `GuardianWarning`、`TurnAborted`、`AuthRecoveryStarted` 等），`exec_events.rs` 是有损投影。

**我们怎么改**：这正是 v2 §2.3-12 说的「daemon 转写器」——但补一条：**别让 UI 读原始事件流**。daemon 转写器应是唯一把 pi `--mode json` 原始事件压成 `EventRecord` 的地方（S2 已这么设计），`server.ts` 只读 `events.jsonl`，`index.html` 只读 apiView。v2 S2 的「二选一：daemon 转写为权威」判对了，理由是这条分层。

---

## 3 核心机制

### 3.1 会话主循环、turn 边界与取消

**turn 边界**由 `turn.started` / `turn.completed` / `turn.failed` 三个事件唯一确定（`exec_events.rs:16-24`）。`TurnStartedEvent` 是**空结构体**（`:45-47`）——turn 的元信息不放事件里，靠 `thread_id` + 顺序推导。承诺：一个 turn = 处理一个 prompt 期间发生的全部事件。

**取消**是三件事分开的：

1. `Op::Interrupt` 与 `Op::InterruptIfNoPendingInput`（`protocol.rs:1108-1109`）——后者是「没有新输入才中断」，防「用户刚打字就被取消」的竞态。
2. `TurnAbortedEvent`（`:4562-4586`）带 `root_turn_id`、`turn_id`、`reason`、`error`、`started_at`、`completed_at`、`duration_ms`。
3. `TurnAbortReason{Interrupted, Replaced, ReviewEnded, BudgetLimited}`（`:4588-4595`）——**`BudgetLimited` 是一等取消原因**，预算耗尽与用户中断在事件流里同构。

**我们怎么改**（对应 G4 + S3）：v2 的 `ar abort` 只写 `result failed("aborted by user")`，太扁。

- `EventRecord.kind` 增 `abort` 时必带 `{reason:"user"|"timeout"|"replaced"|"budget", duration_ms}`，与 Codex 四值对齐；
- daemon 的 `setTimeout` 到期走同一 abort 路径，但 `reason:"timeout"`，`result.summary` 写 `timeout`（v2 已这么想，补 reason 字段即可）；
- `InterruptIfNoPendingInput` 的语义值得抄：`ar abort` 若发现该节点 `spec.reply` 有新消息待处理，则**不中断**，改为把新消息交给下一轮。这一条能直接消掉「用户补一句话刚好撞上 abort」的体验坑。

### 3.2 上下文压缩与 AGENTS.md 注入

**压缩**：`core/src/compact.rs:63` `COMPACT_USER_MESSAGE_MAX_TOKENS = 20_000`——压缩请求本身有一条 20k token 的**用户消息预算**，即「要被摘要的历史」在进摘要模型前先被截到这个量级。`run_inline_auto_compact_task`（`:117`）是 inline 路径，`advance_auto_compact_window`（`:417`）推进「第 N 个压缩窗口」。压缩产物带 `active_context_tokens_before` / `compaction_summary_tokens` / `cached_input_tokens` 三个观测字段（`:457-467`）——**压缩是被计量的，不是黑盒**。

**AGENTS.md**：`core/src/agents_md.rs` + `agents_md_manager.rs` + `context/world_state/agents_md.rs`，且 `context/world_state/snapshots/` 下有一个 `codex_core__context__world_state__agents_md__tests__snapshots.snap`——说明注入结果是**快照测试锁定的字符串**。即「AGENTS.md 怎么拼进上下文」是一个被测试钉住的契约，不是随手拼。

**我们怎么改**（对应 G2/G22/§2.5-26）：

- 我们的 `userMessage()` 现在把规则、经验、inputs 全拼一段（v2 S12 要在末尾加「## 经验教训」≤2000 字）。抄 Codex 的计量：给 `daemon.ts` 的拼装加一份 `context-report.json{segments:[{name,chars,sha1}]}` 落节点目录，UI 的 sheet 加一个「上下文构成」小块。收益：调提示词时能一眼看出是哪段在膨胀，不用读 spawn cmd。
- 压缩事件：pi 的 `compaction_*` 我们只透传成 `compaction`（S2）。补两个字段 `tokens_before`/`tokens_after`（能从 `message_end.usage` 前后差算），UI 显示「上下文已压缩 42k→9k」。成本一行，收益是用户能理解为什么 worker 突然"忘事"。
- AGENTS.md 注入用**快照测试**钉住：在 `aica-pi/prompts/` 加一个 `test/userMessage.snap`（node:test + `JSON.stringify` 稳定序列化），把「worker.md + skills + learned.md + already_known」的拼接顺序固化成断言。我们改提示词的频率远高于 Codex，没有这个测试，S12/S14 每改一次都要人肉回归。

### 3.3 工具集与权限/审批

#### 3.3.1 双轴：`SandboxMode` × `AskForApproval`

第一轴 `SandboxMode`（`config_types.rs:98-113`）：`read-only`(default) / `workspace-write` / `danger-full-access`。它是 **OS 级**边界（`sandboxing/`、`windows-sandbox-rs/`、`linux-sandbox/`、`bwrap/` 四个 crate 实现），不是"模型自觉"。

第二轴 `AskForApproval`（`protocol.rs:1163-1186`）：`untrusted` / `on-request`(default) / `granular{5 bools}` / `never`。

两轴正交：沙箱管「跑起来之后能碰什么」，审批管「跑之前问不问」。`granular` 的 5 个 bool 不是档位而是**类别开关**（`sandbox_approval`/`rules`/`skill_approval`/`request_permissions`/`mcp_elicitations`），false = 该类自动拒。

**我们怎么改**（对应 G3/G30/S4）：v2 把 `spec.permission` 做成 `supervised|edits|full` 三档，这是**单轴**（只有"问不问"）。我们没有 OS 级沙箱，所以第二轴不存在——但可以引入一个**廉价的伪沙箱轴**：`spec.fs_scope: "node"|"repo"|"full"`，gate.ts 用它做路径前缀判定（node = 只允许节点目录 + `spec.inputs` 物化目录；repo = 允许 run 根；full = 不判）。这比 v2 的单轴 `deny_paths` 更贴 Codex 的形状：**判据是"作用域"而不是"黑名单"**，黑名单永远漏（`.env.local`、`id_rsa.bak`…）。

#### 3.3.2 审批请求是一个带"选项菜单"的数据结构

`ExecApprovalRequestEvent`（`approvals.rs:283-356`）字段值得逐个看：

- `call_id` + `approval_id`（子命令审批/stdin 写入时才有，`:302-308`）；
- `parsed_cmd: Vec<ParsedCommand>`——**命令在弹审批前已被解析**；
- `proposed_execpolicy_amendment`（`:336-339`）与 `proposed_network_policy_amendments`（`:340-343`）；
- `additional_permissions`（`:344-347`）；
- `available_decisions: Option<Vec<ReviewDecision>>`（`:348-354`）——**客户端不许自己发明按钮**，服务端给菜单；老客户端缺这个字段时走 `default_available_decisions()` 兜底（`:365-377`）。

**我们怎么改**（对应 G36/S5）：v2 的 approve 卡写死三个按钮「同意一次 / 本次会话都同意 / 拒绝」。改成 `gate-req.json{opts:[{id,label,hint}]}` 由 gate.ts 生成，前端只渲染 `opts`。好处立刻体现：deny_paths 命中的卡不该给「同意一次」；超时前的最后一次重试卡可以只给「拒绝」。**卡片语义跟着规则走，而不是跟着前端走。**

#### 3.3.3 批准即规则：`ExecPolicyAmendment`

`ExecPolicyAmendment`（`approvals.rs:39-44`）就是「命令 token 前缀」，批准时把它塞回 `ReviewDecision::ApprovedExecpolicyAmendment`，落到 execpolicy 的 `prefix_rule(..., decision="allow")`。即**用户在审批卡上的选择直接生成一条持久规则，且这条规则是可展示的（就是命令前缀）**。

**我们怎么改**（对应 G30）：v2 的 `grants.json` 只记「tool 在列就放行」，粒度是工具名。升级为 `grants.json{rule:"bash:npm test *", scope:"session"|"run", created_from:"call_7f3a"}`——规则形态抄 execpolicy 的「命令前缀」，并记来源 call_id。这样「本次会话都同意」不会把 `bash` 整个放开，而是只放开那一条前缀；UI 上还能显示"当前授权：`npm test *`"。

#### 3.3.4 **Guardian：内置自动审批评审器（v2 未收录）**

`approvals.rs` 里有一整套与人工审批并列的自动评审：

- `GuardianAssessmentAction`（`:136-180`）7 种被审对象：`Command`、`Execve{program,argv}`、`WriteStdin`（往已存在的终端写 stdin！）、`ApplyPatch{cwd,files}`、`NetworkAccess{host,protocol,port}`、`McpToolCall`、`RequestPermissions`。
- `GuardianRiskLevel{low,medium,high,critical}`（`:87-94`）与 `GuardianUserAuthorization{unknown,low,medium,high}`（`:96-103`）——**风险与"用户授权强度"是两个独立维度**：同一动作，用户明确要求过 vs 没提过，评级不同。
- `GuardianAssessmentEvent`（`:217-270`）带 `review_reason`、`status`、`risk_level`、`user_authorization`、`rationale`（人话理由）、`decision_source`，且 `target_item_id` 指回被审的 thread item——**评审结果是一个可渲染的事件，挂在原 item 上**。
- `GuardianAssessmentStatus{InProgress,Approved,Denied,TimedOut,Aborted}`（`:113-121`）——评审自己也会超时。
- `GuardianReviewReason`（`:203-215`）10 个触发原因：`Policy`、`FreshRequired`、`MissingScore`、`StaleScore`、`InvalidScore`、`IncompatibleCompaction`、`ElevatedRisk`、`ScoringFailure`、`AuthorizationChanged`、`Unknown`。—— 注意 `IncompatibleCompaction`：**压缩之后旧评分作废**；`StaleScore`：评分有 TTL。这套"评分可缓存但会过期"的设计，正是 advisor 类功能能落地而不炸成本的关键。
- `EventMsg::GuardianWarning(WarningEvent)`（`protocol.rs:1536+` 区段内）——评审警告进主事件流。
- `Op::ApproveGuardianDeniedAction`（`Op::kind()` 里，`protocol.rs:1138`）——**guardian 拒了之后人还能推翻**，这是一条独立意图，不是"重试一次"。

**我们怎么改**（G34 advisor 的蓝本，比 v2 设想的"reviewer 子节点"更省）：

R1 不要上第二个 pi 进程。做一个 `aica-pi/extensions/guardian.ts`：

1. 输入：`tool_call` 的 name+args + 最近 N 条 `events.jsonl` 摘要 + `spec.goal/accept`；
2. 输出：`{risk: low|medium|high|critical, authorization: none|mentioned|explicit, reason: string}`；
3. 落 `guardian.jsonl`（一行一次评估，带 `target_call_id`），并 `appendEvent approve_decide` 复用同一投影；
4. gate.ts 决策顺序变成：`deny → rules → guardian(risk>=high → ask) → grant → approve 档`；
5. 评分 TTL = 该节点最后一个 `compaction` 事件之后作废（抄 `IncompatibleCompaction`）。

但 R1 **只落"high 才问人"这一条**，不要落完整的四档风险。理由：guardian 自己也是模型，误判成本高；先用它把"明显该问的"捞出来，比 v2 的"reviewer 派一个子节点"便宜一个数量级（零进程、零 session 目录）。

#### 3.3.5 `HumanCommand`：不可缓存、不可自动批

`ExecApprovalKind{Command, HumanCommand, WriteStdin}`（`approvals.rs:273-281`），注释：`HumanCommand` —— "Requires a fresh human decision; automated and reusable approvals are invalid."

**我们怎么改**（补 G30/G33 的洞）：v2 的 grants 一旦写入，同类调用就用不再问——但有些调用**永远该问**。在 `deny_paths` 之外加 `spec.always_ask: string[]`（模式列表），gate.ts 里这个列表**优先级高于 grants**（判断顺序：deny → rules → **always_ask** → grant → approve）。默认值给：`bash:git push *`、`bash:npm publish *`、写 `.git/` 的 edit、`ev_dispatch` 新增子节点。这是全篇最便宜的一个改动（一个数组 + 一次比较），但挡掉的是最不可挽回的几类误操作。

#### 3.3.6 决定枚举要比我们设想的宽

`ReviewDecision`（`protocol.rs:4465-4500`）8 档：`Approved`、`ApprovedExecpolicyAmendment{..}`、`ApprovedForSession`、`ApprovedMcpPolicyAmendment`、`NetworkPolicyAmendment{..}`、`Denied{rejection}`、`TimedOut`、`Abort`。

注意 `Denied{rejection: String}` 是**带文本的**（拒绝理由随决定一起走），`Abort` 是"别再问了，等用户下句话"——与 `Denied`（"换个法子继续"）语义不同。`to_opaque_string()`（`:4519-4535`）还专门给了一份**脱敏字符串**用于遥测。

**我们怎么改**（S4/S5 的 `gate-ans.json`）：

```jsonc
{ "decision": "allow_once|allow_session|deny|timeout|abort",
  "feedback": "……",          // deny 时给模型的理由（v2 已有）
  "rule": { "prefix": ["npm","test"] },   // allow_session 时生成 grants 规则
  "ts": 1750000000 }
```

在 v2 三值之外补 `timeout` 与 `abort`：前者让 UI 能区分"人没看到"和"人拒绝了"；后者让「挂起卡时用户输入 '取消这个节点'」有正经语义（`abort` 直接跳 `ar abort`）。另外 `feedback` 一律进 `result`/`events` 的 `reason` 字段——Codex 的 `Denied{rejection}` 表明**拒绝理由是决定的一部分**，不是旁注。

### 3.4 plan / 只读模式

Codex 没有一等公民的 "plan mode"。最接近的是：

- `Op::Review`（`Op::kind()` 里 `"review"`）与 `TurnAbortReason::ReviewEnded`（`protocol.rs:4593`）——review 是一个**会结束 turn 的独立动作**；
- `SandboxMode::ReadOnly` + `AskForApproval::untrusted` 组合出事实上只读；
- `prompts` crate 与 `collabation-mode-templates` crate 里有模式模板（本次未读内容，`需要复核`）。

**判定**：v2 §1.2 没给 Codex 记 plan mode，是对的。**不要**把 Codex 当 plan mode 的参照，参照 Claude Code（见 claude-code.md §3.4）。

**我们怎么改**：`spec.mode: "plan"|"exec"` 的开关不要学 Codex 用两个轴拼，直接学 Claude 的一等手段（`EnterPlanMode`/`ExitPlanMode` 工具 + 计划审批）。理由：我们的 worker 是 `pi -p` 一次性进程，没有"中途弹模式"的通道，"只读"必须靠 `--tools` 白名单在 spawn 时就定死；拼轴只会得到"以为只读其实能写"的半成品。

### 3.5 子代理与并行

- 4 个 collab 工具：`spawn_agent / send_input / wait / close_agent`（`exec_events.rs:223-228`）。
- 每次调用回一个 `CollabToolCallItem{tool, sender_thread_id, receiver_thread_ids, prompt, agents_states, status}`（`:252-259`）——**一次调用可以同时指向多个接收者**（`receiver_thread_ids: Vec`），并在结果里带上每一个的当前状态。
- 7 个状态里 `Interrupted` 与 `NotFound` 都是显式的：被中断的子代理与"查无此 thread"是不同的事实，UI 能区分。
- 并行度由配置控（v2 记的 `max_concurrent_threads_per_session`，本次未读 config-schema，`需要复核`）。

**我们怎么改**（G6/S7）：

1. `ev_wait` 的结果别只写 `wait_on:[paths]`。抄 `agents_states`：`result.wait_on: [{path, status:"running"|"done"|"failed", summary?}]`——UI 的 inbox 卡能直接显示"等 3 个：a 跑着、b 完成、c 失败"，而不是一个裸路径列表。
2. `runs.ts` 的 `pendingNodes()` 复活判定按 status 逐条算：全 done 才复活；有 failed 时**先复活父**并把失败摘要塞进 `spec.reply`（现状是父可能永远等）。这是 v2 S7 没写的分支。
3. `NotFound` 语义我们天然有（节点目录被删），但 `pendingNodes` 现在会把它当 pending 重拉——补一条：`spec` 不存在但 `result` 存在 → 视为 done，不重拉。

### 3.6 hooks 生命周期事件清单

Codex 侧 14 个事件（`protocol.rs:1802-1819`），按会话生命周期排：

| 阶段 | 事件 |
|---|---|
| 会话 | `SessionStart`、`SessionEnd` |
| 输入 | `UserPromptSubmit` |
| 工具（agentic loop） | `PreToolUse`、`PermissionRequest`、`PostToolUse` |
| 子代理 | `SubagentStart`、`SubagentStop` |
| 收口 | `Stop`、`Interrupt` |
| 上下文 | `PreCompact`、`PostCompact` |
| 模型 | `PreModelRequest`、`PostModelRequest` |

配套枚举：handler 4 型（`Command`/`McpTool`/`Prompt`/`Agent`，`:1821-1828`）、执行模式 `Sync`/`Async`（`:1830-1835`）、作用域 `Thread`/`Turn`（`:1837-1842`）、来源 11（`:1844-1859`）、信任 4（`:1861-1868`）、运行态 5（`Running/Completed/Failed/Blocked/Stopped`，`:1870-1878`）。

运行时契约（`hooks/src/types.rs:12-30`）：`HookResult{Success, FailedContinue, FailedAbort}` —— hook 失败分「继续跑后面的 hook」与「中止整个操作」两种，`should_abort_operation()` 是唯一判据。`HookPayload`（`:62-72`）带 `session_id`、`cwd`、`client`、`triggered_at`（RFC3339 秒精度）、`hook_event`。`hooks/src/engine/` 把发现/匹配/派发/子进程/输出解析/插件信任/schema 加载拆成 8 个文件——**hook 引擎本身是个子系统，不是一段 if**。

**我们怎么改**（G37/S15）：v2 只落 4 个文件态 hook 点，够了；补两条 Codex 的硬约束：

1. `HookResult` 三态：我们的 hook 现在只有"跑完/没跑"。约定 hook 退出码语义：`0`=成功继续，`1`=失败但继续（记 `hook_error` 事件），`2`=失败且中止后续（对 `node_settled` 意味着不派后续 spec）。**没这三态，"hook 挂了"和"hook 说不行"就分不开。**
2. hook 的 `Blocked` 状态：`HookRunStatus` 里有 `Blocked`——被上游 hook 或策略挡下、根本没跑。我们的 `node_settled` hook 若被信任边界拒绝，要记 `hook_blocked` 而不是静默跳过。
3. 信任的 `Modified` 态：hook 文件被改过就回到待评审。我们 S15 只认 aica-pi 包内目录（够），但加一条 sha256：`hooks.lock.json` 记每个 hook 的 hash，变了就拒绝执行并记 `hook_blocked`。防的是「有人往包目录里塞文件」。

### 3.7 状态与恢复

#### 3.7.1 rollout 文件

`~/.codex/sessions/rollout-<timestamp>-<uuid>.jsonl`（`rollout/src/recorder.rs:79-80`），注释说明可直接 `jq`/`fx` 读（`:79-80`），支持 zstd 压缩（`compression_tests.rs`）。

#### 3.7.2 revert = 新文件，不是改旧文件

`rollout/src/recorder.rs:98-99` 注释：`rollout-<timestamp>-<conversation_id>.jsonl`；`thread/revert` 会产出 `rollout-<timestamp>-<conversation_id>_<rollout_id>.jsonl`，因为 revert "keeps the ..."（保留旧文件）。

**我们怎么改**（G40 checkpoint/revert）：v2 想用 git hidden refs 抓工作区。代码侧更便宜的一步是抄这条**不可变日志 + 分叉文件**：

- 节点目录 `events.jsonl` 永不改写；
- `ar retry` 时不删 `result.json`，而是 rename 成 `result.1.json`，并写 `fork.json{from_attempt:1, attempt:2, at}`；
- `session/` 目录同理：第 N 次尝试用 `session-a1/`，`fork.json` 记父尝试。
  这样"重试"天然可回溯、可并排比较，且不需要任何 git 操作。R1 只需在 S10 的 ⟲（retry）里改三行路径拼接。

#### 3.7.3 恢复语义

exec 侧有 `Resume`/`Fork` 两个动词（`exec/src/cli.rs:174-178`），`--last`（`:206-214`）取最近一条。`ForkArgs` 支持 fork 时立刻带一个 prompt（`:185-200`）。v2 写的 `codex exec resume` 与源码里 `Resume` 位于哪个二进制面，`需要复核`（`cli.rs` 在 exec crate 内，但形如顶层 CLI 定义）。

**我们怎么改**：我们已有 `--session-dir <node>/session --session-id aica`（v2 G1 已验证持久 session）。缺的是 **fork**：`ar retry --fork` 应该复制 `session/` 到 `session-fork-<ts>/` 再拉，而不是复用同一目录。理由：复用同一 session 目录意味着"重试会污染原上下文"，而 Codex 明确把 fork 做成独立动词。

### 3.8 UI / TUI 与 diff 呈现、等待态

- 审批层：`tui/src/bottom_pane/approval_overlay.rs:1-13` 的模块契约值得整段抄进我们的 `gate.ts` 头注释：
  - 「Selection always emits an explicit decision event back to the app.」——**每次选择都必须产一个决策事件**（我们：`gate-ans.json` + `approve_decide` event 两条）。
  - 「MCP elicitation keeps `Esc` mapped to `Cancel`, even with custom keybindings, so dismissal never silently becomes 'continue without info'.」——**Esc 不能等于同意**。我们前端现在 ESC 关 sheet 只是关 UI，要补"关掉 ≠ 批准"的显式提示。
  - 「This module does not evaluate whether an action is safe to run.」——UI 不做安全判断。
- 相关文件：`tui/src/{diff_model.rs,diff_render.rs,get_git_diff.rs,approval_events.rs}`、`tui/src/app/file_change_approvals.rs`、`tui/src/bottom_pane/pending_thread_approvals.rs`、`tui/src/history_cell/approvals.rs`、`tui/src/transcript_view/`。
- 差异呈现：`FileChange` 是 `Add{content}` / `Delete{content}` / `Update{unified_diff, move_path}`（`protocol.rs:4538-4552`），另有 `Chunk{orig_index, deleted_lines, inserted_lines}`（`:4554-4560`）——**两种粒度并存**：给模型/日志用 unified diff，给渲染用逐行 chunk。
- 等待态：`pending_thread_approvals.rs` 的存在说明审批是**按 thread 归集的待答表**（内容未读，`需要复核`）。

**我们怎么改**（G12/G13/S2/S10）：

1. `file_edit` 事件带 `preview`（v2 已有）不够。加 `kind:"add"|"update"|"delete"` + `plus`/`minus` 行数，UI 用它画 `+12 −3` 徽标；unified diff 正文放 `events.jsonl` 可选项（`preview` ≤ 40 行）。逐行 chunk 留 R2（要读文件，代价大）。
2. 待答表：`apiView` 现在扫每个节点找 `gate-req.json`。改成 `STATE/pending.jsonl` 归集（gate.ts 写 req 时 append），inbox 直接读一个文件——节点多了之后 O(n) 扫盘是 S10 的性能坑。
3. 「关掉 ≠ 批准」：前端 sheet 的 ESC 要弹一行 "未批准，worker 仍在等待"，而不是静默关闭。

### 3.9 与 Claude Code 的差异（同一问题的两种解）

| 问题 | Codex | Claude Code | 我们该取谁 |
|---|---|---|---|
| 审批轴 | 2 轴（sandbox × approval） | 6 档 mode + 三层规则（deny→ask→allow） | **都取**：mode 给人选，规则给机器判；我们没有 OS 沙箱，用 `fs_scope` 伪轴补 |
| 自动审批 | **guardian**（风险/授权双维 + 评分 TTL） | **auto mode classifier**（第二模型评审，`auto` 已是默认起始档） | 取 Codex 的**数据结构**（risk/authorization/rationale/reason 枚举），取 Claude 的**落地位置**（挡在 permission 判定里、失败 fail-closed） |
| 决定枚举 | 8 档（含 TimedOut/Abort/Amendment） | allow/deny/ask + `PermissionRequest` 可代答 + 批准附言 | 取 Codex 的宽度 |
| hooks 事件数 | 14 | 33 | 我们只落 4 个（v2 S15），**两边都别照抄**；但要取 Codex 的三态结果与信任 `Modified` |
| 会话文件格式 | rollout JSONL（可 jq） | `~/.claude/projects/<p>/<sid>.jsonl`，官方明说**格式内部、随版本变** | 取 Codex：`events.jsonl` 当对外契约，pi 原始 stdout 当内档 |
| 子代理 | 4 工具 + agents_states + 7 态 | `Agent` 工具 + 后台默认 + 名字可寻址（SendMessage） | 取 Codex 的状态 map（我们 join 需要），取 Claude 的"后台默认"默认值 |
| 压缩 | 20k 用户消息预算 + 三观测字段 | 自动压缩 + `PreCompact/PostCompact` hook + 压缩后重注入 CLAUDE.md | 取 Codex 的计量 |
| plan | 无一等公民 | 一等公民（`EnterPlanMode`/`ExitPlanMode`） | 取 Claude |

---

## 4 UI 侧的三个具体结论

1. **审批卡是数据，不是模板**（§3.3.2）：`opts[]` 从 gate.ts 来。
2. **差异两种粒度**（§3.8）：徽标用 `+n/−m`，正文用 unified diff。
3. **等待态要能区分"人在看"与"人没看"**（§3.3.6 的 `TimedOut`）：节点行在 `gate-req` 超过 60s 未答时变色，超时后仍是 `timeout` 而不是 `deny`。

---

## 5 值得抄（按性价比排序）

| # | 机制 | 落点 | 工作量 | 为什么值 |
|---|---|---|---|---|
| A1 | `always_ask` 恒问列表（`HumanCommand` 语义） | `gate.ts` + `spec.always_ask` | 极小 | 挡不可挽回操作，且不受 grants 污染 |
| A2 | 审批卡的 `opts[]` 由 gate 生成 | `gate-req.json` + `index.html` | 小 | 卡片语义跟规则走，杜绝"给了不该给的按钮" |
| A3 | `abort.reason` 四值 + `duration_ms` | `envelope.ts` + `daemon.ts` | 小 | 用户能分清"我停的/超时/被替换" |
| A4 | `grants` 用命令前缀而非工具名 | `grants.json` | 小 | 「本次会话都同意」不再等于「bash 全放行」 |
| A5 | 不可变日志 + fork 文件表达重试 | `runs.ts`/`cli.ts` retry | 小 | 重试可回溯、可并排 diff，零 git 依赖 |
| A6 | `wait_on` 带逐子状态 map | `ev_wait` + `runs.ts` | 小 | 父节点等待可解释；failed 子节点不再让父永远等 |
| A7 | `context-report.json`（分段 chars/sha1） | `daemon.ts` userMessage | 中 | 提示词调优从"读 spawn cmd"变成"看一块 UI" |
| A8 | `userMessage` 拼接快照测试 | `aica-pi/prompts/test/` | 中 | 改提示词不再人肉回归 |
| A9 | hook 三态退出码 + `hook_blocked` | `hooks/` 约定 | 小 | 区分"hook 挂"与"hook 说不" |
| A10 | guardian 的 risk/authorization/rationale 三元组 | `guardian.ts`（R1 只 high 才问） | 中 | advisor 的最小可用形态，零新进程 |
| A11 | 压缩前后 token 计量 | `daemon.ts` 转写器 | 小 | 让"忘事"可解释 |
| A12 | `fs_scope` 伪沙箱轴 | `gate.ts` 路径判定 | 中 | 比黑名单可靠，且与 Codex 同构 |

---

## 6 不抄

| 不抄 | 原因 |
|---|---|
| 完整 14→33 事件的 hook 面 | 我们是文件态 daemon，没有"模型请求前"这种钩子点；4 个点已覆盖 80% 价值 |
| `AskForApproval::granular` 的 5 个类别 | 我们只有一种"审批流"（gate），没有 skill_approval / mcp_elicitations / request_permissions 的分野；提前抽象会得到 5 个永远 false 的开关 |
| guardian 的完整四档风险 + LLM 评审 | 成本与误判；R1 只落"high 才问人" |
| `Stdin` 写入审批（`WriteStdin`） | 我们的 worker 是一次性进程，没有可写 stdin 的终端 |
| `untrusted` 作为用户可选项 | 它是 Codex 内部的项目信任策略，语义靠 `trust_level` 推导；我们直接给 `permission` 三档更直白 |
| `exec`/`app-server` 双协议并存 | 我们只有一条通道（文件态），不需要协议双轨 |
| 33 个 `Op` 意图枚举 | 我们的 `ar` CLI 动词已够；提前枚举会把 CLI 冻死 |

---

## 7 出处

**源码（commit `93b4e5b`，路径相对 `codex-rs/`）**

- `exec/src/exec_events.rs:11-37` — ThreadEvent 8 变体
- `exec/src/exec_events.rs:61-73` — Usage 五段
- `exec/src/exec_events.rs:107-133` — ThreadItemDetails 9 类
- `exec/src/exec_events.rs:150-157` — CommandExecutionStatus（含 `Declined`）
- `exec/src/exec_events.rs:223-241` — CollabTool 4 / CollabAgentStatus 7
- `exec/src/exec_events.rs:252-259` — CollabToolCallItem（agents_states）
- `exec/src/exec_events.rs:314-323` — TodoItem/TodoListItem
- `protocol/src/protocol.rs:1105-1141` — `Op::kind()` 全表（含 `approve_guardian_denied_action`）
- `protocol/src/protocol.rs:1163-1186` — AskForApproval 四值
- `protocol/src/protocol.rs:1188-1204` — GranularApprovalConfig 五 bool
- `protocol/src/protocol.rs:1536+` — EventMsg（含 `GuardianWarning`）
- `protocol/src/protocol.rs:1802-1819` — HookEventName 14
- `protocol/src/protocol.rs:1821-1842` — Handler/Execution/Scope
- `protocol/src/protocol.rs:1844-1868` — HookSource 11 / HookTrustStatus 4
- `protocol/src/protocol.rs:1870-1878` — HookRunStatus 5
- `protocol/src/protocol.rs:4465-4500` — ReviewDecision 8 档
- `protocol/src/protocol.rs:4538-4560` — FileChange / Chunk
- `protocol/src/protocol.rs:4562-4595` — TurnAbortedEvent / TurnAbortReason
- `protocol/src/config_types.rs:98-113` — SandboxMode 三档（ReadOnly default）
- `protocol/src/approvals.rs:87-121` — Guardian 风险/授权/结果/状态
- `protocol/src/approvals.rs:136-180` — GuardianAssessmentAction 7 类
- `protocol/src/approvals.rs:203-270` — GuardianReviewReason 10 / GuardianAssessmentEvent
- `protocol/src/approvals.rs:273-356` — ExecApprovalKind / ExecApprovalRequestEvent
- `protocol/src/approvals.rs:365-377` — effective_available_decisions 兜底
- `protocol/src/approvals.rs:39-44` — ExecPolicyAmendment
- `hooks/src/types.rs:12-30` — HookResult 三态
- `hooks/src/types.rs:62-97` — HookPayload / HookEvent
- `hooks/src/engine/` — discovery/matcher/dispatcher/command_runner/mcp_runner/output_parser/plugin_trust
- `core/src/compact.rs:63,117,417,457-467` — 压缩预算与计量
- `core/src/agents_md.rs`、`core/src/context/world_state/agents_md.rs`、`core/src/context/world_state/snapshots/` — AGENTS.md 注入与其快照
- `rollout/src/recorder.rs:1,79-80,98-99` — rollout 命名与 revert 分叉
- `exec/src/cli.rs:52-53,63-70,72-79,174-178,206-214` — 非交互 CLI 面
- `tui/src/bottom_pane/approval_overlay.rs:1-13` — 审批 UI 的模块契约
- `tui/src/{diff_model.rs,diff_render.rs,approval_events.rs}`、`tui/src/app/file_change_approvals.rs`、`tui/src/bottom_pane/pending_thread_approvals.rs`

**文档（旁证，未逐页抓取，涉及结论已标 `需要复核`）**

- https://developers.openai.com/codex/config-reference
- https://developers.openai.com/codex/hooks
- https://developers.openai.com/codex/noninteractive

**复现命令**

```powershell
git -C C:\Users\Administrator\ego\research\codex log -1 --format='%H|%ad|%s' --date=iso
cd C:\Users\Administrator\ego\research\codex
git grep -n "pub enum AskForApproval" -- codex-rs
git grep -n "GuardianAssessmentAction" -- codex-rs/protocol/src/approvals.rs
```

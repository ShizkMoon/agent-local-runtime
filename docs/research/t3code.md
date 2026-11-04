# T3 Code 源码级复核（`pingdotgg/t3code`）

> 复核对象：`https://github.com/pingdotgg/t3code`，commit `e68e19d605485db6ef31b2033f67a9d07634fc2b`（2026-11-03），浅克隆于 `C:\Users\Administrator\ego\research\t3code`。
> 复核方法：读 `docs/orchestration-v2/*`、`docs/internals/{overview,providers,web-ui}.md`、`docs/user/{permission-modes,providers-pi,portable-handoffs,composer}.md`，再逐条回源码核（`apps/server/src/orchestration-v2/*`、`packages/contracts/src/orchestrationV2.ts`、`packages/provider-core/src/server/ProviderAdapter.ts`、`packages/provider-pi/src/**`、`apps/web/src/components/chat/*`）。
> 本文用途：复核 `docs/prd-workbench-v2.md` §1.3 / §2.1-4 / §2.3-14 / §2.4-20 的既有结论，并给出可直接落 `ar` / `workbench` / `aica-pi` 的吸收点。
> 证据等级：**[S]**=源码行号可查；**[D]**=仓库内官方文档；**[T]**=本文推断，需复核。

---

## 0 出处

- **仓库与快照**：`pingdotgg/t3code`，浅克隆 `--depth 1`，HEAD `e68e19d6`（2026-11-03）。pnpm monorepo：`packages/*`（provider 适配器、contracts、client-runtime）+ `apps/{server,web,desktop,mobile}`。
- **本仓对照物**：`docs/prd-workbench-v2.md`（§1.3 T3、§2.1-4 pending 文字=deny、§2.3-14 意图-事件-副作用、§2.4-20 审批冒泡）；`src/{cli,runs,daemon,envelope}.ts`；`workbench/server.ts`；`aica-pi/extensions/{tools,events}.ts`。
- **官方内部文档**（仓库内，随 commit 演进）：
  - `docs/orchestration-v2/README.md` — 目标架构、10 条不变量、概念分层、durable effect outbox。
  - `docs/orchestration-v2/{core-graph-and-data-model,feature-lifecycles,provider-capability-system,entity-ids-and-correlation,orchestrator-mcp-server}.md`。
  - `docs/internals/overview.md` — 「Durable intent and side effects」「Turn completion and checkpoints」「Thread settlement is server-owned」。
  - `docs/user/{permission-modes,providers-pi,portable-handoffs,composer}.md` — 面向用户的行为契约。
- **关键源码**：
  - `packages/contracts/src/orchestrationV2.ts`（4323 行，命令/事件/实体 schema 的单一事实源）。
  - `apps/server/src/orchestration-v2/Orchestrator.ts`（14308 行，540KB；每个命令一个 `dispatchXxx`）。
  - `apps/server/src/orchestration-v2/EventSink.ts`（1019 行）、`EffectOutbox.ts`（710 行）、`EffectWorker.ts`、`ProjectionStore.ts`（330KB）、`ProjectionMaintenance.ts`。
  - `apps/server/src/orchestration-v2/ProviderTurnControlService.ts`、`ProviderEventIngestor.ts`、`ContextHandoffService.ts`、`CheckpointService.ts`。
  - `packages/provider-core/src/server/ProviderAdapter.ts`、`packages/provider-pi/src/server/{adapter.ts,mcpExtensionSource.ts,driver.ts}`。
  - `apps/server/src/checkpointing/CheckpointStore.ts`、`apps/server/src/vcs/GitVcsDriver.ts`。
- **未读/不采信**：`ProjectionStore.ts`（330KB）与 `Orchestrator.ts` 未逐行通读，只按 grep 命中段落取证；凡未落到具体机制判断处，本文不引用。

---

## 1 定位与体感

**一句话**：T3 Code 不是一个新的 agent 引擎，而是一层**面向多端的产品化控制面**——它把各家 CLI agent（Claude Code、Codex、Pi、OpenCode、Cursor、Grok、Kiro、Muse、ACP agents）包在 owner 环境里，用一条**事件溯源的控制总线**把「用户意图 → 领域事件 → 副作用 → 投影 → UI」拆开。

体感上的三个特征，正好对应我们要补的三块：

1. **「发了」不等于「做了」，但一定等于「记下了」**。发消息的 ack 返回的是已提交的命令回执和事件序号，不是模型回复。`docs/internals/overview.md:55-59`：*"A command acknowledgement therefore means the intent committed, not that the provider, checkpoint, or other follow-up work finished."* 命令派发结果见 `Orchestrator.ts:360-365`：`{ sequence, storedEvents, replayed? }`。
2. **运行时纠偏是命令，不是特权路径**。打断、转向、排队、改队首、答审批、回滚 checkpoint 全部是同一张命令联合类型里的成员（`packages/contracts/src/orchestrationV2.ts:2895-3606`），没有「特殊 API」。
3. **UI 的「信息层级」= 对话主线 + 可折叠工作日志 + 就地审批卡**。审批不弹模态框，而是插在对话流里；输入框在挂起审批时改变语义（`ChatComposer.tsx:3414-3419`）。

与 v2 PRD 的关系：§1.3 的定位描述基本准确，但**深度不够**——它写的是「事件溯源 + 三档审批」，实际源码里还有：五种派发模式（dispatchMode）、durable effect outbox 的进程丢失分类、provider capability 位表、run/attempt/provider-turn 三层身份。这些是本轮复核的主要增量。

---

## 2 架构

### 2.1 五层概念分层（[D] `docs/orchestration-v2/README.md:46-58`）

```text
Native provider protocol
  -> Rotating raw provider diagnostics        # 原始帧仅作诊断/回放捕获，有界保留
  -> Provider adapter / normalizer            # 各家协议 → 统一 app 事件
  -> V2 orchestration event store             # SQLite：事件 + 投影 + 命令回执
  -> Runtime execution graph                  # Run / Attempt / ExecutionNode / ProviderThread
  -> Conversation projection                  # 用户看到的消息、turn item、审批、计划
  -> UI / API views
```

关键约束（同文件 `:33-42` 的 10 条不变量）：**app id 是主键、provider id 只是引用**（1）；provider 事件不得被改写成别家事件的样子（2）；**子执行完成永不关闭父 run**（3）；checkpoint 绑定可 checkpoint 的执行作用域（4）；**命令只认 app id，adapter 在边缘翻译**（6）；缺失能力必须显式表达并由 policy 处理（7）；provider 切换必须产出显式 handoff 工件，不许偷偷改 prompt（8）。

→ **对我们**：这条「app 身份 vs provider 身份」的分离正是我们缺的。我们现在 `spec.json` 里的 `model`/`session` 同时承担两种身份；一旦将来接 codex worker，`session_id` 语义就崩。R1 不必做完整图模型，但应在 `envelope.ts` 里把「节点身份（app）」与「引擎会话引用（provider）」分成两个字段（详见 §5 A7）。

### 2.2 所有权边界（[D] `docs/internals/overview.md:3-19`）

- provider 进程、终端、Git、项目文件**属于 server**；client 只持有连接与领域状态（`packages/client-runtime`）。
- RPC 契约是版本边界（`packages/contracts/src/rpc.ts`）；**订阅制**：看哪个 thread 才付哪个 thread 的历史。
- socket 认证不等于方法授权（`overview.md:19`）。

→ **对我们**：我们的 `workbench/server.ts` 是单机单用户，认证问题不存在；但「订阅制」值得抄成 `GET /api/runs/<id>/node/<p>/events?since=<seq>`，否则 S2 的 turn 级流会让 UI 每秒拉全量。

### 2.3 V2 对象模型（[D] `README.md:62-82`）

```text
AppThread（用户可见会话）
  Run 1（计数的用户可见轮次）
    root ExecutionNode
      tool / approval / subagent ExecutionNode
        ProviderThread（provider 原生会话句柄）
          child root ExecutionNode
  Run 2
```

- **Run**：用户可见的一轮；**RunAttempt**：同一 Run 下的一次尝试（`reason: initial | steering_restart | retry | provider_recovery`，`docs/orchestration-v2/feature-lifecycles.md:111-116`）。只有最终 attempt 完成 run 与 checkpoint，被中断的 attempt 留在图里供审计。
- **ProviderThread / ProviderSession**：provider 原生句柄；fork/切换 provider 时复用或新建，不新建 AppThread。
- **ExecutionNode**：工具、审批、子代理都挂成节点；审批请求本身就是一个 node（`provider-pi/src/server/adapter.ts:1336-1432` 把 `confirm` 映射成 `approval_request` + `node.updated` + `turn-item.updated`）。

→ **对我们**：我们的 `runs/<run>/<node>` 只有两层（run→node），没有「同一节点多 attempt」。v2 G11（不能 steer 运行中 worker）本质就是缺 attempt 概念：真要实现 steer，正确做法不是往进程里塞消息，而是**中断当前 attempt → 以同一节点新 attempt 重跑并携带 steer 文本**。R2 落 RPC 时按这个模型设计，别再造第三种身份。

### 2.4 与 workbench 的对象映射（本文新增，供实现对照）

| T3 对象 | 我们现状 | 差距 | R1 动作 |
|---|---|---|---|
| AppThread | `runs/<run>` | 我们 run 是一次性 DAG，不是长会话 | 不改 |
| Run | 节点的一次 spawn 轮次 | 我们无计数轮次概念 | 不改 |
| RunAttempt | 无 | 无「同轮重试/转向」身份 | R2（steer）时新增 |
| ExecutionNode | `node/spec.json` + `events.jsonl` | 无 node 树（审批/工具不是节点） | R1 只做事件级投影 |
| ProviderSession | `--session-dir/--session-id` | 已有，且是持久化红利（G1 已修） | 不改 |
| EventSink 单事务 | `writeSpec`/`writeResult` 原子写文件 | 文件态天然单写；无回执表 | 加 `seq` 即可（A1） |
| EffectOutbox | daemon = 隐式 effect worker | 无持久 effect 记录 | A2 轻量版 |
| Checkpoint refs | 无 | 无快照 | R2 G40 |

---

## 3 核心机制

### 3.1 ① 事件模型：领域事件联合、写入时机、重放

**事件种类**（[S] `packages/contracts/src/orchestrationV2.ts:1864-2264`）。`OrchestrationV2DomainEvent` 是带 `type` 字面量的 schema union，共 24 个 `type` 字段（每个字段可含多个 `Schema.Literals` 名称），按语义分组：

- **线程**：`thread.created`、`thread.archived/unarchived/deleted/settled/unsettled/snoozed/...`、`thread.provider-switched`、`thread.model-selection-updated`、`thread.interaction-mode-updated`、`thread.runtime-mode-updated`、`thread.pull-request-synced`。
- **run/attempt**：`run.created`、`run.updated`、`run.background-work-cancelled`、`run-attempt.created`、`run-attempt.updated`。
- **执行图**：`node.updated`、`subagent.updated`、`provider-session.attached/updated/detached`、`provider-thread.updated`、`provider-turn.updated`。
- **人机闸门**：`runtime-request.updated`（审批/结构化提问共用）。
- **会话投影**：`message.updated`、`turn-item.updated`、`plan.updated`。
- **检查点/上下文**：`checkpoint-scope.created`、`checkpoint.captured`、`checkpoint.rollback-requested`、`context-handoff.updated`、`context-transfer.created/updated`。

**Stored event 只多两个字段**（[S] `:2264-2269`）：

```ts
export const OrchestrationV2StoredEvent = Schema.Struct({
  sequence: NonNegativeInt,
  commandId: Schema.NullOr(CommandId),
  event: OrchestrationV2DomainEvent,
});
```

即：**事件 = 全局序号 + 因果命令 + 领域事件**。没有时间戳字段（时间在 payload 里），没有 provider 原始帧（那在旋转诊断日志里）。

**写入时机**（[S] `apps/server/src/orchestration-v2/EventSink.ts:259-284`）：一个 `sql.withTransaction` 里依次做——写事件、apply 投影、写命令回执、写 outbox effect；提交成功后才 `publish`。原文注释（`:257-283`）：

```ts
// Serialize commit and publish; reordered publication makes clients drop earlier sequences.
const publishLane = yield* Semaphore.make(1);
const commitThenPublish = (transaction, publish) =>
  Effect.uninterruptibleMask((restore) => {
    // Cancellation may roll back the transaction's work. Once it commits,
    // every subscriber must hear about it before this writer can exit.
    return sql.withTransaction(Effect.tap(restore(transaction), () => takeLane)).pipe(Effect.tap(publish), ...);
  });
```

投影在事务内 apply（`:355-360`：`projectionStore.apply(stored.event)`，`concurrency: 1` 保序），随后更新 `orchestration_v2_projection_metadata.last_sequence`（`:361-369`）。

**重放/保留**（[D] `docs/internals/overview.md:61-77`）：
- 事件日志**只留约一天**（"about a day of history for reconnect replay and command-id retries"）；
- `ProjectionMaintenance` 删除投影已覆盖的旧事件，**投影不能从日志重建**；保留：每个 stream 的最新事件（高水位）、`thread.created`（legacy importer 标记）、每个 `running` run update（Codex usage 历史读第一次 attempt）、被保留 subagent 行引用的 prompt 锚点；
- 客户端 cursor 低于「该 thread 最新事件」和「已剪枝到的序号」→ 走 snapshot 恢复；空闲 thread 的 cursor 可无 snapshot 续播；
- 命令回执保留用于幂等：比保留窗口更老的 retry 仍会被去重，只是回放里没有那些被剪掉的事件（`EventSink.ts:625-694` 的 receipt 分支；`Orchestrator.ts:360-365` 的 `replayed?: true`）。

→ **我们怎么改**：
1. **不要照抄 event-sourcing 全套**。我们 `events.jsonl` 是唯一审计证据且要长期保留，不能「只留一天」。
2. R1 只抄两点：① 每行事件加 `seq`（daemon 单调递增）与 `cmd`（`ar` 命令 id）；② `records.json`/`runs.json` 视为投影，`seq` 写进文件头，`apiView` 返回 `since` 语义，前端轮询带 `since` 只取增量。这就是 S2 「2s 内至少 1 事件」验收的低成本实现。
3. 事件名**不要**抄 T3 的（`thread.*`/`run.*`），抄它的**分层**：provider 原生事件 → 我们的规范化事件（`agent_delta`/`tool_execution`/`turn`/`approval_*`）→ 投影。v2 §2.3-12 的 codex item 对齐方向正确，T3 证明「规范化层必须是 app 自己的，不是 provider 的」。

### 3.2 ② 命令面：派发模式、打断、steer、队列

**命令联合**（[S] `packages/contracts/src/orchestrationV2.ts:2895-3606`，71 个 `type` 字段，每个字段可含多个名称）。与运行时纠偏直接相关的成员：

| 命令 | 行号 | 语义要点 |
|---|---|---|
| `message.dispatch` | `:3147-3186` | 发消息；带 `deliveryIntent: auto\|steer\|restart`（`:3168`）与 `dispatchMode` 五选一（`:3176-3185`） |
| `dispatchMode` | `:3176-3185` | `defer_start` / `steer_active{targetRunId}` / `restart_active{targetRunId}` / `queue_after_active` / `start_immediately` |
| `run.interrupt` | `:3226-3233` | `reason?`、`holdQueue?` |
| `queued-message.promote-to-steer` | `:3234-3240` | 把排队消息提升为当前轮转向 |
| `queue.resume` / `queued-run.start` / `queued-run.reorder` / `queued-run.cancel` / `queued-run.edit` | `:3241-3274` | 队列是一等公民，可增删改排序 |
| `runtime-request.respond` | `:3275-3284` | 审批/提问应答：`decision`、`feedback`、`answers`、`attachmentsByQuestionId` |
| `thread.user-input.dismiss` | `:3285-3290` | 丢弃挂起提问 |
| `checkpoint.rollback` | `:3291-3298` | `restoreFiles` + scope/checkpoint |
| `thread.fork` / `thread.merge_back` | `:3299-3318` | fork 记录 lineage，先记 app 侧再懒解析 provider 原生 fork |
| `subagent.stop` | `:3219-3225` | 单独停子代理，不影响父 |

**steer 的实现策略不是一种**（[D] `docs/orchestration-v2/feature-lifecycles.md:71-98`）：
- provider 支持 active steering → 直接把消息送进在飞 turn，run 不变；
- 不支持 → **中断当前 provider turn、终结该 attempt、以同一 RunId 新 attempt 重放 steer 意图**（`:75-78`、`:101`）；
- 用户明确要新一轮 → 即使支持 steer 也走 queue（`:98`）。

**打断是两阶段**（[D] `docs/orchestration-v2/README.md:88-89`）：`turn/interrupt` 先作为请求完成，真正的 terminal 状态稍后经 `turn/completed` 到达；`feature-lifecycles.md:229-247` 明确「**不得仅因 interrupt 请求返回就把 run 标终态**」。源码侧 `ProviderTurnControlService.ts:127-172` 的 `load()` 处理了三种脏状态：provider turn 已结束但 steer 未送达（补一个 `operation:"steer"` 的终止事件，`:133-148`）、interrupt/restart 找不到活 session（视为已停，`:158-172`）。

**Stop 还顺手 hold 队列**（[D] `feature-lifecycles.md:254`："The Stop button sends `run.interrupt` with `holdQueue`"）。

→ **我们怎么改**：
1. v2 G4/G11 的现有设计是「abort 杀进程 + reply 写 spec.reply」。T3 证明这不够：**必须先定义 running 时收到 reply 的语义**。R1 建议在 `spec.reply` 处理里加 `delivery` 字段（`queue`/`steer`/`restart` 三值，`auto` 由 daemon 判定），落在 `src/daemon.ts` 的 resume 分支与 `workbench/server.ts` 的 `apiReply`。
2. `holdQueue` 值得直接抄：用户 abort 后不应自动拉起下一个 pending 节点，否则「停」会变成「换个节点继续跑」。
3. **不要**在 R1 做真 steer（需要 RPC）。R1 的诚实语义是：reply 对 running 节点 = 排队，UI 明示「将在本轮结束后送达」，别假装即时。

### 3.3 ② 后半：副作用执行器与「进程丢失」分类

**Effect 类型**（[S] `apps/server/src/orchestration-v2/EffectOutbox.ts:32-122`）共 15 种，含 `provider-turn.start/interrupt/steer/restart`、`runtime-request.respond`、`provider-thread.rollback`、`checkpoint.capture`、`provider-runtime.continue`、`delegated-tasks.stop`、各类 cleanup、`thread-title.generate`。

**分类是本轮最有价值的发现**（[S] `:125-144`）：

```ts
export const REPLAY_SAFE_EFFECT_TYPES_AFTER_PROCESS_LOSS = [
  "provider-runtime.continue", "provider-session.detach", "provider-thread.rollback",
  "checkpoint.capture", "scheduled-tasks.cleanup", "terminal.cleanup", "preview.cleanup",
  "attachment.cleanup", "thread-title.generate", "delegated-tasks.stop",
] as const;
export const PROCESS_BOUND_EFFECT_TYPES = [
  "provider-turn.start", "provider-turn.interrupt", "provider-turn.steer",
  "provider-turn.restart", "runtime-request.respond",
] as const;
```

配套语义（[D] `docs/internals/overview.md:58-59`）：*"Effects tied to a lost provider process cannot simply replay; recovery retires them before admitting new work."* 即：**绑定在活进程上的副作用在进程丢失后不能重放，只能「退役」**。

**Outbox 行结构**（[S] `:159-172`）：`status: pending|running|succeeded|failed|cancelled`、`attemptCount`、`availableAt`（退避）、`leaseOwner`（租约）、`lastError`；`claimNext` 用一条 SQL 原子 `status='running', attempt_count+1, lease_owner=workerId`（`:521-544`）；成功后 `succeeded`（`:581-588`），失败 `pending` 重试（`:615-622`）或 `failed`（`:644-651`）；settled 行保留 7 天（`:155-156`），`layerPruneWorker` 批量清理（`:672-700`）。

→ **我们怎么改**：
1. daemon 现在**就是** effect worker（spawn pi、写 result、派发后续），但没有「effect 台账」。R1 可在 `<node>/worker.json` 之外加 `<node>/pending.job`（JSON：`{kind, payload, attempts, leaseUntil}`），`finish` 后删除；daemon 重启时按「进程丢失」规则处理：`spawn` 类直接丢弃并记 `event: recovered`，写 result 类可重放。
2. **这条规则直接解掉我们的孤儿 worker 问题（G29）**：worker.json 存在且 pid 活着 = lease 仍被持有；pid 死 = 该 effect 是 process-bound，**不得重放同一 turn**，只能标记 failed 让用户重拉——而不是像现在这样「pending 就再 spawn 一个」，那会双写同一 session 目录。
3. `availableAt` 退避可省；`attemptCount` 建议保留，用于 S8 loop guard 的旁证。

### 3.4 ④ 前：provider 抽象与能力位

**Adapter 接口**（[S] `packages/provider-core/src/server/ProviderAdapter.ts:595-700`）：`getCapabilities`、`openSession`、`ensureThread`、`resumeThread`、`startTurn`、`compactThread?`、`steerTurn`、`stopTask?`、`awaitBackgroundTasks?`、`interruptTurn`、`stopSubagent?`、`unloadThread?`、`respondToRuntimeRequest`、`readThreadSnapshot`、`rollbackThread`、`forkThread`（`:631-682`；带 `?` 者为可选能力，缺失即由 policy 降级）。错误类型把「不支持」与「失败」分开：`ProviderAdapterSteerRunUnsupportedError`（`:324-336`）、`ProviderAdapterInterruptTimeoutError`（`:365-379`）。

**能力位**（[D] `docs/orchestration-v2/provider-capability-system.md:7-122`）：sessions/threads/turns/streaming/tools/approvals/planning/subagents/context/checkpointing/identity 十一组。与纠偏相关：

```ts
turns: { supportsInterrupt, supportsActiveSteering, supportsSteeringByInterruptRestart, supportsQueuedMessages, terminalStatusQuality }
approvals: { approvalsHaveNativeRequestIds, approvalCallbacksAreLiveOnly, approvalsCanOriginateFromSubagents }
planning: { emitsTodoList, emitsProposedPlan, supportsStructuredQuestions }
```

**设计原则**（同文 `:3`）：*"Provider behavior should be expressed through capabilities and policies, not provider-name conditionals spread across orchestration."*

→ **我们怎么改**：v2 G9（claude/codex worker 是摆设）的正确修法不是补 adapter，而是先在 `envelope.ts` 写 `engine` 能力表（`{interrupt:bool, steer:bool, approval:"native"|"hook"|"none", resume:bool}`），daemon 在收到 `spec.reply`/abort 时查表决定「拒绝」还是「降级」。T3 的 `ProviderAdapterSteerRunUnsupportedError` 就是「显式拒绝 > 静默假装」。R1 只填 pi 一行（`interrupt:true, steer:false, approval:"hook", resume:true`）。

#### 3.4.1 ⑧ T3 相对 pi 基线的增量（我们的 worker 就是 pi，这节最可复用）

T3 不 fork pi，它在 pi **外面**加了一层，但加的位置非常准。拆开看：

| pi 1.5.0 提供的 | T3 在其上加了什么 | 证据 |
|---|---|---|
| `--mode rpc` / JSON 事件 / `--session-dir` 会话文件 | T3 **独占**执行模式与 session 选择参数，不许用户启动参数覆盖；用 RPC 驱动，session 文件交给 pi 原生管理 | [D] `providers-pi.md:20-24,40-45`；[S] `provider-pi/src/server/rpc.ts`、`driver.ts` |
| 扩展系统（`pi.on("tool_call")` 可阻塞、`ctx.ui.confirm/select/input/editor`） | 注入**权限桥扩展**：三档模式 → 放行 / confirm / block；即使没有 MCP 凭证也强制注入，否则 Supervised 会退化成无限制 | [S] `mcpExtensionSource.ts:311-348`；`adapter.ts:465` |
| 模型目录与 thinking level | 发现 pi 报的模型与思考档，composer 的思考选择器把「当前配置档」标为默认但不覆盖 | [D] `providers-pi.md:38-40` |
| skills（`$` 菜单、原生展开） | 把用户/项目 skills 列进 composer 的 `$` 菜单，选中即用 pi 原生展开 | [D] `providers-pi.md:47-48` |
| 扩展 UI 对话（select/confirm/input/editor） | 映射成 T3 的 composer 内对话；通知进 work log；终端装饰（标题/状态行/控件）明确**不映射** | [D] `providers-pi.md:50-53` |
| usage 上报 | composer 的 context meter 跟随 pi 自己的 usage（流中与收尾后） | [D] `providers-pi.md:44-45,89-91` |
| 无内建子代理（只有示例 `subagent` 扩展） | `delegate_task` 建**独立 T3 子 thread**；若用户装了 pi 示例 subagent 扩展，T3 只把它的进度/结果映射进 UI，子代理本身不可打开/恢复 | [D] `providers-pi.md:71-74`；[S] `orchestrator-mcp-server.md:484-513` |

**T3 在 pi 上踩过、值得我们直接避开的三个坑**：
1. **不要在 pi 外再包一层 approval 概念**：pi 的权限本来就是「扩展的事」（源码注释原话，`mcpExtensionSource.ts:311-313`）。所以 gate.ts 走 `tool_call` 是对的；不要试图改 pi 的启动参数或注入 provider 层审批。
2. **T3 的模式切换靠重启 session 保 policy 不可变**（`adapter.ts:96`）。我们每轮 spawn 天然满足，但**不要**在 daemon 里加「运行中改 permission」的热更新——那会让已经批准的调用和尚未发生的调用处于两套规则下。
3. **子代理能力必须显式声明**：T3 给 pi 的 `approvalsCanOriginateFromSubagents` 是 `false`（`adapter.ts:141`），所以它没有假装「父会话能答子代理审批」。我们的 `engine` 能力表同理——pi 的 native subagent（如果将来用）不能冒泡审批，只能靠 T3 式的独立 thread + 父通知。

**可直接复用的集成契约**（我们已经具备 80%）：
- `AR_NODE_PATH` + `AICA_STATE` 定位 spec（≈ T3 的 `T3_PI_RUNTIME_MODE_ENV` / `T3_MCP_*` 环境注入，`mcpExtensionSource.test.ts:60-84`）；
- daemon 持有 session 目录（≈ T3 独占 `--session-dir`）；
- 每轮 spawn 带 `-e gate.ts`（≈ T3 每次启动注入 permission bridge，`adapter.ts:465`）。
**缺的只有一条**：我们没有「RPC 长连接」——T3 的 steer/中断即时性全建立在 RPC 上（`provider-pi/src/server/rpc.ts`）。这与 v2 「RPC 迁移 = R2.1」的判断一致，**确认**。

### 3.5 ③ 前：投影与 turn item 排序

`turn-item.updated` 是消息/工具/计划的统一 UI 单元；排序不靠时间戳，靠 `TurnItemPositionStore.normalize(payload, runOrdinal)`（[S] `EventSink.ts:332-353`），即**同一 run 内按序数归一化**，跨 run 用 `run.ordinal`。`plan.updated` 是独立事件（`:1973-1977`），不是消息子类型。

→ **我们怎么改**：S2/S9 的投影字段直接对齐：`tool_execution` 带 `call_id`+`ordinal`，`todo` 带 `items[].done`，`compaction` 单独 kind。别把 plan 塞进 agent_delta 文本里——T3 的独立 `plan.updated` 让「计划态」可与消息流分开渲染（G10 的解）。

### 3.6 ③ 上下文：portable handoff

**契约**（[D] `docs/user/portable-handoffs.md`）：
- 短对话整体迁移；长对话优先「最近的请求与回答 + 原始请求 + 命令结果类活动」，保留角色与顺序，**包括失败/中断轮次的部分工作**（`:7-9`）；
- **用户当前输入永不被裁短**（`:9`、`:27`）；
- 被省略历史留**引用**，模型可用 T3 的 thread-reading 工具回取（`:15-18`）；
- 预算是「选人话消息」而非 agent 写的摘要（`:17-18`）；
- 默认上限 16,000 token，环境变量 `T3CODE_CONTEXT_HANDOFF_TOKEN_CAP` 可调，钳制 1,024–64,000；**计费 1 token/UTF-8 byte**（含归属与 JSON 转义）（`:31-35`）；
- 容量未知时假设 128k 窗口，至少预留 16k 或窗口的 1/4；图片每张估 8,192 token，其他附件 4,096（`:42-46`）。

**源码**：`ContextHandoffService.ts:352` 读 `DEFAULT_HANDOFF_TOKEN_CAP`（解析失败回退默认），`:389/:459/:538` 三处生成 selection 时都带 `budget` 与 `omittedItems/omittedItemIds`（`:406-407`、`:476-477`、`:555-556`）；`provider-core/src/server/handoffBudget.ts` 是预算实现。

→ **我们怎么改**：R2 G39 直接照这个契约写 `aica-pi` 的 handoff 模块：从 `events.jsonl` + pi session JSONL 选「原始诉求 + 最近 N 轮 + result 摘要」，把省略项写成 `already_known` 里的引用条目，并依赖 `ar_read` 回取。**不要**用模型生成 handoff 摘要（成本且失真）——T3 明确「budgeted selection, not an agent-written summary」。

### 3.7 ④ 审批与权限：T3 最有借鉴价值的集成面

**四档**（[D] `docs/user/permission-modes.md:13-18`）：`Supervised`（命令与文件改动都问）、`Auto-accept edits`（自动批文件编辑）、`Auto`（用 provider 自带评审器）、`Full access`（不问）。**默认是 Full access**（`:10-11`），thread 级生效，项目管理策略可封顶（`:20-21`）。逐 provider 映射见 `:27-45`：Codex/Claude/Cursor/Grok/fx 支持 Auto；OpenCode/Antigravity 无等价物回退为问；Muse/Kiro 只有 Supervised/Full。

**pi 侧实现（重点，[S] `packages/provider-pi/src/server/mcpExtensionSource.ts:311-348`）**：T3 在启动 pi 时注入一个扩展，用 pi 的 blocking `tool_call` hook 实现三档：

```ts
// Pi deliberately leaves permission policy to extensions. T3's injected
// bridge uses Pi's public blocking tool hook so the shared runtime modes
// keep their normal meaning without replacing or shadowing Pi's runtime.
pi.on("tool_call", async (event, ctx) => {
  const mode = runtimeMode();
  if (mode === "full-access") return;
  if ((event.toolName === "tool_search" ? hasBuiltinToolSearch() : READ_ONLY_TOOLS.has(event.toolName)) || isReadOnlyMcpTool(event.toolName)) return;
  if (mode === "auto-accept-edits" && FILE_CHANGE_TOOLS.has(event.toolName)) return;
  const approved = await ctx.ui.confirm(`Allow ${event.toolName}?`, toolInputSummary(event.input), { signal: ctx.signal });
  if (!approved) return { block: true, reason: `${event.toolName} was declined in T3 Code.` };
});
```

三个细节值得逐字抄：
1. **只读工具按来源校验**：`pi.getAllTools()` 里同名工具必须 `sourceInfo.path` 指向 T3 自己注册的扩展（`:320-329`），否则不认只读——防「用户扩展冒充 `tool_search` 拿免审批」。
2. **block reason 写给模型看**（"was declined in T3 Code"），不是给人看的错误码。
3. **模式变更重启 session**：`adapter.ts:96` 注释 *"Restart on mode changes so the permission hook retains one immutable lifetime policy."*（用户文档 `providers-pi.md:67-69` 同步写明）。

**审批的数据模型**（[S] `packages/provider-pi/src/server/adapter.ts:1336-1432`）：pi 的 `confirm`/`select`/`input`/`editor` 请求 → `idAllocator.allocate.runtimeRequest` → `OrchestrationV2RuntimeRequest{kind:"approval_request"|"user_input_request"}` → 同时发 `node.updated`（审批节点）、`turn-item.updated`（`approval_request` 行）、`runtime-request.updated`。应答经 `runtime-request.respond` 命令回传 `decision` + `feedback`（[S] `contracts:3275-3284`）。Pi 的能力位：`approvalsHaveNativeRequestIds: true`、`approvalCallbacksAreLiveOnly: true`、`approvalsCanOriginateFromSubagents: false`（[S] `adapter.ts:134-141`）。

**「挂起时发文字 = 拒绝并给反馈」**：v2 说这条来自 T3，**部分确认**。用户文档只在 Claude 段落写明（`permission-modes.md:51-52`），但 Web 端是通用实现：`ChatComposer.tsx:3414-3419` 按 `activePendingApproval?.supportsFeedback` 切换 placeholder——支持反馈时是 "Send feedback to decline this request"，不支持时是 "Send a message to decline and redirect the agent"。即：**「发文字 = 拒绝」是产品语义，「带反馈」取决于 provider 能力**。我们 gate.ts 的 `gate-ans.json{decision:"deny",feedback}` 正好落在这个能力为 true 的一侧，可以满配。

**子代理审批冒泡**：v2 说「子代理审批冒泡进父会话、就地答复」——**部分确认/需修正**。`permission-modes.md:23-25` 是通用产品承诺；但 pi 适配器明确 `approvalsCanOriginateFromSubagents: false`。原因在 `providers-pi.md:71-74`：T3 的 `delegate_task` 子代理是**独立的 durable child thread**（有自己的会话与审批），Pi 原生 subagent 扩展跑的子代理无 session、不能作为 T3 thread 打开。所以「冒泡」在 T3 里实际是「**共享 subagent UI + 父会话通知**」，不是同一审批卡冒泡。我们照抄时应改为：审批卡带 `crumb` 父链（v2 §2.4-20 已这么写），而不是假设同一张卡能被父节点回答。

→ **我们怎么改**：
1. gate.ts 的只读白名单**必须**做来源校验（对应 A5），否则 `pi -e our-gate.ts` 场景下用户扩展可绕过。
2. `permission` 三档（supervised/edits/full）与 T3 的映射对得上；但 T3 默认 Full access，我们默认必须 supervised——**默认值不要抄**。
3. 热切换：T3 选择「重启 session」换取 policy 不可变；我们 worker 每轮重启，天然满足，但要在 gate.ts 注释里写明「档位只在 spawn 时读一次」，防止以后有人加「运行中改档」需求时破坏语义。
4. `supportsFeedback` 的降级文案值得抄：没反馈通道时，把用户文字作为「拒绝并转向」的新轮输入，而不是丢掉。

### 3.8 ⑤ 子代理、并行与父会话通知

- **delegate_task 生命周期**（[D] `docs/orchestration-v2/orchestrator-mcp-server.md:484-513`）：MCP tool → `OrchestratorMcpService` → `ThreadManagementService` → `delegated_task.request` 命令 → 子 thread + 子 run → 父侧 `app_owned` subagent 投影 + turn item → 子 run 终态 → 父 subagent/node/turn item 收口 → `subagent_result` context transfer。**finalization 幂等**靠已存在的 `subagent_result` transfer（`:511-513`），且事件流「先回放持久事件再跟 live」，所以**服务器重启后收口仍会发生**。
- **子代理提问的父通知**（`:515-530`）：子线程挂起 `user_input` 时，父收到通知消息；父轮在跑且 provider 可 steer 就 steer 进当前轮，否则排队；问题在排队通知启动前被答掉 → 该排队轮取消。**审批不路由**，因为那些工具答不了审批（`:524-525`）。
- **MCP 控制面**（`:439-466`）：`t3_thread_send`（`auto/queue/steer/restart` 四模式）、`t3_thread_wait`（等 run 终态，超时只报状态不取消）、`t3_thread_interrupt`（走 `run.interrupt`，无 runId 选最新可中断 run）。子线程的 runtime/interaction mode **不得比父宽**（`:537-540`）。

→ **我们怎么改**：
1. `ev_wait`（S7）的「父等子」在 T3 是 `t3_thread_wait`：**超时只报告状态、不取消工作**。我们 `wait` 目前没有超时语义，落地时可以加 `timeout_s`，超时写 `status:"waiting"` 并保留 `wait_on`，别把子节点标失败。
2. 子代理提交通知的唤醒策略（steer 优先、否则排队、问题被答则取消排队）可以简化成：`pendingNodes()` 在父节点 waiting 且子节点产生 `gate` 时，把 gate 写进父 `spec.reply` 并唤醒父——比 T3 简单，但语义一致。
3. 「审批不路由」这条边界要写进我们的 reviewer/advisor 设计：**子节点的 gate 卡只能由人答，不能被父 worker 代答**。

### 3.9 ② 补充：队列的产品语义

- 发消息时默认「排队等下一轮」还是「立即 steer」是**客户端设置**（[D] `docs/user/composer.md:59-63`），已排队消息保留原位置；`mod+Shift+Enter` 把队列首条提升为 steer（`:70-73`、`keybindings.md:21`）。
- 队列消息在 UI 里以虚线气泡出现在 thread 末尾；停止/服务重启后**保序保留**；编辑队列消息用铅笔，保存原位（`composer.md:223-236`）。
- 排队消息也会在「有限流/失败轮」后自动恢复（`:228-230`）。

→ **我们怎么改**：R1 不做队列 UI，但 API 语义要预留：`apiReply` 接受 `{text, delivery?}`，默认 `queue`；`POST .../node/<p>/abort` 带 `hold_queue:true`。这样 R2 接 UI 队列时不用改后端。

### 3.10 ⑥ 检查点与回滚

- **hidden git refs**（[S] `apps/server/src/orchestration-v2/CheckpointService.ts:26`）：`const CHECKPOINT_REFS_PREFIX = "refs/t3/orchestration-v2/checkpoints"`；写入走 `GitVcsDriver.ts:1258-1287`：`t3 checkpoint ref=<ref>` 的 commit + `update-ref <ref> <commitOid>`；删除 `update-ref -d`（`:1525`）。
- **作用域不变量**（[D] `orchestration-v2/README.md:36-37`）：checkpoint 绑定可 checkpoint 的执行作用域；根 run 的 checkpoint 推进 app run 计数，子/子代理的 checkpoint 嵌套、不推进父计数。
- **回滚必须与 provider 会话协同**（[D] `docs/internals/overview.md:88-91`）：*"A revert must coordinate workspace state with the provider conversation. A provider that cannot roll back its conversation must reject that operation before changing the filesystem."* 即**先校验再动文件**，不允许「文件回滚了但会话没回滚」。
- 回滚目标有两种（[S] `ProviderAdapter.ts:518-530`）：`thread_start` 或 `provider_turn`，都要求 `checkpointId` 存在。

→ **我们怎么改**：G40 的 cheap 版（节点目录 tar 快照）可以做，但必须补一条**T3 式的前置校验**：我们的 pi session 不支持按轮回滚 → 快照只恢复「节点工作目录」，**不得**声称会话也回滚；恢复后应新开一轮并在 `already_known` 里说明「工作区已回滚、会话历史未回滚」。这条不写清楚，就会出现「模型以为文件还是它改过的样子」的严重错位。

### 3.11 ⑥ 补充：快照 + cursor 的恢复协议

（[D] `docs/internals/overview.md:61-73`）客户端 cursor 低于「thread 最新事件」与「已剪枝序号」两者 → 必须走 snapshot；空闲 thread 可直接续播；**replay 读完还要再查一次剪枝序号**，因为读的过程中可能发生剪枝；命令回执保留独立于事件保留（幂等优先于回放完整性）。

→ **我们怎么改**：我们的 `apiView` 每次都是全量快照，天然安全，但也意味着 S2 之后无法做增量。若做增量，按 T3 的三件套：`snapshot_seq`（写入快照时的 seq）、`latest_seq`、`pruned_below`。R1 可以先只暴露 `latest_seq` 让前端去重。

### 3.12 v2 结论核验表

| # | v2 说法（出处） | 判定 | 证据 | 差异/动作 |
|---|---|---|---|---|
| 1 | Orchestrator 序列化命令、只决定事件不做 I/O；EventSink 单事务提交事件+投影+回执+outbox；EffectWorker 后行（§1.3） | **确认** | `overview.md:45-59`；`EventSink.ts:259-284`；`EffectOutbox.ts:32-172` | 文档说的「outbox 是后续改进」已落地为正式实现，v2 把它当「未来」低估了 |
| 2 | ack=意图已提交≠工作完成（§1.3） | **确认** | `overview.md:55-59`；`Orchestrator.ts:360-365` | 原文准确；建议我们 UI 的「已发送」态与「运行中」态分开 |
| 3 | 事件日志只留 ~1 天做重放（§1.3） | **确认** | `overview.md:61-63` | 我们**不能**照抄保留策略（见 §3.1） |
| 4 | 四档审批 Supervised/Auto-accept edits/Auto/Full，逐 provider 映射（§1.3） | **确认** | `permission-modes.md:13-45` | 补充：默认档是 **Full access**（`:10-11`）；我们没有 Auto 档（无 provider 评审器） |
| 5 | 子代理审批冒泡进父会话、就地答复（§1.3） | **修正** | `permission-modes.md:23-25` vs `provider-pi/adapter.ts:141`（`approvalsCanOriginateFromSubagents:false`）、`providers-pi.md:71-74` | pi 路径下不冒泡；T3 的 `delegate_task` 子代理是独立 thread。我们按「审批卡带 crumb」实现，不假设可代答 |
| 6 | 审批挂起时发文字 = 拒绝并给反馈（§2.1-4） | **确认（有条件）** | `ChatComposer.tsx:3414-3419`；`permission-modes.md:51-52` | 是否带 `feedback` 取决于 `supportsFeedback`；无该能力时语义是「拒绝并转向」 |
| 7 | Pi→blocking tool hook 实现调用级审批（§2.1-1） | **确认** | `mcpExtensionSource.ts:311-348`；`providers-pi.md:55-69` | 与 Cindy 双实证成立；补「只读工具按 sourceInfo.path 校验」细节 |
| 8 | portable handoff 16k/1 token per byte/用户输入不裁（§1.3） | **确认** | `portable-handoffs.md:7-35`；`ContextHandoffService.ts:352,406-407` | 额外：容量未知假设 128k、图片 8192 tok/张 |
| 9 | checkpoint = hidden git refs 抓工作区（§1.3） | **确认** | `CheckpointService.ts:26`；`GitVcsDriver.ts:1258-1287` | 补：revert 必须 provider 会话可回滚，否则先拒（`overview.md:88-91`） |
| 10 | 命令回执：writeSpec 已返回 id，无改动（§2.3-14） | **确认（可加强）** | `EventSink.ts:625-694`；`Orchestrator.ts:360-365` | 我们目前 id 只做日志；建议 `events.jsonl` 每行带 `cmd`，崩溃恢复时按 `cmd` 去重（A1） |
| 11 | （v2 未记）五种 dispatchMode + promote-to-steer + holdQueue + 队列编辑 | **新增** | `contracts:3147-3284`；`feature-lifecycles.md:254` | R1 先落 reply 的 delivery 三值；UI 队列留 R2 |
| 12 | （v2 未记）outbox 的 replay-safe / process-bound 分类 | **新增** | `EffectOutbox.ts:125-144`；`overview.md:58-59` | 直接用于 G29 孤儿 worker：process-bound 不得重放 |
| 13 | （v2 未记）provider capability 位表 | **新增** | `provider-capability-system.md:7-122`；`ProviderAdapter.ts:595-700` | 落 `envelope.ts` 的 engine 能力表（A7） |
| 14 | （v2 未记）Run/Attempt/ProviderTurn 三层身份；steering 后用新 attempt 重放 | **新增** | `feature-lifecycles.md:111-116`；`README.md:88-94` | R2 做 steer 时的正确模型；R1 只记录 attempt 号 |
| 15 | T3 有「provider 事件流」可对齐（隐含） | **修正** | `README.md:33-42`（app id 为主、provider 事件不改写） | T3 的事件是 app 领域事件，不是 provider 原样；我们抄分层，不抄事件名 |

---

## 4 UI

**布局**（[S] `apps/web/src/components/`）：

```text
┌──────────────┬──────────────────────────────────────────────┐
│ sidebar      │ thread 头部（标题/模式/模型/PR 链接）          │
│ - 项目分组   │──────────────────────────────────────────────│
│ - thread 行  │ MessagesTimeline                              │
│ - 新会话     │   ├ 用户消息（含 context chips）              │
│              │   ├ 工作日志组（工具/Run 进度，可折叠）        │
│              │   ├ 审批行（就地，不弹窗）                     │
│              │   └ 助手消息（markdown/引用）                  │
│              │──────────────────────────────────────────────│
│              │ Composer（模式选择/模型/附件/队列提示）        │
└──────────────┴──────────────────────────────────────────────┘
```

- **工作日志分组**：`TimelineWorkGroupRows.tsx`（632 行）把工具调用按「组」渲染，支持折叠、滚动锚点、失败着色（`workEntryDisplayIndicatesToolFailure`）、live 计时（`formatWorkingTimerNow`）；`TimelineWorkEntryRow.tsx` 负责单条与 reasoning trace。
- **审批行**：`TimelineWorkGroupRows.tsx:1` 直接 import `TimelinePendingApprovalRow`；挂起审批是时间线里的一行，回答后就地消失。
- **挂起请求的状态源**：`usePendingThreadRequests.ts:66-70` 注释——*"Resolution can come from anywhere: another device, an interrupt, the turn ending, or a thread that is not open."* 所以前端不持有「待答」真相，全部由服务端投影派生（`derivePendingApprovals/derivePendingUserInputs`，`:44-48`）。
- **输入框语义随状态变化**：`ChatComposer.tsx:3414-3429` 一个 placeholder 表达式覆盖审批（有/无反馈）、结构化提问（选项/自填）、计划跟进、项目未选、provider 不可用五种状态。
- **队列控件**：`QueuedRunsControl.tsx`（20KB）单独成件，说明「排队」在 UI 上是独立信息层，不混进消息流。
- **渲染约束**（[D] `docs/internals/web-ui.md`）：所有控件来自 `components/ui` 原语；Tailwind 类写在组件上；大组件里 handler 用普通函数 + `useStableCallback` 只在出口包（`:41-56`），因为 V8 每个 render 的闭包共享 scope 会保活旧 state（`:43-47`）。这是性能细节，不是布局哲学。

**信息层级的三条规则**（我们从这里学）：
1. **主线永远只有对话**；工具、审批、计划都是「可折叠的工作条目」，不是主线的平级。
2. **挂起态改变输入框语义**，而不是弹模态框抢焦点——用户可以不答审批、直接说话，产品把这句话解释成拒绝/转向。
3. **队列是独立层**（`QueuedRunsControl`），有编辑/取消/提升，不与消息混排。

→ **我们怎么改**：R1 只有 `index.html`，不可能做工作日志分组。但两条低成本可落：
- approve 卡出现时，把回复框 placeholder 改为「回复=拒绝并说明原因」（对应 `ChatComposer` 的 `supportsFeedback` 分支），并让 `apiReply` 识别「有未答 gate → deny+feedback」；
- 节点行加 `cur`（尾事件工具名）与 `dur`，等价于 T3 工作组的「live 摘要」，不做折叠。

---

## 5 值得抄（A1..A10）

> 格式：机制 → 为什么 → 落点（文件/函数）→ R1/R2。

**A1 · 事件行带 `seq` + `cmd`，命令回执幂等**
为什么：T3 用 `{sequence, commandId}` 把「回放位置」与「重复提交」两件事分开；我们 `events.jsonl` 现在无序号，UI 轮询只能全量 diff。
落点：`src/daemon.ts` 写事件处、`src/events.ts` 的 `EventRecord`、`workbench/server.ts` 的 `steps`。R1。
验收：同一条 `ar done` 重复执行两次，`events.jsonl` 只有一个 `cmd` 的回执事件；`GET .../events?since=N` 返回 N 之后。

**A2 · process-bound effect 不得重放**
为什么：`EffectOutbox.ts:125-144` + `overview.md:58-59`。我们的「pid 死了就当 pending 重拉」会双写同一 session。
落点：`src/runs.ts pendingNodes()`、`src/daemon.ts spawnWorker()`。R1（与 S3 的 worker.json 合并）。
验收：kill daemon 后重启，正在跑的节点标 `failed("orphaned")` 而非二次 spawn；events 只有一次 `spawn`。

**A3 · reply 的 delivery 三值语义（queue/steer/restart）**
为什么：T3 把「发消息」拆成五种 dispatchMode，核心是三值；不定义这个，G11 就永远是「写了 spec.reply 但进程看不到」。
落点：`src/envelope.ts`（`Reply{text, delivery?}`）、`workbench/server.ts apiReply`、`src/daemon.ts` resume 分支。R1 只实现 `queue`，其余显式返回「不支持」。R2 接 RPC 后实现 steer/restart。
验收：running 节点 reply → `spec.reply[].delivery="queue"`，UI 明示「本轮结束后送达」。

**A4 · approve 卡的输入框语义（supportsFeedback 降级）**
为什么：`ChatComposer.tsx:3414-3419`。用户不该为了「拒绝并解释」去点两次按钮。
落点：`workbench/public/v1/index.html` 的 composer 区块、`server.ts` 的 `apiReply`。R1（S5 已规划，补降级文案）。
验收：有 gate 时 placeholder 变化；发送文字 → `gate-ans.json{decision:"deny",feedback:"<text>"}`。

**A5 · 只读工具按来源校验，不只按名字**
为什么：`mcpExtensionSource.ts:316-329`。`pi.on("tool_call")` 的 `event.toolName` 可被用户扩展同名劫持；只读白名单若只比名字，等于开洞。
落点：`aica-pi/extensions/gate.ts` 的 `isReadOnly` 判定。R1。
实现：`pi.getAllTools().find(t => t.name===name)?.sourceInfo?.path` 必须等于我们自己注册的扩展路径（或内置 `builtin:tool-search`）。

**A6 · 档位只在 spawn 时解析一次，变更即重启**
为什么：`provider-pi/adapter.ts:96`。运行中改 policy 会让「已批准/未批准」语义漂移。
落点：`gate.ts` 顶部读 `spec.permission` 一次 + 注释；`daemon.ts` 文档化「改档=新节点」。R1（本来就是这样，补文档防回归）。

**A7 · engine 能力表 + 显式「不支持」错误**
为什么：`provider-capability-system.md:3` + `ProviderAdapterSteerRunUnsupportedError`。比 `if (engine==="pi")` 散落各处好。
落点：`src/envelope.ts`（`engine` 对象）、`src/daemon.ts`、`src/runs.ts`。R1 只填 pi；R3 接 codex 时填第二行。
验收：对 `spec.reply.delivery="steer"` 的 pi 节点返回 `unsupported`，不静默排队。

**A8 · Run/Attempt 分离，steer 用新 attempt 重放**
为什么：`feature-lifecycles.md:111-116`。这是 R2 做真 steer 的唯一干净模型。
落点：`events.jsonl` 的 `turn` 事件带 `attempt`；`result.json` 带 `attempts` 计数。R2。
验收：一次 steer 后同节点有 `attempt:1,2` 两条 turn 事件，最终 result 只认 attempt 2。

**A9 · snapshot + cursor 三件套（`latest_seq`/`snapshot_seq`/`pruned_below`）**
为什么：`overview.md:61-73`。R1 的 2s 轮询一旦改增量，没有这三个数必然错位。
落点：`server.ts apiView`。R2。

**A10 · handoff = 预算化选消息 + 省略引用 + 回取工具**
为什么：`portable-handoffs.md:15-18`。比模型摘要便宜且可审计。
落点：`aica-pi/` 新模块（R2 G39），复用 `ar_read` 作回取通道。

---

## 6 不抄

1. **全套 Effect-TS + SQLite 事件溯源 + 投影重建**。我们是文件态、Node 26 type-stripping、零新依赖（v2 §4 原则）。T3 的 14k 行 Orchestrator + 330KB ProjectionStore 是它多端多 provider 的代价，我们没有这个约束。
2. **8 家 provider adapter**。R1 只有 pi；codex/claude 是 R3。抄能力位（A7），不抄 adapter 矩阵。
3. **事件日志只留一天**。我们的 `events.jsonl` 是唯一审计证据，必须长期保留；T3 可以剪枝是因为它有 SQLite 投影做真相。
4. **默认 Full access**。T3 的默认档位是产品选择（降低摩擦），我们的默认必须是 supervised；抄档位结构，不抄默认值。
5. **Auto 审批档（provider 评审器）**。pi 没有 AI 审批评审器（`providers-pi.md:64-66` 明说不显示 Auto）；我们的对应物是 R2 的 advisor/reviewer，不是审批档。
6. **LegendList 虚拟列表 / React Compiler 约束 / Tailwind 原语体系**。`index.html` 是原生 DOM，照抄这些只会引入构建复杂度。
7. **thread.fork / merge_back / side chat / guest links / mobile relay**。G23/G26 非本期；fork 语义还依赖 provider 原生会话，pi 的支持面要单独验。
8. **`ProjectionStore` 式的「投影即真相」**。我们的真相是文件 + events；投影是 API 视图，随时可重算。别把 `runs.json` 做成不可重建的投影。
9. **T3 的 MCP 编排器工具名**（`t3_thread_send` 等）。抄语义（send/wait/interrupt），不抄命名；我们已有 `ar` 命令面。
10. **审批挂起时「任何文字都算拒绝」而不区分场景**。T3 有 `supportsFeedback` 能力位兜底；我们若无条件把用户文字当 deny，会把「我只是想补充一句」变成误拒。R1 只在「有未答 gate」时启用该语义。

---

## 7 出处

### 7.1 仓库内文档

- `docs/orchestration-v2/README.md:3-166` — 目标架构、10 条不变量、概念分层（`:46-58`）、最小心智模型（`:62-82`）、probe 结论（`:85-94`）、durable effect outbox（`:110-166`）、命令回执（`:108`）。
- `docs/orchestration-v2/core-graph-and-data-model.md:197-278` — Run/Attempt/Node 状态与 `steering_restart` 原因（`:232-248`）。
- `docs/orchestration-v2/feature-lifecycles.md:66-116` — steer 三策略；`:229-254` — interrupt 两阶段、`holdQueue`。
- `docs/orchestration-v2/provider-capability-system.md:7-122` — 11 组能力位。
- `docs/orchestration-v2/orchestrator-mcp-server.md:439-466` — send/wait/interrupt；`:484-530` — delegated task 生命周期与父通知；`:535-544` — 权限不得放大。
- `docs/internals/overview.md:3-19` — 所有权与 RPC；`:45-77` — 意图/副作用/重放/剪枝；`:79-103` — turn 完成 vs 收口、checkpoint、settlement；`:105-112` — drainable worker。
- `docs/internals/providers.md:119` — 「resumes/queues/steers when the adapter supports it」。
- `docs/user/permission-modes.md:1-60` — 四档、默认 Full、逐 provider 差异、子代理审批、Claude 的「文字=拒绝+反馈」。
- `docs/user/providers-pi.md:1-91` — Pi 集成面、blocking hook、模式变更重启、delegate_task、扩展信任模型。
- `docs/user/portable-handoffs.md:1-48` — handoff 预算契约。
- `docs/user/composer.md:59-76,223-236` — 排队/steer/编辑队列。
- `docs/internals/web-ui.md:1-76` — UI 原语与 React Compiler 约束。

### 7.2 源码

- `packages/contracts/src/orchestrationV2.ts:1864-2264`（事件 union）、`:2264-2269`（StoredEvent）、`:2895-3606`（命令 union）、`:3147-3186`（message.dispatch/dispatchMode）、`:3226-3240`（interrupt/promote）、`:3275-3290`（runtime-request.respond/dismiss）、`:3291-3318`（checkpoint/fork）。
- `apps/server/src/orchestration-v2/EventSink.ts:255-284`（commitThenPublish）、`:332-353`（turn item 归一化）、`:355-369`（投影 apply + last_sequence）、`:625-694`（命令回执）。
- `apps/server/src/orchestration-v2/EffectOutbox.ts:32-122`（15 种 effect）、`:125-144`（replay-safe vs process-bound）、`:146-172`（状态/租约/计数）、`:521-544`（claim SQL）、`:581-651`（成功/失败转移）、`:672-700`（剪枝）。
- `apps/server/src/orchestration-v2/Orchestrator.ts:345-365`（错误 union 与 dispatch 返回值）、`:5466`（dispatchMessage）、`:9034`（dispatchRuntimeRequestRespond）。
- `apps/server/src/orchestration-v2/ProviderTurnControlService.ts:38-77`（操作枚举与接口）、`:102-184`（load 的三类脏状态）、`:339-417`（steer）。
- `apps/server/src/orchestration-v2/CheckpointService.ts:26`（refs 前缀）。
- `apps/server/src/vcs/GitVcsDriver.ts:1258-1287`（checkpoint commit + update-ref）、`:1525`（delete ref）。
- `apps/server/src/orchestration-v2/ContextHandoffService.ts:352,389,406-407,459,476-477,538,555-556`（预算与省略项）。
- `packages/provider-core/src/server/ProviderAdapter.ts:324-379`（unsupported/timeout 错误）、`:448-700`（输入类型与 SessionRuntime 接口）。
- `packages/provider-pi/src/server/adapter.ts:96`（模式变更重启）、`:134-141`（Pi 能力位）、`:1336-1432`（confirm→runtimeRequest/node/turnItem）。
- `packages/provider-pi/src/server/mcpExtensionSource.ts:311-348`（tool_call 审批桥）、`:320-329`（只读来源校验）。
- `apps/web/src/components/chat/ChatComposer.tsx:3414-3429`（挂起态 placeholder）、`usePendingThreadRequests.ts:66-70`（挂起真相来自服务端）、`TimelineWorkGroupRows.tsx:1-60`（工作日志组）、`QueuedRunsControl.tsx`（队列控件）。

### 7.3 上游链接

- 仓库：https://github.com/pingdotgg/t3code
- 架构文档：https://github.com/pingdotgg/t3code/blob/main/docs/internals/overview.md
- 编排 V2：https://github.com/pingdotgg/t3code/blob/main/docs/orchestration-v2/README.md
- 权限档：https://github.com/pingdotgg/t3code/blob/main/docs/user/permission-modes.md
- Pi 集成：https://github.com/pingdotgg/t3code/blob/main/docs/user/providers-pi.md
- 便携 handoff：https://github.com/pingdotgg/t3code/blob/main/docs/user/portable-handoffs.md

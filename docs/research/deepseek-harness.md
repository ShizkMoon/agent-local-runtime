# DeepSeek Harness 源码级调研（dsh）

> 调研对象：本机安装的 DeepSeek Harness 桌面版 + 其公开 GitHub 仓。
> 调研日 2026-11-04。所有 `path:line` 均指 **GitHub 仓 clone**（下称 `[repo]`），行号可复核；本机安装包内的同构证据另标 `[asar]`。
> 全文结论只写「可复核事实 + 我们怎么改」。不确定处标 **需复核**。

---

## 0 版本与出处

### 0.1 两条独立证据链

| 项 | 本机安装包 `[asar]` | 公开仓 `[repo]` |
|---|---|---|
| 来源 | `C:\Users\Administrator\AppData\Local\Programs\DeepSeek Harness\resources\app.asar`（182,766,714 B） | `https://github.com/deepseek-ai/deepseek-harness` |
| 版本 | `@deepseek-ai/dsh-desktop` **0.2.1-rc.5**（`[asar]/package.json:4`） | master 已到 **0.2.2** 线（`[repo]` HEAD 提交信息：`worktree-sync-dsh-0.2.2-to-master-1103b`） |
| 提交 | `dshBuildCommit: d4db512a969fccf0c5cc7ec8fe38e9c1d27af916`（同文件 :25） | `8bd073392eef6f54e921a093b95076248eb08cbb`，2026-11-03 15:27:29 +0800 |
| 运行时 | `desktop-runtime.json`：`node 24.21.0` / `pnpm 11.28.5` / `hostProtocolVersion 4` / `schemaVersion 1` | 根 `AGENTS.md`、`pnpm-workspace.yaml` |
| 许可 | MIT（`[asar]/package.json:6`） | `LICENSE` MIT |

**版本纪律**：本文所有行号取自 `[repo]` master（0.2.2 线）。安装的 0.2.1-rc.5 与本机 `d4db512` 无法从浅克隆取回（`git fetch --depth 1 origin d4db512a…` → `upload-pack: not our ref`），因此**「机制是否存在」以 master 为准，「本机是否跑这个机制」以解包源码为准**；两者冲突处已单独标注。**需复核**：0.2.1→0.2.2 之间的行为差异本文不做穷举。

### 0.2 复现命令（我实际执行的）

```powershell
npx --yes @electron/asar extract "<asar>" C:\Users\Administrator\ego\research\dsh\app   # → 413 MB / 18,234 文件
git clone --depth 1 https://github.com/deepseek-ai/deepseek-harness.git C:\Users\Administrator\ego\research\dsh-repo
```

规模实测：`[repo]/packages` 下 370 个 `package.json`；非测试 `.ts` 约 **431,617 行**；`[asar]/dsh/node_modules/@deepseek-ai` 下 **307 个**包。

### 0.3 一手样本：本机会话日志（形态证据，非文档转述）

`C:\Users\Administrator\.dsh\sessions\--C-Repos-agent-local-runtime--\session-2746de05-…\session.v4.jsonl.zstd`
zstd 解压后 **1050 条 JSONL**，25 类事件，实测分布（我在本机统计）：

```
164 tool/result   160 tool/call   133 step/start   133 assistant/message   132 step/end
 95 job/registered  94 job/settled  21 user/message  14 agent/inbox/spliced
 11 team/task   10 team/member   9 request/header   8 assistant/attempt   8 llm/retry
  6 compaction/start  6 compaction/end  5 compaction/prune  5 compaction/summary
  5 subagent/catalog  3 goal/change  2 permission/preset  2 sandbox/mode  2 approval/policy
  2 command/run  2 command/done  2 request/context  2 session/title  1 turn/start  1 system/message
```

这条样本一次性证明了六件事：会话是 append-only 事件日志、turn 与 step 分离、tool call/result 成对、压缩有 4 类事件、Team 任务板落进同一日志、`approval/policy`+`sandbox/mode`+`permission/preset` 是同一条流里的三个独立事实。

### 0.4 入口文件

- CLI/服务入口：`[repo]/apps/cli`；`npx @deepseek-ai/dsh web` → `http://127.0.0.1:3080`（`[repo]/README.md:21-27`）。
- 桌面入口：`[asar]/lib/main.js` + `[repo]/apps/desktop`、`apps/desktop-host`。
- 本仓使用的 DSH GUI 是 `http://127.0.0.1:58008`（OS 分配端口），`dsh web` 直连浏览器时**需要 URL 内的鉴权 token**（我直接 `Invoke-WebRequest` 得到 `dsh web authentication required`）——这条本身是个设计事实：Web 载体默认是**已认证**的。

---

## 1 定位与用户体感

**一句话**：dsh 是「**整条产品都是插件**」的本地 agent harness —— 会话日志是唯一真相，UI、工具、模型适配器、agent 循环本体都是可替换插件（`[repo]/docs/architecture.md:9-11`）。仓库 README 标题直接叫 *Everything is a Plugin*。

### 1.1 典型工作流（用户视角，逐段给证据）

1. `npx @deepseek-ai/dsh web` → 浏览器打开 3080（`README.md:24-27`）；或桌面版双击（自起 Host + 内置 Web 资源，`docs/architecture.md:53`）。
2. 选目录开会话：Session 绑定 `cwd`，日志目录按 cwd 转义命名（本机实测 `--C-Repos-agent-local-runtime--`，构造见 `[repo]/packages/session/session-persistence-jsonl/src/format.ts:243-244`）。
3. 输入 → 流式回复 + 工具卡。工具调用先落 `tool/call` 再执行（`docs/tool-execution-pipeline.md:11`），所以「模型说了要做什么」永远先于「做没做成」可见。
4. 需要人批时弹审批卡：**Enter = 只批这一次**，要持久授权必须点高亮的 **Always allow**；Esc = 拒（`[repo]/packages/client/ui-approval/README.md:21-23`）。
5. 一轮结束进折叠：Work details 四档（Compact/Standard/Detailed/Verbose）+ 「Final answer only」，历史轮只留答复或留摘要（`[repo]/packages/client/ui-chat/README.md:105-107`）。
6. 右栏看文件：`dsh-resource://file/session/<id>/<path>` 地址开 tab，同一地址同类型复用 tab（`docs/subsystems/sidebar-right.md:26-32`）。
7. `/compact` 手动压上下文；自动压缩在 pre-step 压力阈值与 context-overflow 两处触发（`docs/subsystems/compaction.md:77-84,101`）。
8. 子代理：`task`/subagent 工具派生；需要协作就 `team on` 打开共享任务板（`docs/subsystems/agent-team.md:78`）。
9. 恢复：会话 survive 进程崩溃，重开时日志自带 `request/header(reason: 'resume')` 与合成的 `interrupted` turn 收口（`docs/subsystems/session.md:185,721-737`）。

### 1.2 体感差异（与我们现在的 AICA 工作台对照）

| 维度 | AICA 现状（v2 PRD 口径） | dsh |
|---|---|---|
| 执行体 | 外部进程 `pi -p --mode json` + 信封文件 | in-process 插件树，模型适配器/工具/循环都是包 |
| 真相源 | `spec.json`/`result.json`/`events.jsonl` 三件套 | 一条 append-only `SessionEvent` 日志，其余全是投影 |
| UI | 单文件 `index.html` + `node:http` 桥 | 70 个 client 包（60 个 `ui-*`）+ Slots 组合 + `node:http` 载体 |
| 审批 | `gate.ts` 文件态 gate-req/ans | `ctx.approval` 闭集裁决 + 一次性授权 + 审计对 |
| 权限 | 单轴 `permission: supervised\|edits\|full` | **双轴**（sandbox × approval）+ preset 表 |
| 子代理 | 子节点目录 + depends | activation runtime + Agent Teams 任务板（revision CAS） |

**判断**：dsh 不是「另一个 pi」，它把 AICA 正在用文件态模拟的东西（事件流、审批、子代理、压缩、恢复）都做成了**库内一等类型**。可吸收的不是它的技术栈，而是它的**词汇与不变量**。

---

## 2 架构

### 2.1 组合模型：profile → bundle → patch 三层叠加

- 一个运行中的 dsh 是**启动时按序叠出来的插件树**；profile 列 bundle，bundle 是 Cordis 配置行 + 它挂载的代码，patch 按 id 改行或插行（`docs/architecture.md:15-25`）。
- 分层：profile 的 bundles → 其 `cordis.patch.yml` → home patch → `--patch` 覆盖（同 :25）。
- 内置 profile：`web`/`headless`/`sdk`/`sdk-minimal`/`acp`；**只有 profile 能启动 Node 应用**，包 bin、demo、SDK argv 都禁止绕过（`docs/architecture.md:43`；`AGENTS.md:13`）。
- `dsh --profile web --dump-config` 打印实际树，任何一行都能被自己的 patch 替换（`docs/architecture.md:31-37`）。

**我们怎么改**：AICA 不需要 Cordis，但需要这层**可打印的最终装配**。落在 `src/daemon.ts`：spawn 前把「本次 worker 的最终配置」物化成 `node/effective.json`（model/tools 集/permission/presets/hooks/skills 逐项来源标注），`ar dispatch --explain` 打印它。今天我们的「配置从哪来」散在 `daemon.ts` + `gate.ts` + 前端三处，出问题只能靠读代码。

### 2.2 进程与包分层

- Host 层：业务服务 + `packages/api/*-controller`，拥有权威状态、持久化、变更顺序、访问策略、流生产（`docs/subsystems/web-client.md:13`）。
- 传输：`client/connection` + `api/gateway` + `api/remotes`，建立 Client generation，暴露生成的 `ctx.remote` 方法与流（同 :14）。
- Client 模型：React-free 镜像 + 流/单次竞态裁决（同 :15）。
- UI 适配 / 会话数据 / 组合渲染（Slots、renderer、layout）（同 :16-17）。
- **依赖方向单向**：Host 状态 → Remote → Client model → UI adapter → Conversation → Slots → React；展示组件拿不到 `ctx`/传输对象/别人的实现（同 :19）。
- Web 载体是 `packages/host/webserver`：**一个 `node:http`（配 tls 时 `node:https`）**，命名路由注册表、可选 gzip、index.html 变换回调、单一 fallback；它不属于 agent 循环，也不是 seam（`docs/subsystems/web-server.md:5`）。Electron 走 `file://` + IPC 桥，不经过该服务（同 :5）。

**我们怎么改**：这条和 AICA 的 `workbench/server.ts`（`node:http` + 零依赖）**同构**，差异在「路由由谁注册」：dsh 是插件注册命名路由；我们是 server.ts 里硬编码 `/api/*`。R1 不必改成插件，但**把 apiView 的每个字段来源标注清楚**（Host 真相 / 派生 / 缓存），否则 UI 会对「派生值」产生写意图。参考 `web-client.md:19` 的单向依赖：前端不重新计算状态，只渲染。

### 2.3 三个域的事件（这是整份文档最该背下来的一节）

| 域 | 事件 | 用途 | 出处 |
|---|---|---|---|
| **Session 事件** | `turn/*`、`step/*`、`system/message`、`user/message`、`assistant/message`、`assistant/attempt`、`tool/*`、`compaction/*`、`approval/*`、`permission/preset`、`hook/*`… | 落盘、装进日志、广播 `session/event`；**重载后必须存活** | `docs/architecture.md:71,108` |
| **Agent 事件** | `agent/inbox/*`、`agent/pre-step`、`agent/request`、`agent/assistant-stream`、`agent/turn-stopping`、`agent/status` | 活体协调：入队/状态/拦截/改参/继续 | 同 :72 |
| **能力事件** | `fs/*`、`tools/*`、`telemetry/*` | 在不 import 循环的前提下挂策略/适配器 | 同 :73 |

关键细节（够我们直接照抄的三条）：

1. **durable vs live 是硬边界**：`agent/assistant-stream` 的 chunk 帧是进程内瞬态，只有「提交后的 end 帧」落成 `assistant/message`；进程硬死前没结算的流**不留任何durable 痕迹**（`docs/architecture.md:108,126`；`docs/agent-lifecycle.md:85`）。
2. **waterfall vs serial**：`agent/pre-step`、`agent/request`、`llm/stream`、`tools/*` 是 waterfall（必须 `next()` 才下传）；`agent/turn-stopping` 是 serial 终局检查（`docs/architecture.md:108`）。
3. **log-only 事件**：`approval/asked|decided`、`permission/preset`、`hook/invoked|result`、`compaction/*` 都**不进模型 transcript**（`docs/subsystems/approval.md:88`；`permission-presets.md:75`；`hook-protocol/README.md:69`；`compaction.md:11`）。

**我们怎么改**：AICA 的 `events.jsonl` 现在是「什么都往里写」，没有 log-only 与 surface 的区分。S2 转写器必须引入两个标记位：`surface: true|false`（是否进 `worker.md`/下一轮 userMessage）与 `durable: true`。`approve_ask/approve_decide`、`hook_*`、`loop`、`compaction` 一律 `surface:false`——**这正好是 v2 §2.1-6 想要的效果，但 v2 只说了「进 UI steps 不进提示」，没给实现契约**。

### 2.4 能力 seam：definition / provider / consumer 三角

- seam = 可替换能力，三角色：**Service Definition**（接口）、**Service Provider**（实现）、**Consumer**（通常是模型可见工具）；单包可兼多角色，缺一不算 seam（`docs/architecture.md:136-138`）。
- 好处举例：文件系统与子进程共享同一执行世界，把两者指向远端沙箱，Bash/PTY/LSP 一起搬走，不改 provider（同 :140）。

**我们怎么改**：AICA 的 `ar` 信封已经是「definition」层，但 worker 执行核（pi / claude / codex）没有真正被当 provider 对待（v2 G9 说「claude/codex worker 摆设」）。S1 扩字段时应把 `AgentKind` 与「能力声明」绑起来：每个 kind 声明 `{permission, approve, hooks, resume, streamDelta}` 支持面，daemon 按能力降级（如 codex 无 gate → 拒绝 supervised 档并记 event），而不是静默当 pi 跑。

---

## 3 核心机制（对应任务书 ①–⑩）

### 3.1 ① 进程/会话主循环：turn 与 step

**定义**（`docs/architecture.md:83`）：**step = 一次模型请求 + 它调用的工具**；**turn = 零或多个 step**，在「第一批输入被 claim 之前」开启，在「不再欠任何东西」时关闭。

主循环（`docs/architecture.md:85-106` 原图逐行，`docs/agent-lifecycle.md:19-82` 是同一流程的序列图）：

```
turn/start
  claim 下一步输入 + 一条排队消息
  快照 Session model selection；装配 prompt 段 + 本步准入的工具 schema
  -> agent/pre-step；再投影 runtime context
        reject，或首个 enter 被改写成空 -> 本 turn 不开 step 直接关
     step/start
     agent/request -> prepareCall（取消则 system 与 user 都不提交）
     按 prepared call 能力对账 system/message
     把 enter 的消息 append 成 user/message；对账保留的 runtime context
     需要时记 request/header 与 request/context
     从日志派生并冻结 model history
     流式调用 -> llm/stream -> agent/assistant-stream start/chunk*/end
     tool/call* -> tools/pre-execute -> tools/execute -> tools/post-execute -> tool/result*
     step/end
     工具欠下一次请求，或来了新输入 -> claim -> 下一个 step
  -> agent/turn-stopping（serial 终局）
turn/end
```

四条不变量（直接可用）：

1. **取消是原子的**：`prepareCall()` 在系统提示与被接受用户消息提交**之前**绑定适配器，任一 async 阶段取消 → 两者都不提交（`docs/architecture.md:93-94,114`）。例：turn 里点了取消，不会留下半个 `system/message`。
2. **失败也补账**：失败的 step 会**补记缺失的 tool result**（`docs/architecture.md:118`），失败/重试/取消/流错误但没产出可见消息的尝试落 `assistant/attempt`（log-only，不进模型历史）（同 :126；`docs/agent-lifecycle.md:85`）。
3. **重试不重跑装配**：同一 open step 内重试「只准备并重对账同一份已渲染装配，不重复 pre-step、不重复 user admission」（`docs/agent-lifecycle.md:52`）。
4. **turn 关闭条件 = 什么都不欠**：`agent/turn-stopping` 只在「自然停下且 inbox 为空」时跑（`docs/agent-lifecycle.md:70-72`）。

**并发与 steer**：单一 inbox 喂驱动；注入的 context 等待「唤醒消息」；`steer`/注入上下文走同一个 pre-step waterfall，但用的是后来 claim 的下一批（`docs/architecture.md:112`；`docs/agent-lifecycle.md:89`）。运行中的子代理收到消息 = Steer；目标不在才 cold resume（`docs/subsystems/subagent.md:173`）。

**我们怎么改**：

- `src/daemon.ts` 现在把 pi 的 `turn_start/turn_end` 当同类事件透传，但 AICA 没有「turn 何时可以关」的定义。S2 落一条硬规则：**只有 `agent_settled`（或 pi 等价终局）之后才写 `turn{end}`，且写之前跑一遍「未配对 tool_call」检查**（对应 dsh 的补 result）。否则 UI 的「运行中」会依赖时间猜测。
- 取消语义照抄第 1 条的顺序：我们 `ar abort` 现在是直接 `taskkill`，会留下「已写 spec.reply 但没写 result」的中间态。改法：abort 先写 `abort.json{reason}` 再杀，`runs.ts` 的 `pendingNodes` 见到 abort.json 一律写 `result{failed("aborted by user")}`（S3 已设计，补 abort.json 这一层让崩溃也可判）。
- 并发模型**不要**学 dsh 的 in-process：我们是进程隔离。但可以借它「inbox 单队列 + claim 时裁决」的语义，把 AICA 的 `spec.reply` 当成 claim 时消费的消息（S3/G11 的 steer 留 R2 时，这条正好是接口）。

### 3.2 ② 上下文管理

**(a) 日志即上下文。"Model-visible means logged"**（`docs/architecture.md:130`）：模型请求必须能从日志重建；新引入的模型可见输入必须新增 session 事件；改既有内容要注册纯投影。请求信封 `request/header`（call config + 默认标记 + 工具 schema）也进日志，`foldRequestHeader(events)` 取最新快照重建（`docs/subsystems/session.md:185`）。header 的 reason 有 `initial|resume|change|series` 四种，`resume` 明确记录「循环实例边界」（同 :185）。

**(b) surface 与 surfaceOp**：会话有稳定的 `SessionSurface` 视图，append 候选先经增量校验再提交（`session.md:402`）。**只有产出消息的事件进 surface**；压缩的 summary 不自己当事件，而是**挂一条 `user/message` 带 `surfaceOp: { op:'replace', startSeq, endSeq }`** —— 整个压缩系统唯一的 surface 变更点（`docs/subsystems/compaction.md:11`）。

**(c) 压缩是带锁的三事件**（`compaction.md:11-21`）：

| 事件 | 载荷 | 作用 |
|---|---|---|
| `compaction/start` | `{turn}`（数字=自动，`null`=手动） | 拿日志记录的锁 |
| `compaction/summary` | summary + rawOutput + **shadowedRange/shadowedSeqs/shadowedTokenCount** + provider/model/usage | 安全投影，**可重建那次一次性调用** |
| `compaction/end` | `{turn, error?}` | 释放同一把锁 |

- 锁括住**整个操作**：先 start，再摘要，再落 summary 与替换消息，最后 end。**崩溃 → 留下 orphaned start（可检测），而不是谎报完成的 end**（同 :19）。
- 触发器只有两种：`'pressure'` | `'context-overflow'`（同 :81）；入口三处：`agent/pre-step`（已提交 header 上）、`agent/request`（目标已变）、`agent/request-error`（失败后恢复）——且**只有 surface 替换代际真的前进时才重试**（同 :101；`docs/agent-lifecycle.md:87`）。
- 压缩前先跑可选的 **tool-result 剪枝**（`ctx.toolResultPruner`），剪枝后重新用 `ctx.tokenMeter` 计量，可以「不摘要也推进 surface」（同 :101）。
- 区域边界**保 tool-call/result 配对，但不保整 turn**，所以超大 turn 的早期已关闭 step 也能压（同 :101）。
- 手动失败有闭集错误码：`busy|cancelled|changed|summary|commit|persistence`（同 :86-99）。
- 还有 **image offload**（`image/offload` 事件 + 纯消息投影），把图片从上下文里摘出去但保节点/消息身份（同 :28-37）。

**(d) 溢写（spill）**：过大的工具结果**不塞回上下文**，而是 `saveText` 落盘并返回 `SpillRef{locator, bytes, retrievalHint}`；locator 是品牌化的模型可见句柄，本地后端渲染成路径，远端后端可渲染成 URI/key，消费方**不许假设 read 一定能取**，要按 `retrievalHint` 呈现（`docs/subsystems/spill.md:5,11,70-77`）。`spill-policy` 是 `tools/post-execute` 的消费者（`docs/event-producer-consumer.md:88`）。

**(e) 文件/会话引用**：`session-reference` 能把另一个会话的投影抓成上下文，同样走 spill 的 owner/source 模型（`spill.md:11`）；右栏有 `dsh-resource://` 地址协议族（见 3.7）。

**(f) 前缀缓存友好**：审批策略变化时，是**追加一份完整 runtime-context 快照**（`user/message`），不动承载系统提示的 `system/message` 节点（`docs/subsystems/approval.md:49`）——这就是「前缀稳定、变更后置」的写法。同理 AgentLoop 在装配前快照 model selection，重试保留它（`architecture.md:114`）。

**我们怎么改**（这是 AICA 最大的结构性缺口，比 v2 里写的更严重）：

1. 我们现在有 `compaction_*` 透传（S2 计划），但**没有 surface 投影**：压缩后 UI 仍显示旧消息，模型看到的是被压过的历史 → 两端分叉。落点：`src/transcribe.ts` + `src/runs.ts` 增加 `surface.jsonl` 投影（或直接在 `apiView` 里按 `compaction/summary.shadowedSeqs` 折叠），**以 summary 的 shadowed 列表为准**，不要自己算范围。
2. **孤儿锁检测**：daemon 启动时扫节点 `events.jsonl`，发现未配对的 `compaction{start}` 且其后有 `turn/start` → 标 `interrupted` 并写 `compaction{end,error:"orphaned"}`。这比 v2 的「compaction_end 进 steps 显示『上下文已压缩』」多了一层**崩溃可判**，成本约 30 行。
3. **spill**：`gate.ts` 现在只保留 `PREVIEW=300`（`aica-pi/extensions/gate.ts:20`），大结果直接丢。改为：超阈值（建议 8KB）写 `node/spill/<callId>.txt`，事件里记 `{locator,bytes,hint:"read <path> offset.."}`，预览保留 —— 这直接解掉 G12（transcript 不可见）与 G2 的一个副作用：**UI 不因截断而失真**。
4. **前缀稳定**：daemon 拼 `userMessage` 时把「易变段」（当前时间、审批策略、grant 列表）放**尾部**，把 spec.goal/accept/already_known 放头部；这本来就是 dsh 的 `runtime-context 快照追加在后` 做法（`approval.md:49`），对 pi 的 prompt cache 同样有效，零成本。

### 3.3 ③ 工具层

**(a) 每步准入（step-owned admission）**：注册可带 `when(context)` 条件；AgentLoop **每个候选 step 调一次** `ctx.tools.resolve()`，返回集合决定该 step 的声明、executor 段、以及该批每个调用（含 PTC 子调用）；同批执行时 `ctx.tools.executable()` 再按集合裁一次；step 批结算后 `dispose()`（`docs/subsystems/tools.md:180-221`）。同名替换或新限制会**拦住尚未开始的调用**（同 :182）。

**(b) 执行模式：barrier 与 rolling pool**：每个待执行调用自报 `parallel | exclusive`；`exclusive` 单独跑并形成顺序屏障（`tools.md:388-398`）。批量并发上限可由 `maxParallelToolCalls` 覆盖，但只作用于根调用，程序子调用另有上限（同 :238-243）。

**(c) executor 契约（可直接抄进我们的 `ev_*` 文档）**：`execute(batch)` 必须
- 返回**与输入同序、每个输入一条**结果，**包括 abort 被跳过的调用**；
- **绝不**在已启动的工作还在跑时结算；
- 内部失败要在 drain 之后以 `ToolBatchExecutionError` reject，保留已提交结果与 context，调用方必须停掉依赖工作并**修补缺失的日志 result**（`tools.md:296-307`）。

**(d) 管线**：`tools/pre-execute`（hooks/permission/sandbox 瀑布）→ **monotonic guards**（只能 deny 或弃权，身份受保护）→ `ctx.approval` 一次性提问（**缺席或无法作答 = deny**）→ `tools/execute`（timeout/retry/metrics 的 around 包装）→ 工具体 → `fs/write-intent|fs/edit-intent`（仅写类工具）→ 工具自有事件 → `projectContent` → `tools/post-execute`（accept/block/replace/add context）→ 归一化（pipeline/result 快照抛错变 `isError`）→ `finalizeContent`（content-only 不变式）→ `tools/result`（冻结的权威结局）→ 批次结算后按 FIFO 注入 `additionalContexts`（`docs/tool-execution-pipeline.md:6,8-64`）。

**(e) PTC（programmatic tool calling）**：`run_code` 传输 + 其子调用走同一条管线；子调用带父 token、记 `tool/ptc-dispatch`、把拒绝当**绑定级 rejection** 返回、不带 `additionalContexts` 以保 call/result 相邻（同 :64；`tools.md:400-426`）。

**(f) UI 结果词汇**（`tools.md:623`）：`generic|terminal|diff|search|read|web` 六种完成卡。两处诚实性设计值得抄：
- search 卡带 `truncated`/`total`，**UI 不得把部分结果呈现为完整**；
- read 卡带 `offset`/`lines`/`totalLines`，`content` 是去掉信封的文本，给不支持 read 卡的 UI 兜底。
完成视图替换 pending 视图；写类工具即使与调用时片段重复也要回 diff 卡。

**(g) 工具目录规模与持久 shell**：`docs/tool-catalog.md` 覆盖 **35 个工具包**（我数 `^## ` 标题 36 条，扣掉索引段落 `Tool Package Map`）；包内 `###` 小节 72 条（多为同一工具的参数小节，**不是** 72 个工具，**需复核**）。其中两处与任务书直接相关：

- `dsh-tool-bash-persistent` 暴露的 `bash`：「Run commands in a persistent bash shell. State, including the current directory and exported environment variables, persists across calls **for this agent**」（`docs/tool-catalog.md:884-890`）——即持久 shell 是**可替换工具包**，与一次性 `dsh-tool-bash` 同名互斥，按 agent 隔离；Windows 侧对应 `dsh-tool-pwsh-persistent`。
- 持久 PTY 另有一套（`dsh-tool-terminal` + `ctx.terminals`），带 `TerminalWaitReason` 判定交互是否在等输入（`docs/subsystems/terminal.md:5-14`）。

**(h) 崩溃/超时**：`dsh-tool-call-timeout-policy` 只做**协作式**超时——把 signal 交给工具、取消结算后回一条清晰的 timeout 错误；工具不理取消就仍会挂着（`packages/guard/timeout-policy/README.md:11`）。

**我们怎么改**：

- `gate.ts` 已有 `deny→rules→grant→approve` 顺序；dsh 的增量是**「每步集合」而不是「每次调用判断」**。R1 落法：daemon 在 `turn_start`（或每 N 步）把 `allowedToolSet` 写进 `node/tools.json`，gate 只查集合 + 单次规则，集合外的调用直接 `{block:true,reason:"tool not admitted this step"}`。收益：`--tools` 从「整进程静态」变成「按步可调」，且集合变化有落盘证据。
- **barrier 语义**：pi 的 tool 并行我们是全放开。加一个小分类：`exclusive` 集合 = `{write, edit, bash(带重定向/rm)}`，其余 `parallel`。落点在 `aica-pi/extensions/gate.ts` 的 `tool_call` 前置判定 + `aica-pi/prompts/orchestrator.md` 的一句约束。成本 S，收益是「并行读 + 串行写」的可预期性。
- **持久 shell 不抄**：我们每个 `tool_call` 独立进程更利于 gate 审计与失败复现；但要抄 dsh 的「**按 agent 隔离**」原则——`cwd`/环境变量由 `spec` 决定，worker 之间的 bash 状态绝不共享（`docs/tool-catalog.md:884-890` 的 phrasing 已经把隔离写进工具描述）。
- **executor 契约的第 1、3 条**要写进 `tools.ts` 的 `ev_done/ev_fail` 注释：abort 时也必须为每个已发出的 tool call 落一条结果（哪怕 `st:"deny"` 或 `st:"aborted"`），否则 `events.jsonl` 出现黑洞，v2 G2 的对账就没法断言「events 条数 = stdout 里 tool_execution_start 条数」。

### 3.4 ④ 权限与审批模型

**(a) 双旋钮，不是单档位**：`permission-presets` 把两个**彼此独立**的执行旋钮捆成命名 preset：
- `sandbox/mode`（沙箱档）× `approval/policy`（`ask` | `never`）（`docs/subsystems/permission-presets.md:5,11`）；
- 默认表：`workspace-write` = (workspace-write + ask)，`danger-full-access` = (danger-full-access + never)；`custom` 与 `auto` 是**保留字**，不可配置（同 :11）；
- `set(session,name)` 先 append log-only 的 `permission/preset`，再把每个 knob 通过自己的 setter 写下去，**只在有效值变化时写 knob 事件**；重选当前 preset 不写任何事件（同 :73）；
- `current(session)` 从 `permissions` 投影折叠 sandbox/approval/记录的选择推导，匹配不上就是 `custom`（**只用于显示，永不作为切换目标**）（同 :55）；
- 组合前置条件：需要**会约束的** `ctx.shell` executor + `ctx.approval`；在不会约束的 bash executor 上组合直接抛错（同 :45）。

**(b) 审批裁决是闭集且 fail-closed**：`ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'`，**只有 `allowed-once` 是授权**；缺失/非属主/抛错/不合规的应答者一律 `unavailable`（=调用方必须拒绝）（`docs/subsystems/approval.md:21-28`；`packages/interaction/user-approval/src/index.ts:56,314,317`）。

**(c) 策略在应答者之前生效**：`ask` 交给应答链（无应答者 → `unavailable`）；`never` **不派发任何应答者**，直接 `rejected`——即使后来有人 `prepend` 注册也绕不过（`approval.md:33-46,86`；`index.ts:301`）。有效值取会话日志里**最后一条** `approval/policy`，回放即可重建（同 :33）。

**(d) 必须有 open turn**：`ctx.approval.request()` 要求请求会话处于 open turn，否则在 append 任何东西之前就 reject（`approval.md:86`；`index.ts:246`）。审计对 `approval/asked` → `approval/decided` 由同一 `ApprovalRequestId` 配对，**log-only，不进 transcript**（`approval.md:11,88`）。

**(e) 不复制参数**：`ApprovalRequest` 故意不带工具参数，靠 `callId` 关联到「已经流出的工具调用」，避免第二份可能漂移的展示（`approval.md:53`）。

**(f) 沙箱**：`dsh-sandbox*` 后端族（安装包内有 `dsh-sandbox-windows-acl`，Linux 侧有 landlock 相关 postmortem `docs/postmortem/0004-landlock-partial-notice-misclassified-child-failures.md`），`danger-full-access` 是一档显式模式。**需复核**：各平台后端的默认档与拒绝语义本文未逐行读 `docs/subsystems/sandbox.md`（13.4 KB）。

**(g) hooks 是第四种介入**（不是审批，但同一条管线）：command hook 退出码 2 = 阻断（stderr 当理由），其它非 0 = 非阻断失败，配置读不出 = 警告后不跑 hook；合并取**最严** `deny > ask > allow`，`continue:false` 取首个且粘住，context 按 hook 顺序累加（`packages/experimental/hook-protocol/README.md:36-49,65`）。

**我们怎么改**：

1. **拆轴**：`spec.permission: "supervised"|"edits"|"full"` 是**单轴**，把「问不问」和「能不能越界」混在一起。S1 改为 `spec.approval: "ask"|"never"` + `spec.sandbox: "none"|"workspace-write"`（后者 R2 才有执行体，但**字段与事件先落**），并加 `presets.json` 表（`workspace-write` / `danger-full-access` / `custom` / `auto` 保留）。UI 一个选择器，写事件 `permission/preset`。**这条同时修掉 v2 G30 的「managed 封顶档位」**：`policy.json{max_sandbox, max_approval}` 在 preset 解析处压低。
2. **裁决词表**：gate 现在只有 allow/deny 二元。改为 `{decision:"allowed-once"|"rejected"|"cancelled"|"unavailable", reason}`，超时→`unavailable`（现为 block，语义等价但不可统计），worker 退出→`cancelled`。`approve_decide` 事件带 `reason`，UI 能区分「人拒了」和「没人答」。
3. **不抄 allowed-once-only**：dsh 明确**没有**持久 grant（`allowed-once` 是唯一授权形态）。AICA 的 `grants.json`（G30）是有意偏离，但要把风险写进文档：**会话级 grant 等于把一次性授权升级成策略**，必须限定 tool 级、节点级、spawn 时清空——这三点 v2 已写，本文确认保留，并在 `README` 的安全边界段（G25）加一句「grant 不是沙箱」。
4. **审批卡语义照抄**（详见 4.4）：Enter=一次、Always allow 显式、Esc=拒、pending 锁互斥、被撤回/替换的请求不能再被作答、旧失败不能解锁新请求（`ui-approval/README.md:21`）。
5. **审计对的两个硬约束**补进 S4：①`approve_ask` 必须早于 handler 内轮询第一条；②配对必须能检错（未配对的 ask 在 daemon 启动时补 `decide{unavailable}`），否则 `events.jsonl` 的 approve 历史不可审计。

### 3.5 ⑤ 子代理与多代理

**(a) 统一 activation**：所有后端都走 `startActivation`；能力旗标校验请求选项（`agentOptions`/`agentPreset`/`outputSchema`/`depthLimit`），`prepareContinuable` 选本地子 Agent，`start` 选外部执行（`docs/subsystems/subagent.md:9,20-26`）。

**(b) 请求面**（`subagent.md:67-114`）：`cwd`（缺省捕获父当前有效目录）、`agentPreset`、`prompt`、`parent`、`signal`（**启动前后统一的取消通道**：启动前 fire → 清理后 reject；启动后 fire → 取消已发布运行的剩余 turn 工作）、`agentOptions`、`outputSchema`（对象根 JSON Schema，子成功返回 `structured`）、`maxDepth`（绝对深度上限，子计算深度 ≤ 该值）。

**(c) 交付方式**：`delivery: 'parent' | 'caller'`——`parent` 通知模型，`caller` 只把结果还给调用者（workflow/code 模式用它避免多注入一条父消息）；本地子**总是**进父 catalog（`subagent.md:31-43`）。

**(d) 通信与中断**：`sendMessage` 要求精确活着的发送者 + 同一 root 树内的目标 Session；**运行中的目标收到 Steer，只有目标不在才 cold resume**；中断权限 `user | ancestor`（Remote 调用者需对目标 Session 有权限）（`subagent.md:171-224`）。

**(e) 结果**：`SubagentResult{output, structured?, diagnostic?, stopReason}`；`diagnostic` 要求**不含工具入参/文件内容/环境值/凭证/协议原始载荷**，且 ≤4096 UTF-8 字节；`output` 取最后一条非空 assistant 消息（`subagent.md:230-265`）。**归属诚实**：运行时自己写的那条「子代理已结算」通知用 `kind:'subagent-settled'`，**故意**与 agent 之间互发的 `agent-message` 区分——否则 transcript 会把不是子代理说的话记到它头上（`subagent.md:186-205`）。

**(f) 收尾**：`drainDescendants(parents)` **等整棵树 teardown**（`subagent.md:494`）；activation 收据的 `dispose()` 只释放那一次执行（`subagent.md:45-59,173`）。

**(g) Agent Teams（与我们的 shared task board 同构）**：
- `TeamId` = root `SessionId` 的品牌；任务 id `task-<n>`（`agent-team.md:9`）。
- **每个任务事件存完整快照**；`revision` 是 CAS 值，每次变更 +1；`blockedBy` 必须指向未删除任务且保持无环；`writeScopes` 是**归一化的建议性路径前缀，不是锁**（同 :56）。
- 状态闭集：`pending`（未开始/已释放）、`in_progress`（有 owner）、`completed`（满足阻塞者）、`deleted`（保留的墓碑）（同 :72）。
- 视图 = 快照 + 派生 `ready` + `writeScopeWarnings`（重叠提示），不改快照（同 :72,84-96）。
- **模式**：`agentTeam.enabled` 存 root Session；新会话默认 false；只有 root 能 `setEnabled`，后代共享；工具在 step 准备时解析可用性，任务变更在排队操作开始时检查模式（同 :78）。
- **重要反直觉结论**：任务变化**不**结束 inbox 等待、不投递 inbox 消息、不唤醒 idle agent；要让 agent 对任务更新行动，必须显式发消息（同 :28）。
- 错误契约：`TEAM_TASK_PERSISTENCE_UNCONFIRMED` —— 「任务可见但持久性未知」，**先读再重试**，避免重复创建（同 :157,182）。

**我们怎么改**：

1. **v2 §2.4-17 要修正**：`drainDescendants` 是「整树 teardown 等待」，**不是「等子完成并取结果」**。AICA 的 `ev_wait{paths}` 语义应继续以 codex `wait_agent` / OMP `wait` 为参照；dsh 的 `drainDescendants` 只适合当 **abort/收尾兜底**（杀进程后等全体退出再写 result）。这条修正直接影响 S6 的验收写法。
2. **把 board 语义补齐到 AICA 的 `STATE/runs/<r>/tasks`**（我们已经有 task board 形态）：a) `revision` CAS（写入时比对，冲突返回当前快照而不是覆盖）；b) `writeScopeWarnings` 派生；c) `ready` 派生（不落盘）；d) `TEAM_TASK_PERSISTENCE_UNCONFIRMED` 式错误码——我们的 `writeSpec` 在 Windows 上写失败但内存已生效时，正是这个状态。
3. **别让任务变化唤醒 agent**：这条反向约束我们也要守。AICA 若做「任务完成自动派发后续任务」，必须走显式 `spec` 生成 + `node_start` hook，而不是让 orchestrator 轮询 board（否则 token 烧在轮询上）。
4. **子代理结果诚实性**：我们的 `result.summary` 现在是 worker 自报。加一条 `result.origin: "worker"|"daemon"`（daemon 生成的超时/abort 结果不带 worker 语气），并把诊断信息长度限制在 4KB 内、禁止贴文件内容——直接对应 `SubagentResult.diagnostic` 的规则。

### 3.6 ⑥ 状态与恢复

**(a) 物理形态**（本机实测 + 源码）：`$DSH_HOME/sessions/<escaped-cwd>/<session-id>/session.v4.jsonl.zstd`；zstd 压缩，解压后是**一行一个 JSON 事件**；首行是 header：`{"type":"session","version":4,"id":…,"createdAt":…,"cwd":…,"isSeeded":false,"delegationDepth":0,"agentPreset":"standard"}`。目录名 `--<escaped-path>--`（`format.ts:243-244`）。`SESSION_FORMAT_VERSION = 4`（`packages/core/session/src/types.ts:90`）。

**(b) 代际与迁移**（这是恢复能力的真正来源）：
- 打开已存会话：`stat`/`list` 只扫 header、选**数值最高的规范代际**，不加载事件；`open` 选中同一代际，**拒绝未来版本**，或「把静态相邻迁移链解码一次」后返回校验过的当前逻辑事件；**只读 open 不发布后继**；**写 open 先编码、校验，再把最终版本名后继排他发布在未改动的源文件旁边**（`docs/architecture.md:128`）。
- 已提交代际**永不重命名/替换/删除**；相邻迁移包各自只拥有一步 `vN -> vN+1`（同 :128；`AGENTS.md:7`）。
- 格式现状有机器可读记录：`latestFinalizedVersion: 4`、`latestReleasedVersion: 4`（evidence tag `dsh-v0.2.0-rc.2`）（`docs/session-format-status.md:31-49`），并有文档测试校验记录结构、双语一致、release 不超过 checkout writer（同 :56）。
- 压缩格式兼容细节：安装包内有 `zstd-private-decoder.ts` / `zstd-public-decoder.ts`（`[repo]/packages/session/session-persistence-jsonl/src/`），说明「非 Node zstd 可用」时也有读者路径。**需复核**：私有解码器的适用条件。

**(c) 恢复语义**：
- `request/header` 的 `resume` reason 标记循环实例边界（`session.md:185`）。
- 崩溃留下的 open turn：agent-loop 恢复时 append「**crash-orphaned turn 的追加收口**」（`session.md:721`），turn 结局 `interrupted` **由恢复合成，不在 live 时发出**（同 :737）。
- turn 结局闭集：`completed|cancelled|error|interrupted|max-tokens|forked`；**`max-tokens` 会压过 `completed`**（「被截断」这个事实赢过后续续跑），fork 种子构造合成 `forked`（同 :737）。
- fork：`fork(source, boundary?, childSessionId?)` 取到**含**边界的源事件（默认最后一条），关闭任何 open tail，然后用**深拷贝种子**建独立会话：`isSeeded:true`、精确 `inheritedEventCount`、继承 `cwd`、**不带 parentSession**；显式边界允许从任意稳定的 turn 间位置分叉，**拒绝落在 open turn 内部的边界**（不静默裁剪）（`session.md:688-690`；`:953,1223`）。
- 种子与活体的区分标记：`buildForkSeed` 在**精确的继承前缀切口** append `session/end-seed{inherited:true}`；README 说「fork 子会话在其精确继承点拥有一个 `{inherited:true}` 标记」（同 :747-751）。**为什么需要**：种子历史与 live 工作字节级相同，否则任何插件的开闭括号（如 `compaction/start`）都无法区分「崩溃中场」和「正在压缩」（同 :751）。
- 事件 id/序号：`seq`+`time` 负责顺序与计时；`SessionEventMap` 声明合并可扩；已知类型集合在 `known-event-types.ts`。**需复核**：未知事件类型的前向兼容策略细节。

**我们怎么改**：

1. **会话目录加版本**：AICA 节点现有 `session/`（v2 G1 已用 `--session-dir`）。加 `session/FORMAT` 文件写 `{writer:1, minReader:1}`，daemon 打开时校验；pi 升级导致格式变化时**不覆盖旧目录**，而是新建 `session.v2/` 并留旧目录只读。成本 S，价值是 G29（孤儿 worker）之外的另一类灾难：**用户升级 pi 后节点的历史被新格式覆写**。
2. **turn 结局语义**：`result.json` 现在 `status: done|failed` + `summary`。补 `reason: completed|cancelled|error|interrupted|max-tokens|aborted|timeout`，且 **`max-tokens` 优先于 completed**（dsh 的裁决）。UI 用颜色区分 `interrupted`（进程死）与 `failed`（工作失败）——这两个在 AICA 今天都显示成红。
3. **分叉与边界**：如果 R2 做 `ar fork --node --at <seq>`，直接照抄「拒绝落在 open turn 内部的边界」这条，否则会造出无法回放的半 turn。
4. **恢复期补账**：daemon 启动时对每个 running 节点做一次「日志收口」：未配对 `tool_call` → 写 `tool_result{st:"unknown"}`；未配对 `approve_ask` → 写 `decide{unavailable}`；未配对 `compaction_start` → 写 `end{error:"orphaned"}`；open turn → 写 `turn{end, reason:"interrupted"}`。这一步让「重启后同节点不二次拉起」（S3 验收）之外的**日志完整性**也成立。

### 3.7 ⑦ UI 布局与信息层级、等待态/错误态、键盘、主题

**(a) Web Client 分层**（`docs/subsystems/web-client.md:11-19`）：Host（权威状态/持久化/顺序/策略/流）→ Transport（connection/gateway/remotes，建立 generation、转发白名单事件、携带取消）→ Client 模型（React-free 镜像，解决流与单次调用的竞态）→ UI 适配（把模型 observable 变成 Slot 源）→ Conversation（把历史窗口装配成目标快照）→ Slots/Renderer/Layout。**禁止展示组件直接拿 ctx/传输对象/别的插件的实现**（同 :19）。

启动：Host 把 `WebBootGraph` 写进 `window.__DSH_BOOT__`，浏览器侧惰性 CommonJS 表注册工厂；boot kernel 预取 `immediately` 条目、挂 Cordis Loader、创建每个图节点；**必需的条目 inactive = 拒绝启动**，其它 inactive 只 warn；全部 settle 后 `ui-renderer` 水合无框架 boot DOM 并调用唯一的 `renderSlot('root')`（同 :23-25）。`$events` 逻辑流的首个 `ready` 帧携带 Host home 并确立 generation（同 :29）。

**(b) 会话区信息层级（真实规则，直接可抄）**（`packages/client/ui-chat/README.md`）：
- **隐藏行**：系统提示、普通 context 注入、`permission` 命令行在任何 work-details 档都不显示；隐藏不改变会话事件，也不影响 Trajectory 检查（:57）。没有可见消息的 assistant 尝试，Node 隐藏而不是删 key，同 step 重试可见内容回来时复用它（:59）。文本/推理只有含非空白字符才计入可见性（:61）。
- **四档 work details**：Compact / Standard / Detailed 折叠合格的历史轮但**保留每条 assistant 答复可见**，或只留最终答案（Final answer only）；Verbose 不折叠，保留时长/状态头 + 历史过程行（:105）。折叠时机是**独立偏好**，「Replies After Collapse」在 Verbose 下隐藏（:107）。
- **回复间距语义**（可直接当设计规范）：普通流行间距 4px；展开的组标题与内容 8px；assistant 回复与相邻过程行 12px；完成轮的时长/状态控件与输入、与紧随可见行各 16px；**折叠不改变答复的 12px 间距**（:124）。
- **完成轮 footer**：动作行在前置正文或扩展内容下方 **20px**；只有最新一轮且末条可见内容是回复时常显，其它情况 hover/键盘聚焦才显（:94）。
- **token 用量行**：只有「已加载窗口含 `turn/start`」且「每个已开始的模型尝试都报了安全、精确的 usage」才显示；**不完整或自相矛盾的账目整行隐藏，绝不显示部分合计**（:77）。这是我们要抄的最硬的一条 UI 诚信规则。
- **失败行**：终结性失败渲染红色圆点行；配额失败用中性文案而不是供应商原文；**中间重试不产生终结行**；输出 token 上限用琥珀色警告点；恢复期被判 `interrupted` 的 turn 渲染本地化的「已停止」行，无 code chip，过程摘要写 Stopped（:68）。
- **等待态**：运行中的组标题、推理预览、工具/命令行、重试行、底部运行状态共用 `TextShimmer`（每行文本一条左→右高亮，图标与 chevron 不参与）；运行状态是「一条鲸鱼 APNG mask 继承 text color」，reduced-motion/forced-colors 下退化为静态 SVG（:124-126）。
- **滚动所有权**（:141-159）：跟随尾部与「每个打开的有上限组各自跟随」彼此独立；读者手势会打断动画；`scrollend` 才结算；回底按钮只恢复外层跟随；next-message 折叠时同一帧时钟移动折叠行与 scrollport（:153）；turn rail 与回底按钮在 transcript 裁剪区之外，**rail 在可用宽度 ≤900px 时隐藏（判据是 transcript 可用宽，不是视口宽）**（:147）。
- **Turn rail**：导航以原始 Node key 为目标，落在其第一个可见 part；每个 part 有独立 DOM 锚点供阅读位置恢复（:116）。

**(c) 右栏（docking）**（`docs/subsystems/sidebar-right.md`）：
- 每个 Session 一个 docking surface；tab 身份 = `(kind, address)`，**address 即 contentId**，同地址同类型复用、同地址不同类型是两个 tab（:26-32）。
- 地址族：资源地址 `dsh-resource://<type>/…`（`file` 协议路径以 scope 开头：`session/<sessionId>/…` 或 `absolute/<path>`，Windows 盘符的 `:` 保留字面量）；页面地址 `sidebar://<kind>`，**只有 Sidebar 自己写**（:28-30）。
- 路由是**排序抢占**：先按 band（`extension` > `builtin` > `fallback`），再按最长匹配 pattern 长度，再按注册序；无人认领的地址抛错（「这是接线错误，不是用户错误」）（:43,51）。
- 导航四个动作（claim/focus/新 tab/展开栏）**记为一条历史**；用户看不见的内容不会被打开，折叠栏会在同一步展开；reveal 已在屏的 tab 时，**持有它的 pane 闪一次**（仅当该 Session 在屏）（:78）。
- 每次布局变化都是**一条可记录的历史条目**；reload 恢复保存的布局（:11）。

**(d) 审批卡**：`conversation.approval.card` Factory 提供 reject/allow/可选 always-allow，scope 由调用方给，带 subject 元数据（左对齐内容 + 可换行动作）与回答回调；工具审批保持两个结局（`ui-approval/README.md:38`）。

**(e) 键盘**：快捷键由 `client/shortcuts` 做窗口内命令注册与物理键派发，`ui-shortcuts` 负责呈现可用命令与本地输入动作；命令所有者声明各平台默认并复用同一动作（`web-client.md:7`）。审批区：聚焦详情区后 Enter 批准（一次）、Esc 拒绝，二者对可编辑快捷键保留；输入控件与 IME 候选保留自己的键；键盘与指针共享一个 pending 锁（`ui-approval/README.md:21`）。

**(f) 主题/排版**：`docs/ui-radius.md` 定义圆角刻度（组件引用 `ui-radius.md#radius-scale`，例如 `ui-chat/README.md:81`）；`docs/web-styling.md` 定义 Web 样式规则；`client/ui-theme` 提供主题；数量级的细节（如统计控件圆角、窄屏 gutter）都在包 README 里被显式约束。

**我们怎么改**（`workbench/public/v1/index.html` 单文件，只挑能落地的）：

1. **诚信三规则**（全部 S 级成本）：①token/耗时「不完整就整块隐藏」而不是显示 `?`；②工具结果 `truncated` 必须可见（`…共 N 行，已显示前 M 行`），不许把截断当完整；③失败分色：红点=终结失败、琥珀=预算/输出上限、灰=被拒、蓝=运行中。
2. **折叠两档足够**：`紧凑`（只留最终答复 + 每轮一行摘要「N 步 / M 秒 / Σtok」）与 `详细`（保留工具行）。别做四档。折叠**不改变**答复前的 12px 间隔——这决定观感是否「稳」。
3. **等待态用一条 shimmer 而不是转圈**：我们的 `stepHtml` 已有流式 delta，给正在跑的行加 `text-shimmer`（CSS 渐变 + `prefers-reduced-motion` 退化）。成本几十行 CSS，观感收益最大。
4. **回底与跟随**：现在依赖浏览器默认。加「是否跟随尾部」状态：用户上滚 > 24px 停止跟随并显回底按钮；用户自己提交输入立即恢复跟随（`ui-chat:145` 的规则）。
5. **审批卡键盘**：Enter=同意一次，Shift+Enter 或按钮=Always allow，Esc=拒绝；卡片打开时挂起其它输入快捷键；**已被撤回/替换的请求不能再作答**（我们 gate-ans 是文件态，天然幂等，但 UI 侧要禁掉重复点）。
6. **右栏不抄**：dockkit 成本远超 R1。但**抄地址语法**：`art://`（G18）改成 `aica-resource://artifact/<node>/<file>` 解析器，一个 scheme 多协议，UI 里所有「可点开的引用」用它。

### 3.8 ⑧ 扩展点

| 扩展点 | 形态 | 证据 | AICA 对应 |
|---|---|---|---|
| 插件 | Cordis 服务/事件/可回滚 effect；一切皆插件 | `architecture.md:9-11` | 无（不做） |
| profile/bundle/patch | 三层 YAML 叠加，可 `--dump-config` | `architecture.md:15-39` | 可借鉴「最终配置可打印」 |
| **hooks（Claude Code 方言）** | 读 `hooks.json` 或含 `hooks` 键的 settings；`hooks.json` from each `session/new.cwd` | `docs/config-catalog.md:1661-1698` | **G37 直接对应** |
| **hooks（Codex 方言）** | 读 Codex `hooks.json`，进程级一次读入 | `config-catalog.md:1709-1714` | 同上 |
| hook 协议核心 | matcher 方言只差 `mode` 一个参数；命令经 `dsh-shell` executor 跑（环境清理可覆盖、进程组取消、超时）；任何失败都降级为被包含的结局，**永不抛进循环** | `hook-protocol/README.md:65,75-78` | 我们的 `hooks/*.mjs` 应照此 |
| `hook/*` 审计 | `hook/invoked` + `hook/result` 按 `handlerId` 配对，log-only；`UserPromptSubmit/PreToolUse/PostToolUse/Stop` 因构造位于 turn 内；`SessionStart` 在 turn 1 之前，**不产生 hook 记录**，其 context 在 inbox 等唤醒 | `hook-protocol/README.md:67-71`；`docs/subsystems/session.md:761` | 新增：hook 也要留审计对 |
| hook 覆盖的事件面 | 监听 `agent/created`、`agent/pre-step`、`tools/pre-execute`、`tools/post-execute`、`agent/turn-stopping`；waterfall 返回类型化决策，turn-stopping 可 steer 下一步 | `docs/cookbook/extension-cookbook.md:106` | 与 G37 四点点位一一对应 |
| skills | provider 注册表 + 本地发现优先级 + 会话 catalog + 工具契约 | `docs/subsystems/skills.md`（标题级） | `--skill` 显式挂载（v2 §2.6-29） |
| commands | 人类命令注册表，**不产生模型消息**即可直接执行 | `docs/subsystems/commands.md:5` | 我们缺：`/abort`、`/compact`、`/retry` 这类应该走命令不走 prompt |
| MCP | `dsh-mcp-client` + 资源/指令 + 限额 | `docs/subsystems/mcp.md` | 继续 Cindy 网关方案（v2 §2.5-25） |
| 后台作业/定时 | `jobs`（`job/*` 事件、`job_*` 工具）、`schedule`（cron）、`webhook` | `architecture.md:156-157`；本机会话实测 95 条 `job/registered` | G24 的参照，非本期 |
| 持久终端 | PTY 后端 + `ctx.terminals` + `TerminalWaitReason = stdin_read\|inferred_idle\|timeout\|session_exit` | `docs/subsystems/terminal.md:5-14` | `inferred_idle` 这一招解决「交互命令等输入」判定 |
| 模组（Claude mods） | `defineMod({name,version,root,userConfig,register})` 包住 hooks 模块；**不读** `plugin.json`/`hooks.json` | `docs/subsystems/claude-code-mods.md:11,18` | 说明：hook 兼容层 ≠ 插件兼容层 |

**我们怎么改**：

1. `aica-pi/hooks/node_settled.mjs` 已存在（1361 B）。把 hook 协议照抄成三件套：`hooks/<event>.mjs` 的 stdin/stdout JSON 契约（与 Claude 一致）→ 运行器中**非 0 且非 2 = 非阻断失败并记 `hook/result{ok:false}`** → 合并取最严 → **一律 turn 内可归属**（我们的 `node_start` 相当于 `SessionStart`，已知它没有 turn，事件里 `turn:null`）。
2. hooks 必须**只从包内目录加载**（v2 §2.6-28 已写），再加 dsh 的一条：配置解析失败 → 记 `hook/result{error:"config"}` 且 agent 照常启动（`hook-protocol/README.md:48`）。
3. `/abort`、`/compact`、`/retry` 做成 **command 而不是 prompt**：`workbench/server.ts` 加 `POST /api/.../command`，写 `command.json`，daemon 轮询消费；这样不消耗 token，也不会被模型「理解错」。dsh 的 command 明确「不产生模型消息」（`commands.md:5`）。

### 3.9 ⑨ 他们怎么测 harness

七层（`docs/testing.md:9-17`）：

1. **Unit**（`pnpm run test`）：vitest 跑各包 `tests/**`；**每个 registry 都有 HMR 安全测试**（dispose 贡献 fiber、断言清理）；偏好边界、错误路径、事件顺序、并发竞态、以及「契约回归的永久测试」（同 :9）。
2. **覆盖率门**（`test:coverage`）：**`packages/*/*/src` 逐文件 100%**；未覆盖的行「往往是死代码，门禁在提示你删，而不是补测试」；行覆盖必要但不充分（同 :10）。
3. **真 API e2e**（`test:e2e`）：带 key 跑真模型；无 key 自跳过，保持 keyless CI 绿（同 :11）。政策原话：「不要节省真 API 测试；无 key 的测试只证明接线，只有带 key 才证明 agent 能用」；**最高价值是 smoke**：启动一个发布态 profile、发一句、**检查世界**（同 :25）。
4. **Owner-local expected**（`test:expected`）：不录音的装配期望（同 :12）。
5. **基准**（`test:bench`）：`benchmarks/` 按用户路径分组，构建库与 worker，计时代码跑纯 Node（同 :13）。
6. **快照**（`test:snapshot`）：顶层场景**最高代的已录父代**提供用户输入与模型回放，并作为期望的持久化结果；父 `session[.vN].jsonl`、子 `session.<ordinal>[.vN].jsonl`，文件名必须与 header 一致；`snapshot.yml` 声明 profile/组合/录制策略/工作区事实；**变更型场景还要独立比对完整 `workspace.expected/` 树**，record/refresh 永不改写它（同 :14）。改模型 transcript 用 `:record`，回放输入仍有效用 `:refresh`，**每个 diff 都要看**。
7. **Web 浏览器快照**（`test:web`，必需 PR 门）：构建插件 CSS 后在 Chromium 比对 `snapshots/web/` 与 `apps/web/tests/expected/`，模型选择器另跑 WebKit；CI 强制 `DSH_SNAPSHOT=replay` 只读，录制只在本地（同 :15）。

四条方法论（比工具更值钱）：
- **「验证世界，不是验证自我报告」**：e2e 断言**外部重跑命令或重读文件**；对 agent 自己输出做关键词探针会放过作弊的 agent；断言**未触碰的文件字节相同**（同 :35）。
- **「守卫只有在回归能让它变红时才算守卫」**：给没有 `inject` 的插件加显式断言，然后**制造回归、看它变红、回退**（同 :40）。
- **测发布artifact**：bin 必须用纯 `node` 跑 `lib/bin.js`，暴露 tsx 掩盖的 settle 竞态/模块解析/吞掉的加载失败（同 :41）。
- **一个 spec 只有单独跑才过 = 测试缺陷，不是 runner 不稳**（同 :21）。

工程配套：2682 篇 Agent Notes（`proposed/implemented/archived/rejected`）+ 23 个仓内 skills（`.agents/skills/dsh-ci-test-reliability`、`dsh-error-handling`、`dsh-session-projection`…）；文档由脚本生成并有校验（`gen-doc-graphs`、`gen-cordis-catalog`、`verify-type-equiv`、`scripts/doc-standard.spec.ts`）；`jscpd` 查重复、`oxlint`、`lefthook` 预提交。

**我们怎么改**：

1. **S 系列的验收命令按「验证世界」重写**。例：S4 现在写「写 deny → 工具返 block 且 worker 续跑」；改成三条可断言：①`events.jsonl` 出现 `approve_ask`+`approve_decide` 且配对；②**未触碰文件字节不变**（`Get-FileHash` 前后比对）；③worker 的下一条 `tool_call` 出现（证明续跑），而不是 grep worker 的自述。
2. **契约回归目录**：`tests/contract/`，专放「曾经修过的坑」，每条注释写触发它的真实事故（对齐 dsh `contract-regressions.spec.ts` 的用法）。
3. **快照**：R1 只做一条主链录制回放（dispatch → gate 提问 → 答 → done），存 `tests/snapshots/<name>/`。价值在于**改门时不靠人眼回归**。
4. **Agent Notes**：`docs/notes/YYYY-MM-DD-<slug>.md`，状态 `proposed|implemented|rejected`；代码注释引用 note 路径（dsh 全仓这么干，如 `architecture.md:126,128` 的 `[decision](../.agents/notes/...)`）。R1 起步只需「决策一条一文件」，不做目录平台。

### 3.10 ⑩ 相对 v2 的增量（Δ）与修正（C）

**确认（v2/v1 已写，本次源码复核成立）**：
- v2 §2.1-6 的 `approval/asked`+`approval/decided` 审计对：存在（`approval.md:86-88`），但**必须补 log-only 约束**。
- v2 §2.1-2「OMP 三输入」之外，dsh 提供了**第二种**解（双旋钮 + preset），见 Δ1。
- v2 §2.4-19 `outputSchema`：确认（`subagent.md:100-106,230-265`）。
- v2 §2.6-27 hooks 四点点位：与 dsh 的 `agent/created`、`agent/pre-step`、`tools/pre-execute|post-execute`、`agent/turn-stopping` 对齐（`extension-cookbook.md:106`）。
- v2 §2.5-26「compaction_end 进 steps」：方向对，深度不够，见 Δ4/C4。
- v1 §2.6「Everything is a Plugin」+ `npx @deepseek-ai/dsh web` → 3080：确认（`README.md:24-27`）。

**修正（C）**：
- **C1**（改 v2 §2.4-17）：`drainDescendants` = 整树 teardown 等待，**不是** join/取结果（`subagent.md:173`）。`ev_wait` 的语义参照改回 codex `wait_agent` / OMP `wait`。
- **C2**（补 v2 §2.1-6）：审计对是 log-only，不进 transcript（`approval.md:88`）。所以「进 UI steps 不进 worker 提示」不只是「我们想这样」，而是该系统唯一正确做法。
- **C3**（改 v1 §2.6）：`packages/examples/{acp-agent,headless-agent,jsonrpc-agent}` 在 master 已不存在；ACP/headless/SDK 都变成 profile（`architecture.md:43`）。**需复核**：0.2.1 时期是否仍有 examples 目录（安装包内无 `examples/`，只有 `dsh/`、`lib/`、`renderer/`、`node_modules/`）。
- **C4**（补 v2 §2.5-26）：压缩不能只发事件，必须同时改 surface 投影，否则 UI 与模型所见分叉（`compaction.md:11`）。
- **C5**（补 v2 S4）：审批请求必须有归属 turn（`approval.md:86`；`index.ts:246`）。我们文件态 gate 现在是「daemon 侧无 turn」，迁移 RPC 时这条会变成硬约束。

**新增（Δ，v2/v1 未覆盖）**：

| # | 机制 | 证据 | 建议 |
|---|---|---|---|
| Δ1 | 权限**双轴** + preset 表（sandbox × approval，`custom`/`auto` 保留字） | `permission-presets.md:5,11,45,55,73` | 拆 `spec.permission` → `spec.approval` + `spec.sandbox` + `presets.json`（R1 字段先落） |
| Δ2 | **step 级工具准入** `when()` + `ResolvedToolSet` 批后 dispose | `tools.md:180-221` | daemon 每步写 `tools.json`，gate 只查集合 |
| Δ3 | **spill**：大结果外溢 + locator + retrievalHint；search 卡 `truncated/total` | `spill.md:5,70-77`；`tools.md:623` | G12/G2 的诚实性补丁 |
| Δ4 | 压缩**三事件锁** + summary 走 `user/message{surfaceOp:replace}` + orphan 锁检测 | `compaction.md:11-21` | S2 加 surface 投影 + 启动收口 |
| Δ5 | 任务板 **revision CAS** + `writeScopes` 建议性 + `ready` 派生 + `PERSISTENCE_UNCONFIRMED` | `agent-team.md:56,72,157` | 补 AICA board 语义 |
| Δ6 | `hook/invoked|result` 审计对 + turn 内约束 + SessionStart 无记录 | `hook-protocol/README.md:67-71`；`session.md:761` | G37 增强 |
| Δ7 | 审批 UI 键盘语义 + pending 锁 + 撤回不可再答 | `ui-approval/README.md:21` | G36 直接抄 |
| Δ8 | 会话格式**版本号 + 相邻迁移 + 只读打开不改写 + 已提交代际不可变** | `architecture.md:128`；`session-format-status.md:31-49` | 新缺口：格式演进安全 |
| Δ9 | **turn 结局闭集**（`max-tokens` 压过 `completed`；`interrupted`/`forked` 由恢复/分叉合成） | `session.md:737` | `result.reason` 字段 |
| Δ10 | 结果诚实性三处：token 不完整就隐藏、`diagnostic` 脱敏 ≤4KB、`subagent-settled` 归属分离 | `ui-chat:77`；`subagent.md:255-264,186-205` | 抄进 result.json 与 UI |
| Δ11 | 测试「验证世界 / 证伪回归 / 未触碰文件字节相同」 | `testing.md:35,40` | 重写 S 验收 |
| Δ12 | Agent Notes（2682 篇决策记录）作为工程机制 | `.agents/notes/*` | R1 起步版 |

---

## 4 UI / 交互（落点级，给 AICA 用）

### 4.1 主视图骨架（dsh 实测结构与我们的映射）

dsh web 三块 + 覆盖层：**Session 列表（左）/ Conversation（中）/ Sidebar（右，可 dock/float）**，加 `shell.overlay` 级的一次性通知（配额/更新）与底部 composer 的 dock 统计项（`ui-chat/README.md:68,81`；`sidebar-right.md:5`）。

AICA 单文件版建议保持：**左 = Run 树（节点行）**、**中 = 对话/步骤流**、**右 = 详情抽屉（不是 docking）**。差异点：
- dsh 的 tab 身份是 `(kind,address)`；我们的抽屉身份应是 `(node, kind)`，同一节点同一 kind 不叠开。
- dsh 的「用户看不见的内容不会被打开」→ 我们点引用时若抽屉折叠，**同一步展开**并闪一次持有它的行（`sidebar-right.md:78`）。这条几乎零成本，但对「点一下没反应」的体感改善很大。

### 4.2 信息层级（谁大谁小）

| 层 | 内容 | 视觉权重 |
|---|---|---|
| 1 | 本轮最终答复 | 正文 14px，唯一有 12px 上下留白的内容 |
| 2 | 运行中的一行状态（shimmer + 当前工具名） | 同正文但次级色，图标不闪 |
| 3 | 工具/命令行（可折叠组） | 13px、tertiary 色、hover secondary（`ui-chat:136`） |
| 4 | 轮摘要头（N 步 / 时长 / Σtok） | 12px、可点开 |
| 5 | 审计行（approve/hook/compaction/loop） | 默认折叠，仅计数徽标 |

**反例（不要做）**：把 `step/start`、`tool_execution_update` 原样铺成时间线。dsh 用「组 + 折叠 + 隐藏行」把 133 条 step 事件压成一屏可读（本机样本 1050 事件里 265 条是 step 边界，全铺出来没人看）。

### 4.3 等待态与错误态

- **运行中**：一行 shimmer + 当前工具名 + 已用时；`step` 计数不显示（噪声）。
- **等待人**：审批卡或提问卡**自动聚焦到详情区**，Enter/Esc 直接可用（`ui-approval:21`）。
- **红线**：token/时长 **不完整不显示**（`ui-chat:77`）。
- **错误分四色**：红=终结失败（含 `interrupted` 的「进程已退出」措辞，`ui-chat:68`）、琥珀=预算/输出上限、灰=被拒（`denied`）、蓝=重试中（**中间重试不产生终结行**）。
- **断线态**：dsh 的 Connection 用 generation 建模；我们 `server.ts` 用 SSE 时，断线要显式显示「已断开，重连中」而不是静默停在最后一条 delta。

### 4.4 审批卡（可直接实现的规格）

```
┌ 需要你批准 ──────────────────────────── 来自 nodes/research-2 ┐
│ bash · rm -rf build/                                          │
│ 目标路径: <repo>/build （3 个文件将被删除）                     │
│ [拒绝 Esc]            [同意一次 Enter]      [本次会话都同意 ⏎] │
└───────────────────────────────────────────────────────────────┘
```

- 主按钮高亮 = 「本次会话都同意」（若允许）；否则「同意一次」为主（`ui-approval:23`）。
- Enter 永远只给**有限 scope**；持久授权必须显式动作（同 :23）。
- 键盘与指针共享一个 pending 锁；被撤回/替换的请求不能再作答；旧的失败回答不能解锁新请求（同 :21）。
- 卡片带 `crumb`（父链）——我们已经有了（`server.ts:316` 口径），保持。
- 挂起时用户直接打字 = 拒绝并给反馈（v2 §2.1-4，T3 语义；dsh 无此语义，属于我们的增量）。

### 4.5 键盘

- 全局：`Ctrl/Cmd+K` 命令面板、`Esc` 关闭顶层弹层并还焦（dsh：共享 modal primitive 仲裁顶层 Esc 与焦点恢复，`web-client.md:7`）。
- 会话内：`Ctrl/Cmd+Enter` 发送、`Shift+Enter` 换行（现状保留）、`Ctrl/Cmd+.` 中止当前节点（映射 `ar abort`）。
- 审批卡内：Enter/Esc，输入控件与 IME 优先（`ui-approval:21`）。
- **判据**：任何快捷键都必须有对应的鼠标入口，且焦点恢复点明确（dsh 强调「preference 菜单把焦点还给触发器且不滚动」`ui-chat:87`）。

### 4.6 主题与排版

- 抄三件：**圆角刻度统一**（`docs/ui-radius.md#radius-scale`）、**等宽只给工具/代码**、**过程行统一 tertiary 色**（`ui-chat:136`）。
- 动效：一律 `prefers-reduced-motion` 退化（dsh 的鲸鱼 APNG 退静态 SVG，`ui-chat:126`）；我们的 shimmer 同样处理。
- 不要做暗色/亮色双套全量 token：单文件版先用 `color-scheme` + 少量 CSS 变量。

---

## 5 值得抄的（A 清单：机制 + 为什么 + 落点 + 成本）

| # | 机制 | 为什么值得 | 落点 | 成本 |
|---|---|---|---|---|
| **A1** | **审批裁决闭集 + fail-closed 归一化**（`allowed-once\|rejected\|cancelled\|unavailable`；应答者缺失/抛错→unavailable） | 我们只有 allow/deny 二元，「没人答」「被撤回」「人拒了」在统计上不可分；闭集让 UI 文案与审计都能精确 | `aica-pi/extensions/gate.ts` 决策词表；`events.jsonl` 的 `approve_decide.reason` | S |
| **A2** | **审计对 + log-only 标记**（`asked`→`decided` 同 id 配对；不进取 prompt） | 现在事件是混的；加了 surface 位之后，「UI 可见 / 模型可见」第一次分离 | `src/transcribe.ts` 事件写出点；`aica-pi/extensions/events.ts` | S |
| **A3** | **权限双轴 + preset 表** | 单轴 `permission` 把「问不问」和「能不能越界」耦合，未来加沙箱会推翻字段 | `src/envelope.ts`（`approval`/`sandbox`/`preset`）+ `aica-pi/presets.json` + UI 选择器 | M |
| **A4** | **审批卡键盘语义 + pending 锁** | 审批是唯一「人必须在环」的地方，键盘语义错=慢一倍 | `workbench/public/v1/index.html` approve 卡 | S |
| **A5** | **step 级工具准入**（每步集合 + 批后释放） | 现在 `--tools` 全进程静态；按步可调 = 更小爆炸半径 + 可审计 | `src/daemon.ts`（写 `node/tools.json`）+ gate 查集合 | M |
| **A6** | **溢写 spill**（大结果落盘 + locator + retrievalHint） | 我们靠 `PREVIEW=300` 丢内容；溢写让「不塞上下文」和「可回取」同时成立 | `src/transcribe.ts` + `spill/<callId>.txt` | S |
| **A7** | **结果诚实性**（`truncated/total/offset/totalLines`；不完整就不显示统计） | 直接决定用户信不信这个工作台 | `index.html` stepHtml + `transcribe.ts` | S |
| **A8** | **压缩三事件 + surface 投影 + orphan 检测** | 现在压缩对我们是不透明副作用；改造后「压缩」变成可回放、可检测、可显示 | `transcribe.ts` + `runs.ts`（启动收口） | M |
| **A9** | **turn 结局闭集**（`max-tokens` 压过 `completed`；`interrupted` 由恢复合成） | 今天所有异常都塌成 `failed`；分原因后 UI/统计/重试策略才有依据 | `src/envelope.ts` `ResultEnvelope.reason`；`daemon.ts` 收口 | S |
| **A10** | **任务板 CAS + 建议性写域 + persistence-unconfirmed** | 与我们的 board 同构，且解决「写失败但已可见」这个真实状态 | `workbench/server.ts` + `STATE/runs/<r>` 写入路径 | M |
| **A11** | **hook 审计对 + turn 内归属 + 永不抛进循环** | `hooks/` 已存在，但没有审计与失败语义 → 事故时无法回答「hook 跑了吗、它说了啥」 | `aica-pi/hooks/` runner + `events` | S |
| **A12** | **会话格式版本化 + 相邻迁移 + 已提交代际只读** | pi 升级会改 session 格式；我们没有防线 | `src/daemon.ts`（`session/FORMAT`）+ 文档 | S |
| **A13** | **「验证世界」验收法 + 证伪回归 + 未触碰文件字节相同** | 我们的验收现在读 worker 自述，容易被「模型说它做了」骗过 | 全部 S 步骤的验收段 | S |
| **A14** | **Agent Notes（决策一条一文件）** | 2682 篇是 dsh 能维持 43 万行复杂度的原因之一；我们 PRD 已很厚但决策散落 | `docs/notes/YYYY-MM-DD-*.md` | S |

> 优先级：A1/A2/A4/A7/A11/A13 是「便宜且立刻改善体感或可信度」的一档；A3/A5/A8/A10 是「结构性、改动面大」的一档；A6/A9/A12/A14 归 R1 尾巴或 R2 头。

---

## 6 不抄的与原因

| # | 不抄 | 原因 |
|---|---|---|
| N1 | **全插件化（Cordis）/ 370 包 / 431k 行** | 我们的约束是零依赖 + 单文件 + Windows 优先；插件框架的成本在当前规模不划算。只借「最终装配可打印」（2.1）这一个产物。 |
| N2 | **`allowed-once` 唯一授权（无持久 grant）** | 我们在 S5 已选 `grants.json` 会话级授权。保留偏离，但必须限 tool 级 + 节点级 + spawn 清空，并在 README 安全边界写清「grant 不是沙箱」。dsh 的做法是最保守解，不是唯一解。 |
| N3 | **PTC `run_code` + 双 executor** | 需要沙箱内代码执行与子调用管线，R1 无收益。 |
| N4 | **右栏 docking 引擎（dockkit：pane 预算/浮窗/历史/布局持久化）** | 收益集中在「多文件并看」，而我们的主对象是节点而不是文件。只抄地址语法。 |
| N5 | **Work details 四档 + 折叠时序系统** | 两档够用；四档的标题/时钟/disclosure 重置规则是复杂度的黑洞（`ui-chat:105-107` 背后还有一整份 business-rule reference）。 |
| N6 | **MCP 直透** | 继续 v2 §2.5-25 的 Cindy 网关两 schema。 |
| N7 | **OS 级沙箱后端（Windows ACL / landlock）** | R2+；本期只落 `spec.sandbox` 字段与文档（G25）。 |
| N8 | **快照测试全量（web/desktop/acp/sdk 四套录制回放）** | 成本按仓计；我们 R1 只做一条主链。 |
| N9 | **`assistant/attempt` 双轨（message vs attempt）** | 这是为「可重建的失败尝试」付的复杂度；我们的 `events.jsonl` 已能承载，没必要再分两套 durable 形态。 |
| N10 | **HMR / 热重载插件图** | 我们的开发循环是 `node` 重启，不需要。 |
| N11 | **持久 bash / 持久 PTY** | 每个 tool_call 独立进程更适合文件态审批与事故复现；持久 shell 会让「这条命令在什么环境里跑的」变成隐式状态。只抄「按 agent 隔离 cwd/环境」的原则。 |

---

## 7 一手出处

### 7.1 仓库（`[repo]` = `C:\Users\Administrator\ego\research\dsh-repo`，commit `8bd0733`，2026-11-03）

URL：<https://github.com/deepseek-ai/deepseek-harness>

| 主题 | 文件:行 |
|---|---|
| 组合/分层/进程 | `docs/architecture.md:9-11,15-39,43,53,59-65` |
| 三域事件 | `docs/architecture.md:71-73,108` |
| turn/step 主循环 | `docs/architecture.md:81-108,110-118`；`docs/agent-lifecycle.md:19-83,85,87,89,91` |
| 日志即上下文 + 代际/迁移 | `docs/architecture.md:124-132`；`docs/subsystems/session.md:185,402,684-690,721-751,953,1223` |
| 能力 seam | `docs/architecture.md:136-142,144-169` |
| 工具管线 | `docs/tool-execution-pipeline.md:6,8-64` |
| 工具准入/执行模式/契约 | `docs/subsystems/tools.md:180-221,233-265,284-308,388-398,400-426,623` |
| 溢写 | `docs/subsystems/spill.md:5,11,70-77` |
| 压缩 | `docs/subsystems/compaction.md:5,11-21,28-37,77-84,86-99,101-103` |
| 审批 | `docs/subsystems/approval.md:5,11,21-28,33-46,53,86-88`；`packages/interaction/user-approval/src/index.ts:56,246,252,259,301,309,314,317` |
| 权限 preset | `docs/subsystems/permission-presets.md:5,11,45,49,55,73,75` |
| 子代理 | `docs/subsystems/subagent.md:5,9,20-26,31-43,45-59,67-114,171-173,177-224,228,230-265` |
| Agent Teams | `docs/subsystems/agent-team.md:5,9,28,54-72,78,80,111,157,182` |
| hooks 协议 | `packages/experimental/hook-protocol/README.md:12,36-49,63-71,75-78`；`docs/cookbook/extension-cookbook.md:106`；`docs/subsystems/claude-code-mods.md:11,18` |
| hooks 配置发现 | `docs/config-catalog.md:1661-1698,1709-1714` |
| 命令 | `docs/subsystems/commands.md:5,9-22` |
| 终端（PTY） | `docs/subsystems/terminal.md:5-14` |
| Web 客户端分层/boot | `docs/subsystems/web-client.md:5,7,11-19,21-29` |
| HTTP 载体 | `docs/subsystems/web-server.md:5,14-18` |
| 右栏 | `docs/subsystems/sidebar-right.md:5,11,13,26-32,36-53,76-94` |
| Chat 信息层级 | `packages/client/ui-chat/README.md:55-61,66-70,74-88,89-95,98-108,111-137,141-159` |
| 审批 UI | `packages/client/ui-approval/README.md:11,21-23,38` |
| 测试政策 | `docs/testing.md:9-17,21,25,29,35,39-41` |
| 格式状态 | `docs/session-format-status.md:20,31-49,56`；`packages/core/session/src/types.ts:90` |
| 目录命名/压缩 | `packages/session/session-persistence-jsonl/src/format.ts:243-244`；同目录 `zstd.ts`/`zstd-public-decoder.ts` |
| 事件生产/消费表 | `docs/event-producer-consumer.md:16,22,25,80,83,88,89` |
| guard | `packages/guard/repeat-tool-reminder/README.md:11`；`packages/guard/timeout-policy/README.md:11` |
| 工具目录（35 个工具包 / 持久 shell） | `docs/tool-catalog.md:884-890`；`docs/subsystems/terminal.md:5-14` |
| 仓规约 | `AGENTS.md:3,7,13`；`README.md:21-27` |

### 7.2 安装包（`[asar]` = 解包后的 `C:\Users\Administrator\ego\research\dsh\app`）

| 主题 | 位置 |
|---|---|
| 版本/commit/许可 | `package.json:4,6,28` |
| 运行时版本 | `dsh/desktop-runtime.json`（node 24.21.0 / pnpm 11.28.5 / hostProtocolVersion 4） |
| 包清单（307 个 `@deepseek-ai/*`） | `dsh/node_modules/@deepseek-ai/` |
| 本机程序 | `lib/main.js`；`renderer/`（更新/欢迎/强制更新页） |

### 7.3 本机会话样本（形态证据）

`C:\Users\Administrator\.dsh\sessions\--C-Repos-agent-local-runtime--\session-2746de05-de11-4bb6-81d3-8a8dd3b43b54\session.v4.jsonl.zstd`
→ zstd 解压 + JSONL 统计（1050 事件 / 25 类）；header 字段与事件样例见 0.3 与 3.6(a)。

### 7.4 官方入口

- 仓库：<https://github.com/deepseek-ai/deepseek-harness>
- npm 包：`@deepseek-ai/dsh`（`npx @deepseek-ai/dsh web`，默认 127.0.0.1:3080，`README.md:21-27`）
- 文档索引：仓库 `docs/subsystems/README.md`（11.5 KB）、`docs/tool-catalog.md`、`docs/config-catalog.md`、`docs/persistence-catalog.md`

### 7.5 待复核清单

1. `docs/subsystems/sandbox.md`（13.4 KB）——各平台后端默认档、`danger-full-access` 的精确语义、Windows ACL 后端行为。
2. 0.2.1-rc.5（本机）与 0.2.2（master）之间的机制漂移；尤其 `permission-presets` 与 `agent-team` 是否在 0.2.1 已存在（本机会话样本里出现 `permission/preset` 与 `team/task`，**初步判定已存在**）。
3. `zstd-private-decoder` 的适用条件与失败降级。
4. `docs/subsystems/goal.md` + `packages/goal/goal-round-driver`（同会话长目标 + 轮驱动）——很可能与 AICA orchestrator 的「多轮重拉」直接同构，本轮未精读。
5. `docs/subsystems/workflow.md`（JS 工作流编排，`WorkflowMeta/WorkflowResult/WorkflowError.fatal`）——与 AICA 的编排层可对照，本轮只到标题级。
6. `session-reference` 的抓取预算与脱敏规则（`docs/subsystems/session-reference.md`，10.6 KB）。
7. `docs/defensive-patterns/*`（4 篇，含 `conversation-and-session.md` 20 KB）里关于并发/竞态的禁令，值得单独抽成我们的 checklist。

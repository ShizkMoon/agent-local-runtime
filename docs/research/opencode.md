# OpenCode 源码级调研（v2.2.5，`d852834`）

> **一句话**：OpenCode 已不是 v1 调研时那个「server-first 的 TUI + OpenAPI」——v2.2.5 是一次 Effect-TS 重写：单例后台 server + 多客户端、SQLite 投影、`action/resource/effect` 规则集审批、Code Mode 单工具、git-tree 快照回滚、崩溃续跑预算。**它的多数机制不是「更聪明的 agent」，而是「把不确定的模型行为关进可重放的状态机」**，这正好补我们 `ar` + 文件态运行时的短板。
>
> **调研口径**：`git clone --depth 1` 到 `C:\Users\Administrator\ego\research\opencode`（branch `dev`，commit `d85283496fefedaab61bd15750db81b1f82dc42f`，2026-11-04），全部结论以源码为准；官方 `opencode.ai/docs` 仍大量描述 v1 行为，与源码不一致处在文中标「文档滞后 / 需复核」。
>
> **本轮最强三条可吸收机制**（详见 §5）：**A1 资源级权限规则集 + deny 先行**、**A5 工具输出截断契约（头截断 + 全文落盘路径）**、**A9 崩溃 claim + 续跑次数预算**；UI 侧再加 **A7 分组/verbosity 投影**。

---

## 0 版本与出处

### 0.1 快照

| 项 | 值 | 依据 |
|---|---|---|
| 仓库 | `github.com/sst/opencode`，GitHub 已跳转 `anomalyco/opencode`；`package.json` 内 repository 指后者 | `package.json:138-141`；本次 clone 的 remote 仍是 sst URL |
| 版本 | `2.2.5`（根包 private monorepo） | `package.json:5-6` |
| 提交 | `d85283496fefedaab61bd15750db81b1f82dc42f`，`dev`，2026-11-04 | `git log -1` |
| 许可 | MIT | `package.json:142`；`LICENSE:1-3` |
| 运行时 | Bun `1.4.4`（`packageManager`），TypeScript；effect `4.1.0`；drizzle-orm rc；opentui `0.8.1` | `package.json:8,57,82-83` |
| 规模 | 约 40 个 `packages/*`；`*.test.ts` 实测 1169 个 | 本地 `Get-ChildItem -Recurse -Filter *.test.ts` |
| 形态 | 单仓多包：`schema / protocol / core / server / cli / tui / app / desktop / plugin / codemode / session-ui` | `packages/` 目录 |

> **Δ0-1（相对 v1 §2.5 与 PRD v2）**：v1 记录的「TUI 是 `opencode serve` 的客户端、OpenAPI 3.1 + SSE + SDK」方向仍成立，但细节全变：v1 提到的 per-agent `permission` 键值、`.opencode/plugins/*.ts` 函数式 hook、`session export --sanitize` 都已被 v2 的新模型替换或重写，内部 message/part 模型也已重做（v1 原文见 `docs/prd-workbench-v1.md:73-80`）。**本文件的结论优先于 v1 §2.5，v1 不要再用。**

### 0.2 代码地图（只列与本项目决策相关的）

| 包 | 角色 | 必读文件 |
|---|---|---|
| `packages/schema` | 纯 Schema 层：事件、消息、权限、config 定义（全仓依赖方向 schema → core/protocol → server） | `session-message.ts`、`session-event.ts`、`permission.ts`、`config/*.ts` |
| `packages/core` | 领域实现：session 循环、工具、权限、插件、MCP、快照、PTY、后台 job | `session/*.ts`、`tool*`、`permission.ts`、`bus.ts` |
| `packages/server` | HTTP 装配：Effect HttpApi、SSE、鉴权、单例服务注册 | `event-feed.ts`、`auth.ts`、`routes.ts` |
| `packages/protocol` | 对外 API 契约（含 OpenAPI 生成） | `groups/session.ts`、`groups/event.ts` |
| `packages/cli` | CLI 入口；默认拉起/复用后台服务，再进 TUI | `commands/handlers/default.ts`、`server-process.ts`、`run/run.ts` |
| `packages/tui` | TUI 客户端（SolidJS + `@opentui`），**纯客户端** | `config/keybind.ts`、`routes/session/*` |
| `packages/app` / `desktop` | Web PWA / Electron 壳，共用 `session-ui` 渲染层 | `packages/session-ui/src/*` |
| `packages/plugin` | 插件 API 类型与 Effect host 类型 | `src/effect/plugin.ts`、`src/effect/session.ts` |
| `packages/codemode` | 受限 JS 解释器 + 工具目录 + 预算 | `src/codemode.ts`、`src/tool-runtime.ts` |

### 0.3 相对 PRD v2 的增量 Δ

> 只列会影响我们 R1/R2 决策的差异；依据全部在 §2/§3 展开。

| # | PRD v2 / v1 的认知 | v2.2.5 源码事实 | 对我们的影响 |
|---|---|---|---|
| Δ1 | OpenCode = TS + server-first + OpenAPI/SSE（v1 §2.5） | 仍 server-first，但底层换成 **Effect 4 + Bun + Drizzle SQLite + OpenTUI**；TUI 不是 Go，也不是 Web 前端，而是 SolidJS 终端渲染器 | 抄机制不抄栈；不要因「它用了 Effect」就引入 Effect |
| Δ2 | per-agent `permission` 键值：read/edit/bash/.../doom_loop，`ask/allow/deny` | 统一为 **`Permission.Ruleset`：`{action,resource,effect}` 有序数组，last-match-wins，deny 先全量预检**；legacy `permission` 配置在 normalize 层迁移成 ruleset；`doom_loop` **只剩 v1 配置兼容键，v2 运行时未见循环判定** | 我们的 `gate.ts` 应从「工具名模式」升级为「工具+资源」；不要把 `doom_loop` 当 OpenCode 现有能力引用（需复核文档） |
| Δ3 | message/part 两表；sessions 文件态 + export/import（v1 §2.5） | **`session` / `session_message` / `session_part` / `session_inbox` 四表**；`SessionPartTable` 按 `{message_id, ordinal}` 存 assistant 的 text/reasoning/tool；**Bus 的 durable 事件默认不落事件表（`persist=false`）**，durable 只表示「同事务排序 + 投影 + commit hook」 | 不要照搬 event sourcing；我们的 `events.jsonl` 就是日志，关键是「写日志与投影同序」 |
| Δ4 | 工具 = 一堆 JSON Schema 工具，Code Mode 未提及 | 工具注册表按权限快照；**默认把非 `codemode:false` 的工具收进单个 `execute` 工具**，目录以 2000 字符预算写进指令；MCP 工具也可进 Code Mode | 我们 pi 工具面固定，Code Mode 不适用；但「目录预算 + 增量目录」可给 R3 MCP 网关 |
| Δ5 | task agent 一次性子代理 | 子代理 = **child session**（有独立 sessionID、完整历史、可被父再次 follow-up、可后台跑、深度默认 1） | 与我们的 `ar_dispatch` 节点模型不同，但「子会话 ID 可继续」值得吸收到 `ar reply` |
| Δ6 | resume 靠 pi session 持久化 | 除 session 外还有 **执行 claim + 重启续跑 + 每 turn 最多 10 次 resume** 的崩溃语义；stale tool call / stale compaction 在启动时补终态 | 我们只有 `worker.json` 租约，缺 attempts 与终态补齐（A9/A10） |
| Δ7 | TUI 信息层级未记录 | 有 **activity/reasoning/exploration/instructions 分组 + low/medium/high verbosity**，running 行有稳定 busy label，被权限挡住的工具固定在组外 | 我们的 `apiView.steps` 只取尾 12 条平铺，可直接吸收（A7） |
| Δ8 | 文档与源码一致 | **官方 docs 滞后**：仍写 `permission` 键值、函数式 plugin hooks、`opencode serve` 固定 4096 等 v1 形态 | 引用 OpenCode 时以源码为准；文档只能当用户体感参考 |

---

## 1 定位与用户体感

- **产品定位**：开源 AI coding agent，卖点是「多客户端 + 多 provider + 可插拔」；README 首页仍是 TUI 截图（`README.md`）。面向 terminal 的 TUI 是主入口，但同一 server 还接 Web/Desktop/IDE/ACP（`packages/cli/src/commands/commands.ts:12-100` 的命令面）。
- **一次典型交互**：`opencode` → 若没有匹配版本的后台服务则自动拉起 → TUI 连接 → 选 session / 发 prompt（默认 steer）→ 流式文本/推理/工具 → 工具审批卡（once/always/reject）→ 完成的 turn 落 SQLite → 可 compact / revert / export。`opencode run` 是一次性非交互；`opencode serve` 是 headless server。
- **用户体感上的三个关键设计**：
  1. **会话是服务端对象，不是终端窗口**：TUI 关闭/重连/换客户端，session 继续；`ctrl+b` 甚至能把当前阻塞的工具挪到后台继续跑（`keybind.ts:129`，`session.background`）。
  2. **权限提示是「可记忆的」**：`always` 把命中的资源写进项目级 saved permissions，后续同 action/resource 不再问；拒绝可附反馈给模型（`permission.ts:306-366`）。
  3. **长会话有明确的「压缩/回滚」动作**：`<leader>c` compact、`<leader>u/r` undo/redo message、`<leader>x` export（`keybind.ts:128-175`）。
- **与 Claude Code / Codex 的体感差异**：Claude Code/Codex 是「一个 CLI 进程拥有一个会话」；OpenCode 是「一个后台 server 拥有多个项目/会话，任意客户端接入」。这带来多端与重连优势，也带来服务生命周期/版本握手/鉴权成本（§2.1）。
- **同构点**：三者都把「模型调用 → 工具执行 → 结果回填 → 再请求」做成受控循环；都用 `AGENTS.md`/`CLAUDE.md` 类指令文件；都支持子代理、MCP、审批、压缩；都把会话历史持久化到本地。**差异不在「有没有」，而在「状态归谁、审批怎么表达、历史怎么重放」。**

| 维度 | OpenCode v2.2.5 | Claude Code | Codex |
|---|---|---|---|
| 进程模型 | 单例后台 server + TUI/Web/Desktop/ACP 多客户端；session 归 server | 单 CLI 进程拥有 session；TUI/-p/SDK/IDE/Desktop 多形态 | Rust CLI；TUI + `exec --json`；session 归进程/rollout |
| 审批 | `action/resource/effect` 有序规则集；deny 先行；saved per project；reject 可带反馈 | `allow/ask/deny` 规则 + 六档 permission modes（default/acceptEdits/plan/auto/dontAsk/bypass） | `sandbox_mode` × `approval_policy` + `execpolicy` 规则 |
| 会话存储 | SQLite：message/part/inbox 行 + durable 事件投影；默认不保留事件表 | transcript JSONL 异步落盘 | rollout JSONL（`~/.codex/sessions/`） |
| 子代理 | child session，可 resume/follow-up，深度默认 1，可后台 | Task 工具 + `.claude/agents/*.md` + agent teams | `agents.*` + `spawn_agent/send_input/wait` |
| 上下文 | 指令前缀缓存 + 摘要模板 + 后台预压缩 + git-tree 快照 | CLAUDE.md/rules + auto-compact + skills 渐进披露 | AGENTS.md + compact + `--output-schema` |
| 工具面 | 原生工具 + Code Mode 单 `execute`（目录预算） | 原生全家桶 + hooks + MCP | exec/apply_patch/web/MCP + sandbox |
| 扩展 | 进程内 Effect plugin（tool/session/permission/shell 域） | hooks（约 32 事件，外部进程） + skills + plugins | hooks（Claude 兼容） + MCP |
| UI | TUI（OpenTUI）+ Web/Desktop；分组/verbosity/subagent picker | CLI TUI + IDE/Desktop | TUI + exec 事件流 |

> Claude Code/Codex 两列取自 PRD v2 §1.1/1.2 的一手调研（`docs/prd-workbench-v2.md:17-35`），本轮未重复核验；OpenCode 列全部来自本次源码。
- **Δ 相对 v2**：PRD v2 已把 OpenCode 排除在六家画像外（v2 引言「v1 的 Pi/OpenCode/DSH 本轮不再重复画像」），所以本文不是补画像，而是补 **v1 之后 v2 重写产生的可吸收增量**。

---

## 2 架构

### 2.1 进程模型：单例后台服务 + 多客户端

- **默认路径**：CLI 的 default handler 先 `ServerConnection.resolve({ mismatch: "replace", ... })`，没有可用服务就 spawn 一个 detached 的后台服务，再把 `server.endpoint` 交给 `@opencode/tui` 的 `run()`（`packages/cli/src/commands/handlers/default.ts:30-70`，`:100-125`）。TUI 本身只拿 endpoint 和 service 的 `reconnect/restart` 回调。
- **服务模式**：`ServerProcess.run({mode})` 支持 `default | service | stdio`（`packages/cli/src/server-process.ts:24-31`）；service 模式读 `ServiceConfig` 的 hostname/port/cors/env，密码来自配置或随机 32 字节，服务启动后通过 `ServiceRegistration.register` 写注册文件（`server-process.ts:74-180`）。默认 hostname `127.0.0.1`（`server-process.ts:72`）。
- **单例竞争**：客户端用 `spawnServiceContender` 以 detached 子进程 + stderr 尾部缓冲 + `contenderPool`（最多两个候选、失败退避、版本/锁竞争由服务注册解决）确保同一时刻只有一个服务（`packages/client/src/service-contender.ts:1-140`）。**这是「后台服务」而不是「每项目一个进程」**；一个 server 用 Location 区分多个目录。
- **Location 模型**：`Location` = `{directory, workspaceID}`，每个 Location 有独立 service graph；`LocationLifecycle` 在关闭时统一关 permission/form/rpc 并发布 shutdown 事件（`packages/core/src/location.ts:6-37`，`location-lifecycle.ts:37-76`）。空闲 Location 默认 60 分钟卸载（`packages/schema/src/config/experimental.ts:46-50`）。
- **鉴权**：可选 password（HTTP Basic，用户名默认 `opencode`），登录后发 HMAC 签名的 30 天会话 token，cookie 名带端口避免同 host 不同端口串号（`packages/server/src/auth.ts:16-61`）。**没有 password 时服务对本机完全开放**——这是本地单机产品有意为之，不是漏洞修复对象。
- **事件出口**：`GET /api/event` 是 SSE（`packages/protocol/src/groups/event.ts:60-88`），支持 `types` 过滤，连接先收 `server.connected`；**契约写明 volatile：慢消费者溢出会直接 fail 掉 stream，断线期间事件不补**（同文件 72-80）。服务端每订阅者 4096 条队列，溢出即 fail（`packages/server/src/event-feed.ts:27-31`，`:56-90`）；客户端多个订阅者共享一条 SSE，`server.connected` 会重放给新订阅者用于 resync（`packages/client/src/shared-events.ts:33,52,113-115`）。

**→ 我们怎么改**：`workbench/server.ts:309-333` 现在是「文件 watch → 广播 `{type:"change",files}`」，没有 event type、没有 per-client 上限、没有 resync 标记。可直接吸收三件小事：① SSE 首帧固定 `server.connected`（现在是自定义 `hello`，语义等价，但应文档化）；② 每个客户端队列设上限，溢出主动断开并让前端重拉 `apiView`（而不是静默丢）；③ 事件带 `seq`/`kind` 后前端按类型过滤（`gate`/`todo`/`agent_delta`），减少全量重拉。**不抄后台服务/单例选举**：我们的 shell 已托管 `server.ts`，多一层进程生命周期只增加 Windows 上的杀进程/端口占用风险。

### 2.2 事件与存储：durable 事件 + SQLite 投影（但不是默认 event sourcing）

- **事件总线**：`Bus` 给每个 aggregate（session）维护 `seq`；durable 事件在 `db.transaction` 内依次执行：取最新 seq → 编码 → 跑该事件类型的 projector → 跑调用方 `commit(seq)`（如 claim/release）→ 更新 `event_sequence` → 可选写 `event` 表 → 提交后通知订阅者（`packages/core/src/bus.ts:290-448`）。`publishAll` 只允许同 aggregate，整批一个事务（`bus.ts:549-647`）。
- **durable 的含义**：不是「一定持久化」，而是「进有序日志 + 事务投影 + 可挂 commit hook」。**本地 server 默认 `persist=false`**（`bus.ts:188-214`），只有 workerd 部署才 `persist:true`（`packages/server/src/workerd.ts:71`）。所以本地恢复靠的是 SQLite 投影 + 执行 claim，不是 replay 事件表；`event` 表只在需要历史 replay 的部署里存在。**这点与 T3 的 event sourcing、Codex 的 rollout JSONL 都不同，别混。**
- **投影即状态**：`Projector` 用 `Match` 对每个 durable 事件做穷举更新，assistant 消息的 streaming 事件（text/reasoning/tool 的 started/delta/ended）落在 `SessionMessageUpdater` 里，按 `findLast` 找到当前 text/reasoning/tool，用 immer `produce` 更新同一条 assistant（`packages/core/src/session/message-updater.ts:33-60`，`:161-260`）。**part 行只在内容变化时 update**（`projector.ts:270-308`），不是每条 delta 都 insert。
- **SQLite 表**：`session`（含 `time_suspended` = 执行 claim、`resume_attempts`）、`session_message`（`seq` 唯一）、`session_part`（`{message_id, ordinal}`，`call_id`）、`session_inbox`（未消费的 steer/queue/control）、`instruction_entry/blob/state`、`blob/blob_ref`（`packages/core/src/session/sql.ts:28-199`）。DB 文件默认在全局 data 目录，`OPENCODE_DB` 可覆盖，channel 不同库名不同（`packages/cli/src/database-path.ts:4-12`）。
- **消息/part 读取**：`SessionHistory.withParts` 批量按 message 取 part 行，按 ordinal 合并回 `assistant.content`；没有 part 行的老消息保留内联 content（`packages/core/src/session/history.ts:88-118`）。所以 v2 的「part」不是独立消息类型，而是 assistant 内容数组的持久化切片（`packages/schema/src/session-message.ts:220-246`）。

**→ 我们怎么改**：我们的 `events.jsonl` 已经是 append-only 日志，但**没有 seq、没有「写日志与写投影同序」的约束**（`runs.ts:97-100` 只 append；`server.ts` 读时再投影）。最低成本吸收：① 每条 event 加 `seq`（run 内单调）与 `session`/`node` 聚合键，让 `pendingNodes`/`apiView` 能判断「日志完整性」；② 把「先 append 再写 result」改成「写 result 与终态 event 在一个临界段内完成」（daemon 已有幂等 `writeResult`，可加 `seq` 校验）；③ **不要**引入 SQLite/事件表——单机文件态下，`events.jsonl` + 幂等写已经足够，且可以直接被外部 tail。

### 2.3 会话主循环：inbox 边界 + 单 fiber 门铃 + 每步一次 LLM 调用

- **入口是 admission，不是模型**：`Session.prompt` 只做三件事：准备（附件/技能/materialize）→ `inbox.admit` 发布 `session.inbox.enqueued` → `execution.wake(sessionID)`（`packages/core/src/session/session.ts:155-191`）。默认 `delivery:"steer"`，可选 `"queue"`；控制项还有 `compaction` / `move`（同文件 259-277）。**写消息与跑模型彻底解耦**。
- **一条执行 = 一个 fiber**：`SessionRunCoordinator` 给每个 session 一个 busy period，`wake` 是门铃：正在跑就置 `pendingWake`，drain 结束前再 drain 一次；空闲才启动新 fiber（`run-coordinator.ts:27-54`，`:69-140`）。同一 session 串行、不同 session 并发（`AGENTS.md:205`）。`interrupt` 只对当前 fiber 发中断，等待清理由 `awaitIdle` 负责（同文件 142-171）。
- **drain 的边界**：每个 step 边界 `SessionInbox.promote` 按优先级消费：steer 优先；只有 `scope="input"`（空闲/进入新 turn）才允许再取一条 queue；`compaction`/`move` 是控制项，顺序特殊（`packages/core/src/session/inbox.ts:53-57`，`:470-486`，`:567-586`）。消费时在同一事务里删 inbox 行并写可见消息（`AGENTS.md:200`）。
- **一个 step = 一次 `llm.stream`**：`SessionRunnerLLM.drain` 循环：`advanceToStep` 处理 move/compaction/空闲 hook → `runStep` 组请求 → `step.attempt` 发起流式请求 → 工具调用按到达顺序 fork → 等全部工具 settle → 决定 Completed/Retry/Continue/OutputLimit/Compacted（`packages/core/src/session/runner/llm.ts:64-221`，`:233-380`）。**不变量：绝不在内存里做「工具结果→再请求」的私有循环**，每步都从重载的历史重新组请求（`AGENTS.md:204`）。
- **步数预算**：`agent.steps` 是每 turn 上限；到限后不硬杀，而是把 `MAX_STEPS_PROMPT` 作为 assistant 消息追加、`toolChoice:"none"` 再请求一次，让模型总结收口（`runner/llm.ts:252-272`，`runner/max-steps.ts:1-20`）。**保留工具定义以复用 provider 缓存前缀**（同文件 270-271）。
- **输出截断续写**：`finish=length` 时最多自动续两次，第三次报 `output-limit`；续写前注入「不要道歉/重述」的 synthetic 消息（`runner/llm.ts:339-369`）。
- **崩溃后的收尾**：drain 开头 `settleStaleCompactions` 把遗留 `running` 的 compaction 标 failed；`settleStaleToolCalls` 把遗留 `streaming/running` 的 tool 标 aborted（`runner/llm.ts:382-435`）。**这是「进程死了，状态不能假装还在跑」的硬规则。**

**→ 我们怎么改**：我们的 daemon 是「每节点 spawn 一次 pi，worker 自己跑完」，没有 turn 级循环；但**G11（不能 steer 运行中 worker）可以按这个语义诚实降级**：running 节点收到自由文本时，不再假装写 `spec.reply` 就能中途注入（`workbench/server.ts:229-256` 现在正是这个假象），而是提供两个明确动作——「排队到本轮结束后的下一次拉起」与「abort 当前进程 → 带反馈重新拉起」。前者只是把 reply 写进 spec 并标记 `queued`，后者复用现有 `abort`（`server.ts:294-306`）。真 steer 需要 pi RPC，留 R2。

---

## 3 核心机制

### 3.1 进程模型与 TUI/服务端分离（问题①）

**结论**：OpenCode 的「TUI/服务端分离」不是 web 前端 + API 的那种分离，而是**同一个产品的本地后台服务化**：server 拥有 session/工具/权限/PTY/后台 job，TUI 只是渲染 + 输入；连 TUI 的崩溃都不影响 session。

- 客户端种类：TUI（`@opentui/solid`）、Web PWA（`packages/app`）、Electron（`packages/desktop`）、ACP（CLI `acp`）、`run` 一次性、SDK/HTTP。它们都通过同一套 protocol（`packages/protocol/src/groups/*`）访问 server。
- 传输：HTTP + SSE（不用 WebSocket 做事件主通道；WebSocket 只在 provider 原生 WebSocket 模式下按 session 复用，`plugin/src/effect/session.ts:94-130`）。请求/响应是普通 JSON（Effect HttpApi），事件是 SSE 单向流。
- **SSE 的诚实语义**：volatile、可丢、慢消费者会被断开（`protocol/groups/event.ts:72-80`）；客户端必须用「重连 + 重新拉 session/消息」恢复，而不是假设 stream 是可靠日志。**可靠状态的来源是 HTTP GET，不是 SSE。**
- **多 Location**：一个 server 进程服务多个项目目录；每个 Location 有独立 service 图（含 permission 服务）、活动会话与 SQLite 项目数据。这解决了「开多个项目要开多个 server」的问题，也意味着「按目录隔离」是 server 内建能力。
- **服务生命周期**：版本不匹配会重启后台服务（`default.ts:30-50` 的 `mismatch:"replace"`）；`opencode run` 不会留下新服务（`commands/handlers/run.ts:8-12` 注释）。**这是「CLI 生命周期」与「服务生命周期」解耦的代价：必须有服务注册、版本握手、密码/会话、PTY handoff。**
- **PTY handoff**：服务重启时，持久终端可通过 `OPENCODE_PTY_HANDOFF` 继承并恢复（`server-process.ts:90-110`）。普通 `shell` 工具不是持久终端（见 §3.4）。

**→ 我们怎么改**：我们的 `workbench/server.ts` 是零依赖 node:http，没有「服务」抽象；`shell` 负责拉起 server 与 WebView。**不要引入单例服务**。可吸收的只是「可靠状态用 HTTP 拉、SSE 只做失效通知」这一条：现在前端收到 `change` 后也是重拉 `apiView`（`public/v1/index.html` 的 SSE handler），方向已经对；要做的是**把 SSE 的 `change.files` 收敛成 `{kind, node, seq}`**，让前端只重拉相关节点而不是整 run。

### 3.2 会话主循环与消息/part 存储模型（问题②）

**结论**：v2 的存储单元是「带 seq 的 message 行 + 有序 part 行 + 未消费的 inbox 行」；assistant 的 text/reasoning/tool 是同一 message 的内容数组，不是独立消息。

- **消息类型**（`schema/session-message.ts`）：`user | synthetic | system | skill | shell | assistant | compaction | idle | agent-switched | model-switched | location-switched`；assistant 内含 `content: AssistantContent[]`（text/reasoning/tool），每个 tool 有 `state: streaming|running|completed|error` 与 `time.created/ran/completed`（`:220-246`，`:165-206`）。
- **part 行**：`session_part` 按 `{message_id, ordinal}` 存，`type` 是 `text|reasoning|tool`，tool 额外存 `call_id`（`sql.ts:107-128`）。读取时 `withParts` 批量合并（`history.ts:88-118`）；写入时只对变化的 part 做 update/insert，尾部多余的 part 删除（`projector.ts:270-308`）。**这解决了「流式内容反复重写整条消息」的写放大。**
- **inbox**：只存未消费项，`delivery` 是 `steer|queue`，`enqueued_seq` 排序；消费后在同一事务里删行并写可见消息（`sql.ts:130-152`，`AGENTS.md:200-201`）。**inbox 是「待办」而不是「历史」**。
- **idle 标记**：`session.execution.succeeded/failed/interrupted` 投影成 `Idle` 消息；shutdown 中断不写 Idle（继续同一 turn），用户中断写 `interrupted`（`message-updater.ts:143-160`）。**这让「turn 的边界」在数据里可读，而不只存在于进程内存。**
- **usage**：assistant message 带 `tokens`（input/output/cache read/write/reasoning）与 `cost`（`schema/session-message.ts:236-238`），另有 `session.usage.recorded/updated` 事件（`session-event.ts:161-180`）。**成本是消息级事实，不是 UI 估算。**

**→ 我们怎么改**：我们的 `events.jsonl` 是「事件流水」，没有 message 实体；`view.ts` 的 `buildSteps` 已按 `call_id` 把 start/end 合并成 step（`workbench/view.ts:359-460`），但仍是 step 粒度、没有 message 聚合。可以做一个**轻量消息投影**：在 `transcribe.ts` 里按 `message_start/message_end` 维护 `assistant` 聚合（content 数组 + tool state），把 `tool_execution_start/end` 挂到同一 call_id 下；输出仍落 `events.jsonl`，但增加 `msg_id`/`part_ordinal` 字段，让 `view.ts` 能按「消息」而不是「事件」渲染。**不需要改存储介质。**

### 3.3 上下文管理（问题③）

OpenCode 的上下文管理有四个互相独立的层，**不要混成一个「压缩」概念**：

1. **指令前缀（cache 优先）**：`SessionContext.select` 把指令源按「最共享 → 最局部」排序：Code Mode 目录 → MCP instructions → references → skills → 发现的项目指令（AGENTS.md）→ builtins（日期/环境）→ 会话内 instruction entries（`packages/core/src/session/context.ts:149-163`）。注释明确目的：**baseline 是可复用的 prompt-cache 前缀**（同文件 151-155）。日期/环境这类每天/每目录变化的内容放 builtins 段（`instructions/builtins.ts:24-56`）。
2. **指令增量（不重写前缀）**：每个指令源有稳定 `key`，`Instructions.diff` 比较 hash 只产出变化的 key/blob；变更以 `session.instructions.updated` 事件投影成 `system` 消息（`instructions/index.ts:88-160`，`message-updater.ts:151-160`）。Plan mode 的 reminder 也是「插在用户消息前、尽量靠尾」而不是改 system prompt（`plugin/plan.ts:55-66` 注释：*appending near the tail so the cached prefix stays warm*）。
3. **AGENTS.md 发现**：全局 `~/.config/opencode/AGENTS.md` + 从 cwd 到项目根的逐级 `AGENTS.md`；`config.instructions` 还支持 glob/URL；文件被 watcher 监听，变了就重读并产生增量（`config/plugin/instruction.ts:41-62`，`:84-118`）。首次建立 baseline 时，如果某个源暂时不可用，`Instructions.diff` 返回 `InitializationBlocked` 而不是带残缺 baseline 起跑（`instructions/index.ts:143-145`，`session/instruction-state.ts:205-210`）。
4. **压缩（compaction）**：
   - 触发：每次 step 前估算 prompt，超过 ceiling 才压；ceiling = 窗口 − `max(15%, 16k)`（窗口小于 32k 时退回 15%）（`session/compaction.ts:128-139`，`:1135-1142`）。
   - 保留：最近 `keep` tokens 逐字保留在摘要旁边（默认 `keep: 15_000`）；摘要只覆盖更早的消息，`metadata.keepID` 标记保留起点（`compaction.ts:262`，`:451-464`）。
   - 摘要格式：固定模板 `Objective / Requirements / Decisions / Work State(Completed|Active|Blocked) / Next Move / Relevant Files(≤15) / Important Context`，并强制「保留精确路径/命令/错误串」「不重复已解决的问题」「不要提压缩过程」（`compaction.ts:166-205`）。
   - 后台预压缩：到阈值的 85% 且已测 token ≥64k 时，后台先生成摘要但**不换入**，避免现在换入导致后续每步丢缓存；真到阈值时直接复用（`compaction.ts:153-164`，`:331-345`）。
   - 原生压缩：若模型/provider 支持 native compaction，则用 provider 返回的加密窗口替代摘要（`compaction.ts:304-307`，`:547-580`）。
   - 摘要请求本身也复用原请求前缀，以命中 prompt cache（`compaction.ts:437-445` 注释）。
5. **文件快照**：每个 step 开始/结束抓一个 **独立 git object 目录**下的 tree（不是用户仓的 commit），记录在 assistant `snapshot.start/end/files`；`revert.stage` 可按消息边界恢复文件并给出 file diff（`snapshot.ts:90-148`，`revert.ts:22-55`）。**这使「消息回滚」和「文件回滚」是同一个动作的两个面。**

**→ 我们怎么改**：① 我们的 `userMessage()` 已把 `goal` 放最前、`learned` 放最后（`src/daemon.ts:83-104`），方向对；把 `already_known`/`inputs` 也固定在 goal 之后，避免每轮顺序漂移。② 摘要模板可以直接抄进 `aica-pi/prompts/orchestrator.md` 与节点 `result.summary` 的写作约束（尤其 Relevant Files ≤15、Next Move 有序）。③ 节点重拉时可把上次 `result.summary` 作为「已有 checkpoint」注入，而不是重述全部 events——这就是 OpenCode 的「摘要 + keep 尾部」廉价版。④ 快照留 R2（A13）。

### 3.4 工具层（问题④）

**结论**：工具是「注册表 + 权限快照 + 统一 schema 校验 + 统一截断 + 并行 fiber + 后台 job」；**bash 不是持久 shell**。

- **注册**：插件通过 `ctx.tool.transform(editor => editor.add({...}))` 注册；工具可带 `options.namespace`（名字变成 `ns_tool`）、`options.codemode`（是否收进 Code Mode）、`options.permission`（权限 action 名）。注册时把输入/输出 schema 编成 `ToolDefinition`，非法名字/命名空间会被跳过并记 error（`packages/core/src/tool.ts:184-245`，`:363-413`）。
- **会话快照**：`Tool.snapshot(permissions)` 按权限过滤工具，`whollyDisabled` 只看 `action:* + resource:"*" + deny` 的整体禁用；Code Mode 的目录与 `execute` 定义按 registry revision + 可见工具名缓存（`tool.ts:251-323`）。**工具面是每个 drain 现算的，不是启动时定死。**
- **schema 校验**：执行前 `decodeInput`；失败时最多列 5 条 issue（带 `path`），并回显 args、明确要求「更新参数后重试」（`tool/runtime.ts:64-101`）。输出也按 output schema 编码，非法输出变成 `Tool.Error`（`runtime.ts:111-134`）。**错误信息是模型可执行的，不是 `invalid input`。**
- **截断**：`ToolOutput.truncate` 规则——文本 ≤2000 行且 ≤50KiB 原样；超出则保留**头部**（按行/字节），全文写 `tool-output/tool_<id>`，末尾追加 `[showing lines 1-N of M; full output saved to <path>]`，metadata 标 `truncated:true, outputPath`（`tool-output.ts:20-24`，`:84-124`）。shell 工具另有一套**尾部**截断：保留最后 `max_lines/max_bytes`，提示 `[showing lines X-Y of Z; full output saved to ...]`（`shell.ts:244-259`）。**头 vs 尾是有意的：读文件要开头，命令报错要结尾。**
- **并行**：provider 流里每收到一个 tool-call 就 fork 一个 fiber 执行，不等前面的工具；工具结果按各自完成顺序发布，assistant 内容按 call_id 归并（`session/runner/step.ts:107-131`）。工具调用之间有 `Tool.Called` 发布的先后约束（同文件 107-109 注释）。
- **bash/shell**：
  - 每次调用 **spawn 一个新 shell 进程**（`shell.ts:302-317`），`stdin:"ignore"`，不保留上一次命令的 cwd/env 修改/函数/别名；`workdir` 参数显式指定目录（`tool/plugin/shell.ts:46-59`）。**没有「持久 bash」**；跨命令状态靠「写文件 + 后台 job + 输出文件」。
  - 默认超时 2 分钟，`timeout:0` 禁用；后台命令默认无超时（`shell.ts:22`，`tool/plugin/shell.ts:52-58`）。
  - 输出流式写文件，完成后按上限截尾部；`shell.result` 同时返回 `exit/signal/timeout`（`shell.ts:238-262`）。
  - 后台命令作为 `Job` 持久化，完成后通过 `Session.synthetic` 注入 `<shell id=... state=...>` 通知，并明确告诉模型「不要轮询，结束本轮，完成会自动唤醒你」（`tool/plugin/shell.ts:24-25`，`:144-176`，`:241-254`）。
  - 权限：先把命令解析成 `resource`（如 `git status`）再 `permission.assert`，`save` 也是这些 resource；外目录先走 `external_directory` 审批（`tool/plugin/shell.ts:118-134`）。
  - **持久终端是另一个东西**：`persistent-pty` 是给用户开的终端 tab，支持服务重启 handoff（`core/src/persistent-pty.ts`、`protocol/groups/persistent-pty.ts:18-103`），不是模型 bash 的会话。
- **后台 job**：`Job` 有 `running/completed/error/cancelled`、`recovery`（`shell|subagent|image`）、`blockingSessions`；`block()` 可被 CLI `ctrl+b` 转成 background，完成通知带 `notificationID` 可幂等恢复（`core/src/job.ts:18-128`，`job/recovery.ts`）。

**→ 我们怎么改**：① 把「工具结果截断」做成 `aica-pi/extensions/tools.ts` 的统一 helper：模型输出 ≤2000 行/50KiB，超出落 `artifacts/` 或 `STATE/tool-output/` 并在结果里给路径；**shell 类用尾部截断**。② `transcribe.ts` 的 `RESULT_PREVIEW=300` 只是 UI 预览，不要拿它当模型侧截断——两者要分开。③ `ev_*` 工具的错误信息改成「字段路径 + 当前 args + 请修正后重试」句式。④ 我们已是「每节点一个 pi 进程」，bash 持久性天然没有；不要为了「像 Claude Code 一样保留 cwd」去改 pi，改用 `workdir`/`cd` 显式化（`worker.md` 可加一条规则）。

### 3.5 权限（问题⑤）

**结论**：OpenCode 的权限是**有序规则集求值**，不是「模式档位」；审批只是 `ask` 的副作用，且审批结果可持久化、可带反馈、可批量拒绝。

- **规则结构**：`{action: string, resource: string, effect: allow|deny|ask}`；`Ruleset` 是数组（`schema/permission.ts:44-56`）。`action` 通常是工具名（`shell`/`edit`/`read`/`subagent`/`skill`）或路径动作（`external_directory`），`resource` 是该工具的资源（shell 命令、文件路径、子代理 ID、skill ID）。**legacy `permission` 配置**（工具→`ask/allow/deny` 或 `{pattern: effect}`）在 normalize 层迁移成 ruleset（`core/src/config/normalize.ts:586-625`）。
- **求值**：`evaluate(action, resource, ...rulesets)` 取**最后一条匹配**的规则，无匹配默认 `ask`（`permission.ts:94-104`）；`merge` 只是数组拼接（`:106-108`）。`evaluateInput` 先对**所有 resource** 做 deny 预检——任一命中 deny 立即 deny，不再看 ask/allow（`:176-189`）；然后合并 saved 规则；若任一 resource 是 ask → ask，否则 allow。**这解决了「同一次调用跨多个路径，其中一个被禁」的漏网。**
- **规则来源**：agent 的 `permissions` + session 的 `permissions` 合并（`:169-174`）；项目级 saved permissions 追加在后面（`:159-167`）。默认 agent 是 `* allow` + `.env` 类 read ask（`schema/agent.ts:40-64`）；Explore 用「先 `* deny` 再逐条 allow」实现只读面，Plan 则只 deny `edit`、仅允许 plan 目录（`plugin/agent.ts:74-94`，`plugin/plan.ts:33-42`）。
- **审批**：`ask` 生成 `Permission.Request{sessionID, action, resources, save, metadata, source, message}` 发布 `permission.asked`，然后 `Deferred.await`；`reply` 支持 `once|always|reject`；`always` 只把 `request.save` 里的 resource 写 saved 表，并**重新评估当前 session 其他 pending 请求**，能 allow 的自动放行（`permission.ts:248-255`，`:337-363`）。`reject` 带 `message` 时变成 `CorrectedError`（模型可继续），不带则 `DeclinedError`（调用被隧道成 defect，不算工具失败，见 `:272-278` 注释）。
- **批量拒绝**：一个 reject 会拒绝同 session 所有 pending（`:320-336`），反馈应用到整批——针对模型并行发多个审批的情况。
- **无人值守**：`Permission.Unattended` 是一组只在「本来要 ask」时生效的规则；没人可答时，不能 allow 就 deny 并给明确 message（`:59-65`，`:199-208`）。**这比「超时自动 allow」安全。**
- **插件可改写决策**：`hooks.trigger("permission","evaluate", ...)` 可以改 `effect`（`:190-201`），例如组织策略强制 deny。
- **外目录**：`FileAccess` 先解析路径是否在 Location 内；外部路径先发 `external_directory` 审批（可 save 目录级 resource），再走 read/edit 自己的审批（`core/src/file-access.ts:120-156`）。**目录授权与文件授权是两层。**
- **保存的授权可管理**：`PermissionSaved` 按 project 存 `{action, resource}`，支持 list/add/update/remove，唯一索引防重复（`permission/saved.ts:59-115`）。UI 可列出、编辑、删除。
- **auto 模式**：`--auto` 只在 TUI 客户端生效——它监听 pending 审批并自动 `reply("once")`（`tui/src/routes/session/index.tsx:268-285`，`tui/src/context/permission.tsx:13-15`）；**server 不强制执行**。官方文档说的「auto 不绕过 deny」在客户端层面成立（deny 根本不会产生 pending），但这不是 server 策略。**需复核**：未来是否有 server 侧 auto 策略。
- **文档滞后**：`opencode.ai/docs/permissions` 仍写 `permission: {bash: {..., "rm *": "deny"}}` 的对象形态和 `doom_loop`；源码里 legacy 形态仍能迁移，但 `doom_loop` 没有运行时判定（全仓 `rg doom_loop` 只命中 v1 config 兼容与 docs）。

**→ 我们怎么改（这是本轮最值得抄的一块）**：
1. `aica-pi/extensions/gate.ts:263-287` 现在的顺序是 `deny → rules → grants → approve`，且匹配只到「工具名/前缀」。升级为 `perm: Rule[]`（`{action,resource,effect}`）：
   - `action = toolName`；`resource` 由工具类型解析：shell 取命令首段/完整命令串，edit/read 取归一化路径，dispatch 取子代理名；
   - **先对 args 里所有 resource 做 deny 预检**（等价 `permission.ts:176-189`），再 `ask`，最后 `allow`；
   - `spec.deny_paths` 保留为「无条件 deny 规则」的语法糖。
2. 把 `grants.json` 从 `{tools:[...]}` 升级为 `{rules:[{action,resource,created}]}`；`allow_session` 只写本次命中的 resource（不是整个工具），并在 UI 可删除。
3. `gate-ans.json` 的决策扩为 `once|always|reject`；`reject` 带 `feedback` 时以 `{block:true, reason: feedback}` 返回（现在已支持，`gate.ts:229`），并在同 session 有多个 pending 时批量拒绝（pi 目前串行工具调用，先留字段，R2 生效）。
4. 外目录：在 `gate.ts:103-136` 已有 `argStrings/extractTargets` 的基础上，先判「是否在 `spec.cwd` 内」，外部路径产生 `external_directory` 审批并 `save` 目录；这比 `deny_paths` 的字符串包含匹配更准确（现在 `hitDenyPath` 对 `..` 和短路径有误报风险）。
5. `policy.json` 封顶档位（PRD G30）保留，但语义改为「追加 deny 规则」而不是「压低 enum」，与 OpenCode 的「deny 先行」一致。

### 3.6 子代理与多代理（问题⑥）

**结论**：子代理是 **child session**，不是一次性工具调用；父可继续它、可后台跑、可限深；但默认深度只有 1，且子会话默认全新上下文。

- **创建**：`subagent` 工具接受 `agent`（必须是 `mode !== primary`）、`description`、`prompt`、可选 `model`/`sessionID`/`background`（`tool/plugin/subagent.ts:17-63`）。它先沿 `parentID` 链算深度，`depth >= experimental.subagent_depth`（默认 1）就拒绝（`:119-139`）；再校验 agent 存在、非 primary、`permission.assert("subagent", agent.id)`（`:140-151`）；然后 `sessions.create({parentID, title, agent, model})` 建 child，`prompt` 注入「You are a subagent spawned by another session.」（`:184-218`）。
- **继续**：传已有 `sessionID` 时，必须是当前 session 的 child；可切换 agent/model，然后继续 prompt（`:153-182`）。**返回结果里始终带 `sessionID`**，失败也带，父可接着救（`:245-255`）。
- **后台**：`background:true` 时把 child 当 Job 跑，立即返回 `{status:"running", sessionID}`，并明确要求父「不要 sleep/poll/重复它的工作；做不重叠的事或结束本轮」（`:19-28`，`:229-243`）。完成时 `SubagentCompletion` 注入通知，唤醒父 session。
- **模型**：`model` 可覆盖，优先级 `explicit > agent.model > parent.model`（`:184`）；模型必须是 chat model，image/decision 模型会被明确拒绝（`:86-103`）。
- **权限**：子代理的工具面由它自己的 agent permissions 决定（创建时 agent 的 ruleset），父的 `subagent` 权限只决定「能不能派这个 agent」。
- **UI**：TUI 有 subagent picker（`down` 打开、`left/right` 切换 child、`up` 回父，`keybind.ts:138-141`）；child 是完整会话，可单独看 transcript/审批。
- **多代理并行**：不是「agent team」抽象，而是父在一个 step 里并行发多个 `subagent` 工具调用（工具 fiber 并行，§3.4），或多个 child 各自后台跑；没有 DAG/join 原语，父要靠「通知唤醒」或轮询（工具描述明确禁止轮询，但语言上仍可做）。**与 Misaka 的 DAG、Cindy Orca 的 Lead/Worker 全会话制都不同。**

**→ 我们怎么改**：我们的 `ar_dispatch` + `ev_wait` 已经比它强（有依赖、join、depth_left）。可吸收两点：① `ar reply` 支持「回复一个已完成的子节点并让它继续」（现在 reply 只作用于当前节点），等价于 child session 的 `sessionID` 续聊；② 子节点 `result` 里显式带 `node_id` 与 `session` 路径，父可据此继续（我们 result 已有 `id`，但 UI 没有「继续子节点」动作）。**不要抄默认深度 1**——我们的 `depth_left` 是显式预算，更可控。

### 3.7 状态与恢复（问题⑦）

**结论**：恢复不是「session 文件还在就行」，而是 **claim（写前意图）+ 续跑预算 + 终态补齐 + job recovery** 四件套。

- **claim**：turn 开始时 `SessionStore.claim` 在 `session` 行写 `time_suspended`，与 `session.execution.started` 事件**同事务提交**（`execution.ts:73-83`，`:109-115`；`store.ts:218-237`）。terminal（succeeded/failed/user interrupt）释放 claim；**shutdown 中断故意保留 claim**，让下次启动知道「这个 turn 没跑完」（`execution.ts:117-143`）。
- **启动恢复**：`SessionRestart.resumeSuspendedSessions` 扫所有 `time_suspended` 非空且无 parent 的 session；每恢复一次 `resume_attempts += 1`（durable，先写后跑）；超过 `maxAttempts`（默认 10）就发布 `session.execution.failed{aborted, "interrupted repeatedly"}` 并释放 claim（`execution/restart.ts:16-100`）。**这防止「一启动就崩」的死循环。**
- **续跑提示**：恢复时注入 `CONTINUE_AFTER_SERVER_RESTART`（「服务器重启了，从你停下的地方继续，不要重复已完成工作」）的 synthetic 消息（`restart.ts:16-17`，`:93-99`）。
- **stale 状态补齐**：遗留 running 的 compaction 标 failed（`llm.ts:382-410`）；遗留 streaming/running 的 tool 标 aborted，并带上 subagent 的 child sessionID（`llm.ts:412-435`）。
- **job recovery**：后台 shell/subagent/image 是 durable `Job`，带 `recovery` 描述；重启后把未完成的 job 恢复成通知，`notificationID` 保证幂等（`job.ts:18-128`，`job/recovery.ts`，`restart.ts:102-180`）。
- **持久化格式**：SQLite 单文件；消息/part 是行；事件表可选；session 导出是 `{info, messages}` 的 JSON（`schema/session-transfer.ts:1-12`），支持 `sanitize` 把敏感字段替换成 `[redacted:<kind>:<id>]`（`session/transfer.ts:208-275`）。
- **share 已移除**：TUI keybind 明确标 `Deprecated: session sharing was removed`（`keybind.ts:126-127`）；保留的是 export/import（`protocol/groups/session.ts:187-218`，`session/transfer.ts:35-65`）。
- **fork/revert**：fork 按消息边界 `before|through` 复制前缀并保留 part（`schema/session-fork.ts`，`projector.ts:193`）；revert 按消息边界恢复 git-tree 快照并给出 file diff，下次 prompt 前 commit（`revert.ts:22-80`，`session.ts:350-358`）。

**→ 我们怎么改**：`src/runs.ts:124-180` 已有 `worker.json` 租约 + pid 判活 + 崩溃重拉，但缺三样：① `attempts` 计数（spawn 前 +1，terminal 清零；≥10 标 `failed("resume exhausted")`）；② daemon 启动时把「pid 死但 result 缺失」的节点补终态（现在 `pendingNodes` 会直接重拉，可能掩盖真实崩溃）；③ `events.jsonl` 里未闭合的 `tool_call` 在重拉前补一条 `is_error:"aborted"`。这三样不需要新依赖，直接改 `runs.ts`/`daemon.ts` 即可（A9/A10）。**不要抄 claim 的 DB 事务**——我们的 `worker.json` 就是 claim，但要把「写 claim 与 spawn」做成先写后 spawn，而不是现在的 spawn 后写（`daemon.ts:299-302`，顺序可调）。

### 3.8 UI/TUI 信息层级与快捷键（问题⑧，细节见 §4）

- TUI 是纯客户端；session 状态来自 server 的 SSE + HTTP，TUI 本地只存 tabs/stash 等客户端偏好（`packages/tui/src/routes/session/index.tsx` 顶部 context 结构）。
- 信息层级：左侧 sidebar（标题 + 插件 slots + footer）、中间 transcript（分组行）、底部 composer（prompt + subagents/shell/terminals tabs）、会话 tab rail；右侧 pane 可聚焦（`keybind.ts:96-101`）。
- 快捷键面很宽：`leader` 默认 `ctrl+x`（`keybind.ts:41`），`<leader>l` session list、`<leader>n` new、`<leader>b` sidebar、`<leader>t` terminal、`<leader>c` compact、`<leader>g` timeline、`<leader>q` queued prompts、`<leader>u/r` undo/redo、`<leader>x` export、`ctrl+p` command palette、`escape` interrupt、`down` subagent picker、`shift+tab` agent cycle（`keybind.ts:48-260`）。
- 权限卡：一次/始终/拒绝；子会话的拒绝会进入「带反馈」阶段（`routes/session/permission.tsx:231-256`），父会话直接拒绝。
- **→ 我们**：抄「leader + 上下文分组 + footer hints」，不抄具体键位；我们的 UI 是鼠标优先的 WebView，键位只做高频（发送、abort、重试、切换节点）。

### 3.9 扩展点（问题⑨）

| 扩展点 | 形态 | 关键证据 | 我们对应物 |
|---|---|---|---|
| Plugin | 进程内 Effect 模块，`ctx` 暴露 `tool/command/agent/session/permission/shell/mcp/skill/vcs/worktree/...` 域；hook 域 = `aisdk/session/permission/shell/tool` | `plugin/src/effect/plugin.ts:27-65`；`core/src/plugin/hooks.ts:22-38` | 我们只有 `-e` 扩展与 `hooks/*.mjs`（外部进程） |
| Plugin 源 | `.opencode/plugins/*.ts` 目录、npm 包、`plugin` config 数组；本地文件 watch 热重载 | `core/src/plugin/source-directory.ts:8-40`，`core/src/plugin/module.ts:28-80` | 可吸收「目录 + 显式白名单」，不引入 npm 安装 |
| Session hooks | `prompt`（可改输入）、`context`（可改 system/messages/tools）、`compaction`（可给摘要）、`generate`、`title`、`model.request`、`http.request/response`、`ws.*`、`retry`、`experimental.idle`（可注入工作） | `plugin/src/effect/session.ts:185-199` | 我们的 `node_settled` 只覆盖「节点落定」 |
| Tool hooks | `execute.before`（可失败、可改 args）、`execute.after`（可改结果/错误） | `core/src/plugin/hooks.ts:26-38`，`tool.ts:121-179` | `gate.ts` 的 `tool_call` 拦截是同类 |
| MCP | stdio/remote/SSE，OAuth，tools/prompts/resources；工具可标 `codemode`；连接是异步的，模型调用可以等 grace | `core/src/mcp/index.ts:94-165`，`tool/mcp.ts` | R2 才接；避免直接把目录灌进上下文 |
| Command | `.opencode/command(s)/**/*.md` + `config.commands`（template/agent/model/subagent） | `core/src/config/plugin/command.ts:119-133`，`schema/config/command.ts` | 我们可做 `aica-pi/commands/*.md` |
| Agent | JSON config `agents` + legacy `.opencode/agent(s)/**/*.md` frontmatter；`mode/hidden/model/steps/permissions/system` | `core/src/config/plugin/agent.ts:23-24,80-110`，`schema/config/agent.ts` | 我们已有 `roles.json`+profile；缺 per-role 工具面/步数 |
| Skill | `SKILL.md` 目录/URL；按 permission 过滤；prompt 里显式 attach 后注入正文 + 文件清单（≤10） | `core/src/config/plugin/skill.ts:87-100`，`core/src/skill.ts:33-39,67-90` | 我们 `--skill` 显式挂载已落 |
| Instructions | `AGENTS.md` 逐级 + `config.instructions` glob/URL + `.claude/.agents` 目录 | `core/src/config/plugin/instruction.ts:41-62,84-118` | 我们 `--no-context-files`，需显式 `spec.instructions` |
| Code Mode | 单一 `execute` 工具 + JS 目录 + `search()` + budget（`timeoutMs`/`maxToolCalls`/`maxOutputBytes`） | `codemode/src/codemode.ts:23-80`，`core/src/codemode/catalog.ts:47-55` | R3 的 MCP 网关可借鉴 |
| Schedule/Goal/Artifact | 定时任务/artifact 是 experimental，goal 是内置续跑插件；可插拔 artifact provider | `schema/config/experimental.ts:20-31`，`core/src/plugin/goal.ts`，`core/src/schedule/*` | 我们 `budget.minutes`/daemon 定时器是雏形 |

**→ 我们怎么改**：我们已经有 `hooks/node_settled.mjs` 的外部进程 hook，方向对；缺的是「事件/权限/tool 三类 hook 的统一契约」。建议 R2 把 hook 点从 1 个扩到 4 个（`pre_tool`、`post_tool`、`node_start`、`node_settled`），形态保持「文件/JSON stdin-stdout」，不要引入进程内插件运行时——我们的零依赖和 Windows 进程模型比「插件热重载」值钱。

### 3.10 测试与质量手段（问题⑩）

- **测试规模**：1169 个 `*.test.ts`；根脚本明确禁止在 repo root 跑测试（`package.json:36`，`AGENTS.md:187`），每个 package 自己跑 `bun test`；CI 用 turbo `--affected` 在 Linux + Windows 两个 matrix 上跑（`.github/workflows/check-test.yml:79-120`）。
- **类型/静态检查**：根级必过项是 `bun run check`（lint + typecheck）；包内 `typecheck` 用 Bun 的 `bun check`，CI/发布跑 `typecheck:tsc`（官方 TypeScript），两者不一致时以 tsc 为准（`package.json:25-27`，`AGENTS.md:190-195`）。**自定义 ast-grep 规则**（Effect patterns / Effect simplifications）是它把「框架用法」变成可 lint 规则的例子（`package.json:20-24`）。
- **测试哲学**：尽量不 mock，测真实实现；不把逻辑复制进测试；先读对应 skill（`unit-tests`/`tui-tests`/`app-e2e-tests`/`component-tests`）再写测试（`AGENTS.md:183-188`）。
- **UI 测试**：Playwright e2e（`packages/app/e2e`）+ Playwright component tests on stories（`packages/stories`）；浏览器测试有 quarantine 机制（`check-test.yml:10-15`）。
- **生成物/打包**：Protocol/Server HttpApi 变更后必须 `packages/client` 重新 generate，不手改生成文件（`AGENTS.md:1`）；CI 校验 generated client、packed codemode、workerd SDK（`check-test.yml:119-160`）。
- **架构守护**：依赖方向 schema → core/protocol → server；client 不得依赖 core/server（`AGENTS.md:2`）；`packages/session-ui/src/import-boundaries.test.ts` 是同类边界测试。

**→ 我们怎么改**：① 把 `AGENTS.md` 里「测试写在包内、允许 repo root 守卫」的规则搬进我们 README；② 给 `gate.ts` 加「事件级断言」测试（deny 路径不产 gate-req、approve 超时产 block、allow_session 后不再问），用临时 run 目录跑，不 mock fs；③ 把 `tsc --noEmit` 作为 CI 必过项（我们现在只有 smoke）；④ 不引入 ast-grep/turbo（收益与仓库规模不匹配）。

---

## 4 UI/交互

### 4.1 布局与信息层级

TUI 的 session 屏是四块：

1. **左侧 sidebar**（固定宽，`SESSION_SIDEBAR_WIDTH`）：session 标题（带 shimmer/pending 状态）+ 插件 `sidebar.content` slots + `sidebar.footer`（`tui/src/routes/session/sidebar.tsx:13-79`）。
2. **中间 transcript**：按「行」渲染的 projection（message / part / group / turn usage / assistant footer），不是直接遍历消息；滚动、折叠、复制都基于行模型（`tui/src/routes/session/rows.ts`、`grouping/session.ts`）。
3. **底部 composer**：prompt 输入 + tabs（subagents / shell / terminals）+ footer hints（`tui/src/routes/session/composer/index.tsx:84-153`）。
4. **会话 tab rail** + 右侧可聚焦 pane（`keybind.ts:96-119`）。

**信息层级原则**（从代码反推）：
- **默认只显示分组摘要**：连续的 reasoning 合成一组，read/glob/grep/webfetch/websearch 合成 exploration 组，instruction 加载单独成组；组默认折叠，按需展开（`grouping/session.ts:78-99`，`index.tsx:249-254`）。
- **running 用稳定 busy label**，不随流式细节闪烁：`Thinking…` / `Running command…` / `Running code…`（`activity-summary.ts:46-52`）。
- **完成的组给统计标签**：低档 `3 commands, 1 edit, 2 thoughts, 4 reads`（`activity-summary.ts:54-95`）。
- **被权限挡住的工具不并进摘要**，固定在组外可见（`grouping/session.ts:163-175`，`activity-summary.ts:22-43`）。**这是「等待人」必须比「已完成工作」更显眼的设计。**
- **工具行是工具特定的**：`session-ui/src/tools/tool-renderer.tsx`（95KB）按工具渲染 diff/shell/read/subagent 等，TUI 有自己的 `rows.ts`/`message-parts.tsx`；二者共享「tool state → 视觉」的语义。
- **usage**：turn 末有 token/cost 行（`turn-usage` entry，`grouping/session.ts:19`），`usage.tsx` 处理套餐/额度/402。

### 4.2 分组与 verbosity（可直接吸收）

`Verbosity = "low" | "medium" | "high"`，默认 `medium`（`grouping/session.ts:30-32`）：

- `low`：所有非文本活动再包一层 activity 组，只显示统计摘要 + 当前 running 项。
- `medium`：reasoning / exploration / instructions 分组、默认折叠（`index.tsx:247-254`）。
- `high`：同样分组，但 exploration 与 instructions 默认展开（`index.tsx:249-252`）。

分组路径由 `partPath(part, verbosity)` 决定：`question` 永不分组；reasoning → `reasoning`；read/glob/grep/webfetch/websearch → `exploration`；低档再加 `activity` 外层（`grouping/session.ts:85-91`）。instruction 加载的消息单独成组（`messagePath`，`:94-97`）。

**→ 我们怎么改**：`workbench/server.ts:250-278` 的 `steps` 现在是「尾 12 条平铺」；把它改成「服务端投影出行」：
- 给每条 step 加 `group: "activity"|"reasoning"|"exploration"|"instructions"|null` 与 `status: "streaming"|"running"|"completed"|"error"|"deny"`；
- 同一 `group` 连续合并，前端可折叠；`deny`/`gate` 行固定显眼；
- 默认 medium，UI 提供 low/high 切换；
- `cur` 用「Running <tool>…」稳定文案，而不是原始事件名（现在 `cur` 是 `ev?.data?.tool ?? ev?.kind`，`server.ts:271`）。

### 4.3 快捷键（只列高频）

leader 默认 `ctrl+x`（`keybind.ts:41`）。以下均来自 `keybind.ts`：

| 键 | 动作 | 行 |
|---|---|---|
| `ctrl+p` | command palette | 57 |
| `escape` | interrupt session | 128 |
| `ctrl+b` | background blocking tools | 129 |
| `<leader>c` | compact | 130 |
| `<leader>q` | queued prompts | 133 |
| `<leader>b` | sidebar | 96 |
| `<leader>t` | terminal pane | 100 |
| `<leader>l` | session list | 111 |
| `<leader>n` | new session | 110 |
| `<leader>g` | timeline | 121 |
| `<leader>x` | export | 106 |
| `<leader>u` / `<leader>r` | undo / redo message | 195-196 |
| `<leader>a` | agent list | 175 |
| `<leader>m` | model list | 167 |
| `shift+tab` | next agent | 176 |
| `ctrl+t` | cycle model variants | 178 |
| `down` / `left` / `right` / `up` | subagent picker / child nav / parent | 138-141 |
| `ctrl+r` | rename session | 123 |
| `ctrl+d` | delete session | 124 |
| `<leader>1..9` | quick switch | 143-151 |
| `ctrl+alt+k` | which-key | 292 |

### 4.4 审批/提问/队列

- **审批卡**：显示工具 + 参数预览 + 目标列表；选项 `once/always/reject`；`always` 展开说明会保存什么；`reject` 在子会话进入反馈编辑（`permission.tsx:223-256`）。
- **问题工具**：`question` 是独立工具（`tool/plugin/question.ts`），支持选项/多选/自定义输入；plan agent 被允许用它（`plugin/plan.ts:38`），general 子代理被拒绝（`plugin/agent.ts:68-71`）。
- **队列**：composer 里 `<leader>return` 排队而不是立即发送（`keybind.ts:200`）；`<leader>q` 管理队列（`:133`）；`ctrl+u` 撤销队列项、`ctrl+d` 删除（`:134-135`）。**排队是用户显式动作，不是默认。**
- **后台化**：`ctrl+b` 把当前阻塞工具挪到后台，模型收到「不要轮询」提示（`keybind.ts:129` + shell/subagent 描述）。

### 4.5 与 Claude Code / Codex 的 UI 差异

- Claude Code：终端里「对话流 + 工具块 + 权限提示」，没有多客户端/服务端会话；OpenCode 的 TUI 更像 IDE：tabs、sidebar、timeline、subagent picker、which-key。
- Codex：TUI + `exec` 事件流；UI 以 thread/turn/item 为核心，工具块更「协议化」；OpenCode 的 grouping/verbosity 更像「给人读的日志」。
- OpenCode 的 UI 复用面更大：`session-ui` 同时服务 Web/Desktop，TUI 另写渲染；我们的 WebView 单文件更适合学「投影 + 分组」而不是学组件架构。

---

## 5 值得抄的（编号）

> 编号 A1–A17；排序 = 收益/成本。每条给「机制 → 为什么 → 落点」；落点用本仓现有文件/行。

### 审批与守门

**A1 资源级规则集（`action/resource/effect`，deny 先行）** — ★R1.5
- 机制：`Rule{action,resource,effect}` 数组，last-match-wins，无匹配默认 ask；求值前先对**所有 resource** 做 deny 预检，任一 deny 即拒（`core/src/permission.ts:94-104,176-189`）。
- 为什么：我们现在的 `spec.deny` 只到工具名，`spec.rules` 是 args 正则；无法表达「允许 `git *`、拒绝 `rm *`」「只允许读某目录」。资源级规则把「工具」和「工具参数」一起纳入策略，且 deny 先行避免多路径漏网。
- 落点：`aica-pi/extensions/gate.ts:263-287` 的判定链前插 `permissions` 规则；`src/envelope.ts:35-42` 增 `permissions?: Rule[]`；`src/cli.ts` 透传。shell 资源先用「命令首段 + 全串」两档，edit/read 用归一化路径；`deny_paths` 作为语法糖。
- 验收：`permissions:[{action:"shell",resource:"rm *",effect:"deny"},{action:"shell",resource:"*",effect:"allow"}]` 时 `rm -rf x` 直接 block 且不产 gate-req；`git status` 不问。

**A2 外目录审批（`external_directory` 先于工具审批，目录级保存）** — ★R1.5
- 机制：路径解析先判 Location 内/外；外部路径先发 `external_directory` 审批（可 save 目录 resource），再走 read/edit 审批（`core/src/file-access.ts:120-156`）。
- 为什么：我们 `deny_paths` 的「字符串包含」既会误伤（`secrets` 命中 `mysecrets.md`），又无法「临时授权一个目录」。目录级 ask+save 是更自然的粒度。
- 落点：`gate.ts:103-136` 已有 `argStrings/extractTargets`；增加 `spec.cwd`（节点目录）与 `realpath` 归一化，外部路径走独立 gate kind；`grants.json` 记录目录规则。
- 验收：读 `..\other\a.txt` 弹「外部目录」审批；同意一次后同目录不再问；`deny_paths:["secrets"]` 对 `src/secrets.ts` 的 block 仍生效（显式规则优先）。

**A3 审批回复语义：once / always（只存命中资源）/ reject+feedback（批量）** — ★R1.5
- 机制：`reply` 三值；`always` 只写 `request.save`；拒绝带 message → `CorrectedError` 让模型继续；一个 reject 拒绝同 session 所有 pending（`core/src/permission.ts:306-366`）。
- 为什么：我们 `gate-ans` 现在只有 `allow_once/allow_session/deny`，且 `allow_session` 存整个工具；`deny` 的 feedback 已能回注。升级后「本次会话都同意 `git status`」不会把整个 shell 放行。
- 落点：`gate.ts:203-240` 的 `askApproval` 决策分支；`gate-req.json` 增 `save[]`（本次命中的资源）；`workbench/server.ts` 的 approve API 与 UI 按钮文案同步。
- 验收：对 `bash:npm test` 点「本次会话都同意」→ `grants.json` 只有 `{action:"shell",resource:"npm test"}`，下一条 `npm publish` 仍问。

**A4 授权管理面（list/update/remove）** — R2
- 机制：saved permissions 按 project 存 `{action,resource}`，唯一索引，提供 CRUD（`core/src/permission/saved.ts:45-115`）。
- 为什么：我们的 `grants.json` 一旦写入只能手改文件；用户需要在 UI 里看到「到底放行了什么」并撤销。
- 落点：`workbench/server.ts` 加 `GET/DELETE /api/grants`，`apiView` 带 `grants` 列表；`public/v1/index.html` 设置页渲染。

### 事件与 UI

**A5 工具输出截断契约（头截断 + 全文路径 + 尾部截断用于 shell）** — ★R1
- 机制：2000 行/50KiB；超出保留头部，全文写 `tool-output/`，marker 带行范围与绝对路径（`core/src/tool-output.ts:20-24,84-124`）；shell 另用尾部截断（`core/src/shell.ts:244-259`）。
- 为什么：模型上下文有限，但「完整输出在哪」必须可追；我们现在 `transcribe.ts` 的 `RESULT_PREVIEW=300` 只服务 UI，模型侧没有统一上限。
- 落点：`aica-pi/extensions/tools.ts` 所有 `ev_*` 结果 + `worker` 的 shell 结果统一 helper；全文写 `<node>/artifacts/tool-output/`，结果文本带 marker；`gate.ts` 的 `preview` 只用于审批卡。
- 验收：一条 10MB 的 `npm test` 输出 → 模型看到最后 2000 行 + 完整文件路径；`events.jsonl` 仍是 300 字预览（UI 不炸）。

**A6 工具状态机与 assistant 内容投影（streaming/running/completed/error + call_id）** — ★R1（S2 缺口）
- 机制：assistant `content[]` 内联 tool，tool `state` 四态；事件 `session.tool.called/progress/success/failed`、`session.text.delta`、`session.step.*` 都是 durable，投影到同一 message（`schema/session-event.ts:335-570`；`message-updater.ts:33-60`）。
- 为什么：我们的 `events.jsonl` 目前 `tool_execution` 只有 start/end，`message_update` 被 `SKIP`（`src/transcribe.ts:14`），所以 UI 只能看到「做完的工具」，看不到「正在跑/流式文本」。
- 落点：`transcribe.ts:52-101`：去掉对 `message_update` 的全量 SKIP，按 200ms/≥500 字符聚批发 `agent_delta`；`tool_execution_update` 发 `tool_update`；`tool_execution_start/end` 保留；`apiView.steps` 按 `call_id` 折叠（同 id 只留最新）。
- 验收：运行 3 分钟任务，`events.jsonl` 在运行中出现 `agent_delta`/`tool_update`，UI 能看到流式文本；工具结束后同 `call_id` 折叠为一行。

**A7 分组/verbosity 投影（activity/reasoning/exploration/instructions + low/medium/high）** — ★R1.5
- 机制：见 §4.2；默认 medium，低档只显示统计摘要，running 行稳定文案，被权限挡的行固定组外（`tui/src/routes/session/grouping/session.ts:30-135`，`activity-summary.ts:22-95`）。
- 为什么：我们的 steps 平铺且只取尾 12 条（`server.ts:250-278`），长任务里用户看不到「整体在干什么」；分组是纯投影，不改事件格式。
- 落点：`server.ts` 的 `steps` 生成加 `group`/`status`；`public/v1/index.html` 的 `stepHtml` 支持折叠组与计数标签；`verbosity` 存 localStorage。

**A8 队列 vs steer 的诚实语义** — ★R1.5
- 机制：inbox 的 `delivery: steer|queue`；steer 在 step 边界优先消费，queue 只在空闲边界消费一条；运行中不能真正插入文本（`core/src/session/inbox.ts:53-57,567-586`）。
- 为什么：我们的 `reply` 对 running 节点只写 `spec.reply`（`server.ts:442-467` 注释自己写「注入 spec.reply，worker 上下文可见」——但**当前进程看不到**）。这是 PRD G11 的准确缺口。
- 落点：reply API 加 `mode: "queue"|"interrupt"`：queue = 写 `spec.reply` + `reply-queued` 事件，等 worker 下次拉起；interrupt = 复用 `abort`（`server.ts:506-519`）→ 写 reply → `ensureDaemon()` 重拉。UI 两个按钮，按钮文案明确「本轮结束后生效」/「中断并继续」。
- 验收：running 节点点「排队」→ worker 当前轮不变，下一次拉起 `userMessage` 出现该回复；点「中断并继续」→ 进程被杀、result=failed(aborted)、随后以 reply 重启。

### 运行与恢复

**A9 claim + 续跑次数预算** — ★R1.5
- 机制：turn 开始写 claim（与 started 同事务）；terminal 释放；shutdown 保留；启动扫 claim，每次 `resume_attempts += 1`，>10 标 `failed("resume exhausted")`（`core/src/session/execution.ts:73-143`，`execution/restart.ts:16-100`）。
- 为什么：我们 `worker.json` 租约能防重复拉起，但 pid 死后「重拉→再崩→再重拉」可以无限循环；`budget.minutes` 只限单次。
- 落点：`runs.ts:124-180` 的 `worker.json` 增 `attempts`；daemon 启动时对「pid 死且无 result」的节点先 `patchResult failed("resume exhausted")`（≥N）再 `pendingNodes`；正常 terminal 清零。
- 验收：注入一个必崩的 launcher，daemon 连续重拉 3 次后第 4 次标 failed 且不再拉起。

**A10 stale tool 终态补齐 + 续跑提示** — R2
- 机制：启动时把遗留 `running` 的 tool 标 aborted，compaction 标 failed（`core/src/session/runner/llm.ts:382-435`）；恢复注入「从停下的地方继续，不要重复」的 synthetic（`execution/restart.ts:16-17`）。
- 为什么：daemon 崩溃后节点重拉时，`events.jsonl` 里会留下永远 running 的 tool_call，UI 会一直转圈。
- 落点：`daemon.ts` spawn 前扫 `events.jsonl` 尾部的未闭合 `tool_call`，补 `tool_execution{is_error:true,reason:"aborted"}`；`userMessage(resumed=true)` 加固定一句「服务器重启/进程中断，从停下的地方继续」。
- 验收：kill -9 daemon 后重启，UI 中旧 tool 行变红（aborted），新 turn 第一句带继续提示。

### 上下文与交付

**A11 压缩摘要模板（Objective/Requirements/Decisions/Work State/Next Move/Relevant Files/Important Context）** — ★R1（提示词层）
- 机制：固定标题 + 「保留精确路径/命令/错误串」「未解决问题才带过来」「Relevant Files ≤15」「不要提压缩过程」（`core/src/session/compaction.ts:166-205`）；更新式摘要有「新历史优先、旧结论可删」的规则（`:221-237`）。
- 为什么：我们的节点 `result.summary` 是自由文本，父节点读到的摘要质量不稳定；orchestrator 的 plan 也没有固定骨架。
- 落点：`aica-pi/prompts/orchestrator.md`/`reviewer.md`/`worker.md` 写死摘要骨架；`src/envelope.ts` 的 `ResultEnvelope.summary` 文档注明按此写；`plan.v1.json` 可加 `coverage/paths`（PRD G10/G21 已有设计）。
- 验收：任意节点 result.summary 含 `## Work State` 与 `## Next Move`；orchestrator 的 plan 含 `Relevant Files` 且 ≤15。

**A12 指令前缀稳定 + 变更通知（不重写前缀）** — ★R1.5
- 机制：指令按「最共享→最局部」排序，baseline 作为缓存前缀；变更用 `instructions.updated` 增量消息；plan reminder 插在用户消息前（`context.ts:151-163`，`message-updater.ts:151-160`，`plugin/plan.ts:55-66`）。
- 为什么：我们 `worker.md` 走 `--append-system-prompt`（`daemon.ts:156`）已经稳定；但 `userMessage()` 里 `already_known`/`inputs`/`learned` 的顺序和内容每轮都可能变，`learned` 放最后是对的。
- 落点：`daemon.ts:83-104` 固定段顺序：goal → 节点静态上下文 → inputs/already_known → reply → learned；`already_known` 只放「父明确要求你知道的」，不要塞全量历史；若未来支持 `spec.instructions`，用独立段并标注「变更于 <ts>」。
- 验收：同一节点两次拉起的 userMessage 前半段字节级一致（除 goal/reply），利于 provider 缓存。

**A13 git-tree 快照/回滚（独立 gitdir）** — R2
- 机制：每 step 抓 content-addressed tree 到独立 gitdir，assistant 记录 start/end/files；`revert.stage` 按消息边界 restore + diff（`core/src/snapshot.ts:90-148`，`session/revert.ts:22-55`）。
- 为什么：我们的 `retry` 只重拉 session，不恢复工作区文件；节点失败后重试可能污染工作区（PRD G40）。
- 落点：`src/runs.ts` 增 `checkpoint` 命令：节点目录下 `git --git-dir=<state>/snap/<run>/<node> --work-tree=<cwd>` 抓 tree；spawn 前 capture、result 时 diff、retry 前 restore。先做「节点目录快照 tar」cheap 版，完整版随 worktree（G20）。
- 验收：节点 A 改了两个文件后 failed，`ar retry` 能回到 spawn 前内容；diff 里列出这两个文件。

**A14 导出/导入 + sanitize（typed placeholder）** — R2
- 机制：`{info,messages}` JSON；sanitize 把 title/directory/text/files/metadata 等替换成 `[redacted:<kind>:<id>]`，保留结构（`session/transfer.ts:208-275`）。
- 为什么：我们目前没有 run 导出；直接 zip 会把 token/本地路径/命令带出去。
- 落点：`workbench/server.ts` 加 `GET /api/runs/<id>/export?sanitize=1`；CLI `ar export`；sanitize 只替换值不改 schema。

### 扩展与工程

**A15 MCP/Code Mode 的「目录预算」思路** — R3
- 机制：单 `execute` 工具 + 2000 字符目录预算 + 120 字符描述 + 部分目录 + `search()`，目录变化用 diff 更新（`core/src/codemode/catalog.ts:47-55`，`codemode/instructions.ts:14-45`）。
- 为什么：R2 接 MCP 时，如果把所有工具 schema 直接塞进 prompt，会吃光上下文；OpenCode 的「目录摘要 + 按需搜索」是可行解。
- 落点：`aica-pi/extensions/aica_mcp.ts`（R2/R3）：模型只见 `aica_mcp_list`/`aica_mcp_call` 两个稳定工具（Cindy 网关模式），目录摘要进 system prompt 尾部；未披露 schema 的调用 fail-closed。
- 验收：接一个 50 工具的 MCP server，system prompt 增量 < 2k 字符，模型能先 list 再 call。

**A16 服务/SSE 的可靠性语义（只抄语义）** — R2
- 机制：SSE 明确 volatile、慢消费者 fail、`server.connected` 重放给新订阅者、HTTP GET 才是可靠状态源（`protocol/groups/event.ts:72-80`，`client/src/shared-events.ts:33-52`）。
- 落点：`workbench/server.ts:521-546` 的 SSE 加 `server.connected` 首帧与 per-client 队列上限；前端收到溢出/断线就重拉 `apiView`。**不抄后台服务/鉴权/HMAC**。

**A17 测试策略与事件级断言** — ★R1
- 机制：不 mock、测真实实现、包内跑测试、根目录守卫、CI 双平台、生成物校验（`AGENTS.md:183-195`，`.github/workflows/check-test.yml:79-160`）。
- 落点：新增 `test/gate.test.mjs`：临时 run 目录 + 真 `gate.ts` handler + 断言 `events.jsonl`/`grants.json`；新增 `test/transcribe.test.mjs`：喂固定 stdout fixture，断言 event 序列。`tsc --noEmit` 进 CI。

---

## 6 不抄的与原因

| 不抄 | 原因 | 备注 |
|---|---|---|
| Effect 4 + SQLite + Drizzle + 事件总线 | 我们卖点是「零依赖 node:http + 文件态唯一真相」；引入 Effect 运行时 + 迁移/事务/迁移脚本，换来的是多端与云端部署能力，不是本项目当前目标 | 只抄「事务内投影 + seq」的思想 |
| 后台服务单例 / 服务注册 / HMAC 会话 / PTY handoff | shell 已托管 server；多一层服务生命周期在 Windows 上增加杀进程、端口占用、版本升级风险 | 若未来做远程访问再评估 |
| Code Mode（单 `execute` + JS 解释器） | pi 的工具面固定，模型调用协议不归我们控制；Code Mode 需要模型写 JS，收益依赖工具数量与模型能力 | MCP 网关可借鉴「目录预算」 |
| 把每个 token delta 都 durable 落库 | 写放大严重；本地 `persist=false` 也只是投影，仍需每 delta 事务 | 我们做 200ms 批 + UI 折叠即可 |
| TUI 的 opentui/Solid/keymap/which-key 实现 | 我们是 WebView + 单文件 HTML；抄交互语义（leader、footer hints、分组）不抄栈 | — |
| `--auto` 作为安全策略 | 它只是 TUI 自动答 `once`，不是 server 强制；把「自动放行」放客户端会让 headless/其他客户端行为不一致 | 我们的 `policy.json` 应在 gate.ts 服务端生效 |
| share / 云同步 | v2 已移除 share（`keybind.ts:126-127`）；我们单机文件态，导出/导入足够 | 保留 export/sanitize |
| provider 池 / models.dev / OAuth / integrations / schedules / artifacts | 与 pi 的模型路由重叠，且需要网络与账号体系；R3+ 再评估 | 我们的 `roles.json` 已够用 |
| 子代理默认深度 1 | 我们的 `depth_left` 是显式预算，比「默认只能一层」更可控 | 可抄「child session 可继续」 |

---

## 7 一手出处

### 7.1 源码（GitHub，pin 到本次 commit）

> 仓库已跳转 `anomalyco/opencode`；下列 URL 用 `sst/opencode` 亦可 302。路径后的行号对应 `d852834`。

- 进程/服务：`packages/cli/src/commands/handlers/default.ts`、`packages/cli/src/server-process.ts`、`packages/client/src/service-contender.ts`、`packages/server/src/auth.ts`
- 事件/SSE：`packages/core/src/bus.ts`、`packages/server/src/event-feed.ts`、`packages/protocol/src/groups/event.ts`、`packages/client/src/shared-events.ts`
- 会话/存储：`packages/core/src/session/{session,execution,run-coordinator,inbox,history,projector,message-updater,compaction,revert,transfer}.ts`、`packages/core/src/session/sql.ts`、`packages/schema/src/session-{message,event,inbox,transfer,fork,revert}.ts`
- 权限：`packages/core/src/permission.ts`、`packages/core/src/permission/saved.ts`、`packages/schema/src/permission.ts`、`packages/core/src/config/normalize.ts`、`packages/core/src/file-access.ts`
- 工具：`packages/core/src/tool.ts`、`packages/core/src/tool/runtime.ts`、`packages/core/src/tool-output.ts`、`packages/core/src/tool/plugin/{shell,subagent,read,edit,grep,glob,question}.ts`、`packages/core/src/shell.ts`
- 快照：`packages/core/src/snapshot.ts`
- 扩展：`packages/core/src/plugin/{hooks,host,module,source-directory}.ts`、`packages/plugin/src/effect/{plugin,session,tool,permission}.ts`、`packages/core/src/config/plugin/{instruction,agent,skill,command}.ts`
- TUI/UI：`packages/tui/src/config/keybind.ts`、`packages/tui/src/routes/session/{index.tsx,sidebar.tsx,permission.tsx,activity-summary.ts,grouping/session.ts}`、`packages/session-ui/src/tools/tool-renderer.tsx`
- 测试/工程：根 `AGENTS.md`、`package.json`、`.github/workflows/check-test.yml`

示例 URL（其余按同规则替换）：
- `https://github.com/anomalyco/opencode/blob/d85283496fefedaab61bd15750db81b1f82dc42f/packages/core/src/permission.ts#L94-L104`
- `https://github.com/anomalyco/opencode/blob/d85283496fefedaab61bd15750db81b1f82dc42f/packages/core/src/tool-output.ts#L20-L124`
- `https://github.com/anomalyco/opencode/blob/d85283496fefedaab61bd15750db81b1f82dc42f/packages/core/src/session/execution/restart.ts#L16-L100`

### 7.2 官方文档（**注意：多数仍是 v1 行为，与 v2 源码不一致**）

- Permissions：`https://opencode.ai/docs/permissions/`（仍写 `permission` 键值对象、`doom_loop`；源码已迁移为 ruleset，`doom_loop` 无运行时判定）
- Agents：`https://opencode.ai/docs/agents/`（Build/Plan/General/Explore 的体感仍成立；Plan 的权限实现已改为 plugin）
- Server：`https://opencode.ai/docs/server/`（仍写 `opencode serve --port 4096`、TUI+server 同进程；v2 默认是后台服务 + 客户端）
- Plugins：`https://opencode.ai/docs/plugins/`（仍写函数式 hook 对象；v2 是 Effect plugin + `ctx.*` 域）
- 配置：`https://opencode.ai/config.json`（schema 可能与 v2 不完全同步，需复核）

### 7.3 本仓交叉参照

- 六家画像与差异基线：`docs/prd-workbench-v2.md:17-45`（Claude Code/Codex/T3/Cindy/OMP）；v1 的 OpenCode 旧画像在 `docs/prd-workbench-v1.md:73-80`，本文 Δ0-1 已说明它过期。
- 现有实现：`aica-pi/extensions/gate.ts`、`src/transcribe.ts`、`src/daemon.ts`、`src/runs.ts`、`workbench/server.ts`、`aica-pi/prompts/*.md`
- 相关缺口：`docs/prd-workbench-v2.md:90-181`（G2/G3/G11/G29/G30/G32/G33/G36/G40）

---

## 附：本次调研未覆盖 / 需复核

- **TUI 视觉细节**（主题 token、具体组件布局）只看了结构与 keybind，没有逐组件读；若要做 UI 评审，需另起一轮读 `tui/src/component/*` 与 `session-ui/src/v2/*`。
- **provider 路由/模型 catalog**（`packages/core/src/model.ts`、`models-dev.ts`、`provider/*`）未深读；与 pi 的模型路由重叠，暂不吸收。
- **MCP OAuth/集成**（`core/src/mcp/oauth.ts`、`integration/*`）未读；R2 接 MCP 时再评估。
- **`doom_loop`**：源码只有 v1 配置兼容键，没有找到 v2 运行时循环判定；文档仍宣称「同工具同输入重复 3 次触发」。**需复核**是否有未定位到的实现（可能在 server/plugin 之外）。
- **`--auto`**：只在 TUI 客户端实现自动 `once`；server/其他客户端是否有等价策略，**需复核**。
- **Worktree/Workspace**：只确认存在与 Location 关联，未评估对我们的 G20 的可复用度。

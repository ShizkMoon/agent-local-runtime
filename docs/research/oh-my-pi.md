# Oh My Pi 源码级复核（`can1357/oh-my-pi`）

> 复核对象：`https://github.com/can1357/oh-my-pi`，commit `ff0a986b88c223a0a746ed95cda8ddada236140c`（2026-11-03），浅克隆于 `C:\Users\Administrator\ego\research\oh-my-pi`。
> 复核方法：先读 `docs/{approval-mode,ttsr-injection-lifecycle,agent-hub,advisor-watchdog,task-agent-discovery,prewalk,memory,compaction,session,rpc,sdk,tui,models}.md` 与 `docs/tools/{checkpoint,wait,task}.md`，再回源码核：`packages/agent/src/{agent.ts,agent-loop.ts,types.ts,live-steering.ts}`、`packages/coding-agent/src/{session,tools,advisor,task,extensibility}/**`、`packages/ai/src/utils/tool-call-loop-guard.ts`。
> 对照基线：本机 `%APPDATA%\npm\node_modules\@earendil-works\pi-coding-agent`（pi **1.5.0**，docs 目录已列）。
> 本文用途：复核 `docs/prd-workbench-v2.md` §1.6 / §2.2（G31/G32/G34/G36）/ §2.1-2 的既有结论，并给出可直接落地的吸收点。
> 证据等级：**[S]**=源码行号；**[D]**=仓库内官方文档；**[T]**=推断/需复核。

---

## 0 出处

- **仓库事实**：`can1357/oh-my-pi`，HEAD `ff0a986b`。README 自述 *"Fork of Pi by @mariozechner"*（`README.md:26`），当前规模：60+ providers、31 个内建工具、14 个 LSP 操作、28 个 DAP 操作、约 80k 行 Rust 核心（`README.md:31`）。
- **包结构**（pnpm workspace + Bun + Cargo）：
  - `packages/coding-agent`（`@oh-my-pi/pi-coding-agent`）— 产品层：session、tools、task、advisor、TUI/CLI、ACP、RPC。
  - `packages/agent`（`@oh-my-pi/pi-agent-core`）— agent 循环、steering 队列、compaction、live steering。
  - `packages/ai`（`@oh-my-pi/pi-ai`）— provider 传输、tool-call loop guard、模型能力。
  - `packages/tui`（`@oh-my-pi/pi-tui`）— 差分终端渲染器。
  - `crates/{pi-natives,pi-shell,pi-edit,pi-vcs,pi-walker,...}` — Rust 原生层（bash 5.3 引擎、ripgrep/glob/find 进程内实现）。
- **官方文档**（仓库内）：`docs/approval-mode.md`（216 行，审批三输入）、`docs/ttsr-injection-lifecycle.md`（309 行，流规则全生命周期）、`docs/agent-hub.md`（123 行，子代理控制面）、`docs/advisor-watchdog.md`（432 行）、`docs/task-agent-discovery.md`（400 行）、`docs/session.md`（649 行）、`docs/compaction.md`（554 行）、`docs/rpc.md`（1700+ 行，运行时纠偏命令的完整契约）。
- **pi 1.5.0 基线**：`docs/` 共 40+ 篇（含 `extensions.md`、`rpc.md`、`sessions.md`、`compaction.md`、`tui.md`、`sdk.md`、`security.md`），**没有** `approval-mode`、`ttsr`、`agent-hub`、`advisor`、`memory`、`task/subagent` 任何一篇。这是本文判断「Δ vs pi」的第一手依据。
- **未读**：`session-advisors.ts`（137KB）、`task/executor.ts`（222KB）、`task/index.ts`（80KB）未逐行通读，只按文档指向与 grep 命中取证；`advisor-watchdog.md` 只读 140-219 行与相关 grep 段。

---

## 1 定位与体感

**一句话**：Oh My Pi 是 pi 的**硬分叉 + 电池全装**——它保留 pi 的会话/扩展/工具骨架，把「运行时纠偏」从「一个 steer 队列」扩成**三通道（steer / followUp / aside）+ 两类中断粒度 + 审批/顾问/子代理三套人机闸门**，并把大量能力下沉到 Rust 原生层。

体感上的四个特征，正好对应我们要补的四块：

1. **纠偏不是打断，而是分级**。`steer` 会跳过剩余工具、`followUp` 等本轮收尾、`aside` 在下一个步边界注入且不打断工具批（`docs/sdk.md:274`）。同一句话用哪种方式送，决定了 agent 是「立刻改道」还是「做完再说」。
2. **审批是解析器，不是弹窗**。每个工具声明 tier，调用可带 policy/override，用户 policy 再覆盖；解析顺序固定，扩展改参后**按最终参数重解析**（`docs/approval-mode.md:89-100`）。
3. **规则可以在模型脱稿的当下打断它**。TTSR 规则平时沉睡，正则/AST/LLM 判题命中即 `agent.abort()` → 注入 rule → 同点重试（`docs/ttsr-injection-lifecycle.md:115-145`）。
4. **子代理是会话，不是函数**。Agent Hub 里能看 roster、读 transcript、打字 steer、`r` revive（从盘上全史重建）、`x` kill（`docs/agent-hub.md:44-59`）。

与 v2 PRD 的关系：§1.6 的能力清单**方向全对、颗粒度不够**——它把 OMP 描述成「审批三输入 + prewalk + advisor + agent hub」的集合，但漏掉了最重要的三层：**三通道纠偏语义**、**中断粒度（interruptMode）**、**审批的 fail-closed 与 grant tier 规则**。另外有两处需要修正（checkpoint 不是文件快照；model roles 数量），见 §3.10。

---

## 2 架构

### 2.1 运行时分层（[D] README + 包结构，[S] 目录）

```text
omp CLI（TUI / -p / --mode rpc / acp / collab）
  └─ packages/coding-agent   产品编排：session、tools、task、advisor、子代理、审批、记忆
       ├─ packages/agent     agent 循环：steering 队列、followUp、aside、compaction、tool 调度
       ├─ packages/ai        provider 传输、工具调用 loop guard、模型能力
       └─ packages/tui       差分渲染：Component.render(width) -> readonly string[]
            └─ crates/pi-*   Rust 原生：shell、edit(hashline)、vcs、walker、ast
```

- **TUI 是纯渲染层**：`Component.render(width)` 返回不可变行数组，引用相等即可跳过重绘；焦点用 `CURSOR_MARKER` 而非查询光标（`docs/tui.md:49-80`）。
- **会话是 JSONL 树**：每行一个 entry，`id`/`parentId` + 内存 `leafId` 指针；分支导航只移动指针，不重写文件（`docs/session.md:63-69`）。
- **provider 层用「角色」路由**：`modelRoles` 把 `default/smol/slow/vision/plan/commit/tiny/memory/task/advisor` 等映射到具体 selector，支持 `:high` 思考后缀与 `@` 别名（`docs/models.md:782-795`）。

→ **对我们**：我们的 worker 是 `pi -p --mode json`，只用到 pi 的「会话 + 扩展 + 工具」骨架，等于只用到了 OMP 分层里的 `coding-agent` 最薄的一层。这不是问题——**我们缺的不是运行时，而是控制面语义**；OMP 的 value 在于它把控制面语义写成了文档与源码两套可对照的规格。

### 2.2 会话与事件存储（[S] `docs/session.md:37-100`、`session-entries.ts:43-355`）

- 落盘：`~/.omp/agent/sessions/<encoded-cwd>/<timestamp>_<sessionId>.jsonl`，文件头是 256 字节定宽 title 槽，其后是 `type:"session"` header（version 3，UUIDv7）。
- **Entry 类型**（[S] `session-entries.ts:43-355`）：`session`、`message`、`model_usage`、`thinking_level_change`、`model_change`、`service_tier_change`、`compaction`、`branch_summary`、`reset_boundary`、`custom`、`label`、`ttsr_injection`、`credential_pin`、`session_init`、`mode_change`、`custom_message`。
- **关键设计**：compaction / branch_summary / ttsr_injection 都是**一等 entry**，不是消息的子类型；重建上下文时按 `firstKeptEntryId` 与 branch 路径重放（`docs/compaction.md:29-58`）。
- **事件出口**：RPC 模式下的 session 事件流（`docs/rpc.md:1673-1677`）：

```json
{"type":"agent_start"}
{"type":"message_update","messageId":"msg-2","assistantMessageEvent":{"type":"text_delta","delta":"..."}}
{"type":"agent_end","messages":[],"isTerminal":true,"yielded":true}
{"type":"prompt_result","id":"req_1","agentInvoked":true,"status":"completed","sessionSettled":true}
{"type":"session_settled"}
```

另有 `queue_update`（steering/followUp 快照，`rpc.md:892-903`）、`ttsr_triggered`（`rpc.md:978`）、`manual_compaction_start/end`（`:974-977`）、`retry_fallback_applied`（`:977`）、`btw_record/btw_delta`（`:1179-1182`）。

→ **对我们**：S2 的转写器目标事件（`agent_delta`/`turn`/`tool_execution`/`compaction`）与 OMP 的 `message_update`+`agent_start/end`+`session_settled` 是对得上的；额外值得加的是 **`queue_update`**（让 UI 知道「有几条消息在排队」）与 **`prompt_result` 的 admission 语义**（见 §3.3）。落点 `src/daemon.ts` 转写器 + `workbench/server.ts apiView`。

### 2.3 三个身份：session / agent / subagent（[D] `agent-hub.md:1-5`、`docs/task-agent-discovery.md:25-49`）

- **session**：磁盘 JSONL 树，可 fork/resume/tree 导航。
- **agent**：一次运行中的循环（可由 session 恢复）；advisor 有自己的 `Agent` 与私有 transcript。
- **subagent**：`task` 工具派生的子会话，状态 `running | idle | parked | aborted`；**parked/killed 都能 revive**，因为 transcript 在盘上（`agent-hub.md:59`）。

→ **对我们**：我们的 `runs/<run>/<node>` 只有「节点」一个身份，没有「parked/aborted/revive」。好处是简单；代价是 abort 后无法审计「它当时做到哪」。R1 的 `events.jsonl` + 持久 session（G1 已修）其实已经具备 revive 的物质基础——**差的是把 worker.json 的 pid 死亡与 session 存在分开判定**（见 A4）。

---

## 3 核心机制

### 3.1 ① 事件模型：delta 流 + 一等 entry + 会话事件

OMP 有三套「事件」，不要混：

| 层 | 形态 | 写入时机 | 证据 |
|---|---|---|---|
| provider 流 | `message_update` / `text_delta` / `thinking_delta` / `toolcall_delta` | 流式，逐 delta | `ttsr-injection-lifecycle.md:98-109` |
| 会话持久化 | JSONL entry（见 §2.2） | `message_end`、工具结果、compaction、注入等**完成时** | `session.md:63-69`；`session-entries.ts:43-355` |
| 会话事件（RPC/TUI） | `agent_start/end`、`turn_*`、`queue_update`、`ttsr_triggered`、`manual_compaction_*` | 循环状态变化时 | `rpc.md:1673-1677,892-903,974-978` |

**写入时机的三条纪律**（从 TTSR 与 compaction 文档反推）：
1. **流中不落盘**：delta 只进内存 buffer；只有 finalized message / tool result / 注入记录才 append entry（`ttsr-injection-lifecycle.md:247-249`）。
2. **注入有独立 entry**：`ttsr_injection` 记规则名，`custom_message` 记注入正文；恢复时用 `restoreInjected(ruleNames)` 重建抑制状态（`:234-252`）。
3. **compaction 是 entry 而非删除**：`CompactionEntry{summary, firstKeptEntryId, tokensBefore, ...}`，重放时把 summary 转成一条 `compactionSummary` 用户消息，再从 `firstKeptEntryId` 续（`compaction.md:29-52`）。

→ **我们怎么改**：我们的 `events.jsonl` 现在混了「流事件」与「状态事实」（tool_execution 是完成时写的，agent_delta 若按 S2 做会变成流式）。建议**两类分开**：
- `events.jsonl` 保持「事实日志」（可重放、可审计）；
- `stream.jsonl`（或 `delta.log`）只在运行中写、轮末截断/归档，UI 读它做流式，daemon 重启后不依赖它。
这样 S2 的「1 事件/2s」验收不会把 `events.jsonl` 撑成日志垃圾，也不会破坏「events 是唯一审计证据」这条底线。

### 3.2 ② 主循环与取消：agent-loop 的纠偏总线

**核心源码**：`packages/agent/src/agent.ts`、`agent-loop.ts`。

- **队列**：`#steeringQueue: AgentMessage[]`（[S] `agent.ts:431`）、`#followUpQueue`、`#asideMessageProvider`（`:518`）。`steer(m)` 只是 `push` 进 steering 队列（`:1453-1455`）；`followUp(m)` 进 followUp 队列（`:1477-1481`）。
- **交付模式**：`steeringMode: "all" | "one-at-a-time"`（`:456,578`，默认 `one-at-a-time`），`interruptMode: "immediate" | "wait"`（`:458,580`，默认 `immediate`）。
- **步边界**：循环在「一轮工具批结束且还有工作」时取 steering + aside（[S] `agent-loop.ts:1804-1810`）：

```ts
const asides = signal?.aborted ? [] : resolveAsides(await config.getAsideMessages?.("work"));
pendingMessages = asides.length > 0 ? [...steering, ...asides] : steering;
```

  在「即将停止」时再取一次（`:1821-1837`）：`lateSteering + asideMessages + followUpMessages` 一起收，避免 aside 单独触发一次多余模型轮。
- **中断粒度**（[S] `agent-loop.ts:3274-3455`）：
  - 工具可声明 `interruptible`（布尔或按参数判定，`types.ts:1213-1217`）；
  - 排队 steering 到来时，**只硬中断不可中断之外的等待类工具**；`interruptMode:"wait"` 下不抬「协作软信号」，让有副作用的工具干完（`:3293-3296,3441-3455`）；
  - 被跳过的调用产 `__synthetic` 或 `__interrupted` 结果，标 `interrupt_skipped`（`:3952-3975,4089-4126`）。
- **外部 abort vs 内部纠偏**：外部用户中断时 **保留 steering 队列**（`:1777-1781` 注释），mid-batch 轮询只 peek 不消费；这样「abort 后恢复」不会丢用户刚打的字。

→ **对我们怎么改**：
1. 我们现在的 abort = `taskkill /T /F`，是把「人」和「机器」一起杀。OMP 的粒度告诉我们：**「打断」至少有三档**——停一轮（保留会话）、停当前工具、停整个进程。R1 只能做第三档，但 `spec.reply.delivery` 必须把语义写清楚，UI 上「停止」按钮的文案要区分「停止本轮（会保留会话，可继续）」与「杀掉节点」。
2. `interruptMode: "wait"` 是给「副作用工具」的保护：已经执行的 `bash` 不应被半路中止。我们若做 R2 的 RPC steer，应默认 `wait`，只对 `read/grep/glob` 类可中断工具即时切。

### 3.3 ② 运行时纠偏原语全表（本轮最重要的一节）

| 原语 | 触发 | 语义 | 证据 |
|---|---|---|---|
| `steer(text)` | 用户/扩展/父代理 | 进 steering 队列；本轮工具批结束前注入；`one-at-a-time` 下逐条 | [S] `agent.ts:1453-1455`；[D] `rpc.md:1258,1286-1288` |
| `followUp(text)` | 用户 | 等本轮**所有**工作（含重试/压缩）收尾后再开下一轮 | [S] `agent.ts:1477-1481`；[D] `rpc.md:1288` |
| `aside`（`deliverAs:"aside"`） | 扩展/advisor/后台任务 | 在**下一个步边界**注入，不打断当前工具批；会结束可中断的 `wait` | [S] `agent-session.ts:10288-10304`；[D] `sdk.md:274` |
| `promote_queued_message` | 用户 | 把队首 followUp 提到 steering 队尾（不中止流） | [D] `rpc.md:422-433` |
| `remove_queued_message` | 用户 | 从 steering/followUp 队列删一条（同步检查） | [D] `rpc.md:402-412` |
| `abort_and_restore_queue` | 用户 | abort 前撤回**用户写的** steer/followUp 供编辑器恢复；扩展/代理写的保留在 transcript | [D] `rpc.md:443-450` |
| `steer_subagent(id,msg)` | 父/用户 | 给子代理发用户消息：运行中 steer、空闲则开轮、parked 则 revive | [D] `rpc.md:1118-1134` |
| `write agent://<id>` | 代理自己 | 同上，走内部 URL；`agent://all` 广播 | [D] `agent-hub.md:118` |
| `set_steering_mode(all\|one-at-a-time)` / `set_follow_up_mode(immediate\|wait)` | 用户 | 调交付节奏 | [D] `rpc.md:1282-1288` |
| live steering | provider 支持时 | 把用户输入塞进**正在流式的响应**（OpenAI Responses `response.steer`），被拒则退化为边界注入 | [S] `live-steering.ts:1-89`；[D] `models.md:986` |

**三个容易抄错的点**：

1. **steer 不是「塞进当前请求」**。默认情况下它等当前工具批跑完再作为新的用户消息加入下一请求（`rpc.md:1263`）。真正「塞进流」是 live steering，需要 provider 协议支持，且要处理「provider 接受/拒绝」的记账（`live-steering.ts:49-88`：`accepted`/`deferred`，拒绝的排到边界）。
2. **aside 与 steer 的差别是「是否打断工具批」**，不是「是否打断文本」。`sdk.md:274` 原文：*"aside ... without interrupting the current tool batch, instead of steering (which skips remaining tools)"*。
3. **队列是可编辑状态**，不是 fire-and-forget：`queue_update` 事件让 UI 能画 chip、编辑、删除、提升（`rpc.md:892-903`）。OMP 的 Web/RPC 客户端因此不需要自己维护一份队列镜像。

→ **对我们怎么改**（R1 落三件，R2 再补）：
- `envelope.ts`：`Reply` 增 `delivery: "queue" | "steer" | "restart"`，默认 `queue`；`QueueState` 写进 `records.json`（`{steering:[], followUp:[]}`）供 UI 读取。R1。
- `workbench`：节点行显示「排队 N 条」，回复框在 running 时改文案「将在本轮结束后送达」。R1（对齐 OMP 的 `queue_update` 语义，不做编辑）。
- `daemon`：R1 只支持 `queue`；`steer/restart` 返回 `unsupported`（对应 v2 G11 的诚实降级），R2 接 RPC 后用 `abort + resume with message` 实现。

### 3.4 ③ 上下文管理：compaction 六触发 + TTSR 规则

**compaction**（[D] `docs/compaction.md:66-78`）有六种触发：手动 `/compact`、同模型 context overflow 恢复、`stopReason:"length"` 的不完整输出恢复、成功后超阈值、**轮内超阈值（`midTurnEnabled`）**、空闲维护。子代理会话**强制开启轮内压缩**（`:76`），因为「一次任务 = 一轮」，收尾再压就来不及。

**TTSR**（[D] `docs/ttsr-injection-lifecycle.md`）：
- 三种条件：`condition`（正则）、`astCondition`（ast-grep，只在工具参数流、且有可用文件路径时）、`question`（判题模型，**不打断**，只在 `message_end` 后判）。
- 命中即 `agent.abort()`（同步），50ms 后重试任务校验 retry token / prompt generation / abort 状态 / 目标消息身份，然后：`contextMode:"discard"` 删掉被中断的部分输出、注入 `<system-interrupt reason="rule_violation" rule="...">`、持久化 `ttsr_injection`、续跑（`:126-152`）。
- 非打断路径：工具源命中 → `afterToolCall` 以 **developer message** 附 `<system-reminder>`（不改工具输出）；文本源命中 → 等消息成功收尾后作为隐藏 followUp 注入（`:163-182`）。
- 重复策略：`repeatMode:"once"` 或 `"after-gap"` + `repeatGap`（按**完成的 turn** 计，默认 10）（`:191-205`）。
- 判题规则：`ttsr.judge`（auto/on/off），每个输出一次判题请求，yes 概率 ≥0.7 才触发，`deliverAs:"aside"`（`:286-303`）。

→ **对我们怎么改**：
- v2 G31 的「R1 只做 args 守门」是正确降级：OMP 的流中 abort 需要 agent-core 钩子，pi 基线不暴露，RPC 才有机会。**但要把「block reason 即注入」写进 gate.ts 的契约**：`{block:true, reason:"<rule 正文>"}` 会被 pi 作为工具结果回给模型，效果等价于一次 tool 结果级 reminder。
- v2 G32 的 doom-loop 设计**建议按 OMP 的 `ToolCallLoopGuard` 重写**（见 A8），比「同调用计数 5 次」精确得多。
- compaction：我们 R1 不做主动压缩（pi 自带），但 `compaction_end` 事件要进 `events.jsonl`（v2 §2.5-26 已提），因为它是「上下文已变」的唯一信号，UI 必须能显示。

### 3.5 ④ 工具与审批：三输入 × 四档 × 两档 grant

**三输入**（[D] `docs/approval-mode.md:3-14`）：
1. **工具声明** `approval: "read" | "write" | "exec" | {tier, reason?, override?, policy?, policyKey?}`；
2. **工具策略** `policy: allow | deny | prompt`（可带 `override`、`policyKey` 做参数相关规则）；
3. **用户策略** `tools.approval.<tool>: allow|deny|prompt`——可压过模式，但**不能绕过**工具自己的 deny/prompt，也不能绕过非 yolo 的安全 override。

无声明/非法 tier → **默认 `exec`**；MCP 工具一律 `write`（`:12`）。**没有 settings 也没有 autoApprove 时 fail-closed 到 `always-ask` 且无 grant**（`:14`）。

**四档**（[D] `:18-27`）：`always-ask`（read 自动）、`always-ask-cached`（read 也问，但已 grant 的文件/目录放行）、`write`（read/write 自动）、`yolo`（**默认**，全自动）。

**解析顺序**（[S] `tools/approval.ts:366-390` + `:392-479`，与文档 `:89-100` 对应）：

```ts
export function resolveApproval(tool, args, mode, userConfig, grants?, restrictions?, context?) {
  const resolved = resolvePolicy(tool, args, mode, userConfig, grants, context);
  if (resolved.policy === "deny") return resolved;
  const reason = restrictedFolderReason(tool, args, restrictions);
  if (reason === undefined) return resolved;
  // 受限目录压过一切模式/策略/grant；override:true + source:"restriction" ⇒ 每次必问、不可记住
  return { policy: "prompt", tier: resolved.tier, override: true, source: "restriction", reason, ... };
}
```

`resolvePolicy` 内部：工具 `deny` 恒拒 → 用户 `deny` 恒拒 → `yolo` 下工具显式策略优先、否则用户策略、否则 allow → 非 yolo 下 `override:true` 只在伴随 `allow` 时放行、否则 prompt → 再按 tier 落模式默认 → `always-ask-cached` 最后用 `approvalCacheTargets` 全命中则 allow（`:426-520`）。

**grant 语义**（[S] `tools/approval-cache.ts:1-60`，[D] `:37-46`）：
- 两档寿命：`SessionApprovals`（内存，本次会话）与 `ApprovalCache`（`approval-cache.db`，SQLite，跨会话）；
- **grant key = tier + target**（`approvalGrantKey(capability, subject)`，`:25-27`），**写授权覆盖同目标读，读授权永不放行写/执行**；
- 每次检查开短连接读库、不建库不改 schema；只有记录 grant 时才创建文件（`:9-11`）；
- 只对「模式raise的 prompt」记录；被工具策略/override/用户 `prompt`/provider 安全审查强制弹出的 prompt **不记录**（`approval-mode.md:45`）。

**受限目录**（[D] `approval-mode.md:48-64`，[S] `approval.ts:377-389`）：任何档（含 yolo、`--auto-approve`）都问；无交互 UI（print/headless subagent/Cursor exec bridge）**直接拒**；`bash` 这类无 path 参数的工具按 `cwd` 匹配，命令文本不解析（`:61`），要精确控制请用 `tools.approval.bash` 策略。

**安全 override**（[D] `:102-111`）：`bash` 对 `rm -rf /`、fork 炸弹、`curl|sh`、写 `/etc/passwd`、关机命令强制 prompt；`bash.patterns` 的 deny 绝对、prompt 强制问、allow 只到 `write` tier；**yolo 下裸 override 被忽略**，但用户/工具的显式 prompt/deny 仍生效。

**扩展改参后重解析**（[D] `:100`；[S] `extensibility/extensions/wrapper.ts:259-272,349-352`）：扩展的 `tool_call` handler 可以改 args，审批按**最终要执行的参数**重新解析；deny 在执行前阻断，需要 prompt 但无 UI 时**失败而非静默放行**。wrapper 还把「无 UI + restrictedFolder」做成显式错误信息（`wrapper.ts:449-455`）。

**审批挂起时的用户输入**（[D] `approval-mode.md:145`）：*"Sending a message while calls wait ... denies every pending approval, and any the same tool batch asks for before the message is delivered, then steers the turn with that message, so the agent learns why instead of guessing at a bare denial."* —— 这是 **v2 §2.1-4（pending 文字=deny+反馈）的第二个独立实证**（第一个是 T3）。差别：OMP 是「拒绝**所有**挂起审批 + 把消息 steer 进当前轮」，T3 是「拒绝**被回复的那一个** + feedback」。

→ **对我们怎么改**（R1 可落 5 条）：
1. **把 `approve[]` 工具名白名单升级为 tier 表**：`spec.permission` 三档 × 工具 tier（read/write/exec）判定，未知工具默认 `exec`（fail-closed）。落点 `aica-pi/extensions/gate.ts` 的 `resolve()`。
2. **`deny_paths` 与 `restricted_paths` 分开**：前者静默拒（`{block:true}` 无 req），后者**每次必问**且不可 session 记；两者都按「解析后的绝对路径 + Windows 大小写折叠 + 符号链接」比较。落点同文件。
3. **grant 记 tier**：`grants.json` 的值从 `["bash"]` 改成 `{"write:/repo/a.ts":true}` 或 `{tool,tier,target}` 数组；读 grant 不放行写。落点 gate.ts + S5 的「本次会话都同意」。
4. **fail-closed 兜底**：gate.ts 写不出 `gate-req.json`、或超时、或无 `AR_NODE_PATH` → 一律 `{block:true}`。OMP 的 `wrapper.ts:449-455` 与 `approval-mode.md:63` 是同一原则。
5. **挂起时用户文字的语义**：我们只有单 gate（一次一个调用），所以按 T3 的「拒这一个 + feedback」实现；但如果将来支持并行工具批，按 OMP 的「拒绝所有挂起 + steer」更安全。

### 3.6 ⑤ 子代理与并行

**定义即数据**（[D] `docs/task-agent-discovery.md:27-49`）：agent 定义来自 frontmatter，字段：`name/description/systemPrompt` + `tools/spawns/model(优先列表)/thinkingLevel/output/blocking/structured/autoloadSkills/readSummarize/prewalk/advisor`。
- `spawns` 控制「谁能再派」（缺省时若 `tools` 含 `task` 则视为 `*`，`:39-40`）；
- `model` 可写 `@review` 角色别名，经 `modelRoles.review` 解析（`:51-77`）；
- `blocking:true` 让父等子；`structured:true` 给子代理 `yield` 工具并按其 `output` schema 校验回传（`:45-46`）；
- `prewalk:true|"@smol"|<selector>`：起始用贵模型，**首次 edit/write 时切到目标**（`:48`；`docs/prewalk.md:62`：切换是一次性的，切换后 disarm 并注入实现清单）；
- `advisor:true|<selector>`：给该子代理配独立 advisor（`:49`）。

**并行与隔离**（[D] README `:169-177`；[S] `task/worktree.ts:632-742`）：`task` 可 fan-out 到隔离 worktree，每个 worker 自己的工具面，最终 `yield` 是 schema 校验对象；worktree 用 `git worktree add` + 私有分支，避免兄弟冲突。

**控制面**（[D] `docs/agent-hub.md`）：
- roster：status（running/idle/parked/aborted）、parent、未读 IRC 数、model role/解析模型、age、任务/当前活动、cost/active time/requests/tool calls/tokens（`:26-31`）；
- `t` 切 flat/tree、`/` 过滤、`Tab` 宽屏 inspector（当前工具与参数、last intent、retry 状态、上下文用量、lineage、输出/patch 路径、worktree 分支）（`:33-42`）；
- `r` revive（从盘上 transcript 全史重建）、`x` kill（先 abort 再杀）（`:55-59`）；
- 焦点进子代理后：`Enter` 发送 = 运行中 steer / 空闲开轮 / parked/aborted revive（`:73-82`）；
- 通知面：`agent://<id>`（最终产出，未产出前是状态+yield 载荷）、`history://<id>`（transcript）、`proc://`（后台 job）、`memory://`（记忆行）（`:116-121`）。

**join 原语**（[D] `docs/tools/wait.md:1-18`）：`wait` 阻塞到「下一个后台结果 / peer 消息 / steering 中断」；被 steering 打断时返回 `Wait interrupted by message.` 且 `details.interrupted=true`，**不当作错误**。

→ **对我们怎么改**：
1. `ev_wait`（S7）的「被 reply 打断」语义直接抄：父节点 waiting 时若收到 reply，返回 `{status:"interrupted", reason:"reply"}` 并把 reply 拼进下一轮，而不是失败。
2. `spec.profile` 已经对应 OMP 的 agent 定义；把 `tools/model/blocking/structured/prewalk` 逐步加到 `ar_dispatch` 参数面（v2 §2.4-18 已列），R1 只落 `tools` 与 `model`。
3. **revive 我们天然有**（持久 session），缺的是「杀而不删」：`ar abort` 不应删 session 目录，只写 `result.failed("aborted")`；R1 的 S3 落这条即可。
4. `agent://` 的「产出物 vs transcript 分离」值得抄成两个 API：`/agent/<path>/output`（result.json/artifacts）与 `/agent/<path>/transcript`（events 投影），别混一个接口。

### 3.7 ⑤ 后半：advisor（第二模型评审）

- **严重度三档**（[D] `advisor-watchdog.md:151-155`）：`nit`（非打断 aside，攒到轮界）、`concern`（可打断转向；终答后按 `advisor.continueSeverity` 决定是否续一轮）、`blocker`（必打断；终答也拦不住）。
- **交付路径**（`:167-181`）：流中只有 blocker 可 steer；已 yield 且终答 → 按 `continueSeverity` 决定「续一轮」还是「留卡」；中途 yield → concern/blocker 直接开新轮；用户主动中断后 advisor **不再自动续跑**。
- **免疫期**（`:181`）：`advisor.immuneTurns`（默认 3）——成功交付一次 concern/blocker 后，后续 concern 在 N 个主轮内降级为 aside；blocker 不受此限。
- **发射闸**（`:185-196`，[S] `advisor/emission-guard.ts`）：归一化（小写/NFKC/非字母数字折叠）→ 空话过滤（"stop"/"lgtm" 等）→ 按严重度去重（同severity 或更低则丢；更高可重提）→ 每次 update 的非 blocker 配额（默认 4，可配 1-32）；FIFO 历史上限 4096。
- **catch-up**（`:198-219`）：`syncBacklog: off|1|3|5|strict`；有界值最多等 30s，`strict` 无墙钟上限；abort/failure/quota/session-transition 释放等待。
- **独立上下文**：advisor 有自己的 `Agent`、自己的模型 role、自己的 ToolSession；工具默认只给 `read/grep/glob/recall`（`:140-145`），**顾问的工具调用也走正常审批 wrapper**（`:147`）。

→ **对我们怎么改**：v2 G34 的分期是对的——R1 只做「reviewer 节点」（离线的第二模型），R2 才做 inline advisor。但 R1 的 reviewer **可以现在就借两个成本极低的机制**：
- **严重度决定是否阻断**：reviewer 输出 `blocker/concern/nit` 三档，orchestrator 只在 blocker 时把父节点打回，concern 写进 `already_known`，nit 只记 events。落点 `aica-pi/prompts/reviewer.md` + `result.output` schema。
- **免疫期**：同一 reviewer 对同一节点连续打回 ≤2 次，第 3 次强制放行并记 `loop` 事件（防 reviewer/worker 互踢死循环）。落点编排器或 daemon。

### 3.8 ⑥ 状态与恢复

- **会话树**：`id/parentId` + `leafId`；`/tree` 导航只动指针；被放弃的分支在导航时生成 `branch_summary` entry（[D] `session.md:63-69`；`compaction.md:3-8`）。
- **resume/fork**：`~/.omp/agent/sessions/**` 发现（list/recent/resolve）；fork 会复制会话并继承 provider prompt cache 身份（`session.md:90-99` 的 `providerPromptCacheKey` / `taskPromptCacheKey`）。
- **checkpoint/rewind 的真相**（[D] `docs/tools/checkpoint.md:84-95`）：**不是 git、不是文件快照**。它只记「消息条数 + checkpoint tool-result entry 的 id + 时间戳」，rewind 把探索性上下文折叠成报告；明确不捕获 worktree、artifacts、blob、history db、auth。`checkpoint.enabled` 默认 false，且 checkpoint 与 rewind 成对注册（`:18-20`）。
- **崩溃恢复**：`turn-recovery.ts`（156KB）、`exit-diagnostics.ts`、`session-maintenance.ts` 处理中断轮与压缩；`subagent` 的冷恢复由 `task/persisted-revive.ts` 从盘上 transcript 重建（[S] 文件名，25KB）。

→ **对我们怎么改**：
1. **修正 v2 的一处误读**：§2.3-15 把 OMP `checkpoint/rewind` 与 T3 hidden refs 并列作为 G40 参照——但 OMP 的不做文件快照。G40 只能借 T3 的 git ref 模式；OMP 这里能给的是「rewind = 折叠上下文 + 留报告」这个**会话侧**语义，可作为「节点失败后重开时如何压缩历史」的参考。
2. 我们 `events.jsonl` + 持久 session 已覆盖「恢复会话」；缺的是「恢复**工作区**」。R2 的 G40 应明确只做工作区，并在 `already_known` 里说明会话未回滚（与 T3 §3.10 的结论一致）。

### 3.9 ⑧ 相对 pi 1.5.0 基线改了什么（Δ 表）

| 面 | pi 1.5.0（本机 docs 为准） | OMP | 证据 |
|---|---|---|---|
| 包/运行时 | `@earendil-works/pi-coding-agent`，Node | 同源分叉为 `@oh-my-pi/pi-*`，Bun + Rust natives | `README.md:26,31`；包名 |
| 审批 | **无内置审批**：权限策略交给扩展；扩展可用 `tool_call` + `ctx.ui.confirm` 自行实现 | 三输入 × 四档 × grant db × restrictedFolders × 安全 override | pi docs 无 approval 篇；[S] `mcpExtensionSource.ts:311-313`（T3 注释亦证）；[D] `approval-mode.md` |
| 纠偏队列 | `deliverAs: "steer" \| "followUp" \| "nextTurn"`（pi `extensions.md:1637-1673`） | 增 `aside`、`promote/remove_queued_message`、`abort_and_restore_queue`、`steeringMode`、`followUpMode`、`interruptMode`、live steering | [D] `sdk.md:258-274`、`rpc.md:402-450,1282-1288`；[S] `agent.ts:431-580,1453-1533` |
| 中断粒度 | 有 abort，无「可中断工具」概念 | `interruptible` 工具 + 协作 `steeringSignal` + `interruptMode immediate/wait` | [S] `types.ts:1213-1217`、`agent-loop.ts:3293-3455` |
| 流规则 | 无 | TTSR：regex/AST/LLM 判题 + 中断注入重试 + 持久抑制 | [D] `ttsr-injection-lifecycle.md` |
| 第二模型 | 无 | advisor：severity + emission guard + immuneTurns + WATCHDOG roster | [D] `advisor-watchdog.md` |
| 子代理 | 无内建；只有示例 `subagent` 扩展（T3 文档明说） | `task` 子系统 + worktree 隔离 + 定义即数据 + Agent Hub + revive/kill | [D] `task-agent-discovery.md`、`agent-hub.md`；T3 `providers-pi.md:71-74` |
| 工具 | 基础文件/搜索/bash | 31 个内建（lsp/dap/eval/browser/computer/web_search/github/memory/task/wait/todo/ask…） | `README.md:265-317` |
| 记忆 | 无 | 5 backend + local 两段管线 + learn→learned.md | `docs/memory.md:3-11,70` |
| 会话 | JSONL + resume/fork + compaction | 更完整的树/分支摘要/checkpoint-rewind/索引/统计 | `session.md`、`compaction.md`、`tools/checkpoint.md` |
| RPC 控制面 | prompt/steer/followUp/abort | 增队列增删改、`steer_subagent`、`set_steering_mode`、btw、host URI、manual compaction | `rpc.md` 命令表 |
| 循环守卫 | 无（或很弱） | `ToolCallLoopGuard`：跨轮 canonical hash + exempt + useless 跳过 + 二次即 abort | [S] `packages/ai/src/utils/tool-call-loop-guard.ts:70-128`、`session/stream-guards.ts:199-276` |

→ **对我们的直接含义**：我们 worker 跑在 pi 上，所以上表「pi 列」就是我们的天花板。**OMP 证明这些能力都能在 pi 的扩展/会话模型上做出来**，但也证明它们大多需要 agent-core 改动（aside/interruptible/TTSR 都在 `packages/agent`，不是扩展能做的）。因此：
- 能在 pi 扩展层做的：审批（T3/OMP 双证）、args 规则、loop guard（需要 tool 结果/turn 边界，扩展的 `tool_call`/`turn_end` 钩子够用）。
- 必须等 RPC 的：真 steer、流中 abort、aside、live steering。
这条边界与 v2 §4 的分期一致，**确认**。

### 3.10 v2 结论核验表

| # | v2 说法（出处） | 判定 | 证据 | 差异/动作 |
|---|---|---|---|---|
| 1 | 审批三输入：工具 tier × tool policy × user policy；未报 tier=exec（§1.6） | **确认** | `approval-mode.md:3-14`；[S] `tools/approval.ts:366-479` | 补：无 settings/autoApprove 时 fail-closed 到 always-ask 且无 grant（`:14`） |
| 2 | 四档 `always-ask / always-ask-cached / write / yolo`；cached 写 `approval-cache.db`；grant 记 tier、写覆盖读（§1.6） | **确认** | `approval-mode.md:18-46`；[S] `approval-cache.ts:1-60` | 补：**默认档是 yolo**（`:25`）；只记「模式 raise 的 prompt」（`:45`） |
| 3 | `restrictedFolders` 任何档必问，headless=拒（§1.6） | **确认** | `approval-mode.md:48-63`；[S] `approval.ts:377-389` | 补：无 path 的工具按 cwd 匹配，命令文本不解析（`:61`） |
| 4 | bash 危险模式强 override（`rm -rf /`、fork 弹、`curl\|sh`、写 `/etc/passwd`）（§1.6） | **确认** | `approval-mode.md:102-111` | 补：yolo 下裸 override 被忽略，显式 prompt/deny 仍生效 |
| 5 | 扩展改参后按最终参数重新解析（§1.6） | **确认** | `approval-mode.md:100`；[S] `wrapper.ts:259-272,349-352` | 补：需 prompt 但无 UI 时**失败而非放行** |
| 6 | `task` fan-out（可选 worktree）+ 定义 frontmatter（tools/spawns/model/blocking/structured/prewalk/advisor）（§1.6） | **确认** | `task-agent-discovery.md:27-49`；[S] `task/worktree.ts:632-742` | 补：`spawns` 缺省推导规则（`:39-40`） |
| 7 | `structured`+`yield` 做 schema 校验回传（§1.6） | **确认** | `task-agent-discovery.md:46`；[S] `task/structured-subagent.ts` | — |
| 8 | `agent://`=产出物 / `history://`=transcript / `proc://`=后台 job / `memory://`；`write agent://<id>`=steer（§1.6） | **确认** | `agent-hub.md:116-121` | 补：未产出前 `agent://` 解析为状态 + yield 载荷 + 最新助手文本 |
| 9 | Agent Hub：roster/steer/`r` revive/`x` kill/activity log/pinned agents（§1.6） | **确认** | `agent-hub.md:26-121` | 补：advisor 行只读、不可 kill/revive（`:100-107`） |
| 10 | TTSR 三型条件、命中即流中 abort→注入→同点重试、穿透 compaction、repeatMode/gap（§1.6） | **确认（一处需复核）** | `ttsr-injection-lifecycle.md:25-205,234-252` | 「注入穿越 compaction 存活」出自 README `:163`，源码路径只证明「按当前分支恢复抑制状态」；compaction 是否保留注入正文**需复核** |
| 11 | advisor severity/EmissionGuard/WATCHDOG.yml/immuneTurns/独立 ToolSession（§1.6） | **确认** | `advisor-watchdog.md:140-196` | 补：`advisor.immuneTurns` 默认 3、syncBacklog 有界值 30s 上限（`:198-219`） |
| 12 | 「advisor 自己不审批」（§1.6） | **需复核** | `advisor-watchdog.md:147` 明说 advisor 工具也走 `ExtensionToolWrapper` 审批 | 准确说法应是「advisor 不是审批通道，但它的工具调用仍受审批约束」 |
| 13 | 记忆 5 backend + local 两段管线 + `learn`→`learned.md`（≤100 条/≤2000 字）（§1.6） | **确认** | `memory.md:3-11,70` | — |
| 14 | 9 个 model roles（§1.6） | **修正** | `models.md:786-787` | 现为 10 个 chat role（default/smol/slow/vision/plan/commit/tiny/memory/task/advisor）+ 5 个 kind role（image/web/speech/dictation/judge） |
| 15 | `checkpoint/rewind`（§1.6、§2.3-15） | **修正** | `tools/checkpoint.md:84-95` | 不是 git/文件快照，只是「消息边界 + 上下文折叠」；G40 不能拿它当工作区快照参照 |
| 16 | `~80k Rust 核 + Bun`、`31 内建`（§1.6） | **确认** | `README.md:31` | 注：README 写的是「约 80k 行 Rust 核心」 |
| 17 | （v2 未记）`interruptMode immediate/wait` + `interruptible` 工具 + 协作信号 | **新增** | [S] `types.ts:198-204,1213-1217`；`agent-loop.ts:3293-3455` | 直接决定我们 R2 abort 的粒度设计 |
| 18 | （v2 未记）`aside` 第三通道 + 队列增删改 + `abort_and_restore_queue` | **新增** | [D] `sdk.md:274`；`rpc.md:402-450` | 我们 reply 语义应至少承认「下一轮注入」这种 aside 等价物 |
| 19 | （v2 未记）`ToolCallLoopGuard` 的精确算法 | **新增** | [S] `tool-call-loop-guard.ts:70-128`；`stream-guards.ts:199-276` | 用来修正 G32 的设计（A8） |
| 20 | （v2 未记）审批挂起时「发消息=拒绝所有挂起+steer」 | **新增** | `approval-mode.md:145` | G36 的第二个独立实证，且补充了「多个挂起」时的语义 |

---

## 4 UI

### 4.1 主 TUI 布局（[D] `docs/tui.md`、`docs/agent-hub.md`）

```text
┌──────────────────────────────────────────────────────────┐
│ 状态行（model / thinking / cost / context 用量 / LIVE…）  │
├──────────────────────────────────────────────────────────┤
│ transcript（差分渲染，滚动区 + 提交区）                   │
│   ├ 用户消息（含 ^model 徽标 / 附件 / 排队 chip）          │
│   ├ 工具卡（可折叠，live 参数，失败着色）                  │
│   ├ 审批 dock（贴在 composer 上方，不是模态框）            │
│   └ advisor 卡（nit 旁注 / concern 警告 / blocker 阻断）   │
├──────────────────────────────────────────────────────────┤
│ Subagents 钉跳表（live 子代理，几行 + 展开器）            │
├──────────────────────────────────────────────────────────┤
│ composer（多行编辑器 + 队列提示 + 快捷键）                 │
└──────────────────────────────────────────────────────────┘
```

- **审批 dock**（[D] `approval-mode.md:145`）：贴在 composer 上方直到回答；选项 `Approve` / `Approve <tool> for this session` / `Deny`；空编辑器时方向键选择、`Ctrl+Enter` 直接批、`Esc` 拒；**prompt 出现后前 0.5 秒忽略 Enter/批准键**，防止用户正在打字的回车误批；编辑器有草稿时高亮落在「Deny and send message」，方向键与 Enter 改为编辑并发送草稿；`Ctrl+O` 展开全部详情。
- **队列 chip**：`queue_update` 驱动，steering 与 followUp 分开显示（`rpc.md:892-903`）。
- **Agent Hub**（`agent-hub.md`）：全屏 roster + inspector + activity log 三区；`Alt+A` 打开；`t` flat/tree、`/` 过滤、`1/2` 切 Agents/Activity、`r/x` revive/kill。
- **钉跳表**：编辑器上方 `Subagents` 块，`display.pinnedAgents: collapsed|full|off`；`display.subagentLivePreview:true` 时每行加「当前工具 + 一行细节 + 超 5s 的计时」（`:84-92`）。

### 4.2 信息层级的三条规则

1. **审批不抢焦点**：dock 在 composer 之上，用户仍然可以打字；打字被解释为「拒绝并说明」。
2. **advisor 是「旁注层」**：nit 不打断、concern 可打断、blocker 必打断；UI 用不同卡片承载，而不是把 advisor 的话混进主对话。
3. **子代理有独立视图**：主会话只显示钉跳表摘要，细节进 Hub/inspector/transcript——避免主 transcript 被子代理日志淹没。

→ **我们怎么改**：R1 的 `index.html` 只做第三条的极简版：节点行显示 `live/cur/spent`，点开 sheet 看 events 投影（S10 已规划）。**第二条可以零成本吸收**：approve 卡用黄色、reviewer 的 concern 用蓝色、blocker 用红色，别都做成同一种系统消息。这条成本几乎为零，但直接决定用户「一眼看到该看哪」。

---

## 5 值得抄（A1..A12）

> 格式：机制 → 为什么 → 落点 → R1/R2。

**A1 · 审批解析器（tier × tool policy × user policy）替代工具名白名单**
为什么：`approval-mode.md:3-14`；工具名白名单在扩展/MCP 场景必然漏（MCP 工具默认 write）。
落点：`aica-pi/extensions/gate.ts` 的 `resolve(tool,args)`；`envelope.ts` 的 `permission/approve/deny` 保留为上层策略。
R1。验收：`spec.permission:"edits"` 下 `read` 自动放行、`edit/write` 自动放行、`bash` 产 gate-req；未知工具按 exec 问。

**A2 · `restricted_paths`（必问）与 `deny_paths`（必拒）分离**
为什么：`approval-mode.md:48-63`；「永远问」和「永远拒」是两种产品语义，混成一个字段会让用户无法表达「这个目录我要亲自看每次」。
落点：`envelope.ts` 新字段 + gate.ts 判定顺序（deny → restrict → grant → approve）。
R1。验收：restricted 命中必产 req 且不可 session 记；deny 命中无 req 直接 block。

**A3 · grant 记 tier，写覆盖读、读不放写**
为什么：`approval-cache.ts:25-27`；"approve 一次 bash" 不应等于 "approve 所有工具"。
落点：`grants.json` 结构 `{tool,tier,target}`；S5 的「本次会话都同意」写三元组。
R1（session 级）；R2 跨会话 db。

**A4 · fail-closed 三兜底**
为什么：`approval-mode.md:14,63,100`；T3 也同（写不出 gate-req 即 block）。
落点：gate.ts 的 `catch`/超时/缺 `AR_NODE_PATH` 三处统一 `{block:true, reason:"gate unavailable"}`。
R1。

**A5 · 挂起时用户输入 = 拒绝 + 反馈（+ 转向）**
为什么：OMP `approval-mode.md:145` + T3 `ChatComposer.tsx:3414-3419` 双证。
落点：`server.ts apiReply` 检测未答 gate → `gate-ans.json{decision:"deny",feedback:text}`；UI placeholder 同步。
R1。

**A6 · reply 的 delivery 三态（queue/steer/restart）+ 队列可见**
为什么：`sdk.md:258-274`、`rpc.md:402-450`；不定义就会「写了 spec.reply 但进程看不到」。
落点：`envelope.ts`、`daemon.ts`、`server.ts apiView`（`queue` 计数）、`index.html`（排队提示）。
R1 只 queue；R2 steer/restart（abort+resume 实现）。

**A7 · `wait` 被 reply 打断不算失败**
为什么：`docs/tools/wait.md:1-18`；父节点 waiting 是「等子」，用户插话是正常操作。
落点：`src/cli.ts wait` / `runs.ts resolveWaiting`。
R1。

**A8 · Loop guard 用「跨轮 canonical hash」而非单调用计数**
为什么：`tool-call-loop-guard.ts:70-128` 的同轮多工具会被一起哈希，`exemptTools` 允许 wait 类轮询，`useless` 结果不重置计数，`injectedContext` 会重置——这四条正好对应我们 G32 的四个坑（单调用计数漏并行、wait 误报、轮询漏判、注入后仍误报）。
落点：`gate.ts` S8 的 `Map` 改为 `{lastHash,count}`；`tools.ts ev_wait` 结果标 `useless:true`。
R1。验收：交替 `ev_wait` 与重复 `bash` 不触发；连续两轮完全相同的工具批触发；二次违规直接 terminate。

**A9 · 审批「无 UI 即拒」**
为什么：`approval-mode.md:63`、`wrapper.ts:449-455`；我们的 daemon 是 headless，任何「等人」的路径都必须有超时拒绝。
落点：gate.ts 的超时（v2 S4 已写 5min deny，建议降到 2min 并可配）。
R1。

**A10 · reviewer/advisor 的三档严重度 + 免疫期**
为什么：`advisor-watchdog.md:151-181`；没有严重度分级，reviewer 会把「建议」和「阻断」混成一锅。
落点：`aica-pi/prompts/reviewer.md` + `result.output{severity}`；编排器只在 blocker 打回。
R1（reviewer 节点）；R2（inline）。

**A11 · 会话事件 `queue_update` 与 `prompt_result` 的 admission 语义**
为什么：`rpc.md:331`——prompt 的 ack 是「已准入」（开轮/入队/交给扩展命令），不是「已完成」。
落点：`server.ts` 的回复接口返回 `{admitted:true, queue:"..."}`；UI 显示「已排队」而非「已发送」。
R1。

**A12 · `agent://` 产出物与 `history://` transcript 分离**
为什么：`agent-hub.md:116-121`；混在一起会让「读产出」变成「读几千行日志」。
落点：`/api/runs/<r>/node/<p>/output` 与 `/transcript` 两个端点。
R1（transcript 轻量版）；R2（output schema）。

---

## 6 不抄

1. **Bun + Rust natives 全栈**（bash 5.3 内嵌、进程内 ripgrep/glob/find、14 LSP/28 DAP）。我们是 Node 26 + Windows，R1 零新依赖；这些是 OMP 的护城河，不是我们的缺口。
2. **60+ provider / 全量 modelRoles / fallback 链**。我们只有 pi + 一个默认模型；抄 `roles.json` 的四槽（worker/orchestrator/reviewer/advisor）就够。
3. **TTSR 的 LLM 判题（`question` 规则）**。需要判题模型、32k Jev token 预算、yes≥0.7 阈值、aside 交付；R1/R2 都不划算，R3 再看。
4. **snapcompact（历史压成位图）**与 provider-native streaming compaction。收益在超长会话，我们是短任务节点。
5. **advisor 的 WATCHDOG.yml 多顾问 roster + catch-up + 备份评审**。R2 只取「单 reviewer + 三档严重度 + 免疫期」。
6. **Agent Hub 的全屏 TUI / 差分渲染器 / 鼠标捕获**。我们的 UI 是 `index.html`；抄信息层级（roster/inspector/activity），不抄渲染。
7. **collab / stream / ACP / 桌面 computer-use**。G23/G25 非本期。
8. **`checkpoint/rewind` 作为工作区快照**（见 §3.8 修正）；**yolo 默认档**（`approval-mode.md:25`）——我们的默认必须是 supervised。
9. **`abort_and_restore_queue` 的完整撤回语义**。我们单进程单轮，队列最多一条 reply；撤回逻辑只会增加状态机复杂度。
10. **审批按「所有挂起一起拒」**。OMP 这么做是因为它可能并行多个工具批；我们一次一个 gate，按 T3 的「拒这一个 + feedback」更精确。

---

## 7 出处

### 7.1 仓库内文档

- `README.md:26-31`（fork 事实与规模）、`:141-143`（eval 内核）、`:161-167`（TTSR）、`:169-177`（子代理）、`:179-185`（advisor）、`:205`（原生层）、`:221-223`（记忆）、`:239-243`（内部 URL）、`:265-317`（工具清单）、`:321-329`（magic keywords）。
- `docs/approval-mode.md:3-14`（三输入）、`:18-46`（四档与 grant）、`:48-64`（受限目录）、`:66-100`（用户覆盖与解析顺序）、`:102-119`（安全 override）、`:136-171`（prompt 细节与工具声明）、`:186-212`（ACP）、`:214-216`（子代理 yolo）。
- `docs/ttsr-injection-lifecycle.md:25-59`（发现与注册）、`:86-113`（流监控与增量匹配）、`:115-145`（中断/重试/注入）、`:158-182`（非打断路径）、`:191-205`（重复策略）、`:234-252`（持久化与恢复）、`:286-303`（判题规则）。
- `docs/agent-hub.md:1-5`（定位）、`:26-42`（roster/inspector）、`:44-59`（控制键）、`:61-69`（活动日志）、`:71-82`（读与 steer）、`:84-94`（钉跳表）、`:96-107`（持久化与 advisor 行）、`:111-121`（相关面）。
- `docs/advisor-watchdog.md:97`（运行中 steer）、`:140-147`（工具面与审批）、`:149-155`（严重度表）、`:165-181`（交付路径与免疫期）、`:185-196`（发射闸）、`:198-219`（catch-up）。
- `docs/task-agent-discovery.md:25-49`（定义与字段）、`:51-77`（role 别名）、`:120-122`（Agent Hub 入口）、`:389`（工具自动添加）。
- `docs/session.md:37-69`（落盘与格式）、`:71-100`（header 与缓存身份）。
- `docs/compaction.md:3-8`（两种机制）、`:29-58`（entry 模型与重放）、`:66-78`（六触发）。
- `docs/tools/checkpoint.md:18-20`（成对注册）、`:44-52`（流程）、`:84-95`（**不是 git/文件快照**）。
- `docs/tools/wait.md:1-18`（阻塞与被打断语义）。
- `docs/rpc.md:120-190`（命令表）、`:331`（admission 语义）、`:402-450`（队列增删/撤回）、`:892-903`（queue_update）、`:1118-1134`（steer_subagent）、`:1282-1288`（steering/followUp 模式）。
- `docs/sdk.md:233`（queue_update）、`:258-274`（steeringBehavior 与 aside）。
- `docs/models.md:782-795`（modelRoles 全集）、`:986`（`supportsSteering`）。
- `docs/memory.md:3-11`（5 backend）、`:70`（learn→learned.md 上限）。
- `docs/tui.md:49-80`（Component 契约与 focus）。

### 7.2 源码

- `packages/agent/src/agent.ts:431-458`（steering 队列与模式）、`:518`（aside 提供者）、`:578-580`（默认 steering/interrupt 模式）、`:1043-1141`（live steering 取用与恢复）、`:1332-1352`（模式 setter）、`:1381-1419`（队列重排/提升）、`:1453-1481`（steer/followUp）、`:1483-1531`（清空/peek）、`:1587-1617`（批量出队）、`:1660-1685`（等待器）。
- `packages/agent/src/agent-loop.ts:1742-1840`（步边界/aside/收尾注入）、`:3274-3455`（interruptMode 与协作信号）、`:3952-3975`（`interrupt_skipped` 结果）、`:4089-4126`（中断来源枚举）。
- `packages/agent/src/types.ts:198-204`（interruptMode）、`:314-390`（steering/aside peek 钩子）、`:1213-1217`（interruptible 工具声明）。
- `packages/agent/src/live-steering.ts:1-89`（accepted/deferred 记账）。
- `packages/coding-agent/src/session/agent-session.ts:9516-9534`（steer）、`:9536-9560`（followUp）、`:10241-10320`（steer/followUp/aside 入队）、`:7756`（steeringMode getter）。
- `packages/coding-agent/src/session/queued-messages.ts:28-72`（可显示/用户 authored 判定）、`:106-118`（chip 文本与恢复）。
- `packages/coding-agent/src/tools/approval.ts:360-390`（resolveApproval + 受限目录压过一切）、`:392-479`（resolvePolicy）。
- `packages/coding-agent/src/tools/approval-cache.ts:1-60`（两级 grant、tier key、只读连接规则）。
- `packages/coding-agent/src/extensibility/extensions/wrapper.ts:259-272`（预解析）、`:349-352`（改参后重解析）、`:418-455`（受限目录/无 UI 错误信息）。
- `packages/coding-agent/src/session/stream-guards.ts:199-276`（LoopGuards：检测 → 注入 custom message → 二次触发 abort）。
- `packages/ai/src/utils/tool-call-loop-guard.ts:31-46`（参数 canonical 化，剔除 intent 字段）、`:70-128`（跨轮 hash、exempt、useless、阈值）。
- `packages/coding-agent/src/advisor/loop-guard.ts:27-96`（advisor 自己的 loop guard：一次纠偏、二次 abort）。
- `packages/coding-agent/src/session/yield-queue.ts:43-80`（按 kind 的批量注入队列）。
- `packages/coding-agent/src/session/session-entries.ts:43-355`（entry 类型全集）。
- `packages/coding-agent/src/task/worktree.ts:632-742`（worktree/branch 隔离）。

### 7.3 上游链接

- 仓库：https://github.com/can1357/oh-my-pi
- 审批：https://github.com/can1357/oh-my-pi/blob/main/docs/approval-mode.md
- 流规则：https://github.com/can1357/oh-my-pi/blob/main/docs/ttsr-injection-lifecycle.md
- Agent Hub：https://github.com/can1357/oh-my-pi/blob/main/docs/agent-hub.md
- Advisor：https://github.com/can1357/oh-my-pi/blob/main/docs/advisor-watchdog.md
- 子代理发现：https://github.com/can1357/oh-my-pi/blob/main/docs/task-agent-discovery.md
- RPC 契约：https://github.com/can1357/oh-my-pi/blob/main/docs/rpc.md
- pi 基线：https://github.com/badlogic/pi-mono

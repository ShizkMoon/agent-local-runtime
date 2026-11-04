# Cindy 源码级复核（`makecindy/cindy`）

> 复核对象：`https://github.com/makecindy/cindy`，**`main` 分支 tarball**（`codeload.github.com/makecindy/cindy/tar.gz/refs/heads/main`，2026-11-04 抓取，156 MB），落盘于 `C:\Users\Administrator\ego\research\cindy-src`。仓库**未携带 `.git`**，故本文**无 commit 哈希**；所有行号对该次抓取有效，包版本 `apps/desktop/package.json` 为 `0.0.0`（未用于发布版本）。Apache-2.0。
> 复核方法：先读 `docs/dev-rules/{pi-harness,orca-team-architecture,maker-core-and-agent-behavior}.md`（三份「权威」规则文档），再逐条回源码：`packages/maker-core/src/{agents/base-agent.ts,agents/pi/cindy-bridge-source.ts,agents/pi/auto-review-policy.ts,types/events.ts}`、`packages/orca-workflow/src/orca-bridge-prompt.ts`、`apps/desktop/src/main/localDb/schema.ts`。
> 路径约定：所有 `file:line` 相对仓库根。
> 本文用途：复核 `docs/prd-workbench-v2.md` §1.5 / §2.1-1 / §2.5-25,26 / §2.2-9 的既有结论，标注「确认 / 修正 / 新增」，并给出落 `ar` / `workbench` / `aica-pi` 的改法。
> 证据等级：**[S]**=源码行号可查；**[D]**=仓库内官方规则文档；**[T]**=本文推断，需复核。

---

## 0 出处

- **仓库与快照**：`makecindy/cindy`，`main` tarball，2026-11-04。pnpm monorepo：`packages/*`（35 个包）+ `apps/{desktop,mobile,cindy-headless}`。
- **本仓对照物**：`docs/prd-workbench-v2.md` §1.5（Cindy 画像）、§2.1-1（`pi.on("tool_call")` 拦截式审批）、§2.1-5（ask-and-remember）、§2.2-9（doom-loop guard）、§2.2-10（advisor）、§2.5-25（MCP 网关）、§2.5-26（compaction 后续命）、§3 G3/G15/G30/G32/G34/G36；`aica-pi/extensions/*`；`workbench/server.ts`；`src/daemon.ts`。
- **本次重点读的源码/文档**：
  - 抽象层：`packages/maker-core/src/agents/base-agent.ts`（3,036 行，138 KB）、`packages/maker-core/src/types/events.ts`。
  - pi 桥：`packages/maker-core/src/agents/pi/cindy-bridge-source.ts`（5,741 行，`String.raw` 常量）、`agents/pi/auto-review-policy.ts`。
  - 多代理：`docs/dev-rules/orca-team-architecture.md`、`packages/orca-workflow/src/orca-bridge-prompt.ts`、`packages/lizi-mcps/src/orca/server.ts`（本次按文档定位，未逐行读）。
  - 行为：`docs/dev-rules/maker-core-and-agent-behavior.md`（loop guard 全节）。
- **未读/不采信**：`packages/maker-core/src/agents/pi/index.ts`（507 KB）、`agents/claude-code/index.ts`（430 KB）、`apps/desktop/src/renderer/**`（UI 实现）**未逐行通读**；相关结论均引官方文档 [D]，落源码处只引已核对的点。凡未落到行号者为 **[T]**。
- **与 v2 画像的偏差**：v2 §1.5 对 Cindy 的描述**准确度很高**（maker-core / 拦截式审批 / Orca / MCP 网关 / ToolLoopGuard 五条都对）。本文主要补三处 v2 没写的：**审批面在 host 而不在 bridge**、**Auto 是三档里的第二模型评审档**、**Orca 的三条 turn 结束不变量**。

---

## 1 定位与体感

**一句话**：Cindy 不是 agent 引擎，而是一个**harness-agnostic 的桌面宿主**——它自己不做推理，把 Claude Code / Codex / Pi 当引擎塞进 Electron，用统一抽象抹平差异，用注入式扩展补齐引擎没有的能力（审批、MCP、子代理、压缩），在此之上做多 agent 协同（Orca）与多端（desktop / mobile / device-link）。

体感上四个特征，正好对应 v2 要补的四块：

1. **「不改引擎，只加一层」是它的立身之本**。pi 原生无审批，Cindy 注入 `cindy-bridge.ts` 扩展，`pi.on('tool_call')` 拦截（`docs/dev-rules/pi-harness.md:21-25`）[D]。**这与我们 G3 的路径逐字同构**。
2. **审批的决策在宿主，桥只负责冒泡**。bridge 里 `currentPermissionState()` 只返回 `'ask' | 'bypassPermissions'` 两档（`cindy-bridge-source.ts:1888-1936`）[S]——所谓第三种「Auto」档**根本不在 bridge 里**，而是 host 收到 ask 之后用第二个模型评审。这个分层是我们要学的：**桥不做策略，策略在宿主**。
3. **Worker 是完整会话，不是 subagent**。官方第一句就写死：「Worker 是完整会话，不是一次性 subagent；它有自己的模型、effort、工具调用流、上下文与可见历史」（`orca-team-architecture.md:35`）[D]。prompt 里反复强调「An Orca Worker is NEVER a substitute for a subagent」（`orca-bridge-prompt.ts:29`）[S]。
4. **协同的正确性靠「turn 结束语义」保证，不靠状态机**。Lead 派完活必须**零输出结束 turn**，worker 回报作为新消息自动唤醒它（`orca-bridge-prompt.ts:48-54`）[S]。这套「谁在什么时候闭嘴」的规则写得比任何状态机都严。

与 v2 PRD 的关系：§1.5 的**事实层几乎全对**，可以作为基线。需要补的是**语义层**：为什么这样设计、哪些约束不能抄错。

---

## 2 架构

### 2.1 进程与服务

| 层 | 形态 | 证据 |
|---|---|---|
| 桌面 | Electron main + renderer；手机 Expo；`cindy-headless` 无头 | `apps/{desktop,mobile,cindy-headless}` [S] |
| 内核 | `packages/maker-core`，**不依赖 Electron** | `orca-team-architecture.md` 全文只引 maker-core 公共导出 [D] |
| 引擎 | 三个 adapter：Claude Code（SDK/CLI）、Codex（app-server JSON-RPC）、Pi（`pi --mode rpc`，JSONL/stdio） | `pi-harness.md:10-11` [D] |
| MCP | `packages/lizi-mcps`（`cindy_orca` / `cindy_helper` / `lizi-im`）；in-process providers 经 localhost streamable-HTTP 暴露给 pi | `pi-harness.md:50-57` [D] |
| 存储 | SQLite（`apps/desktop/src/main/localDb/schema.ts`）：`sessions` + `orca_teams` + `orca_workers`；配置在 `~/.cindy` 类目录 | `orca-team-architecture.md:73-90` [D] |
| 远程 | SSH remote-forward 把本机 MCP bridge 端口转到远端 agent；device-link 把整个 team 放在被控端 | `orca-team-architecture.md:43,53-55` [D] |

### 2.2 统一抽象的边界（maker-core）

三件套，边界很干脆：

1. **`BaseAgent`（抽象类）**：`base-agent.ts:2692` 起。文件头一句定调：「不支持的能力默认抛 `NotSupportedError`，子类按 capabilities 覆盖」（`:6`）；统一出口是 `throwNotSupported(capability, reason, upstreamRef)`（`:3033-3035`），`reason ∈ {sdk-missing, not-implemented, platform-limited}`——**「不支持」本身分了三种原因**，供上层决定降级还是报错 [S]。
2. **`AgentSessionHandle`（接口）**：`:2383-2532`。只暴露 provider-neutral 的面——`id/agentKind/model`、`send/steer/abort/close`、`events(): AsyncIterable<AgentEvent>`、`getUsageSnapshot()`；provider 专属能力一律 `xxx?` 可选 + 注释标「Pi-only / Codex-only」[S]。**`send` 与 `steer` 是两个方法不是布尔参数**，注释给了理由（`:2439-2447`）：「send() 开启新 turn 并重置 usage/status/tool-loop；steer() 只进入已有 turn 的输入通道」——**这条直接回答了我们的 G11**。
3. **`AgentEvent`（统一事件）**：`types/events.ts:27` 是 `AgentEventType` 联合，`:178` 是 `AgentEvent`。类型含 `text / thinking / tool_use / tool_result / tool_result_full / agent_task_update / image / account_usage / turn_diff`（`:28-36`）[S]。`tool_result` 与 `tool_result_full` **分两条**：前者精简给内嵌 UI，后者完整给详情面板——这是 v2 G2/G12 想要的分层。

**→ 我们怎么改（A1，G11/G12 修正）**：v2 §2.4-16 把「steer」当 R2 的 RPC 特性。Cindy 证明**即使不换引擎**，也要把「新 turn」与「追加到在途 turn」拆成两个 API 语义，否则 UI 状态、缓存率、计费全乱。落法：`aica-pi` 的 `ev_tell`（若已有）拆成 `ev_tell{mode:"new"|"steer"}`；daemon 对 `steer` 只写 `spec.reply` 且**不重置** `spent`/`events` 计数窗口。即便 R1 做不到真插话，语义先分开。

### 2.3 pi 桥的装配方式（值得抄的工程细节）

- 桥**不是独立包**，而是一个 `String.raw` 字符串常量 `CINDY_BRIDGE_EXTENSION_SOURCE`（`cindy-bridge-source.ts:83`），文件头写明「写进 pi agentHome/extensions/ 的扩展源码」、`CINDY_BRIDGE_EXTENSION_FILENAME = "cindy-bridge.ts"`（`:56`）、「PiAgent 每次 startSession 覆写该文件」（`:27`）[S]。
- 好处：**版本强绑定**——宿主代码与桥代码同一次构建，不会出现「旧桥配新宿主」；坏处：桥不能 import 宿主，只能 import pi 的 `ExtensionAPI`、`fetch`、`node:fs`（`:6-7`）[S]。
- 与之配套：`--append-system-prompt` **只传文件路径不传文本**（`pi-harness.md:17-20`），理由是「伙伴提示词轻易两三万字符，内联会顶穿 Windows 的 spawn 命令行预算」[D]。

**→ 我们怎么改（A2，G14/G37 备注）**：我们的 `aica-pi/extensions/*.ts` 是**独立文件**，daemon `-e` 挂载。这条路更灵活但要防「桥与宿主版本漂移」。建议：`extensions/` 里每个文件头部写 `// aica-pi: <version>` 且 daemon 启动时校验，不匹配则 fail-closed 不挂载。同时抄「提示词写文件传路径」——`spec.goal`/`already_known` 一旦变长，Windows `spawn` 命令行（约 32K）就是硬顶。

---

## 3 核心机制

### 3.1 拦截式审批（v2 §2.1-1 **确认**，并补三个关键细节）

`pi.on('tool_call', async (event, ctx) => {...})`，`cindy-bridge-source.ts:5121-5326`。判定顺序逐字读下来是 [S]：

1. `guestToolGate.blocks(toolName)` → block（分享供应商的受限工具）；
2. `toolsDisabledForTurn()` → block（host 拥有的纯文本 turn）；
3. `permission.reviewOnly` → 只放行四个只读内置工具且路径经 `normalizeReviewReadInput` 归一；其余一律 block，理由写「Cindy Review only permits read-only access」；
4. `ask_user_question` 直接放行（它是提问，不是副作用）；
5. **写类工具先发一次 `ctx.ui.confirm(TURN_CHANGE_CAPTURE_TITLE, ...)`**——注释说明这是「internal synchronization point，宿主只快照目标文件」，且 `try/catch` 吞掉失败（`:5144-5160`）：「capture must never turn an observability failure into a tool-execution failure」；
6. 计算 `targetPath`、`writeTargetResolved`、`writeInsideAgentHome`、`writeInsideSubagentRun`、`controlPlaneWrite`；
7. 收集凭证证据 `bashReadEvidence` / `readonlyCredentialEvidence` / `environRead`（读 `/proc/*/environ` 也算）；
8. `cindy_pi_extension` / `cindy_pi_command` 直接放行（「This tool cannot mutate by itself」，真正边界在 host）；
9. **`if (permission.mode === 'bypassPermissions' && !controlPlaneWrite) return;`**（`:5243`）——Full Access 全放行，**唯独控制面写入不放**；
10. `CINDY_MCP_LIST_TOOLS` 放行；只读内置且非凭证读放行；
11. MCP 网关解析 → **未披露 schema 的调用直接放行给 `execute`（由 execute 的 gate fail-closed 并回路标），不弹框**（`:5271-5276`）；
12. 其余走 `ctx.ui.input(PERMISSION_TITLE, JSON.stringify({toolName, input, resolvedCredentialPaths, resolvedWritePath, resolvedWritableRoots, controlPlaneWrite}))`（`:5288-5304`）——**用 `input()` 而不是 `confirm()`**，注释给了理由（`:5285-5287`）：「Unlike confirm(), it can return why Cindy denied the request, so an automatic review block is not misreported as a user click」；
13. `decision !== 'allow'` → `{block:true, reason: permissionDenialReason(decision)}`；
14. 放行后**把 `event.input.path` 改写成审核过的 canonical 路径**（`:5315-5325`）——缩小「等确认期间把 link 换掉」的竞态面，并诚实注明「这不是 descriptor/inode 绑定」。

**档位文件热切换**：`currentPermissionState()`（`:1888-1936`）每次 tool_call 现读 `CINDY_PI_PERMISSION_FILE`；读不到文件、JSON 坏、字段类型不对 → 一律回落 `{mode:'ask', roots:[]}`，即 **fail-closed**。`reviewOnly` 例外：它由 `CINDY_PI_REVIEW_ONLY` 启动标记独立决定，「权限文件损坏/缺失时**不得**降级成普通 ask」[S]（注释 `:1896-1899`）。

**→ 我们怎么改（A3，G3 + G30/G33 定案）**：

- v2 §S4 的 `gate.ts` 设计**方向正确**，但要补三条：
  1. **perm 文件现读**：`perm-<node>.json` 每次 `tool_call` `readFileSync` 一次，解析失败 → 按 `supervised` 处理（fail-closed），不要缓存；
  2. **控制面永不放行**：`AICA_STATE`、`aica-pi/` 包内、`spec.json` 本身，任何档位命中都写 gate-req。这条比 v2 的 `deny_paths` 更硬——`deny_paths` 是「拒绝」，控制面是「必问」；
  3. **deny 要带理由回给模型**：pi 的 `{block:true, reason}` 的 reason 会进模型上下文，所以 `gate-ans.json` 的 `feedback` 直接当 reason 用，不要写「denied by user」。
- **不要抄**它在 bridge 里做凭证正则那一大坨（`:5208-5234` 引了 `SENSITIVE_CREDENTIAL_GLOB_PATTERNS` 等一整套）。文档自己承认「文本拦截不是安全边界（可被变形绕过）」（`:5209-5210`）[S]。我们的对应物应该是路径白名单（G33），不是正则。

### 3.2 三档 + Auto 的第二模型评审（v2 未记「审批面在哪」）

- 三档：`ask` / `auto` / `bypassPermissions`。**bridge 只见 ask 与 bypass**；`auto` 是 host 侧行为——bridge 冒泡成 `ctx.ui.input`，经 `extension_ui_request` → `PiAgent.handleExtensionUiRequest` → `InteractionRequest`（`pi-harness.md:21-24`）[D]，host 若处于 auto 则交给 `agents/shared/auto-review.ts`。
- `agents/pi/auto-review-policy.ts` 是 adapter：把 bridge 冒泡上来的调用翻成归一化 `ReviewableAction`（`:1-16`）。它明确写了「bridge 直达宿主」的**可达面**——只读四件套非凭证路径**根本不会冒泡**，所以到 auto 的只读调用只有「命中凭证路径」那一类（`:6-10,56-60`）[S]。
- `MCP 工具（mcp__*）一律走 other`，由会话模型结合完整工具名/入参判断，「本 adapter 不猜测各 server 的安全性」（`:12-15`）[S]。
- **fail-closed**：「reviewer 缺失 / 失败仍由共享决策层 fail-closed」（`:14-15`）；`pi-harness.md:332` 维护不变量第 4 条重申「auto 档 dispatcher fail-closed：分类抛错 / 无 resolver 一律不放行」[D]。

**→ 我们怎么改（A4，G34 定案）**：v2 §2.2-10 把 advisor 排在 R2。Cindy 给出的形态可以直接抄成 R1 的**「Auto 档 = 第二模型评审一个 gate-req」**：

- gate.ts 命中 `spec.approve` 且 `spec.permission === "auto"` 时，不写 gate-req 卡，而是把 `{tool, args, targets, cwd}` 写 `review-req.json`，再由 daemon 用 `spec.model`（或配置的 `reviewer` 模型）跑一次**单轮、无工具、强制 JSON 输出**的评审，产出 `{allow|deny, reason}`；
- **任何失败（超时/解析失败/无 key）→ deny**，不是 allow；
- 评审上下文先脱敏再截断（抄 Cindy 的顺序：**先按凭证种类整类删，再截断**，`maker-core-and-agent-behavior.md:92-97`）[D]。
  这条的成本是「每 N 次工具调用多一次小模型调用」，收益是「用户不用点」。作为 `permission:"auto"` 的可选档，不默认开。

### 3.3 Orca：全员会话制多代理（v2 §1.5 **确认**，补数据模型与不变量）

**数据模型**（`orca-team-architecture.md:73-90`）[D]：

| 概念 | 载体 | 约束 |
|---|---|---|
| Lead session | `sessions.orca_role='lead'` | 一个 Lead 同时最多 1 个 active team（partial unique `uniq_active_team_per_lead`） |
| Worker session | `sessions.orca_role='worker'` + `orca_workers.session_id` | 完整 session，有独立 agent/model/context |
| Team | `orca_teams` | 只约束 `status='active'` 的行——「不能用全表 unique，否则非 active team 占住索引会让同一个 Lead 无法重新开启协同」 |
| Worker record | `orca_workers{team_id,session_id,status(idle/running/done/error),label,role,focused,idle_since}` | 一个 team 只能一个 focused（partial unique） |

**关键区分**：`orca_role` 与 `parent_session_id` 是**两个字段**，「fork 关系不能承载 Orca 派单语义」（`:81`）[D]。

**控制面**：`cindy_orca` 是独立 MCP server，**顶层注册 21 个工具**（18 控制 + 3 只读诊断），**不藏在 `list_tools/call_tool` 后面**——理由是「模型在开协同/派 worker 时需要稳定发现 `start_team/create_worker`」（`:137`）[D]。

**身份路由**（这节是精髓，`:147-150,204-206`）[D]：

- 工具**全局可见，权限在 handler 拒绝**：「工具可见性不是权限边界」；
- Codex：身份来自 `params._meta.threadId` → `CodexMcpThreadContextStore`。**`mcp-session-id` 只标识 transport，不作路由依据**；「缺失、未知、batch 内不一致或不完整时，bridge 宁可不给 context（让工具调用安全降级为 `NO_SESSION_CONTEXT`），也不猜一个错误 context 造成跨会话串线」（`:204-206`）；
- Claude Code 远端：「远端 cc 没有 threadId，身份走持久 bearer token + URL `?session=<id>` 路由」；SSH 场景「白名单仅此两个 server」（`:42,55`）；
- 上下文载体是 `AsyncLocalStorage` 的 `withLiziMcpSessionContext` / `resolveLiziMcpSessionContext`，「不能依赖全局 fallback 猜身份」。

**三条 turn 结束不变量**（`orca-bridge-prompt.ts:39-54,68-83`，`orca-team-architecture.md:314-356`）[S][D]：

1. **只有真实异步派发才静默结束 turn**：`send_to_worker` 需 `ok=true` 且 `wake_kind ∈ {resumed, already-active, queued}`；`create_worker(s)` 需 `dispatched=true` 或 `queued_message_id` 或 `dispatch_outcome.kind=session-dispatch && dispatched`。**不满足就必须立刻报给用户**，「不能等待一个不会到来的 Worker 回报」。全部成功则**零输出结束**——「no summary, no 'I've sent...', no 'waiting...'」（`:50`）。
2. **执行通道必须披露并按同一通道验收**：「A native subagent result is not evidence that an Orca Worker ran or completed」（`:81`）；终答要给每个被派任务标 `Orca Worker` 或 `native subagent`。
3. **忙碌目标不丢消息**：默认进输入队列；`delivery:'steer'` 才尝试同轮插话；「已尝试插话后的拒绝不能当成普通忙碌重发」（`orca-team-architecture.md:360-361`）。

**→ 我们怎么改（A5，G6/G36 的语义来源）**：

- 我们已有 `ev_wait{paths}` 的设计（v2 §2.4-17）。Cindy 补的是**反向约束**：父节点在等子节点时**必须明确「我在等谁」**，否则就是死等。落法：`result.json.status="waiting"` 时**强制** `wait_on: string[]` 非空，空数组视为协议违规 → `failed("wait without targets")`。
- **「零输出结束 turn」对我们不适用**（我们是文件态，没有「turn」），但它的对偶适用：**父节点写 `wait` 后 daemon 必须停止给它发任何新指令**，直到 `wait_on` 全 settle。这条现在没有，容易出现「父节点在等，daemon 又因为它 running 而重复拉起」。
- **worker 权限是创建时偏好，不继承 lead**（`orca-team-architecture.md:139-145`）[D]：真源在 renderer localStorage，main 只存内存镜像；产品默认 `bypassPermissions`，但「已由用户保存为 `bypassPermissions` 时，后续沿用不重复确认」。→ 我们的 `spec.permission` **不要从父 spec 继承**，默认取 `policy.json`；显式继承是 bug 源。

### 3.4 上下文隔离与汇总

- **隔离单位是 session**：worker 有自己的模型、effort、工具流、上下文、可见历史（`orca-team-architecture.md:35`）[D]。Lead 看不到 worker 的 pane 输出——「The worker cannot see your conversation output — send_to_worker is the only way to reach it」（`orca-bridge-prompt.ts:72`）[S]；反向同理：worker「Do not only reply in the worker pane; the lead cannot see it unless you call send_to_lead」（`:110`）。
- **汇总靠消息，不靠共享文件**：worker 终态 → `send_to_lead` 或 **auto-bridge** 自动转发 → 作为**新消息**进 lead 会话 → 唤醒 lead 开新 turn（`:44-46`）。
- **按需回读**：worker 可用 `orca_worker_bridge.read_lead_history` 反查 lead 转录，但「只返回 user/assistant、排除 rewound、限制单页数量并保持 `(createdAt,rowid)` 游标分页」，且「不 create/resume Lead，也不发送消息」——「本机与 SSH Worker 都能在不唤醒 Lead 的前提下读取同一份上下文」（`orca-team-architecture.md:166-172`）[D]。**这是 portable handoff 的一个极简形态**（v2 §2.5-23 的参照）。

**→ 我们怎么改（A6，G39 降级版）**：v2 把 handoff 排 R2 全量。Cindy 给了一个 R1 可做的子集：**只读、分页、不唤醒**的「读父节点历史」工具。落法：`ar_read --node <path> --since <ts> --limit 50`，给 worker 一个 `ev_read_parent`，输出走 `result.json` 之外的旁路文件，**不注入父节点上下文**。等真需要迁移时再谈预算化拼接。

### 3.5 ToolLoopGuard（v2 §2.2-9 **确认**，参数需修正）

`agents/shared/loop-guard.ts` 的 `ToolLoopGuard`（`maker-core-and-agent-behavior.md:30-33`）[D]。逐条核：

| 判据 | 数值 | 证据 |
|---|---|---|
| 完全相同「名+参数+输出」连续 | **4 次 → 疑似复核** | `:39,68-69` |
| 完全相同调用连续 | **30 次 → 硬断**（`final:true`） | `:82` |
| 完全相同结果持续 | **60 分钟 → 硬断**（含节奏轮询） | `:82` |
| 只读搜索轮转窗口 | 最近 **128** 次读/搜结果、至多 **32** 种指纹、**≥90%** 属重复≥4 次的指纹 → 硬断 | `:45-47` |
| 节奏轮询豁免 | 距上次同类调用/结果 **≥30s** 不计入 | `:64-67` |
| 复核预算 | 每 turn **≤3** 次，**20s** 超时 | `:72-73` |
| 复核失败 | continue/失败/超时/无效/未注入 → **接下来 20 次普通结果不再报疑似** | `:71-72` |
| 已关闭的规则 | 「同类契约错误连续被拒三次即中断」→ `contractConsecutiveLimit = ∞` | `:36-38` |

**复核本身**：`ToolLoopMonitor` 在后台跑，**主 agent 不暂停**；只有明确 `STOP` 才中断（`:68-72`）。上下文构造有严格顺序（`:89-97`）：用户上下文 ≤4000 字符、行动说明 ≤2000 字符、**先脱敏再截断**（「顺序不能颠倒，否则跨截断点的凭证会留下认不出的前缀」），并附最近 12 次调用摘要（每段 ≤400 字符）。

**→ 我们怎么改（A7，G32 定案，v2 数值要改）**：v2 §S4 写「≥5 次 block / ≥15 次退出」。Cindy 的实测值是 **4 次疑似 / 30 次硬断**，且**疑似不等于 block**——它只是「送复核」，复核通过就继续。我们 R1 没有复核模型，所以最保守的映射是：

- `gate.ts` 计数 `(toolName + sha1(args))` **连续相同**：≥4 次 → `{block:true, reason:"疑似循环：同一调用已连续 4 次，请改变方法"}`（用 block 代替复核，等同「复核判 STOP」）；≥12 次 → 同上但 reason 更强；
- **必须带「节奏豁免」**：间隔 ≥30s 的调用不计连续——否则轮询 CI 的 worker 会被误杀。我们的 `events.jsonl` 有 `ts`，判 `ts[i]-ts[i-1] < 30000` 即可；
- 60 分钟同结果硬顶我们做不了（没有结果哈希的稳定来源），**留 R2**。

### 3.6 MCP 网关两 schema（v2 §2.5-25 **确认**）

- 模型只见两个稳定工具：`cindy_mcp_list_tools` / `cindy_mcp_call_tool`（`cindy-bridge-source.ts:13-18` 头注释）[S]；完整目录留在 bridge 内，调用时「按 server/tool 路由，并把真实 `mcp__<server>__<tool>` 身份交给 Host 审批与审计」（`:18`）。
- **未披露 schema 的调用在弹权限前即 fail-closed**：`:5266-5276` 的注释写死了顺序理由——「若等到工具实现里才拦，这次弹框已经发生了」。实现是 `markPermissionSkipped(toolCallId)` 后 return，让 `execute` 的门记账并回路标；模型补完 `list_tools` 重发才正常过一次权限 [S]。
- 探测预算：每个 server 的 `initialize + tools/list` 总预算 **10s**（低于 Pi RPC 30s ready 门槛），实际调用保留 **600s**（`pi-harness.md:55-57`）[D]。

**→ 我们怎么改（A8，G15 蓝图确认）**：v2 的判断正确。补两条实现细节：

1. **披露门必须在权限门之前**（Cindy 的注释就是理由）——否则用户会为一个「注定失败」的调用点一次同意；
2. **按 `callId` 记账**，防止并行两次调用时第二次因「此时已披露」被静默放行（`:5272-5274`）。

### 3.7 状态与恢复

- **Session 是唯一真相**：worker 的生命周期 `idle/running/done/error` 落在 `orca_workers`；archive 只改 DB 与 UI，「DB 记录保留」（`orca-team-architecture.md:50`）。
- **启动失败清理契约**：未确认退出不放目录租约（v2 §1.5 已记，**确认**）。
- **二段派单的幂等**：凭据在 lead 首条输入 accepted 前持久化；invoke 前转 `uncertain` + 进程内 tombstone；「多个窗口可能同时恢复同一条 `pending`，因此 Main 进程还要按 Lead、Worker 与快照时间建立共享 claim；同一 assignment 的并发或后续请求共用第一次派发结果，最终只调用一次 Worker 投递」（`orca-team-architecture.md:160-165`）[D]。**这是分布式幂等的好范本**。
- **worktree 回收**：archive 后 worktree 交 `scheduleWorktreeRecycleForStatusChange` 后台处理，**不与状态落库同步**（`:54`）[D]。

**→ 我们怎么改（A9，G29 补充）**：「dispatch 只发生一次」这条对我们直接可用。我们的 daemon 现在可能对同一节点重复 `spawnWorker`（崩溃重启后）。落法：`node.json` 增 `dispatch_token`（`sha1(node + spec.mtime + attempt)`），spawn 前 `if (node.dispatch_token === token && existsSync(worker.json)) skip`；spawn 成功后写 token。比 v2 §S3 的纯 pid 检查更稳。

---

## 4 UI

Cindy 的协同 UI 有三次改版，当前形态（`orca-team-architecture.md:227-237`）[D]：

1. **不跳独立页**：普通 Lead route `/cc-agent/<leadSessionId>` + **右侧栏「协同」tab**；worker 列表与 focused worker 的会话流由 `right-sidebar/plugins/orca-workers` 挂载。协同 tab 是 **singleton**，进行中常驻；点 X = 结束协同（先弹确认）。
2. **worker 不进侧栏**：`isOrcaWorkerSession(session) => session.orcaRole === 'worker'` 直接过滤掉；worker deep link 被解析成 `<lead>?worker=<id>` 并转进协同 tab state。
3. **worker 的异常汇总到 lead 行**（`:237`）：Lead 行的状态点、项目折叠灯、rail 瓷砖、排序钉住、Dock 角标都按 **「Worker 出错(红) > Worker 等待确认(蓝) > Lead 自己」** 取一档；「红/蓝同样盖过运行中」；**worker 的完成不汇总**。
4. **聚合是只读派生**：「汇总结果**不得写回** `sessionAttentionStore`」——因为那份会同步到 Main 并被「导航即已读」清掉，「会破坏 Lead 自身的 attention 生命周期」。Dock 角标一个 Lead 只算 1。

**→ 我们怎么改（A10，G36 的 UI 一半）**：三条直接可用：

- **「等待确认」压过「运行中」**：我们的 run 行现在只有 running/done，一个在等审批的节点在树上和跑着的节点长得一样。改成两态点后，`blocked(橙) > running(蓝) > done(绿)`，且 **blocked 优先来自子节点**（聚合取最紧急，与 Misaka A8 同解）。
- **聚合不写回**：我们的 `run.json.summary` 若被 UI 写状态，就会和多端（若将来有）打架。保持「UI 只读派生」。
- **worker 的完成不打扰**：只有 `failed` 与 `waiting-approval` 冒泡到 run 行，`done` 不冒泡。否则 run 行永远在闪。

---

## 5 值得抄（A1…A10）

| # | 机制 | 为什么 | 落点 |
|---|---|---|---|
| **A1** | **`send` 与 `steer` 语义分离**（`base-agent.ts:2428-2447`） | 一个布尔参数会同时污染 usage/turn/tool-loop/UI 状态 | `ev_tell{mode}`；`spec.reply` 不重置计数窗口（G11） |
| **A2** | **桥 = 同构建字符串常量 + 每次 startSession 覆写**（`:27,56,83`） | 防「旧桥配新宿主」；且逼着桥只依赖引擎 API，不偷偷 import 宿主 | `aica-pi/extensions/*` 头写版本 + daemon 启动校验（G14） |
| **A3** | **权限门顺序 + 控制面永不放行 + deny 带理由**（`:5121-5326`、`:5243`） | 顺序错了会「为注定失败的调用弹窗」；控制面写入是权限系统的自我提权面 | `gate.ts`：deny → rules → grant → approve；`AICA_STATE`/`aica-pi/`/`spec.json` 恒问（G3/G33/G30） |
| **A4** | **Auto 档 = 第二模型评审一个 gate-req，失败即 deny**（`auto-review-policy.ts:1-16`、`pi-harness.md:332`） | 「用户不用点」与「不放松」可以兼得；重点是 fail-closed 而不是 fail-open | `spec.permission:"auto"` + `review-req.json` + 单轮 JSON 评审（G34） |
| **A5** | **「只有真实派发才静默」+「按同一通道验收」+「忙碌不丢消息」**（`orca-bridge-prompt.ts:39-54,68-83`） | 三条不变量把「假成功」堵死了——这正是我们「父等不了子」的另一面 | `wait_on` 强制非空；wait 期间 daemon 不下发；`result.status` 区分 `waiting`（G6） |
| **A6** | **只读、分页、不唤醒地读父会话**（`orca-team-architecture.md:166-172`） | portable handoff 的最小可用子集，零迁移成本 | `ar_read --node --since --limit`（G39 降级版） |
| **A7** | **循环判据的数值与节奏豁免**（`maker-core-and-agent-behavior.md:39-47,64-83`） | 4/30/60min/128·32·90%/30s 豁免是调过的；我们自己拍脑袋一定误杀轮询 | `gate.ts` 连续计数 + `ts` 间隔 ≥30s 不计（G32，取代 v2 的 5/15） |
| **A8** | **披露门在权限门之前 + 按 callId 记账**（`cindy-bridge-source.ts:5266-5276`） | 少弹一次无用窗；防并行调用绕过 | `aica_mcp` 网关（G15） |
| **A9** | **派发幂等 token（多窗口共享 claim）**（`orca-team-architecture.md:160-165`） | 崩溃重启重复拉起是我们 G5/G29 的真实痛点 | `node.dispatch_token` + `worker.json` 双条件（G29） |
| **A10** | **聚合取最紧急 + 只读派生不写回 + 完成不打扰**（`:237`） | 三个小规则决定「树上看着乱不乱」 | `index.html` 树行状态点 + run 行聚合（G36） |

**补充两条**：

- **A11 Full access 契约的诚实写法**（`pi-harness.md:26-35`）：明写「该档与原生 Pi 对齐，不得用正则硬拦」「Full access 选择即接受父进程环境里的代理 token / 网关 key / BYOM key / 外部 MCP header **可能被读取**」「真正的强隔离需要 OS 级手段，本阶段未接入」。→ 抄进我们 README 与 `permission:"full"` 的 UI 副标题（v2 G25 **确认，且这是最好的范本**）。
- **A12 `--append-system-prompt` 传路径不传文本**（`pi-harness.md:17-20`）：Windows spawn 命令行预算是硬约束。→ `daemon.ts` 若给 pi 追加 `context.md`，一律写文件传路径。

---

## 6 不抄

1. **三 harness adapter + translator 三套**。`claude-code/index.ts` 430 KB、`pi/index.ts` 507 KB、`pi/cindy-bridge-source.ts` 258 KB。我们只有 pi（v2 G9 的 claude/codex 是摆设），**不要**为了对称去建抽象层。
2. **Orca 的 21 个 MCP 工具**（`orca-team-architecture.md:109-129`）。里面有 6 个是「排队消息操控」（`update/cancel/merge/steer/move/get_worker_queue_status`），前提是「worker 是长驻会话 + 有输入队列」。我们是文件态一次性进程，**没有队列就没有这些**。只抄 `send_to_worker` / `interrupt` / `list` 三个语义。
3. **device-link / remote desktop / SSH remote-forward**（`:43,53-55`）。整套是「多端 + 被控端镜像」，与我们「本机单人」前提相反，且是 Cindy 最大的复杂度来源之一。
4. **worker worktree 自动回收**（`:54,261-266`「失败补偿先等待后台 checkout 收口，再走 cancelPrecreatedWorktree 的封存、preserveDirty 与所有权检查；保留结果写日志，绝不强删」）。v2 G20 已排 R3，现在抄会引入大量 Windows 上的 git 边界。
5. **Auto 档的凭证正则体系**（`cindy-bridge-source.ts:5208-5234` + `shared/sensitive-credential-paths`）。文档自己说「文本拦截不是安全边界」；我们用路径白名单替代。
6. **「不能在 pane 里直接答」的交互**（`orca-bridge-prompt.ts:72,110`）。Cindy 强制「消息是唯一通道」是因为它的 UI 是三栏；我们 HTML 里节点详情本来就能直接回，**不要**为了忠实而去掉直达通道。

---

## 7 出处

**仓库内规则文档（官方「权威」标记）**

- `docs/dev-rules/pi-harness.md:8-35` — 架构总览、权限执行、**Full access 契约**、MCP 桥、`--append-system-prompt` 传路径。
- `docs/dev-rules/pi-harness.md:319-332` — 维护不变量（auto 档 dispatcher fail-closed）。
- `docs/dev-rules/orca-team-architecture.md:33-55` — 目标与边界（worker 是完整会话、当前边界清单）。
- `docs/dev-rules/orca-team-architecture.md:71-90` — 数据模型（`orca_role` vs `parent_session_id`、partial unique）。
- `docs/dev-rules/orca-team-architecture.md:105-150` — 21 个工具、身份路由、worker 权限偏好。
- `docs/dev-rules/orca-team-architecture.md:158-176` — 二段派单与幂等 claim。
- `docs/dev-rules/orca-team-architecture.md:202-225` — Codex Lead 身份（`_meta.threadId`、`mcp-session-id` 不作路由）。
- `docs/dev-rules/orca-team-architecture.md:227-237` — UI / 协同 tab / worker 不进侧栏 / attention 汇总。
- `docs/dev-rules/orca-team-architecture.md:306-385` — 协同运行时行为契约（三条 turn 结束不变量、消息派发与 auto-bridge）。
- `docs/dev-rules/maker-core-and-agent-behavior.md:30-102` — ToolLoopGuard 全节（判据、豁免、复核预算、脱敏顺序）。

**源码（`file:line`）**

- `packages/maker-core/src/agents/base-agent.ts:6,2383-2532,2692,3034` — `NotSupportedError` 契约、`AgentSessionHandle`、`BaseAgent`、统一不支持出口；`:2428-2447`（`send` vs `steer`）、`:2452-2459`（`requestGracefulStop`）、`:2472-2482`（后台任务）、`:2524-2525`（`events()`）。
- `packages/maker-core/src/types/events.ts:27-36,178` — `AgentEventType` 与 `AgentEvent`（含 `tool_result` / `tool_result_full` 分层）。
- `packages/maker-core/src/agents/pi/cindy-bridge-source.ts:3-28` — 桥的职责与覆盖机制；`:56,83`（文件名 / 源码常量）。
- `cindy-bridge-source.ts:153-155` — `PERMISSION_TITLE` / `PERMISSION_ALLOW`。
- `cindy-bridge-source.ts:1888-1936` — `currentPermissionState()`（现读 perm 文件、fail-closed、reviewOnly 例外）。
- `cindy-bridge-source.ts:5121-5326` — `pi.on('tool_call')` 全段（14 步判定顺序、`ctx.ui.input` 信封、canonical 路径改写）。
- `cindy-bridge-source.ts:5144-5160` — 写类工具的 turn-change capture。
- `cindy-bridge-source.ts:5203-5243` — `controlPlaneWrite` 与 Full access 例外。
- `cindy-bridge-source.ts:5266-5276` — MCP 披露门在权限门之前 + `markPermissionSkipped`。
- `packages/maker-core/src/agents/pi/auto-review-policy.ts:1-16,56-60` — Auto 档 adapter 与可达面说明。
- `packages/orca-workflow/src/orca-bridge-prompt.ts:24-97` — `renderOrcaLeadSystemPrompt`（工具面、派发信号、静默结束规则、10 条 Rules）。
- `packages/orca-workflow/src/orca-bridge-prompt.ts:99-124` — `renderOrcaWorkerSystemPrompt`（身份、`send_to_lead` 强制、不问不扰、subagent 边界）。

**本仓对照**

- `docs/prd-workbench-v2.md` §1.5、§2.1-1/5、§2.2-9/10、§2.5-25/26、§3（G3/G11/G12/G15/G29/G30/G32/G34/G36/G39）。
- `src/envelope.ts:20,26,30`（depends/mode.shape/budget）、`src/daemon.ts:152,244`（session-dir/spawnWorker）、`workbench/server.ts:233,335`（apiView/crumb）、`aica-pi/extensions/events.ts:35-36`（tool_execution 发点）。

**需复核（未能从快照确认）**

- Cindy 的确切 commit 与发布版本（tarball 无 `.git`，`package.json` 无 `version`）→ 若要引用长期结论，需 `git clone` 补 commit。
- `packages/lizi-mcps/src/orca/server.ts` 的 `createOrcaMcpServer` / `DirectToolSink` 具体签名（本文只依文档 `orca-team-architecture.md:137` 转述）。
- `apps/desktop/src/renderer/features/right-sidebar/plugins/orca-workers` 与 `orcaLeadWorkerAttention.ts` 的实现细节（本文只依文档 `:229-237` 转述）。

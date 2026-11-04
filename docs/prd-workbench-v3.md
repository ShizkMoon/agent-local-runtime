# aica Workbench v3 PRD — 七家 harness 的绝对值与我们的落点

> 版本：v3 草案（2026-11-04）。上游：[prd-workbench-v1.md](prd-workbench-v1.md)（定位与基线）、
> [prd-workbench-v2.md](prd-workbench-v2.md)（六家深研 + S1–S15 执行）。v3 不重复 v1/v2 的画像与执行细节，
> 只写三件 v2 没解决的事：**七家的横向绝对值**、**"基础功能完整 + 最高质量 harness"的可核对定义**、
> **UI 重心与状态表达的硬约束**，以及把它们拆成 R2 的 S16–S27。
> 研究证据：[research/](research/)（deepseek-harness / opencode / claude-code / codex / t3code /
> oh-my-pi / misaka-agent / cindy / ux-synthesis）。本机实现仓：`C:\Repos\agent-local-runtime`。

---

## 0. 一页结论

**已经成立的（不要重做）**：事件为源（`runs/<id>/nodes/<path>/events.jsonl`）、节点租约锁（`worker.json`）、
审批门（`aica-pi/extensions/gate.ts`：三档 + approve/deny/deny_paths/rules + grants + doom-loop guard）、
节点级持久 session（`--session-dir`）、角色 prompt（worker/orchestrator/reviewer）、art:// 物化、
spent 回填（`usage.json`）、hook 落定派发（`node_settled.mjs`）、桥 + 壳（`:4399` + MyGo 无控制台窗口）。

**v2 之后的真实缺口**（不是"没字段"，是"没成为体验"）：

1. **过程不可见**：工具调用在 UI 里被压成一句"已执行 echo …（退出码 0）"，看不到命令、参数、输出、
   耗时、退出原因；`file_edit` 事件没有 diff 呈现；`retry/compaction/abort/loop` 这类"最有信息量"的事件
   在界面上几乎不可见。**这是"像不像 CodingAgent"的分水岭。**
2. **重心不稳**：中栏一屏里同时出现标题（goal）、用户气泡（同一句 goal）、spec 卡（again goal + accept）、
   结果摘要、完成标记——**同一件事说了四遍**，真正需要读的那一行（结果/错误/待裁决）反而最弱。
3. **等待与失败没有形状**：`进行中` 只有一个小圆点 + 一个跑秒的表；失败卡片把错误截成
   `Worker 退出（code -1）· Error: spa…`；断线（SSE 断、daemon 崩、bridge 重启）没有专门状态，
   用户分不清"在跑"和"卡死"。
4. **上下文与预算是黑箱**：`usage.json` 有 token 数，但没有"这一轮花了多少、还剩多少、什么时候会压缩"的
   可见账本；`spec.budget.tokens` 没有执行点（只有 `minutes` 会超时杀）。
5. **编排只有骨架**：`depends/wait_on/split/hook_dispatch` 都在，但没有"子代理"这一层的 UI 与语义
   （派生、隔离、汇总、取消一个子代理）；`MAX_WORKERS=2` 是全局常量，不是每 run 的并发策略。
6. **恢复靠运气**：daemon 崩后靠 `worker.json` 租约跳过重复拉起，但"崩在半路"的节点没有 checkpoint、
   没有"从第 N 步继续"、没有 fork；删 run 会连带删掉唯一证据。

**v3 的三条赌注**（其余都从属于它们）：

- **B1 每一步可见**：任何节点在任意时刻，UI 必须能回答"它现在在做什么、做到哪一步、花了多少、
  下一步要等谁"。不可见即视为不存在（哪怕事件已经写了）。
- **B2 一屏一个重心**：同一信息只出现一次；重心必须是"现在需要你判断的东西"，不是"任务标题"。
- **B3 可恢复是默认值**：任何进程（daemon / bridge / 壳 / 窗口）死掉重开，界面必须与磁盘真相同构，
  且半路节点有明确的三种归宿（继续 / 重来 / 归档），不允许"僵尸进行中"。

**v3 不做的**：云同步与多用户、macOS/Linux 壳（壳保持 Windows-only）、自研模型、把 pi 换掉
（worker 仍是 pi，七家里我们抄机制不抄实现）、插件市场。

---

## 1. 七家研究增量

> 证据见 `research/*.md`（每条结论都带 `file:line` 或官方文档 URL）。本节只写**改变我们判断的增量**：
> 与 v2 §1 重复的不重述，只写"v2 说错/漏说"和"七家收敛"的部分。

### 1.1 DeepSeekHarness（我们脚下的 harness）

我们每天跑在它上面，但 v2 从没写过它。三件直接影响我们设计的事：

1. **审批裁决是闭集且 fail-closed**：`allowed-once | rejected | cancelled | unavailable`，应答者缺失/抛错一律
   归一成 `unavailable`（不是"拒绝"）。我们现在只有 allow/deny 二元，"没人答"、"被撤回"、"人拒了"
   在审计里不可分——UI 文案与统计都会错（→ M1）。
2. **审计对 + 可见性分离**：`asked` 与 `decided` 用同一个 id 配对，并带一个"只进日志、不进 prompt"的
   surface 位。这解释了为什么同一个事件流可以既喂模型又喂审计（→ M12）。
3. **溢写与诚实截断**：大结果落盘 + locator + retrievalHint；工具结果自带
   `truncated/total/offset`，不完整就不显示统计。我们现在是 `PREVIEW=300` 直接丢内容（→ M8）。
4. 另外两条与我们直接相关：**step 级工具准入**（每步一个工具集合，批准后释放）与
   **会话格式版本化 + 相邻迁移**（pi 升级会改 session 格式，我们没有防线）。
5. **Agent Notes 制度**：一条决策一个文件。我们的 PRD 已经很厚，但决策散落在 PRD 正文与 commit message 里，
   需要单独的 `docs/notes/` 承载（本 PRD 的每条 S 切片验收后各留一条）。

### 1.2 OpenCode（sst/opencode）

v2 完全没写它，但它是七家里**权限模型最完整、事件投影最讲究**的一家，而且没有"企业级"包袱，可以直接抄：

1. **资源级规则**：`Rule{action, resource, effect}` 数组，last-match-wins，**求值前先对所有 resource 做 deny 预检**
   （`core/src/permission.ts:94-104,176-189`）。我们现在 `deny` 只到工具名、`rules` 是 args 正则，
   表达不了"允许 `git *`、拒绝 `rm *`"（→ M2）。
2. **外目录审批**：路径先判"在不在工作区内"，外部路径先发 `external_directory` 审批（可记住目录），
   再走读写审批（`core/src/file-access.ts:120-156`）。我们的 `deny_paths` 是字符串包含，既误伤又无法临时授权（→ M2）。
3. **once / always / reject+feedback 三值，且 always 只存"这次命中的资源"**（`core/src/permission.ts:306-366`）；
   一个 reject 拒绝同 session 所有 pending（→ M4）。
4. **工具输出截断契约**：2000 行 / 50KiB，超限保留头部 + 全文落 `tool-output/` + marker 带行范围与绝对路径；
   shell 另用**尾部截断**（`core/src/tool-output.ts:20-24,84-124`、`core/src/shell.ts:244-259`）→ 模型看到"最后 2000 行 + 全文在哪"（→ M8）。
5. **工具状态机 + 流式投影**：tool `state` 四态（streaming/running/completed/error）+ `session.text.delta`，
   按 `call_id` 折叠（`schema/session-event.ts:335-570`）。**我们现在的 `transcribe.ts` 直接 SKIP 了
   `message_update`，等于把"正在跑"和"流式文本"全丢了**（→ M14，这是 S17/S25 的病根）。
6. **队列 vs steer 的诚实语义**：运行中的 reply 只能 `queue`（本轮结束后消费）或 `interrupt`（abort 后重拉），
   不存在"真插话"（`core/src/session/inbox.ts:53-57,567-586`）。我们的 `apiReply` 对 running 节点写
   `spec.reply` 却**当前进程看不到**，这是静默失败（→ M9）。
7. **续跑预算**：turn 开始写 claim，启动扫描，`resume_attempts += 1`，>10 → `failed("resume exhausted")`
   （`core/src/session/execution.ts:73-143`）。我们的租约只防重复拉起，不防"重拉→再崩"无限循环（→ M13）。
8. **压缩摘要模板**：固定七段（Objective/Requirements/Decisions/Work State/Next Move/Relevant Files/Important Context），
   并要求保留精确路径/命令/错误串（`core/src/session/compaction.ts:166-205`）。我们现在 `result.summary` 是自由文本（→ M12）。

> 不抄的：后台服务/鉴权/HMAC、share 链接、MCP/Code Mode 的工具目录预算（R3 再说）。

### 1.3 五家复核：v2 说错/漏说的

| 产品 | v2 结论 | 复核 | 影响 |
|---|---|---|---|
| Claude Code | `Task` 是子代理 | **修正**：2.1.318 起子代理是 `Agent`（后台默认、可命名、`SendMessage` 寻址、`isolation: worktree\|remote`）；`Task*` 变成**共享任务板**（`blocks/blockedBy/owner/deleted`） | 我们的 task board 字段直接对齐；子代理需要"命名 + 可寻址 + 隔离"三件套（→ M10） |
| Claude Code | 六档权限 | **确认并补一档**：`dontAsk`（会问即拒）用于无人值守；另有 `critical paths` 硬拒（`rm/rmdir` 命中根/家/工作目录，任何档与 `PreToolUse:allow` 都无权放行） | 这是唯一挡得住 `rm -rf` 且不被 grant 绕过的机制（→ M3） |
| Codex | 审批两轴 + 11 个 hook 事件 | **修正**：hooks 实际 **14** 个（多 `Interrupt/PreModelRequest/PostModelRequest`）；`untrusted` 未退役（内部策略档），`on-failure` 只是 `on-request` 的 serde 别名 | hook 清单与策略映射要按 14 事件重排 |
| Codex | 无 | **新增**：`guardian` 自动审批评审子系统——`risk × user_authorization` 双维 + 人话 `rationale` + **遇压缩即作废**（`IncompatibleCompaction`）+ 被拒后可用 `ApproveGuardianDeniedAction` 推翻 | advisor/reviewer 的零新进程蓝本（→ M11） |
| T3 Code | 事件溯源控制面 | **确认并具体化**：事件带 `seq + commandId`；`process-bound effect` 不得重放；回复有 `queue/steer/restart` 三态；快照三件套 `latest_seq/snapshot_seq/pruned_below` | 直接改我们的 pendingNodes 与 view 增量（→ M5/M9） |
| Oh My Pi | 运行时纠偏 | **确认并具体化**：审批是 `tier × tool policy × user policy` 解析器；`restricted_paths`（必问）与 `deny_paths`（必拒）分开；grant 记 tier；loop guard 用**跨轮 canonical hash** 而非单调用计数 | 我们的 gate 是"工具名白名单"，扩展/MCP 场景必漏（→ M2） |
| Misaka-Agent | DAG 研究图 | **新增**：波次屏障 + 层间 reconciliation（同问合并）、串行预热、持久 phase + 每阶段幂等重建、driver 租约替 pid 检查 | "多 agent"真正的难点是**层间收敛**，不是画图（→ M10/M11） |
| Cindy | 拦截式审批 + Orca | **确认并具体化**：`send` 与 `steer` 必须语义分离；权限门顺序 `deny → rules → grant → approve`；`auto` 档 = 第二模型评审一个 gate-req 且**失败即 deny**；忙碌不丢消息；派发幂等 token | 顺序错了会"为注定失败的调用弹窗"（→ M1/M2） |

### 1.4 七家收敛出的十二条硬机制（v3 的吸收清单）

> 只有"≥2 家独立实现 + 我们能落地"才进表。落点列已对到本仓文件；成本 S/M/L 指单切片工作量。

| # | 机制 | 谁有 | 落点 | 成本 | 进哪片 |
|---|---|---|---|---|---|
| **M1** | **审批决策闭集 + fail-closed + 无 UI 即拒**（`allowed-once/rejected/cancelled/unavailable`；超时可配，默认 2min） | DSH、OMP、T3、Cindy | `aica-pi/extensions/gate.ts`、`events.jsonl` | S | S19 |
| **M2** | **审批三件套分离**：`deny`（恒拒，不弹窗）/ `restricted`（必问，不可记住）/ `grant`（记住，按 `工具 × tier × 目标前缀`） | CC、OMP、Codex、Cindy | `envelope.ts` + `gate.ts` + `grants.json` | M | S19 |
| **M3** | **危险路径硬拒**（`rm/rmdir` 命中根/家/工作目录；控制面文件 `AICA_STATE`/`aica-pi/`/`spec.json` 恒问） | CC、Cindy | `gate.ts`（先于一切规则） | S | S19 |
| **M4** | **挂起时的输入 = 拒绝 + 反馈**（不是新消息）；审批卡的动作与文案由规则生成，不由前端硬编码 | OMP、T3、Codex、DSH | `server.ts apiReply` + UI 审批卡 | S | S19 |
| **M5** | **事件 `seq` + 命令幂等 id；process-bound effect 不重放**（pid 死 → `orphaned`，不再二次 spawn） | T3、Cindy | `daemon.ts`、`runs.ts pendingNodes` | M | S21 |
| **M6** | **turn 结局闭集 + reason**（用户停/超时/被替换/预算/异常）+ `abort.reason` + `duration_ms` | DSH、Codex | `envelope.ts`、`daemon.ts` | S | S17 |
| **M7** | **每轮 checkpoint + 区间重跑 / rewind / fork**（文件级快照，不依赖 git） | CC、T3、DSH | `runs.ts`、`daemon.ts`、新 `fork` 路由 | M | S21 |
| **M8** | **上下文可见**：压缩三事件 + 压缩前后 token + 大结果溢写（spill + locator）+ 结果诚实性（`truncated/total/offset`） | DSH、CC、Codex | `transcribe.ts`、UI step | M | S20 |
| **M9** | **回复投递三态 `queue/steer/restart` + 准入语义**（ack=已准入，不是已完成） | T3、OMP、Cindy | `envelope.ts`、`daemon.ts`、`server.ts` | M | S22 |
| **M10** | **编排的任务板化**：`blocks/blockedBy/owner` + `wait_policy: all\|any` + 波次屏障/层间 reconciliation + 子代理"命名 + 寻址 + 隔离" | CC、Misaka、Cindy | `runs.ts`、`daemon.ts`、`aica-pi/extensions/tools.ts` | L | S22 |
| **M11** | **裁决分级**：reviewer 三档严重度（note/warn/block）+ 免疫期；软失败由上层裁决 `retry/continue/fail`；errata 沿后代传播 | OMP、Misaka、Codex(guardian) | `prompts/reviewer.md`、`daemon.ts` | M | S23 |
| **M12** | **可观测的审计面**：`asked/decided` 配对 + 只进日志不进 prompt 的 surface 位 + hook 审计 + 上下文报告 | DSH、Codex、CC | `transcribe.ts`、`events.ts`、UI | S | S26 |
| **M13** | **续跑预算 + 遗留终态补齐**：`resume_attempts` 上限、遗留 `running` 工具标 `aborted`、恢复提示"从停下的地方继续" | OpenCode、Misaka | `runs.ts`、`daemon.ts` | S | S21 |
| **M14** | **流式投影**：`message_update → agent_delta`、`tool_execution_update → tool_update`、按 `call_id` 折叠同一工具 | OpenCode、T3 | `transcribe.ts`、`view.ts`、UI | M | S17 |
| **M15** | **分组与 verbosity 投影**：activity/reasoning/exploration 分组 + low/medium/high 三档（纯投影，不改事件） | OpenCode、DSH | `view.ts`、UI | S | S25 |

**不进表的**（看了但判定不值）：Codex 的 `granular` 审批子档（我们用不上那么细）、
Misaka 的 DAG 可视化（我们的节点树已经够）、T3 的多 provider 运行时（pi 单引擎够了，R3 再议）、
Claude Code 的 44 工具面（多数是产品功能不是 harness 机制）。

### 1.5 三条"看着好但先不做"

1. **MCP 客户端**（5/7 有）：worker 现在显式 `--no-mcp`，接 MCP 要重做工具来源校验（T3 A5 的教训），
   风险大于收益，进 R3。
2. **沙箱**（3/7 有）：本机单人，OS 级隔离（job object / AppContainer）成本高，先用"硬拒 + 必问"兜住。
3. **plan mode**（4/7 有）：不需要新机制——Claude Code 的做法是"spawn 时收窄工具白名单 + `ev_gate` 批计划"，
   我们已有两者，进 R3 只需拼装。


---

## 2. 能力基线：什么算"基础功能完整"

### 2.1 判据

一条能力只有同时满足三条才算"有"：

1. **有执行点**：代码里存在唯一的、可指名的实现位置（文件:行），不是散落的临时判断；
2. **有投影**：UI/API 能看到它的结果（不可见＝不可用）；
3. **有验收**：能用一条命令或一条 UI 断言复现（见 §7 自检门）。

只满足 1 算 **半**；只有字段/文档算 **无**。

### 2.2 清单（40 条）

| # | 能力 | 七家共识 | 我们 | v3 裁决 |
|---|---|---|---|---|
| A1 | 会话主循环 + turn 边界 + 流式增量 | 7/7 | 有（pi + `transcribe.ts`） | 保持，补 turn 级 UI |
| A2 | 会话持久 / 多轮继承 | 7/7 | 有（`--session-dir`） | 保持 |
| A3 | 会话分叉（fork from turn） | 4/7 | 无 | **S21** |
| A4 | 中断后可继续（不丢上下文） | 7/7 | 有（reply 续跑） | 保持 |
| A5 | 并发控制（每 run 上限 + 队列） | 5/7 | 半（`MAX_WORKERS=2` 全局） | **S22** |
| A6 | 超时 / 重试 / 退避 | 7/7 | 半（`minutes` + fallback 一次） | **S20** 补 tokens |
| A7 | 取消语义（进程树 + 幂等 result + 审计） | 6/7 | 有（`abortWorker`） | 保持 |
| A8 | 长任务心跳与进度 | 6/7 | 半（事件有，UI 弱） | **S17** |
| B1 | token 记账 | 7/7 | 有（`usage.json`） | 保持，做成账本 |
| B2 | 上下文压缩（可触发、可见、不丢关键） | 5/7 | 无（透传 pi，未投影） | **S20** |
| B3 | 文件引用 / @ 语法 | 6/7 | 无 | P2（R3） |
| B4 | 输入物化（跨节点产物引用） | 3/7 | 有（art://） | 保持 |
| B5 | 经验注入 | 3/7 | 有（`learned.md`） | 保持 |
| B6 | 预算前置拦截（tokens） | 4/7 | 无（仅 minutes） | **S20** |
| C1 | 工具按 spec 授权 | 7/7 | 有（`toolAllowlist`） | 保持 |
| C2 | 工具调用可视化（参数/输出/耗时/状态） | 7/7 | 半（只剩摘要一行） | **S17** |
| C3 | 大输出落盘 + 截断 | 6/7 | 有（artifacts + cap） | 保持 |
| C4 | 持久 shell（cd/环境在工具间保持） | 4/7 | 需复核（依赖 pi） | 复核后定 |
| C5 | diff 呈现与"接受/回滚" | 5/7 | 无 | **S18** |
| C6 | 并行工具调用 | 4/7 | 有（pi） | 保持 |
| D1 | 三档权限（supervised/edits/full） | 5/7 | 有（gate） | 保持 |
| D2 | 规则匹配（deny/rules/paths） | 4/7 | 有（gate） | 保持 |
| D3 | 审批卡在对话流内 | 6/7 | 有（S5） | **S19** 重做呈现 |
| D4 | 审批审计对（ask/decide） | 3/7 | 有（事件） | 保持 |
| D5 | plan mode（只读规划） | 4/7 | 无 | P1（R3） |
| D6 | 沙箱（命令/路径级隔离） | 3/7 | 无 | 不做（本机单人，代价>收益） |
| E1 | 节点树（parent/children/depends） | 4/7 | 有 | 保持 |
| E2 | join / 等待汇合 | 3/7 | 有（`wait_on`） | 保持 |
| E3 | 子代理派生（隔离上下文 + 汇总） | 5/7 | 半（仅 hook dispatch） | **S22** |
| E4 | 资源预算与并行度策略 | 4/7 | 半 | **S22** |
| E5 | 角色（worker/orchestrator/reviewer） | 3/7 | 有 | 保持 |
| F1 | 事件为源 + 幂等投影 | 4/7 | 有 | 保持 |
| F2 | 租约锁防重复拉起 | 3/7 | 有 | 保持 |
| F3 | 崩溃恢复（半路节点有归宿） | 5/7 | 半（只跳过，不给归宿） | **S21** |
| F4 | 归档 / 清理 / 删除 | 5/7 | 半（仅 DELETE） | **S21** |
| G1 | 每次调用可追（transcript / stdout.log） | 6/7 | 有 | 保持 |
| G2 | 成本与耗时看板 | 5/7 | 半（spent 汇总） | **S20** |
| G3 | 健康自检 / 诊断包 | 4/7 | 无 | **S26** |
| H1 | hooks（落定钩子） | 4/7 | 有 | 保持 |
| H2 | MCP 客户端 | 5/7 | 无（worker 显式 `--no-mcp`） | P2（R3，需安全设计） |

统计：**有 21 / 半 9 / 无 9 / 待复核 1（C4 持久 shell）**。R2 吃掉"9 个半 + 5 个无"
（A3/B2/B6/C5/G3 五个无，外加 S17–S26 覆盖的九个半）；剩下 **D5 plan mode、H2 MCP 进 R3**，
**D6 沙箱不做**，C4 复核后定。**v3 的标准是"半清零 + 五个关键无补齐"**，不是全绿。

### 2.3 差距 Top 6（按用户可感排序）

1. 工具调用不可见（C2）——直接决定"像不像 CodingAgent"。
2. 一屏四遍同一句话（UI 重心）——直接决定"有没有重心"。
3. 失败/等待/断线无形状（A8 + G3）——直接决定"敢不敢信任"。
4. 无 diff（C5）——代码类任务无法复核，等于让人盲签。
5. 预算是黑箱（B6/B1）——不知道一次任务会烧多少。
6. 子代理只有钩子没有语义（E3）——"多 agent"名不副实。

---

## 3. 质量属性："最高质量 harness"的定义

### 3.1 六条硬属性

| ID | 属性 | 定义 | 度量 | 目标 |
|---|---|---|---|---|
| Q1 | 不静默失败 | 任何节点从 spawn 起 30s 内必有一个可见状态；无 `result.json` 必有 reason code | 扫 `events.jsonl` 找"有 spawn 无 exit"或"有 exit 无 result" | 0 条 |
| Q2 | 可解释 | 任一结论可回溯到具体事件行 + 工具参数 | UI 点击结论 → 展开原始事件 | 100% 节点可点开 |
| Q3 | 可恢复 | daemon / bridge / 壳任一重启后，视图与磁盘真相同构 | 杀进程重启 → 对比 `/api/v1/view` 前后 diff | 0 diff |
| Q4 | 省 token | 注入预算可测、压缩可见、前缀稳定 | 单节点注入量 + 压缩前后 token 曲线 | 注入 ≤ 6k；压缩有事件 |
| Q5 | 安全默认 | 未声明工具不给；deny 命中不弹窗直接 block；路径不可逃逸 | 用例集（越权/逃逸/规则命中） | 全绿 |
| Q6 | 快 | 首屏、增量、首事件 | 500 runs 下 `/api/v1/view` p50 | ≤ 100ms / 增量 ≤ 50ms / 首事件 ≤ 2s |

### 3.2 反模式（别人家踩过，我们正在踩）

| # | 反模式 | 证据 | 我们的现状 |
|---|---|---|---|
| A-1 | **事件泄漏**：原始事件直接铺开，界面变日志浏览器 | ux-synthesis C1（T3 / DSH / OpenCode / CC 四家收敛：主线只有对话，过程可折叠） | steps 平铺（S17 修） |
| A-2 | **等待态消失**：思考期间无输出，用户重复提交 | DSH §4.3、OpenCode §4.1（稳定 busy label + 已用时） | 一个小圆点 + 跑秒（S25 修） |
| A-3 | **错误吞掉**：失败被折叠成"完成" | DSH 四色错误、Codex `Declined ≠ failed` | `failed` 只有一行截断（S17/S25 修） |
| A-4 | **误批**：卡片一出现 Enter 就批准 | OMP 0.5s 忽略批准键、DSH pending 锁 | 无防误批（S19 修） |
| A-5 | **静默压缩**：模型"突然忘了" | OpenCode 压缩模板、DSH 压缩三事件 | 事件透传但未投影（S20 修） |
| A-6 | **父行看不出子在等审批** | Misaka `red ● blocked`、Cindy 红 > 蓝 > lead | run 行只看自己 status（S25 修） |
| A-7 | **自动滚动抢占**：用户上翻被拽回底部 | OMP / Cindy 明确列为不做项 | 未处理（S25 修） |
| A-8 | **假成功**：ack 当完成、排队当发送 | OMP admission 语义、Cindy「只有真实派发才静默」 | `apiReply` 对 running 节点静默写 spec（S22 修） |

### 3.3 自检门（可跑，进 CI 与手测清单）

- **G-1 契约门**：`ar` 每个子命令的入参/出参/envelope 字段有校验，坏输入不崩（当前 `ar check` 无参会
  抛 `ERR_INVALID_ARG_TYPE` 栈——反例）。
- **G-2 状态机门**：节点状态迁移只允许 `spec → waiting → done|failed|split`，非法迁移必报错。
- **G-3 恢复门**：随机 kill daemon 10 次，重新拉起后 pendingNodes 不重复拉起、无僵尸。
- **G-4 安全门**：越权工具、`..` 路径、deny 命中、规则命中的用例集全绿。
- **G-5 预算门**：mock 一个超 budget.tokens 的节点，必须在超之前拦截并给出可见事件。
- **G-6 UI 门**：`docs/research/ux-synthesis.md §6` 的验收清单，人工过一遍，允许"不通过"但必须写原因。

---

## 4. 架构 v3

### 4.1 三层与事实源（不变）

```
控制面  ar CLI (src/cli.ts)         ── 写 spec/result/events（唯一写入口）
执行面  pi worker (daemon 拉起)     ── 读 spec，调工具，写 result/events/usage
投影面  workbench/server.ts         ── 只读 runs/，聚合成 /api/v1/view，SSE 推 change
```

事实源永远是 `runs/<rootId>/` 下的文件；UI 不持有任何"真相"，重启后靠投影重建。

### 4.2 三本账（v3 新增）

1. **用量账本** `nodes/<path>/usage.json`：`{turns, tokens_in, tokens_out, cache_read, compacted_at[], budget}`。
   `backfillSpent` 现在只回填总数，v3 要按 turn 记账（`transcribe.ts` 已经能解析 turn 事件）。
2. **审批账本** `nodes/<path>/grants.json` + `approve_ask/approve_decide` 事件对：已有，v3 只做投影
   （"这个会话已批准过 3 类命令"），不再新增机制。
3. **恢复账本** `nodes/<path>/checkpoint.json`：`{last_turn, last_tool, phase, session_id}`，
   由 transcribe 在 turn_end 时写；恢复时据此给出"继续/重来/归档"三选一，而不是静默跳过。

### 4.3 锁与并发

- 已有：`worker.json` 租约（pid + started_at）、`daemon.pid` 心跳、壳的单实例锁。
- v3 增：每 run 的 `concurrency` 策略（`sequential` / `n`），由 `spec.budget` 或 run.json 提供，
  默认 2；全局上限保留作为安全阀。
- 并发调度的唯一入口仍是 `pendingNodes()`（按依赖 + live 锁过滤），不在 server 里另造队列。

### 4.4 边界防御（不新增机制，只保证不漏）

- 路径：`safeJoin` / `badSeg`（server）+ `paths.ts`（worker 侧）双份，任何新路由必须走这两处。
- 子进程：一律 `windowsHide + CREATE_NO_WINDOW`（`spawn_windows.go` 与 server 的 spawn 选项），
  壳的 GUI 子系统保证无控制台。
- env：`AICA_STATE` 必须是解析后的绝对路径（已修，见 `runs.ts`/`server.ts`）。
- 超时：所有跨进程等待都有上限（审批 5min、hook 5s、ready 15s、worker minutes）。

### 4.5 API 面增补（v3）

| 路由 | 用途 | 备注 |
|---|---|---|
| `GET /api/health` | daemon 心跳、runs 数、磁盘、版本 | G3 自检门的数据源 |
| `GET /api/runs/:id/node/:path/diff` | 该节点的文件变更（unified diff） | 由 `file_edit` 事件聚合 |
| `GET /api/runs/:id/node/:path/usage` | 用量账本 | S20 |
| `POST /api/runs/:id/node/:path/fork` | 从某 turn 分叉 | S21 |
| `GET /api/runs?filter=` | 过滤（kind/status/时间） | 治列表噪音 |

---

## 5. UI v3

> 定稿依据：[research/ux-synthesis.md](research/ux-synthesis.md)（八家对照矩阵、C1–C12 共识、D1–D12 分歧取舍、
> P1–P20 修订、U01–U28 验收）。基线规范是 doc 仓的 `docs/workbench-ui.md`；**本节是它的 v3 补丁**，
> 实现以本节 + U 清单为准，P 编号与 ux-synthesis §4 一一对应。

### 5.1 三栏职责（P1）

- **左 256 = 索引**：只显示需要看的 run（未决 / 进行中 / 最近 7 天）；`smoke-*` 之类测试 run 归到"测试"分组，
  不混进主列表（现状一屏 19 条里 12 条是 smoke）。
- **中 1fr = 唯一详情**：这条 run 的过程与结论只在这里出现。
- **右 380 = 决策队列**：只有"需要你 / 产物 / 子代理"三段，默认落"需要你"；**宽度锁定、不可拖拽、不做 docking**。

### 5.2 主线结构（P2 / P3 / P4）

中栏自上而下固定顺序：

```
标题栏（goal，只出现这一次）
用户气泡（只放用户原话）
结论块（本轮结果：一句话 + 关键数字）
工具组（组头统计 "3 命令 · 1 编辑 · 42s" → 组内单行摘要 → 展开原文）
内联审批卡（有 gate 时）
尾部状态（进行中 / 等你回复 / 已完成 / 排队中 / 等依赖 / 失败）
```

- **一条信息只出现一次**（P3）：goal 只在标题栏；spec/验收清单降级为一行折叠条「验收 · 3 条」。
- **结论优先于过程**（P4）：本轮结束后结论上浮到工具组之前，工具组折叠为统计行。
- **折叠不改变间距**（P7）：答复与相邻过程行之间恒为 12px，折叠与否一样。

### 5.3 状态（P5 / P6 / P8 / P9）

- **视觉 4 态**：`blocked / working / failed / done`；颜色只承担这四个语义。
- **文字 6 值**：进行中 / 等你回复 / 已完成 / 排队中 / 等依赖 / 失败；只在**中栏顶部与右栏条目各一次**。
- **聚合取最紧急**（P5）：run 行状态 = `max(子节点)`，优先级 `blocked > failed > working > done`；
  `blocked` 只来自"有未答 gate / 未答提问"；`done` 不冒泡（子代理完成不打扰父行）。
- **等待态**（P8）：一行 `正在运行 bash · 12s`（shimmer + 工具名 + 已用时），不显示 step 计数；
  `prefers-reduced-motion` 退化为静态点。
- **错误四色**（P9）：红=终结失败 / 琥珀=预算或输出上限 / 灰=被拒（可换法重试）/ 蓝=重试中；
  重试中不产生终结行。

### 5.4 审批卡与输入语义（P10 / P11）

- 卡片内容 = **命令原文（等宽）** + 一行"为什么要跑它" + **由服务端 `opts[]` 生成的动作** + 自由输入框；
  `always` 动作旁必须写清"记住什么"（记住的是这次命中的资源，不是整个工具）。
- 键盘：`Enter` = 允许一次；`Esc` = 拒绝；**卡片出现 500ms 内 Enter 不生效**（防误批）；
  有草稿时高亮默认落在"拒绝"。
- 有未答 gate 时，输入框 placeholder 变「回复 = 拒绝并说明原因」；发送的文字写入
  `gate-ans{decision:"deny", feedback}`，不是新消息。
- 关掉卡片 ≠ 批准：run 仍是 `blocked`，右栏仍有一条。

### 5.5 diff（P13）

- 文件级行 = 文件名 + `+N −M` + 状态；点开 = unified diff（前 40 行，超出标「还有 N 行」）。
- **R2 不出现"接受 / 回滚"**（负向）：先只读呈现，回滚随 S21 的 checkpoint 一起做。

### 5.6 分组与 verbosity（P14）

- 两档：**详细**（默认：组头统计 + 每条工具单行摘要）/ **紧凑**（只留结论 + 每轮一行「N 步 / M 秒 / Σtok」）。
- 档位存 `localStorage`；切换不改变间距；不做 `high`（每条 part 不折叠＝反模式 A-1）。

### 5.7 断线 / 通知 / 空态（P16 / P17）

- 断线 → 顶部黄条「桥已断开，正在重连」；重连成功后**以 `/api/v1/view` 全量校准**，不重放 delta；
  提供手动刷新。
- 通知只在"需要你"时发，文案 ≤200 字符；权限在**首次派发**时申请（已改，见 `index.html` composer）。
- 空态必须解释：为什么空（"这个 run 没有待裁决项"）+ 下一步能做什么。

### 5.8 子代理（P18）

主线只显示状态句（"子代理 research-2 正在读 3 个文件"）与树上的状态点；完整过程进右栏"子代理"页签；
子代理 `done` 不冒泡。

### 5.9 键盘（P15）

`Ctrl/Cmd+K` 命令面板 · `J/K` 选 run · `A` 批准首个待裁决 · `R` 拒绝 · `/` 聚焦输入 ·
`Esc` 关层（关层 ≠ 批准）/ 中断（有确认）。每个快捷键必须有鼠标等价入口；关闭弹层后焦点回到触发元素。

### 5.10 视觉与间距（P7 / P19）

- 间距刻度写死四档 `4 / 8 / 12 / 20`；一屏最多 2 个视觉块。
- 等宽字体**只**用于工具输出、代码、路径。
- 双主题 + 单一语义 token 表（两套值）：控件圆角 8 / 卡 12 / composer 14；动效 60/120/200ms，
  `prefers-reduced-motion` 下退化为无位移。

### 5.11 明确不做（P20）

docking / 四档折叠 / pane-tab 终端复用 / 自动滚动抢占视口（用户上翻时新事件不得拽回底部）。

### 5.12 验收

`ux-synthesis.md §6` 的 U01–U28；可自动化的进 S27 的 UI 断言，其余按"不通过必须写原因"人工过。

**验收口径修订（S25 实测后拍板）**：U04 中栏不放整张审批卡，只留一行指引（两处同源、右栏为准）；
U07 行高阈值从 ≤28px 放宽到 ≤36px（单行不换行仍必须）；U22（500 runs p50 ≤100ms 未达标，实测 163.7ms）
转 S26 处理，S25 的聚合不背这个指标。

---

## 6. R2 执行计划（S16–S28）

> **实施状态（2026-11-04）**：S16 ✅ S17 ✅（`c8ef2f5`）· S20 ✅（`7c083c0`）· S19 ✅（`62c1a77`）·
> S21 ✅（`f71cab5`）· S25 ✅（`bdafb81`）。`node --test workbench/test` 74/74 全绿；真机已验工具时间线、
> turn 结局行、审批卡三动作 + 500ms 防误批、预算拦截、孤儿节点归宿与 fork。待派：S18/S22/S23/S24/S26/S27/S28。

每个切片 = 一个可独立验收的改动；**所有切片默认由子代理执行，Lead 只审 diff + 跑验收**。

| 片 | 目标 | 主要落点 | 验收 | 覆盖 |
|---|---|---|---|---|
| S16 | 视图契约化：把 `apiView` 的投影抽成纯函数 + 类型 + 快照测试 | `workbench/server.ts` → 抽 `workbench/view.ts` | `node --test` 快照 3 个 run 目录 | 地基 |
| S17 | 工具时间线：`tool_call/tool_update/file_edit` 投影成 step 列表；补流式投影（`message_update→agent_delta`、按 `call_id` 折叠）；UI 渲染命令/参数/输出/耗时；turn 结局闭集 + reason | `view.ts`、`transcribe.ts`、`public/v1/index.html` | 真机：echo 任务显示命令行与退出码；运行中出现流式文本 | M6、M14 |
| S18 | diff 呈现：`file_edit` 聚合 unified diff（文件级 `+N −M` + 展开前 40 行）；R2 只读，不做接受/回滚 | `view.ts`、`server.ts`、UI | 改一个文件 → 看到 +N −M 并可展开原文 | P13 |
| S19 | 审批重做：决策闭集 + fail-closed + 三件套分离 + 硬拒路径 + 卡上动作由 `opts[]` 生成 + 输入框语义切换 | `gate.ts`、`envelope.ts`、UI | 触发 gate → 三动作走通并留审计；`rm -rf ~` 直接拒 | M1–M4、P10、P11 |
| S20 | 用量与上下文：turn 级 tokens（in/out/cache）、预算前置拦截、压缩三事件、spill + 诚实截断 | `transcribe.ts`、`daemon.ts`、`view.ts` | mock 超预算 → 拦截事件可见；大输出有 locator | M8 |
| S21 | 恢复与分叉：`seq`、orphaned 归宿、续跑预算（`resume_attempts` 上限 + 遗留 running 工具补 aborted）、checkpoint、`fork` 接口、归档 | `runs.ts`、`daemon.ts`、`server.ts`、UI | kill daemon → 重启后节点有归宿且不重复 spawn；注入必崩 launcher 停在 N 次 | M5、M7、M13 |
| S22 | 子代理与投递：`spawn` 原语（命名/寻址/隔离）+ 并发策略 + 回复三态（`queue` 落地，`steer/restart` 显式返回 unsupported，等 R3 接 pi RPC）+ 右栏"子代理"页 | `aica-pi/extensions/tools.ts`、`daemon.ts`、`view.ts`、UI | 一个父节点派 3 个子节点并汇总；reply 排队可见 | M9、M10 |
| S23 | 计划与裁决：`ev_todo` → 计划面板；reviewer 三档严重度 + 软失败裁决 | `view.ts`、`prompts/reviewer.md`、`daemon.ts` | todo 事件 → 面板出现并勾选；blocker 才打回 | M11 |
| S24 | 命令面板与键盘最小集（快捷键都有鼠标等价入口，关层≠批准） | UI | 快捷键全通 | P15 |
| S25 | 状态体系：视觉四态 + 文字六值 + 聚合取最紧急；等待态一行 shimmer；错误四色；分组与 verbosity 两档（详细/紧凑） | UI（+ SSE 重连逻辑、`view.ts` 分组） | 逐个制造并截图对照；切紧凑档只剩结论 + 每轮一行统计 | M15、P6、P8、P9、P14 |
| S26 | 健康与审计面：`/api/health` + 诊断包 + `asked/decided` 配对投影 + 断线黄条与全量校准 | `server.ts`、`transcribe.ts`、UI | 断桥黄条出现并可导出；审计可点开 | M12、P16 |
| S27 | 验收脚手架：e2e 夹具（录制回放 + 故障注入）、UI 断言、性能预算 | `workbench/test/` | `node --test workbench/test` 全绿 | 地基 |
| S28 | 自进化流水线：`ev_propose` 提案目录 + `ar propose` 审阅/应用/回滚 + 路径白名单与 stale 保护（§9） | `aica-pi/extensions/tools.ts`、`src/proposals.ts`（新）、`src/cli.ts`、`server.ts` | low 提案落盘生效；high 需 `--force`；禁止级直接拒；verify 失败字节级回滚；第 4 次 apply 标 stale | §9 |

**排期建议**：S16→S17 串行（同一文件），S18/S20/S23 可并行（都依赖 S16 的 view.ts）；S28 与 S22 同动 `aica-pi/extensions/tools.ts`，必须同一个 owner 串行；
S19/S24/S25 可并行（纯 UI），S21/S22 串行（都动 daemon），S26/S27 收尾。

**R2 完成的定义**：§2 的"半"全部清零（9 条）；§3.3 的六道门可跑且全绿；§5.12 的 U01–U28 人工过一遍（不通过必须写原因）。

---

## 7. 验收

1. `ar` 契约门：每个子命令坏输入返回结构化错误（非栈）。
2. 状态机门：非法迁移被拒。
3. 恢复门：kill daemon × 10 → 无重复拉起、无僵尸。
4. 安全门：越权/逃逸/规则用例全绿。
5. 预算门：超预算被拦。
6. 性能门：500 runs 下 `/api/v1/view` p50 ≤ 100ms。
7. 真机三件事：双击桌面「AICA 工作台」→ 无控制台、窗口 ≤ 2s 出现、首屏 ≤ 1s 可交互。

---

## 8. 风险与不做

| 风险 | 影响 | 对策 |
|---|---|---|
| 七家机制照抄导致复杂度爆炸 | 维护成本 > 收益 | 只抄"用户可感"的 6 条（§2.3），其余进 R3 待议 |
| 工具时间线让界面变日志浏览器 | 重心丢失 | 单行摘要 + 展开；默认折叠输出 |
| diff 回滚误伤用户文件 | 数据风险 | 只回滚本 run 写入且未被后续修改的文件；先备份 |
| 子代理带来 token 成本失控 | 账单 | 并发上限 + 每 run 预算 + 超限拦截 |
| UI 大改导致功能回退 | 体验倒退 | S16 先契约化，UI 改一层验一层 |

---

## 9. 自进化：Agent 改 Agent（S28）

> 目标不是"能改"，而是"改了能证明变好、能回滚、不能自我提权"。七家里最接近的是
> Claude Code 的 `ProposeSkills/ProposeGoal`（模型提议、人审落盘）、DSH 的 Agent Notes 与 hooks、
> Cindy 的 MCP 网关（未披露即 fail-closed）。我们把它落成一条**文件化提案流水线**。

### 9.1 提案即目录

worker 通过新工具 `ev_propose` 产出 `runs/<root>/nodes/<path>/proposals/<slug>/`：

```
proposal.md     动机 / 预期效果 / 风险 / 影响的文件
patch.diff      unified diff（只允许白名单路径）
verify.json     {"cmd": "...", "timeout_ms": 180000}（默认 node --test workbench/test）
meta.json       {"slug","created_at","base": {"file": sha256…}, "risk": "low|high"}
```

`ev_propose` 只写文件，不直接改仓库——**提案与生效分离**是这套机制的安全底座。

### 9.2 路径白名单（可改 / 需人批 / 禁止）

| 级别 | 路径 | 规则 |
|---|---|---|
| low | `aica-pi/skills/**`、`aica-pi/hooks/**`、`aica-pi/prompts/**`、`docs/**`、`workbench/public/**` | 可自动校验后由人一键应用 |
| high | `src/**`、`aica-pi/extensions/**`、`workbench/server.ts`、`workbench/view.ts` | 标 `risk:high`，应用需二次确认 + 必须带 verify |
| 禁止 | `workbench/shell/**`、`.git/**`、`aica-pi/extensions/gate.ts`（审批门本身）、`package.json` 的 scripts 字段 | 直接拒绝；防止自我提权与供应链改动 |

白名单按**归一化后的相对路径**判定，`..`、绝对路径、符号链接一律拒绝。

### 9.3 审阅面

- CLI：`ar propose list` / `ar propose show <slug>` / `ar propose apply <slug> [--force]` / `ar propose reject <slug> --reason`。
- API：`GET /api/proposals`、`POST /api/proposals/:slug/apply|reject`（S28 的 HTTP 面；UI 页签下一轮做）。
- UI（后续）：右栏新增"提案"页签（diff + verify 结果 + 应用/拒绝），与审批卡共用动作语义（P10）。

### 9.4 应用与回滚

1. 把 `patch.diff` 应用到临时 worktree（`<state>/tmp/apply-<slug>/`，复制当前树）；
2. 跑 `verify.cmd`，**全绿才算过**；
3. 过 → 原子落盘（备份被改文件到 `proposals/<slug>/backup/`），写 `applied.json`（时间、verify 输出摘要、文件 sha256）；
4. 不过 → 自动回滚，文件**字节级相同**（DSH 的"验证世界"：验收要证明世界变了，而不是模型说它变了）；
5. 同一 slug 7 天内最多应用 3 次，超限标 `stale`，防"改不好就一直试"。

### 9.5 与运行时的接口

- `result.proposal` 存在 → `node_settled` hook 把提案挂进 inbox（走既有 gate 通道，不新造通知）；
- 应用成功的提案写一条 `events.jsonl{kind:"learn"}` 到来源节点，下一轮 `learned.md` 注入时带上"上次这么改有效/无效"；
- 所有应用动作都有 `approve_ask/approve_decide` 审计对（复用 S19 的账本）。

### 9.6 验收（S28）

1. `ar propose new/list/show/apply/reject` 全通，坏 patch 不崩；
2. 应用一个只改 `aica-pi/skills/demo/SKILL.md` 的 low 提案：verify 通过 → 落盘 → 下一轮 worker 的 `--skill` 能看到；
3. 应用一个改 `src/daemon.ts` 的提案：标 `risk:high`，无 `--force` 拒绝；
4. 一个改 `workbench/shell/main.go` 的提案：直接拒绝（禁止级）；
5. verify 失败 → 自动回滚，且被改文件 sha256 与之前一致；
6. 同一 slug 第 4 次 apply 被拒（stale）。

---

## 附录 A · 研究稿索引

| 文件 | 覆盖 |
|---|---|
| [research/deepseek-harness.md](research/deepseek-harness.md) | DSH 会话/工具/审批/UI/扩展 |
| [research/opencode.md](research/opencode.md) | OpenCode 服务端/TUI/权限/插件 |
| [research/claude-code.md](research/claude-code.md) | Claude Code 文档 + 包内证据 |
| [research/codex.md](research/codex.md) | Codex exec 协议/审批双轴/TUI |
| [research/t3code.md](research/t3code.md) | T3 Code 事件溯源/多 provider |
| [research/oh-my-pi.md](research/oh-my-pi.md) | OMP 运行时纠偏 |
| [research/misaka-agent.md](research/misaka-agent.md) | Misaka DAG 研究图 |
| [research/cindy.md](research/cindy.md) | Cindy 拦截式审批/Orca 会话制 |
| [research/ux-synthesis.md](research/ux-synthesis.md) | 七家界面横向合成 + 验收清单 |

## 附录 B · v3 相对 v2 的差异

- **新增两家**：DSH（我们运行其上的 harness）与 OpenCode（开源、权限模型最完整）。
- **口径从"缺口清单"变成"能力基线 40 条 + 六条质量属性"**：可核对、可判分。
- **UI 从"骨架"变成"硬约束 + 状态体系"**：P1–P20 与 U01–U28 是验收项，不是建议。
- **执行从"S1–S15 功能铺开"变成"S16–S27 半清零"**：不再追求新功能广度，先把已有一半的东西做实。

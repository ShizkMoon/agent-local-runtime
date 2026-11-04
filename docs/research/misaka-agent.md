# Misaka-Agent 源码级复核（`Luciole-Studio/Misaka-Agent`）

> 复核对象：`https://github.com/Luciole-Studio/Misaka-Agent`，`git clone --depth 1`，HEAD `43f0c1fe93ef7dfcbf0238a04aeb3e0ec38e2eb6`（2026-11-03，`pyproject.toml:version = "0.19.23"`），落盘于 `C:\Users\Administrator\ego\research\misaka`。Apache-2.0。
> 复核方法：先读 `README.md`（380 行，含七段流水线与图生长规则）与 `docs/guide/{panel,research}.md`，再逐条回源码：`misaka/core/graph/*`（事件溯源图内核）、`misaka/core/research/*`（run/workflow/planner/views/report/ledger/context）、`misaka/core/network/roster.py`、`misaka/core/platform/tasks.py`。
> 路径约定：本文所有 `file:line` 相对仓库根；包内路径即 `misaka/core/...`。**注意本仓 `misaka/misaka/` 双层目录**（外层仓库、内层包）。
> 本文用途：复核 `docs/prd-workbench-v2.md` §1.4 / §2.4-17,18,21,22 的既有结论，标注「确认 / 修正 / 新增」，并给出落 `ar` / `workbench` / `aica-pi` 的改法。
> 证据等级：**[S]**=源码行号可查；**[D]**=仓库内官方文档；**[T]**=本文推断，需复核。

---

## 0 出处

- **仓库与快照**：`Luciole-Studio/Misaka-Agent`（注意 v2 §1.1 同名消歧里写的是 `Luciole-Studio`，与仓库一致；`Ikalus1988/MisakaNet` 为非 harness，本文不采），HEAD `43f0c1f`，2026-11-03。Python 3.12+，`uv tool install`，`misaka` CLI。`misaka/` 包内 476,405 行 Python（`Get-ChildItem -Recurse -Filter *.py | Get-Content | Measure-Object -Line`）。
- **本仓对照物**：`docs/prd-workbench-v2.md` §1.4（Misaka 画像）、§2.4-17（join/wait）、§2.4-18（定义即数据/分级曝光）、§2.4-21（计划审批+coverage table+paths list）、§2.4-22（红队/发散评审）；`src/{runs,daemon,envelope,cli}.ts`；`workbench/server.ts`；`aica-pi/extensions/{tools,events}.ts`。
- **本次重点读的源码**：
  - 图内核：`misaka/core/graph/{model,schema,journal,lease,store,snapshot,constraints}.py`。
  - run 与图 schema：`misaka/core/research/{runs,workflow,views,planner,report,ledger,context,node}.py`。
  - 队伍与卡片：`misaka/core/network/{roster,dispatch,sister_runtime}.py`、`misaka/core/platform/tasks.py`。
  - 权限面（初稿漏读，二轮补）：`misaka/core/subagent/{policy,configuration}.py`、`misaka/core/agent_session.py`、`misaka/core/extensions/{runner,types}.py`。
- **未读/不采信**：`misaka/core/research/{runs,workflow,planner}.py` 各 100–164 KB，未逐行通读，按 `grep` 命中段落取证；`misaka/core/skills/**`（大量 vendor 技能资产，与本项目决策无关）未读。凡未落到具体行号者为 **[T]**。
- **一次自我更正（保留在案）**：本文初稿断言「Misaka 没有 tool_call 拦截」，二轮 grep 证伪——`tool_call` 扩展事件在 `misaka/core/extensions/types.py:1199,1808`，卡片的实际拦截在 `misaka/core/subagent/policy.py:1483`。§3.5 与 A5 已按实情重写；保留此条是因为「以为它没有」正是本仓最可能的误判方向。
- **与 v2 画像的最大偏差**：v2 §1.4 把 Misaka 描述成「TUI + `misaka research` CLI + Markdown 产物」。实际 0.19.23 已经有两层 v2 没记的东西：**事件溯源图**（SQLite journal + lease + schema 约束）与**完整 Claude Code 兼容权限系统**（六档 + PreToolUse/PermissionRequest hook）。后者对我们尤其重要——它把「拦截式审批」的实证从两家扩到四家。

---

## 1 定位与体感

**一句话**：Misaka 不是通用 coding agent，而是把「一个研究问题」展开成**有向无环研究图**的专用系统；图的每个节点是一支**独立小队**（协调者 Last Order + 专家 Sisters + 专属红队），节点产物是 Markdown 论文级报告。

体感上五个特征，正好对应我们要补的五块：

1. **节点 = 小队，不是子任务**。每个节点有自己的 Last Order 会话、自己的 Sisters、自己的红队，跑完整七段流水线才关（`README.md:127-165`）。我们的节点现在只是一次 `pi` 调用（`src/daemon.ts:244` `spawnWorker`），没有「节点内部还有分工」这一层。
2. **图优先于任务列表**。run 的真相不是「一堆 task 行」，而是一张带 schema 的图：节点种类 `inquiry/decision/option/issue/relation`，边种类 `fork/decides/offers/opens/raised_on/becomes/covered_by/answers/member`（`misaka/core/research/runs.py:262-287`）[S]。我们的 `spec.depends: string[]`（`src/envelope.ts:20`）只有「拉起顺序」语义，没有「为什么开这个节点」。
3. **可能性只开一次**。全局 `paths.md` 记录每条被提出过的路及其归宿（`views.py:443-465`）[S]，层间 reconciliation 负责判「已覆盖 / 合并 / 拒绝并给理由」。我们没有等价物，`budget.depth_left` 只限制深度。
4. **计划审批是对话，不是弹窗**。计划审批把节点挂进 `awaiting_approval`，然后把**两个工具**塞进这个节点自己的 Last Order 会话（改计划 / 开始），由模型在你点头后调用「开始」记下同意（`workflow.py:1865-1936`）[S]。
5. **但工具审批是弹窗，且 headless 一律拒**。这与第 4 条不是一套机制：`before_tool` 里 `ask` 在有人看的会话弹 `ask_in_ui`，在卡片会话（headless）直接 block（`policy.py:1635-1655`）[S]。**两套门并存**，是我们最容易抄错的地方。

与 v2 PRD 的关系：§1.4 的**流程描述基本正确**（七段流水线、coverage table、paths list、红队→分歧评审都对），但**机制层缺失**：图内核、driver lease、波次串行预热、卡片失败后由协调者裁决——这四条 v2 没写，是本文的主要增量。另外 §2.1-1 把「拦截式审批」归给 Cindy/T3 两家，**漏了 Misaka 也有一套**（`before_tool` + 六档 `permissionMode`，见 §3.5），可把实证从两家扩到四家。

---

## 2 架构

### 2.1 进程与服务

| 层 | 形态 | 证据 |
|---|---|---|
| 入口 | `misaka`（TUI panel）/ `misaka chat` / `misaka research` / `misaka chat --as <sid>` | `README.md:44-53,287-304` [D] |
| 面板 | 自 `herdr` 移植，终端库用 `ghostty`；tab = 一种 pane 布局，pane = 一个程序 | `docs/guide/panel.md:11-42`、`README.md:358-360` [D] |
| agent 内核 | **pi 的 Python 移植**（`README.md:358`：「MISAKA's agent kernel is a Python port of pi」） | `misaka/core/agent/{agent,agent_loop,guards,stream_fn}.py` [S] |
| run 驱动 | 单进程 driver 拥有根节点；子节点是**子进程**，登记 `runner_pid/runner_key` | `workflow.py:2626-2716`、`runs.py:51`（`wave` 列）[S] |
| 存储 | SQLite（board：`research_runs` / `research_execution` / `research_cards` / `graph_journal`）+ 项目目录 Markdown + git | `runs.py:21-129`（DDL）、`journal.py:156-161` [S] |

**要点**：Misaka 与我们同构度高于 v2 的描述——同样是「一个 driver 拉起 N 个子 agent 进程，文件/SQLite 做真相」。差别在 driver 用了**租约**而非 pid 文件。

### 2.2 图内核（v2 未记录的层）

`misaka/core/graph/` 是一套完整的事件溯源图存储，四个文件各司一职：

1. **`model.py`**：不可变值对象。`NodeKind{max, frozen}`（`:186-197`）给节点种类设上限与「一旦设定不可改」的属性集；`EdgeKind{source,target,max_in,max_out,unique,acyclic,max_depth,frozen}`（`:200-228`）给边种类设拓扑约束；`Schema{nodes,edges,gates}`（`:231-263`）——`gates` 是「永远要等审批的 op 名集合」[S]。
2. **`journal.py`**：**唯一**的改图通道。`propose → approve → apply` 三段，状态机只有 `_MOVES`（`:42-49`）四态；`apply` 在 `store.savepoint` 里跑 handler → `constraints.check` → 写下一版快照，任一失败全撤（`:190-220`）[S]。`commit`（`:223-235`）是 lease holder 自己提议+应用的快捷方式，但**被 gate 的 op 不许 commit**，必须走 propose 等批准。
3. **`constraints.py`**：纯函数 `check(schema, before, after)`，**每次全图重算**（`:19-30`）。理由写在文件头（`:1-7`）：「at the sizes the graph is built for (hundreds of elements) costs nothing and leaves no rule depending on what a change touched」。`_acyclic` 用 Kahn 拓扑序顺带算深度，超 `max_depth` 直接报 violation（`:109-143`）[S]。
4. **`lease.py`**：`fence(con, graph, token)` 在 apply 前校验租约；`_holding`（`runs.py:290-306`）在没有 driver 时临时取一个 300 秒租约（`runs.py:143` `DRIVER_TTL_SECONDS = 300`）[S]。

**为什么这样设计**：把「谁改了图」变成可审计日志。每条 entry 有 `proposer/approver/receipt/seq`，apply 后写 `receipt_json` 并推进 `seq`（`journal.py:218-219`）[S]。

### 2.3 run 的图 schema（真正落地的约束）

`runs.py:262-287` 的 `graph_schema(chosen)` 是理解 Misaka 的钥匙 [S]：

```
nodes: inquiry{max:max_nodes, frozen:["depth"]}, decision, option, issue, relation
edges:
  fork      inquiry -> inquiry   acyclic, frozen, max_depth=max_depth   # 父子：节点从谁的会话分叉出来
  decides   inquiry -> decision  max_in:1                              # 一个节点只有一次决策
  offers    decision -> option   max_in:1                             # 决策给出若干可能
  opens     option -> inquiry    max_out:1                             # 可能被打开成一个节点
  raised_on issue -> inquiry     max_out:1
  becomes   issue -> option      max_out:1
  covered_by issue|option -> inquiry|option  max_out:1, acyclic        # 「这条可能由谁回答」
  answers   option -> issue|option  unique                             # 回引一条被拒/未开的路
  member    relation -> inquiry  unique
```

三个值得抄的点：

- **`max` 与 `max_depth` 写进 schema，不写进调用方**。`_open_node` 里另有一道运行期检查（`runs.py:1156-1161`），但即使绕过它，`constraints.check` 也会拒——**双保险，且第二道在存储层**。
- **`frozen:["depth"]`**：节点的 depth 一经创建不可改（`constraints.py:47-56`）。这保证波次语义不会被后来的重排破坏。
- **`covered_by` 的注释就是我们的 `paths` 需求**（`runs.py:277-281`）：「跟这些指针走，要么到一个节点，要么到一条没被打开的记录」——这比我们的「depends 是否 done」精确得多。

---

## 3 核心机制

### 3.1 DAG 构造：breadth-first 波次 + 层间 reconciliation

- 主循环 `while True`（`workflow.py:2688-2716`）：先 `_reconcile`（层间结算），再 `next_level`（取当前最浅未处理层），`_expand_level` 并行跑完这一层，回到循环 [S]。
- `next_level` 取 `depth` 最小的一批；`nodes()` 按 `(depth, ordinal)` 排序（`runs.py:1184-1191`）[S]。
- 层的**开启条件**由 `views.reconcile_state`（`views.py:225-244`）决定，逻辑值得逐字抄：
  `needed = settled and (有 pending option 等归宿 or 有 coverage claim 等复核 or (有本轮新完成节点 and 已完成节点≥2))`。
  注释写明「结构判断，不读节点内容」；「≥2 个节点有结论才可能产生 join/relation」；「绝不在有节点还在跑或有节点失败等重试时开」[S]。
- 层间 reconciliation 的产物是**图变更**：开新节点 / 合并同问为 join / 拒绝并记理由。验证器 `views.resolve_reconcile`（`:247-290`）逐条校验覆盖率与归属，`_review_coverage`（`runs.py:1651-1661`）给每条 coverage claim 写复核结论 [S]。

**→ 我们怎么改（A1，G6 扩展）**：现在 `pendingNodes()`（`src/runs.ts:220`）只判 `spec.depends` 是否全 `done`（`:257-258`），等价于「依赖满足就拉起」，没有「整层结完再开下一层」也没有「层间结算」。最小改法：

1. `node.json` 增 `depth`（由 `depends` 长度推导，或 spec 显式给）+ `run.json` 存 `wave`；
2. `pendingNodes()` 增加一道闸：`depth > run.wave + 1` 的节点一律不拉起；
3. 当「本层全部 settle（done/failed/skipped）」且存在 `spec.kind === "reconcile"` 的节点时，wave+1 并只拉起它；否则直接 wave+1。
   这一步不需要新进程模型，纯 `runs.ts` + `daemon.ts` 的状态判断。

### 3.2 并行调度：宽窗口 + **串行预热**（v2 完全没记，价值最高的发现）

`_expand_level`（`workflow.py:2231-2259`）只是壳，真正逻辑在 `_wait_level`（`:2287-2385`）：

- **槽位**：`width = limits["parallel"]`（默认 4，`runs.py:134`）。节点一离开 frontier（终态或 `waiting_input`）就释放槽位，「一个节点卡在计划或被慢 Sister 拖住，不占后面节点的位」（docstring `:2232-2236`）[S]。
- **串行预热**：`top_up()` 里 `and not still_warming()`（`:2316`）——**上一个刚起的节点必须先在会话文件里出现一条模型已接受的回复，下一个才起**。原因写在 docstring（`:2293-2301`）：「A node's first request carries the whole conversation it inherited, and a level's forks share it; sent together they hit the provider as one burst（2026-09-27: eight at once were refused with 502 "Upstream access forbidden", twice）」。串行后「each finds the shared part already in the provider's prompt cache, and the load arrives spread out」。
- **预热只等未计划节点**：`if offset is not None and runs.action(... plan_key(1)) is None`（`:2327`）——已经计划过的节点与同层其它分叉不共享前缀，可能很久不发请求，不等它（否则 15 分钟卡死一个槽，`:2299-2300`）。
- **热判定**：`_replied_since`（`:2262-2284`）按字节 offset 增量读会话 JSONL，只认 `type=message && role=assistant && stopReason ∉ {error, aborted}` 的整行 [S]。

**→ 我们怎么改（A2，新增 G41）**：这是**能直接治我们病**的一条。我们 `daemon.ts` 现在对 `pendingNodes()` 的一批节点**同时** `spawnWorker`（`:244`），多节点 run 一开就是 N 个 pi 进程同时打同一 provider，和 Misaka 2026-09-27 那次 8 个并发 502 是同一个病理。落法：

- `daemon.ts` 的调度循环改「补位式 + 预热门」：维护 `active` 集合，`while (active.size < parallel && pending.length)`，每次只起一个，记下该节点 `session/*.jsonl` 当前字节数；
- 起下一个前先读该文件增量，出现「assistant 且 stopReason 非 error/aborted」才继续；超时（建议 180s）或该节点已写 `result.json` 则直接放行，避免死等；
- 新增 `run.json.parallel`（默认 2，Windows 单机保守），暴露成 `ar dispatch --parallel`。
  这样即使 R1 只上文件态，也不至于被 provider 限流打成一片红。

### 3.3 节点状态机：七段流水线 = 一个持久 status 列上的分支

`_expand_owned`（`workflow.py:1340-1829`）是一个 `while True`，每轮读 `node["status"]` 走一个 `elif` 分支。这是 Misaka 的「工作流引擎」，**不是 prompt 编排** [S]：

| status | 做什么 | 证据 |
|---|---|---|
| `queued` | 置 `planning` | `:1435-1436` |
| `planning` / `awaiting_approval` | 调 `planner.plan`，写 plan 产物；必要时进审批；`clarify` 则返回 `waiting_input` | `:1438-1515` |
| `executing` | `drive("research")` 跑全部卡片 | `:1517-1533` |
| `synthesizing` | 等所有卡片 settle → `planner.synthesize` 写 `synthesis.md`（版本号递增） | `:1535-1611` |
| `critiquing` | 建 `@red-team` 卡 → 红队评审 → `_receive_critique` | `:1613-1687` |
| `disposing` | `planner.dispose`：每条异议**恰好一次**处置（revise/rebut/concede/refer/park/decide） | `:1689-1717` |
| `diverging` | 新会话做分歧评审 → 有 gap 转 `filling_gaps`，否则 `deciding` | `:1719-1782` |
| `filling_gaps` | `planner.fill_gaps` 逐条填/答，revise 则回 `synthesizing` | `:1784-1807` |
| `deciding` | `planner.decide`：每条未走之路记 outcome → 关节点 | `:1809-1826` |

**关键工程约束**（`:1341-1343` docstring）：「Every phase rebuilds what it needs from what is already recorded, so a resumed node picks up its own work where it was.」进度**只在 status 列上**，进程随时可死 [S]。

**→ 我们怎么改（A3，G10 扩展）**：我们节点的生命周期只有 result.json 的 `status`（`pending/running/done/failed`），中间态全靠 events 推断。建议：

- `node.json` 增 `phase`（`planning|executing|reviewing|done`），daemon 每次进入阶段先写再干；
- 每个阶段开头的动作都必须「幂等重建」：产出文件在就跳过（`if (existsSync(artifacts/plan.md))`），而不是重跑模型；
- UI 树行显 `phase` 而非只有 running 点。这条与 v2 G2 的 steps 投影叠加，成本很低。

### 3.4 上下文隔离与汇总：fork 全史 + **context packet 摘要**

两层隔离，分清很重要：

1. **节点层：fork 父节点 Last Order 会话**。`_prepare_sessions`（`workflow.py:2394-2414`）给每个尚未运行的 queued 节点建会话：`planner.fork_session(父的会话文件, 节点自己的目录)`，并用 `fork_entry` 记住「自己轮次从哪条 entry 开始」（`runs.py:1251-1255`；`planner.deliberation_text` `:995-1015` 按 `fork_entry` 切片取「当前分支上的助手话语」）[S]。**这就是 v2 §1.4「新节点从父节点 session fork、继承全部推理史」的准确机制——确认**。
2. **卡片层：不给全史，给 context packet**。`context.build`（`context.py:54-93`）产出一个有界包：根问题、本节点问题、`forked_from`、`reached_by`（从哪个 option 来的 + 同决策的对手 option 及各自 premise）、`parents[].{plan,synthesis,critique,divergence,issues,decisions}`、`ancestors`、errata、artifact_map、`declared_findings`（全 run 的 findings + 每条 claim 的 `locate()` 结果），末尾一句 `notice` 明确「这是快照，读全文请用 `misaka_research_view`」[S]。

**汇总**：卡片不回传自由文本，而是**声明式回传**。`ledger.ingest_report`（`ledger.py:79-121`）用 `Finding.model_validate` 先整体校验（「No silent truncation or partial rejection」），再拆成 `research_findings`（`text/claim_type`）+ `research_claims`（`source_file/quote/evidence_sha`），`id = sha256(run+task+finding)` 幂等 [S]。`claim_type ∈ {fact, inference, interpretation, normative}`（`planner.py:114-116`）。`ledger.locate`（`:57-70`）把每条引文回定位到页，产 `located on p3` / `NOT on the cited p7` / `NOT FOUND`——**是标记不是拒绝**（文件头 `:1-12` 明确「It is a mark, never a refusal」）[S]。

**→ 我们怎么改（A4，G21 前置）**：我们的 `result.json` 现在是 `summary` 自由文本 + `accept` 条目。两步走：

1. R1 只改 daemon 注入：给非根节点写 `context.md`（= 父节点 `result.summary` + 兄弟节点路径 + run 级 `accept`），而不是只给 `spec.goal`；
2. R2 再给 `result.json` 加 `findings?: {text, kind, src, quote}[]`，`ar done --findings <json>` 落盘，run 级 `findings.jsonl` 追加；UI 在节点详情里列出。**不要**一步上 `Finding` 的 pydantic 式校验。

### 3.5 审批与守门

四处，机制各不相同：

1. **计划审批（v2 §1.4 描述正确，但机制要修正）**。`planner.plan_needs_user` 为真且该节点尚未记录「已开始」时，进 `_await_approval`（`workflow.py:1865-1936`）：置 `awaiting_approval` → 把 `commands.review_tools(...)`（**改计划 / 开始计划** 两个工具）注册进该节点会话 → 循环轮询，直到 `runs.plan_started()` 为真才返回 `None`（放行）。用户是**用普通对话**跟 Last Order 说「开始」，她调用工具记下同意 [S]。
   - 审批期间「The node's conversation stays open the whole time」（docstring `:1867-1873`），根节点就是你的窗口，子节点是它自己的 tab；
   - 改题必等：`planner.validate_plan(..., root=..., red_team_required=...)` 与 `_check_plan_change` 约束，`plan["status"] == "clarify"` 则直接 `waiting_input`（`:1464-1467`）；
   - `finally` 里把状态从 `awaiting_approval` 拨回 `planning`（`:1933-1936`），且只在还持有 driver 时 —— **异常/取消不留死状态**；
   - `skipped` → `_skip_node`（`:1939-1949`），节点以 `parked` 关闭，最终裁决记为「path not researched，带理由」。
2. **图级 gate**：`Schema.gates` 里列出的 op 一律 `gated=True`，`commit` 直接拒（`journal.py:223-235`），必须 propose→approve→apply。这是「结构性变更必须人批」的通用闸。
3. **工具级审批——有，而且是完整的 Claude Code 兼容实现**（v2 §1.4 漏了这条，属**新增**）。`misaka/core/subagent/policy.py:1483` 的 `before_tool` 就是 `tool_call` 拦截点，`hook_tool_permission`（`:1052`）串起四段：
   - **档位**：`PERMISSION_MODES = {default, plan, acceptEdits, bypassPermissions, dontAsk, auto, bubble}`（`configuration.py:184`）；顶层可用集不含 `auto/bubble`（`:217`）。
   - **判定**：`_permission_action` 返回 `allow | ask | classify | deny` **四值**（`policy.py:970-1049`），优先级：`bypassPermissions`/管理工具 → allow（`:990`）＞ plan 拒绝（`:999-1009`）＞ 工作区越界（`:1011-1018`，`dontAsk/auto` 直接 deny、其余 ask）＞ 只读/规则/记忆路径（`:1022-1035`）＞ `acceptEdits|auto` 的工作区内编辑（`:1037-1043`）＞ `auto → classify`（`:1044-1045`）＞ `dontAsk → deny`（`:1047-1048`）＞ 兜底 `ask`（`:1049`）。
   - **hook 面**：`PreToolUse`（`:1488-1513`，可带 `updated_input` 改参，`deny` 直接 block）与 `PermissionRequest`（`:1591-1601`，批准前可再改参）；**改参后按最终参数重跑一遍 `_permission_action`**，注释写「Rewrites are new actions: an approved read must not turn into a plan-mode mutation」（`:1615-1622`）。
   - **ask 落地**：`top_level` 且有 UI → `ask_in_ui`，选项 `no/always`（`:1635-1649`）；**headless（卡片、联系人 turn）→ 直接 block**，理由「this session cannot display a permission prompt」（`:1643-1645`）；子代理 → `request_permission` broker 冒泡父会话（`:1650-1664`）。
4. **默认档是 `bypassPermissions`，且是显式产品裁决**（`configuration.py:195-201`）：「no mode at all is bypassPermissions, where CCB's is default, **because a pi session never asked**（user ruling, 2026-10-24）」[S]。这与 Cindy 的 fail-closed（读不到 perm 文件 → 当 ask 处理）**正好相反**，两边都是有意选择：Misaka 的卡片只跑本机，Cindy 的桌面可能被分享。

**→ 我们怎么改（A5 审批形态 + A9 判定序，G3 定案：双实证 → 四实证）**：

- v2 §2.1-1 应把「Cindy + T3 双实证」改成**四实证**：Cindy（`pi.on('tool_call')`）、T3（blocking tool hook）、Oh My Pi（三输入审批）、**Misaka（`before_tool` + 六档 permissionMode）**。结论更硬：**不换引擎就一定有调用级审批**。
- Misaka 的**四值判定序**比 v2 §S4 的五步检查表更可执行，建议直接照抄成 `gate.ts` 的分支顺序：`deny(档位) → plan 拒绝 → 越界(ask/deny 分档) → 规则/只读 → acceptEdits 快路径 → classify → 兜底 ask`。
- **`ask` 在 headless 必须 fail-closed**：我们的 worker 全是 headless（`src/daemon.ts:244` spawn、无 TTY）。`gate.ts` 遇到「需要问但 gate-req 写不出去」时必须 `{block:true}`，并照抄 Misaka 的措辞方向（「this session cannot display a permission prompt」）——v2 §S4 只写了「fail-closed block」，**没给理由文案**；理由会进模型上下文，影响它下一步策略，所以必须写。
- **计划审批仍然独立**：`spec.approval: "plan"`，daemon 在 `plan.md` 写出后**不 spawn 执行进程**，直接写 `gate-req.json{kind:"plan"}` 复用 G36 卡片；答 `allow` 才起 worker。这比 Misaka「模型调工具记同意」简单，且与我们既有 approve 卡同构。

### 3.6 失败、重试与降级

- **卡片级**：`FAILURE_LIMIT = 3`（`tasks.py:160`），`TERMINAL_FAILURE_KINDS = {auth_or_quota, configuration}` 直接判死（`:163`）；退避 `RETRY_BASE_SECONDS=30`、`RETRY_CAP_SECONDS=900`，指数 `retry_delay(kind, failures)`（`:164-165,1299`）；`mark_failed`（`:1318`）写 `retry_scheduled` / `gave_up` 事件（`:1364-1402`）[S]。
- **「干净退出但没结账」= 失败**（`mark_unsettled`，`:1405-1409`）：worker 会话正常结束但从未 settle 卡片，按协议违规计数，「so a model that keeps ending its turn without a summary runs out of attempts instead of being dispatched forever」[S]。**这一条直接对我们有用**，见下。
- **节点内裁决（v2 未记）**：一批卡片失败后**不是立刻 fail 节点**，而是 `planner.cards_failed` 让该节点 Last Order 选 `retry | continue | fail`（`workflow.py:1398-1416`，注释写明「the node used to fail at once and wait for the root to retry it（2026-09-29: provider refusals）」）；选 `retry` 则 `runs.reopen_cards` [S]。
- **节点级**：`_wait_level` 内 `node_failed` 后**本层继续**（`:2364-2366`），run 在本层结束后暂停等 resume 重试；也可当场 `misaka_research_retry(node=...)`。
- **run 级**：`budget.exhausted` / `stop_requested` → `partial(...)`（`:2614-2624`），并且**先把已完成的卡片 settle/ingest/bundle 再写部分报告**——注释记了一个事故：「a driver crash left 39 done cards unregistered for five hours」（`:2618-2619`）[S]。

**→ 我们怎么改（A6，G4 补充）**：我们的 `daemon.ts` 现在 worker 退出即 `writeResult(failed)`。加两级：

- 卡片级不需要（我们没有卡片层）；
- **「干净退出但没写 result.json」必须算失败**（抄 `mark_unsettled`）：现在 `daemon.ts` 只在非零退出码时写 `failed`；worker 以 0 退出却没 `ar done` 的，结果文件缺失 → 被当成 ready 反复拉起。加一条：`exit===0 && !existsSync(result.json)` → `writeResult({status:"failed", summary:"worker exited without settling"})`，并计入重试次数；
- **节点级加一次「软失败」判定**：`failed` 且 `spent.minutes < 3` 且 error 含 `rate|429|502|ECONN` → 不写 failed，写 `retry_at = now + 30s*2^n`，daemon 下次扫到时重拉，n≤3；
- **run 级 halt 前先 flush**：`stop`/`budget` 触发时，先把所有 `running` 节点的 events 尾巴收进 `result.summary`（哪怕截断），再写 run 的 partial 状态。这条正对 v2 G5/G29 的孤儿问题。

### 3.7 状态与恢复

- **driver 租约**（不是 pid 文件）：`_keep_lease`（`workflow.py:1984-2007`）每 `DRIVER_TTL_SECONDS/3 = 100s` 续租；续不上 → `lost.set()` → 主循环 `check_active` 抛「driver lease lost」（`:2605-2612`）。`sqlite3.OperationalError` 有单独宽限（剩余租期 > 30s 则 5s 后重试），注释说明这是为了避免「lease 还剩很多就误判 lost」[S]。
- **孤儿回收**：`_reap_orphan_runner` 在每个节点启动前与 run 启动时跑（`:2629-2634`），「stop shallower writers before refreshing the child inventory」[S]。
- **幂等 resume**：`runs.resume` + 各阶段「从已记录内容重建」；`_prepare_sessions` 会**收养**崩溃前写好但没跑过的 fork（`:2397-2398`）。
- **部分报告**：`_INCOMPLETE_BANNER`（`:2010-2015`）明确写「This research is incomplete… not its answer」——**诚实降级**，不把半成品当结论 [S]。

**→ 我们怎么改（A7，G29/G4 直接落地）**：v2 §S3 设计的是 `worker.json{pid}` + `process.kill(pid,0)`。建议**再加一层租约**：`run.json.driver{pid, token, expires}`，daemon 每 10s 续写 `expires = now + 30s`；新 daemon 启动时若 `expires > now` 就**不接管**（防双 driver 同写 events.jsonl）。pid 检查在 Windows 上有 PID 复用风险，租约没有。同时抄 `_INCOMPLETE_BANNER`：任何非正常结束的 run，`run.json.status = "incomplete"`，UI 顶部一条黄条。

---

## 4 UI：panel 的三层信息架构

`docs/guide/panel.md` 给了完整布局（`panel.md:13-29` 是 ASCII 图）[D]：

1. **spaces（左栏上）**：工作目录，带 git branch/status；`here/all` 切换。
2. **sessions（左栏中）**：会话列表，`↳` 标分叉来源；「a conversation that belongs to a card or a research node opens as a window onto it: you can read it, and talk to the agent while she is still running」（`:148-154`）——**只读窗口 + 可插话**，与我们要的 G11/G12 同构。
3. **agents（左栏下）**：每个跑 agent 的 pane + 在做什么；`grouped/priority` 切换。
4. **主区**：tab（一种 pane 布局）→ pane（一个程序）。研究节点**各占一个 tab**，里面是该节点的 Last Order + 她的 Sisters（`:33-35,122-123`）。
5. **状态点语义**（`:47-53`，值得逐字抄）：`red ● blocked`（在问你，或卡片失败/等评审）/ `yellow ● working` / `teal ● done`（完成且未看）/ `green ○ idle`（完成且已看）/ `·` 未运行。「A space's dot is the most urgent dot among its panes」——**聚合取最紧急**。
6. **navigator**（`ctrl+b g`）：跨 space 搜所有 pane，`b/w/i/d` 过滤 blocked/working/idle/done。

**→ 我们怎么改（A8，G36/G19 合体）**：我们的 `workbench/public/v1/index.html` 已是树 + 详情两栏。建议只借两条：

- **状态点四态**（blocked/working/done-unseen/idle）替掉现在的两态；`done-unseen` 用 `events.jsonl` 最后变更时间 > 节点 `result.at` 且用户未点开判定；
- **聚合取最紧急**：run 行的点 = `max(子节点点)`，顺序 `blocked > working > done > idle`。这条比 v2 §2.4-16 的 `live/cur/spent` 更省事，且视觉收益立刻可见。
- **不抄**：pane/tab/prefix key 那套终端复用——我们有 WebView2 + HTML，抄它等于自杀。

---

## 5 值得抄（A1…A10）

| # | 机制 | 为什么 | 落点 |
|---|---|---|---|
| **A1** | **波次屏障 + 层间 reconciliation**（`workflow.py:2688-2716`、`views.py:225-244`） | 我们 `depends` 只有「拉起」，没有「整层结完再开下一层」，也没有「同问合并」。这是 G6 真正的内容 | `src/runs.ts` `pendingNodes` 增 depth/wave 闸；新增 `spec.kind:"reconcile"` |
| **A2** | **串行预热**（`_wait_level` `:2293-2331`） | 直接治我们多节点同时 spawn 打爆 provider 的问题；Misaka 有 502 事故记录 | `src/daemon.ts` 调度循环补位式 + `session/*.jsonl` 增量判首答；`run.json.parallel` |
| **A3** | **持久 phase + 每阶段幂等重建**（`:1341-1343`、`:1425-1829`） | 我们进程随时会死，现在只能靠 result.json 四态猜 | `node.json.phase`；每阶段先查产物再干活 |
| **A4** | **声明式回传（finding/claim/quote）+ 引文回定位**（`ledger.py:79-121,57-70`） | 我们的 `summary` 是自由文本，父节点无法机械消费；「定位失败只标记不拒绝」很成熟 | `result.findings[]`（R2）；R1 先给子节点写 `context.md` |
| **A5** | **计划审批 = 挂起 + 会话内两工具**（`:1865-1936`） | 证明「人批计划」可以零新进程实现；`finally` 拨回 planning 的写法值钱 | 我们改用 `gate-req.json{kind:"plan"}` + 既有 approve 卡（比它更简单） |
| **A6** | **失败由协调者裁决 retry/continue/fail**（`:1398-1416`） | 固定重试策略会在 provider 抖动时把整层打成 failed；让上层模型抉择更稳 | `daemon.ts` 软失败判定 + `retry_at`；R2 再考虑模型裁决 |
| **A7** | **driver 租约 + 心跳 + 部分报告横幅**（`:1984-2007`、`:2010-2015`） | pid 检查在 Windows 有复用风险；租约没有。诚实降级是 v2 G25 想要的调性 | `run.json.driver{token,expires}`；`status:"incomplete"` + UI 黄条 |
| **A8** | **四态状态点 + 聚合取最紧急**（`panel.md:47-56`） | 我们只有 running 点；blocked 在 UI 上完全不可见（G36 的一半） | `index.html` 树行 + run 行 |
| **A9** | **四值权限判定序 + headless ask 必须拒**（`policy.py:970-1049,1635-1655`、`configuration.py:184,217`） | 这是 v2 §S4 五步检查表的更成熟版本：`allow/ask/classify/deny` 四值、`dontAsk` 与 `auto` 在越界时**直接 deny** 而不是 ask、改参后**重跑判定** | `gate.ts` 按此顺序重写；「写不出 gate-req → block」并给模型可读理由 |
| **A10** | **分级曝光：`routing_catalog` 只给 200 字预览**（`roster.py:225-242`） | Last Order 的上下文里只有 `id + description + profile[:200]`，全文留在 `profile_path` 按需读。v2 §2.4-18 说对了，但没给量化 | `spec.goal` 只放摘要；详情进 `already_known`；`ar` 加 `sister list --preview 200` 形态的 `agent list` |

**补充两条次要项**：

- **A11 覆盖表**：`planner.py:49-50` 要求 `plan_markdown` 必含 coverage table（子问题 × 卡片），空格即「声明缺口」；`commands.py:298-323` 的 `Coverage` schema 在层间复核 [S]。→ `plan.v1.json.coverage[]`，见 v2 §2.4-21（**确认，且加强**：v2 只说 schema 增字段，实际还要在 reconcile 时逐条复核 `holds|reopen`）。
- **A12 errata 沿图向下传播**：`context.build` 把 `ancestors` 里的 errata 注入每个后代的 context packet（`context.py:82`）[S]。→ 我们可用极小成本做：节点失败/被纠正时写 `errata.jsonl`，`daemon` 给后代 spec 的 `already_known` 末尾追加「## 已知勘误」。

---

## 6 不抄

1. **七段流水线全量**。红队→逐条处置→分歧评审→填 gap 的循环（`workflow.py:1613-1807`）在人文研究里必要，在我们「单人多 agent 干活」场景是 4–5 倍成本。**只取形状**：`reviewer` profile 两段（verify + diverge），不取循环与版本管理。
2. **fork 全史继承**。Misaka 能 fork 是因为它自己实现会话存储（`planner.fork_session`）。pi 的 session 目录是 `--session-dir` 平的目录（`src/daemon.ts:152`），**没有 fork 原语**——`pi --fork-session` 是否存在需复核 [T]，不能假设。我们的等价物是 `events.jsonl` 摘要 + `already_known`。
3. **Markdown 作为唯一真相 + 只在用户确认后 commit**（`README.md:40`）。我们已经有 `events.jsonl` / `result.json` 的结构化真相，退回纯 Markdown 是倒退。
4. **TUI panel / tab / prefix key**（`panel.md` 全文）。终端复用是它的正确选择，不是我们的。
5. **人文社科方法论提示词**（`planner.py:22-90` 的 `ROOT_CONTRACT`、`report.py:52-127` 的 `DRAFT_CONTRACT`）。质量很高，但绑定「论文写作」目标；我们只有「验收 + 汇总」需求，抄了会污染 worker 提示词。
6. **每 Sister 独立模型**（`README.md:34`）。我们 G16 已排 `roles.json`，同一件事；但**不要**现在做「每个子节点自选模型」，编排面会失控。
7. **SQLite board + 图内核的完整事件溯源**。Misaka 为此背了 `journal/lease/snapshot/constraints` 五件套（约 60 KB 源码）。我们用「文件 + 追加 events.jsonl + `spec.json` 落盘=意图提交」已同构（v2 §2.3-14 的判断**确认**），R1 不值得引入。

---

## 7 出处

**仓库内文档**

- `README.md:30-42` — Core design 十表（分级曝光、手段与目的分工、症候阅读、DAG、traceability、可审计）。
- `README.md:104-124` — 九个 run 参数与默认值（depth 3 / node-parallel 4 / card-parallel 4 / follow-ups 2 / revisions 2 / max-nodes 30）。
- `README.md:127-165` — 节点七段流水线全文。
- `README.md:167-182` — 图生长、层间 reconciliation、paths list。
- `README.md:265-283` — 输出目录结构（`final/`、`nodes/<node>/{plan.md,cards/,synthesis.md,SOURCES.md}`）。
- `docs/guide/panel.md:11-56,106-127,148-154` — 面板布局、状态点、agents 列表、会话即窗口。
- `docs/guide/research.md` — 运行与接管（本次未逐段引用）。

**源码（`file:line`）**

- 图内核：`misaka/core/graph/model.py:186-296`（NodeKind/EdgeKind/Schema）、`journal.py:42-49,116-161,190-235`（状态机/propose/apply/commit）、`constraints.py:19-30,109-143`（全量校验/Kahn+深度）、`lease.py`（fence）。
- run 图：`misaka/core/research/runs.py:262-287`（graph_schema）、`1134-1169`（create_node/_open_node）、`1184-1191`（nodes 排序）、`290-312`（_holding/_commit）、`143`（DRIVER_TTL_SECONDS=300）、`130-134`（ACTIVE/NODE_TERMINAL/DEFAULT_LIMITS）、`1543-1661`（reconcile/_review_coverage）。
- 工作流：`misaka/core/research/workflow.py:1340-1829`（节点状态机全段）、`1865-1936`（计划审批）、`2231-2259`（_expand_level）、`2287-2385`（_wait_level 含串行预热）、`2394-2414`（_prepare_sessions fork）、`2458-2463`（_reconcile）、`2600-2720`（drive 主循环）、`1984-2015`（lease 心跳/部分报告横幅）。
- 计划与回传：`misaka/core/research/planner.py:22-90`（ROOT_CONTRACT）、`93-120`（工具面与 Sisters 纪律）、`995-1015`（fork_entry 切片）、`1287`（cards_failed 契约）、`1159-1176`（fork_session/session_leaf）。
- 视图与路径：`misaka/core/research/views.py:26-28`（GRAPH_VIEW/PATHS_VIEW/GRAPH_SNAPSHOT）、`139-152`（coverage_claims）、`225-290`（reconcile_state/resolve_reconcile）、`399-465`（snapshot/_paths）。
- 回传与报告：`misaka/core/research/ledger.py:1-12,57-70,79-121`；`report.py:30-143`（STAGE/SURVEY/DRAFT/FINAL 四契约）；`context.py:54-109`（context packet）。
- 队伍与卡片：`misaka/core/network/roster.py:202-206,225-242`（describe_line/coordinator_profile/routing_catalog）；`misaka/core/platform/tasks.py:160-165,1299,1364-1402`（失败上限与退避）。
- 权限与审批（v2 漏记的一层）：`misaka/core/subagent/policy.py:970-1049`（`_permission_action` 四值判定）、`1052`（`hook_tool_permission`）、`1483-1520`（`before_tool` + PreToolUse）、`1591-1664`（PermissionRequest → ask_in_ui / fail-closed / broker）；`misaka/core/subagent/configuration.py:184,195-201,217,220-236`（档位集合、默认 `bypassPermissions` 的产品裁决、子代理继承规则）。

**本仓对照**

- `docs/prd-workbench-v2.md` §1.4、§2.1-1、§2.3-14、§2.4-16/17/18/21/22、§3（G6/G10/G21/G29）、§4 S1–S6。
- `src/runs.ts:220,257-258`（pendingNodes/depends 闸）、`src/envelope.ts:20,26,30`（depends/mode.shape/budget）、`src/daemon.ts:152,244`（session-dir/spawnWorker）、`workbench/server.ts:233,335`（apiView/crumb）、`aica-pi/extensions/events.ts:35-36`（tool_execution 发点）。

**外部参照（README 自述，未独立验证）**

- pi（`github.com/earendil-works/pi`）— agent 内核来源；herdr — panel 来源；hermes-lcm — LCM 压缩；PageIndex — 文档分层索引。`README.md:356-365`。

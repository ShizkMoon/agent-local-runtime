# 七家 harness 的界面 / 交互横向合成（ux-synthesis）

> **输入**：`docs/research/` 八份研究稿的 §4 「UI/交互」与 §5 清单里的 UI 条目（deepseek-harness / opencode /
> claude-code / codex / t3code / oh-my-pi / misaka-agent / cindy）；`docs/prd-workbench-v3.md:302-355`（现状结论、
> 重心规则 R1–R5、六态、关键界面、键盘最小集）；`workbench/prototype/design-demos/direction-approved.md:5-7`
> （定稿 = dir-5 骨架 × dir-6 语言）；2026-11-04 两张真机截图（1426×863，三栏 256 / 790 / 380）。
>
> **产出**：对 `docs/workbench-ui.md` 的修订 P1–P20（§4）、线框级文字描述（§5）、可逐条核对的验收清单 U01–U28（§6）。
>
> **证据标记**：`[S]` 源码级、`[D]` 文档级、`[T]` 推断 —— 沿用研究稿的原始口径。标「需复核」= 研究稿未覆盖，
> 不得当结论用。
>
> **基线缺失（必须先说）**：任务书指向的 `docs/workbench-ui.md` 在本次合成时**不存在**——`git log --all --
> docs/workbench-ui.md` 无记录，仓库内也无同名文件。因此 §4 的 P 条目以 `direction-approved.md` +
> PRD v3 §5 + 现网 `workbench/public/v1/index.html` 的实装令牌（`index.html:44-45` 的 `--sb-w:256px` /
> `--rp-w:380px`，`index.html:24-41` 的 clay / serif / 三档圆角 / 三档动效）为基线；该文件落盘时可直接沿用
> P1–P20 的编号，无需重排。
>
> **行号说明**：`workbench/public/v1/index.html` 正由 S16/S17 切片（task-7）修改，本文引用的行号取自
> 14:5x 的工作副本；**以符号名为准**（`pillOf` / `renderSidebar` / `ST_LABEL` / `data-p` / `notifyNewInbox`）。

---

## 0 结论先行

1. **没有一家把「事件」直接给用户看。** 八家里的四家（DSH、OpenCode、T3 Code、Codex）都有一层显式的
   「事件 → 行/组/item」投影，用户看到的永远是投影。我们现在的 `steps` 平铺（尾 12 条，S17 正在改）正好踩在
   PRD A-1「事件泄漏」上——这不是审美问题，是「这个工作台像不像 CodingAgent」的分水岭。
2. **「等待人」在八家里是唯一被允许抢视觉的东西**，且都做了聚合（Misaka 的 `red ● blocked`、Cindy 的
   「等待确认 > 运行中」、OpenCode 的「被权限挡住的工具不进摘要、固定组外」、DSH 的「审批卡自动聚焦详情区」）。
   我们现状的 run 行只看自己的 `status`，**父行完全看不出子节点在等审批**——这是 G36 的另一半。
3. **审批卡是数据不是模板**：选项由服务端生成（CC §4-1、Codex §4-1 双证），呈现方式三家一致地「非模态、
   不抢焦点」（OMP 的 dock、T3 的时间线行、DSH 的 card + Enter/Esc）。这三条直接决定「人在环」是减速带还是
   加速带。
4. **人文感不在装饰，在间距与措辞**：DSH 把间距写成业务规则（4 / 8 / 12 / 16 / 20px，且「折叠不改变答复
   前的 12px 间距」，`deepseek-harness.md:338`），把「不完整就整行隐藏」写成诚信规则（`:340`）。我们的
   暖纸 + 衬线是对的（dir-6），但**间距还没刻度、诚信还没规则**。
5. **八家里五家是终端 TUI**（OpenCode、CC、Codex、OMP、Misaka），**三家是图形界面**（DSH 的 Web client、
   T3 Code 的 React 前端、Cindy 的桌面端）——而这三家里有两家正是我们骨架与语言的来源。结论不是「学 TUI」，
   而是「学 TUI 的信息纪律，用 Web 的排版表达」，这也正是 dir-5 的既定路线（T3 骨架 × Anthropic 语言）。

---

## 1 对照矩阵

读法：每个单元格给**事实**，「证据」列给研究稿章节（必要时带 `file:line`）。八家 = v2 基线的七家
（OpenCode、CC、Codex、T3 Code、OMP、Misaka、Cindy）+ 本次新增的 DeepSeekHarness。任务书标题里的「七家」
即指 v2 那七家；为了不丢证据，矩阵按八家排。

### 1.1 主视图骨架与信息层级

| 家 | 主视图骨架 | 信息层级（谁大谁小） | 证据 |
|---|---|---|---|
| DeepSeekHarness | 三块 + 覆盖层：Session 列表（左）/ Conversation（中）/ Sidebar（右，可 dock/float），加 `shell.overlay` 级一次性通知 | 五层：本轮最终答复（14px，唯一有 12px 上下留白）> 运行中一行状态 > 工具组（13px tertiary）> 轮摘要头（12px 可点开）> 审计行（默认折叠，仅计数徽标） | `deepseek-harness.md` §4.1、§4.2；`ui-chat/README.md:68,81`、`sidebar-right.md:5` |
| OpenCode | 四块：左 sidebar（固定宽）/ 中 transcript（**行模型** projection）/ 底 composer + tabs / 会话 tab rail + 右侧可聚焦 pane | 默认只显示活动摘要（reasoning/exploration/activity 分组）；running 用稳定 busy label；完成组给统计标签；**被权限挡住的工具不进摘要、固定组外** | `opencode.md` §4.1、§4.2；`tui/src/routes/session/sidebar.tsx:13-79`、`grouping/session.ts:78-91`、`activity-summary.ts:46-95` |
| Claude Code | 终端里「对话流 + 工具块 + 权限提示」，无多客户端/无服务端会话 | 每步可见、每步可折叠，**折叠不改真相**（steps 是投影，transcript 是原文） | `claude-code.md` §4-2、§3.8；`opencode.md` §4.5（横向对比） |
| Codex | TUI + `exec` 事件流；UI 以 thread/turn/**item** 为核心，工具块更「协议化」 | item 分类 9 类（`ThreadItemDetails`），以 item 为单位渲染 | `codex.md` §2.2、§7（`exec/src/exec_events.rs:107-133`）；`opencode.md` §4.5 |
| T3 Code | sidebar（项目分组 / thread 行 / 新会话）+ thread 头部 + MessagesTimeline + Composer | 三条硬规则：①主线永远只有对话 ②工具/审批/计划是可折叠「工作条目」不是平级 ③队列是独立层 | `t3code.md` §4（布局图 + 三条规则）；`apps/web/src/components/` |
| Oh My Pi | 状态行 / transcript（差分渲染）/ Subagents 钉跳表 / composer，四段纵切 | 三条规则：①审批不抢焦点 ②advisor 是旁注层（nit / concern / blocker 三档） ③子代理有独立视图 | `oh-my-pi.md` §4.1、§4.2；`docs/tui.md`、`approval-mode.md:145` |
| Misaka-Agent | 左栏三段（spaces / sessions / agents）+ 主区 tab → pane；**研究节点各占一个 tab** | 三层信息架构；会话 = 「窗」，可只读 + 可插话 | `misaka-agent.md` §4；`docs/guide/panel.md:148-154` |
| Cindy | 不跳独立页：Lead 路由 + **右侧栏「协同」tab**（singleton、进行中常驻）；worker 不进侧栏 | worker 的异常汇总到 lead 行；红（出错）> 蓝（等待确认）> lead 自己，且都盖过「运行中」；**worker 的完成不汇总** | `cindy.md` §4-1…§4-4；`orca-team-architecture.md:227-237` |

### 1.2 等待 / 运行态与错误态

| 家 | 等待 / 运行态 | 错误 / 失败态 | 证据 |
|---|---|---|---|
| DeepSeekHarness | 一行 shimmer（`TextShimmer`）+ 当前工具名 + 已用时；**step 计数不显示**（噪声）；reduced-motion 退化静态 | 四色：红=终结失败（`interrupted` 措辞「进程已退出」）、琥珀=预算/输出上限、灰=被拒（`denied`）、蓝=重试中；**中间重试不产生终结行** | `deepseek-harness.md` §4.3、§3.7(b)；`ui-chat:68,77,124-126` |
| OpenCode | 稳定 busy label：`Thinking…` / `Running command…` / `Running code…`；只有单个 flow「不是每步闪一个词」 | 工具四态 `streaming/running/completed/error`；`deny` 行固定显眼（不进摘要） | `opencode.md` §4.1、§4.2；`activity-summary.ts:46-52` |
| Claude Code | spinner 文案可换（`spinnerVerbs`）、`Compacting...` 是独立文案；status line 显示 context 用量 | `MessageDisplay` 只改**显示**不改 transcript；`retry:true` 表达「你可以重试」 | `claude-code.md` §3.8、§3.3.3 |
| Codex | 审批是**按 thread 归集的待答表**（`pending_thread_approvals`），不是一次一个弹窗 | `CommandExecutionStatus` 含 `Declined`（被拒≠失败）；`TimedOut` 单独存在 | `codex.md` §3.8、§4-3；`exec/src/exec_events.rs:150-157` |
| T3 Code | 工作组带 **live 计时**（`formatWorkingTimerNow`）与失败着色（`workEntryDisplayIndicatesToolFailure`） | 工具失败在组内就地着色，不另起错误页 | `t3code.md` §4 |
| Oh My Pi | 子代理钉跳表每行「当前工具 + 一行细节 + 超 5s 的计时」（`subagentLivePreview`） | 工具卡失败着色；advisor 三档：nit 不打断 / concern 可打断 / **blocker 必打断** | `oh-my-pi.md` §4.1、§4.2；`agent-hub.md:84-92` |
| Misaka-Agent | `yellow ● working` | `red ● blocked` = 在问你，**或卡片失败/等评审**；`teal ● done`（未看）/ `green ○ idle`（已看）；**space 的点 = 其 pane 中最紧急的点** | `misaka-agent.md` §4-5；`panel.md:47-53` |
| Cindy | 「协同」tab 常驻 + attention 角标（一个 Lead 只算 1） | 红色汇总到 lead 行；**聚合是只读派生、不写回** attention store；完成不冒泡 | `cindy.md` §4-3、§4-4 |

### 1.3 审批 / 提问呈现与 diff 呈现

| 家 | 审批 / 提问呈现 | diff 呈现 | 证据 |
|---|---|---|---|
| DeepSeekHarness | `conversation.approval.card` Factory：reject / allow / 可选 always-allow，scope 由调用方给，带 subject 元数据；**Enter=同意一次，Esc=拒绝**；键盘与指针共享一个 pending 锁，被撤回的请求不能再作答 | 未直接覆盖（右栏有 `dsh-resource://file/...` 地址可开文件 tab）→ **需复核** | `deepseek-harness.md` §3.7(d)、§4.4、§4.5；`ui-approval/README.md:21,23,38` |
| OpenCode | 工具 + 参数预览 + 目标列表；`once / always / reject`；`always` 会展开说明「保存什么」；`reject` 进子会话反馈编辑；可 fullscreen | 工具特定渲染器（`tool-renderer.tsx` 95KB）按工具出 diff/shell/read/subagent；另有 snapshot + `revert.stage` 给 file diff | `opencode.md` §4.4、§4.1、§3（`snapshot.ts:90-148`、`revert.ts:22-55`） |
| Claude Code | 四类决定动作：`allow / deny / ask / defer` + `updatedInput`（**改参再放行**）+ `updatedToolOutput`；审批卡 = 服务端给的选项菜单，永远追加自由输入框当 Other | 三端三种：VS Code inline diffs / Desktop visual diff review / TUI `/diff` 实时面板 | `claude-code.md` §3.3.3、§3.8、§4-1 |
| Codex | `approval_overlay.rs:1-13` 三条契约：每次选择必发决策事件；**Esc 恒为 Cancel**（关掉≠同意）；UI 不做安全判断 | 两粒度并存：`Add/Delete/Update{unified_diff}` 给模型与日志，`Chunk{orig_index,deleted,inserted}` 给渲染；徽标 `+n/−m` | `codex.md` §3.8、§4-2；`protocol.rs:4538-4560` |
| T3 Code | 审批是时间线里**一行**，就地、不弹窗，回答后原地消失；待答由服务端投影派生（另一台设备也能答） | 未直接覆盖（checkpoint/rollback 是会话语义，不是 diff 视图）→ **需复核** | `t3code.md` §4、§3.10；`usePendingThreadRequests.ts:66-70` |
| Oh My Pi | **dock 贴在 composer 上方，不是模态框**：Approve / Approve for this session / Deny；空编辑器时方向键选、`Ctrl+Enter` 批、`Esc` 拒；**出现后 0.5s 内忽略批准键**（防误批）；有草稿时高亮落在「Deny and send message」 | 未直接覆盖；checkpoint/rewind 只恢复工作区 → **需复核** | `oh-my-pi.md` §4.1、§3.8；`approval-mode.md:145` |
| Misaka-Agent | 计划审批 = 挂起 + 会话内两工具（`finally` 拨回 planning）；无卡片 UI 细节 → **需复核** | 无（产物是 markdown 报告） | `misaka-agent.md` §5 A5 |
| Cindy | 桥的拦截式审批（`cindy-bridge`）；UI 形态细节 → **需复核** | `AgentEventType` 含 `turn_diff`；`tool_result` 与 `tool_result_full` 分两条（精简给内嵌 UI、完整给详情面板） | `cindy.md` §3（`types/events.ts:27-36`）、§4 |

### 1.4 键盘 / 命令面板与主题 / 排版

| 家 | 键盘与命令面板 | 主题与排版（可迁移到 Web 的部分） | 证据 |
|---|---|---|---|
| DeepSeekHarness | `Ctrl/Cmd+K` 命令面板；`Esc` 关顶层弹层并**还焦**；审批区 Enter/Esc；判据「任何快捷键都要有鼠标入口 + 焦点恢复点明确」 | 圆角刻度统一（`ui-radius.md#radius-scale`）、**等宽只给工具/代码**、过程行统一 tertiary 色；动效一律 `prefers-reduced-motion` 退化 | `deepseek-harness.md` §4.5、§4.6、§3.7(e)(f) |
| OpenCode | leader `ctrl+x`；`ctrl+p` palette、`escape` interrupt、`ctrl+b` 后台化、`<leader>q` 队列、`<leader>c` compact、`down` 子代理选择器、`ctrl+alt+k` which-key（30+ 组合） | TUI 视觉细节未读 → **需复核**（`opencode.md:511` 自陈） | `opencode.md` §4.3、§4.4 |
| Claude Code | 6 档 mode 是「键盘 + 语义」；hook 33 点不属 UI；逐键表 → **需复核** | spinner 词可替换（`spinnerVerbs`）→ 文案可配置，属「语言层」配置而非主题 | `claude-code.md` §3.3.4、§3.8 |
| Codex | 支持自定义 keybinding，但 **MCP elicitation 的 Esc 被钉死为 Cancel**（「dismissal never silently becomes continue」） | 未覆盖 → **需复核** | `codex.md` §3.8 |
| T3 Code | 输入框 placeholder 随状态变化（审批有/无反馈、结构化提问、计划跟进、未选项目、provider 不可用**五态一个表达式**） | 所有控件来自 `components/ui` 原语 + Tailwind 类写在组件上（工程约束，不是布局哲学） | `t3code.md` §4；`ChatComposer.tsx:3414-3429` |
| Oh My Pi | `Alt+A` Agent Hub；Hub 内 `t` flat/tree、`/` 过滤、`1/2` 切 Agents/Activity、`r/x` revive/kill | 显示层可配（`display.pinnedAgents` 三档 collapsed / full / off、`display.subagentLivePreview`）→ 「信息密度是用户偏好」 | `oh-my-pi.md` §4.1；`agent-hub.md` |
| Misaka-Agent | `ctrl+b g` navigator（跨 space 搜 pane），`b/w/i/d` 过滤 blocked/working/idle/done | TUI panel 由 `herdr` 移植、终端库 ghostty（**不抄**） | `misaka-agent.md` §4-6、§4 表格 |
| Cindy | 未覆盖 → **需复核** | 未覆盖 → **需复核** | `cindy.md` §4 |

### 1.5 我们自己的现状（对照结论，来自截图与代码）

| # | 现状（证据） | 违反哪条 | 结论 |
|---|---|---|---|
| 1 | goal 在中栏出现 **3 次**：标题栏、用户气泡、大号衬线卡（`shot-app-cdp.png` / `shot-app-run.png`） | R1 一条信息只出现一次 | 大卡是 spec/验收卡的过度呈现，应降级为 1 行折叠条 |
| 2 | 中栏首屏：结论一行 + 大卡 + 一条点线「已完成」，下方 400px 空白 | R2 结论优先 / R5 留白是信息 | 「已完成」需要承载内容（耗时、Σtok、产物、验收勾选），而不是一条点线 |
| 3 | 左栏 19 条扁平列表，其中 12 条是 `smoke-*` / 「用 bash 执行…」；无 7 天窗、无分组、无未读（`renderSidebar`，`index.html:721-751`） | PRD §5.1 索引职责 | run 列表是「索引」，不是档案库 |
| 4 | run 行 = pill + `dur` + `Σtok`（`pillOf`，`:714-720`）；`1315:03` 这种量级无单位、无口径（累计？本轮？） | R4 单一权威表达 | 时间必须有口径；blocked 必须能在 run 行看见 |
| 5 | 右栏 380 只有一句「没有需要你处理的事」，底部挂 `任务 · 开放 · flash-jailbreak · 低`（截图） | PRD §5.3 空态 | 空态要解释「为什么空、下一步能做什么」 |

---

## 2 共识模式（≥3 家独立做过）

> 入选标准：**≥3 家独立实现**，且我们能在单文件 WebView 里落地。每条给 2–5 个**家级**出处（研究稿一个章节
> 常同时覆盖两家，所以指针数会略多于条目里的家数）；§1 的四张矩阵表对同一模式给了逐家位置，可交叉核对。

**C1 三区骨架：左索引 / 中主线 / 右上下文。** DSH（Session / Conversation / Sidebar）、T3 Code（sidebar /
timeline / composer）、OMP（状态行 + transcript + 钉跳表）、OpenCode（sidebar / transcript / composer /
pane）、Misaka（左三段 + 主区）。出处：`deepseek-harness.md` §4.1、`t3code.md` §4、`oh-my-pi.md` §4.1、
`opencode.md` §4.1、`misaka-agent.md` §4。

**C2 主线只有对话，过程是可折叠条目。** T3 Code 的三条硬规则之一（`t3code.md` §4）；DSH 的五层层级把工具
组压到第 3 层（`deepseek-harness.md` §4.2）；OpenCode 的默认只显示活动摘要（`opencode.md` §4.2）；CC 的
「每步可见、每步可折叠、折叠不改真相」（`claude-code.md` §4-2）。

**C3 等待态 = 一行稳定文案 + 计时，不是转圈也不是每步闪词。** DSH 的一行 shimmer + 当前工具名 + 已用时
（§4.3）；OpenCode 的 `Running command…` 稳定 busy label（§4.1）；T3 Code 的 live 计时（§4）；OMP 的子代理行
「当前工具 + 一行细节 + 超 5s 的计时」（§4.1）。

**C4 审批卡是数据，不是模板；呈现非模态、不抢焦点。** CC（选项菜单由服务端给）、Codex（每次选择必发决策
事件）双证于 `claude-code.md` §4-1 / `codex.md` §4-1；T3 Code 的审批是时间线里一行、就地消失（§4）；
OMP 的 dock 贴在 composer 上方、用户仍可打字（§4.1）；DSH 的 card Factory + 自动聚焦详情区（§4.4）。

**C5 挂起时用户打字 = 拒绝并说明（不是新消息）。** OMP（有草稿时高亮落在「Deny and send message」，§4.1）、
T3 Code（placeholder 随状态变化，把这句话解释成拒绝/转向，§4）、Codex（Esc 恒 Cancel，不说「继续」，§3.8）、
DSH（审批卡自动聚焦后 Enter/Esc 直接可用，§4.4）。

**C6 状态要聚合，且「等待人」压过「运行中」。** Misaka 的「space 的点 = pane 中最紧急的点」+ 四态
（§4-5）；Cindy 的「红 > 蓝 > lead 自己，且盖过运行中」（§4-3）；OpenCode 的「被权限挡住的工具不进摘要、
固定组外」（§4.1）；DSH 的「审批/提问卡自动聚焦到详情区」（§4.3）。

**C7 「关掉 ≠ 批准」「未答 ≠ 同意」。** Codex（Esc 恒 Cancel，刻意如此，§3.8）；DSH（pending 锁 + 被撤回的
请求不能再作答，§4.4）；OMP（出现后 0.5s 内忽略批准键，§4.1）；T3 Code（待答由服务端投影派生，前端不持有
「待答」真相，§4）。四家从不同角度堵同一个洞。

**C8 结果诚实性：不完整不显示，截断必须标注。** DSH 的「token/耗时账目不完整或自相矛盾就整行隐藏，绝不
显示部分合计」（§3.7(b)、`ui-chat:77`）与「截断必须可见」（§3.7 我们怎么改-②）；OpenCode 的「头截断 + 全文
落盘 + marker 带行范围与绝对路径」（§5 A5）；Cindy 的 `tool_result` / `tool_result_full` 分两条（§3）。

**C9 diff 两粒度：徽标给密度，正文给真相。** Codex（`+n/−m` 徽标 + unified diff 正文，§3.8 / §4-2）；
CC（inline diffs / visual diff review / `/diff` 面板三种密度，§3.8）；OpenCode（工具渲染器按工具出 diff，
§4.1）；Cindy（`turn_diff` 事件，§3）。

**C10 键盘：一个「总入口」+ `Esc` 关层/中断 + 审批专用键。** OpenCode（`ctrl+p` palette + `escape` interrupt，
§4.3）；DSH（`Ctrl/Cmd+K` + Esc 关顶层并还焦，§4.5）；OMP（`Alt+A` Hub，§4.1）；Misaka（`ctrl+b g`
navigator，§4）；Codex（keybinding 可自定义但 Esc 语义钉死，§3.8）。

**C11 视图永远不是事件的直出，而是一层投影。** OpenCode 的行模型（`rows.ts` / `grouping/session.ts`，§4.1）；
T3 Code 的 projection（§4）；Codex 的 item（§2.2）；DSH 的「隐藏行 + 折叠 + 计数徽标」把 133 条 step 事件压成
一屏（§4.2 反例段落）。

**C12 队列是独立信息层，不混进消息流。** T3 Code 的 `QueuedRunsControl` 单独成件（§4）；OMP 的 queue chip
（steering 与 followUp 分开显示，§4.1）；OpenCode 的「排队是用户显式动作，不是默认」+ `<leader>q` 管理
（§4.4）；Cindy 的 6 个排队类 MCP 工具（§6-2，我们判定**不抄**，但「独立层」这个结论成立）。

---

## 3 分歧点与我们的选择

**D1 TUI vs GUI（五家终端 TUI，三家图形界面）**
我们的选择：**WebView GUI，抄信息纪律不抄渲染**。OMP 明确把「Agent Hub 的全屏 TUI / 差分渲染器 / 鼠标捕获」
列为不抄（`oh-my-pi.md` §6-6），Misaka 把「TUI panel / tab / prefix key」列为不抄（§6-4），T3 Code 把
「LegendList 虚拟列表 / Tailwind 原语体系」列为不抄（`t3code.md` §6-6）。理由：我们的约束是单文件 HTML +
零依赖，终端复用那套在这里没有收益，只有成本；而**信息层级、间距语义、状态聚合**是跨渲染介质的。

**D2 事件流 vs 对话流**
我们的选择：**事件 → 投影 → 对话流（结论优先）**。中间态是「行/组」（OpenCode 的行模型、T3 的工作组），
终态是「一条对话」；不选「原始 provider 事件铺成时间线」（PRD A-1）。理由：DSH 的样本里 1050 条事件中 265 条
是 step 边界，全铺出来没人看（`deepseek-harness.md` §4.2）；而 Codex 的 item 化证明「协议化」才是给人读的形态。

**D3 右栏常驻 vs 抽屉**
我们的选择：**常驻 380，但只有三段（需要你 / 产物 / 子代理），默认落在「需要你」，且右栏不承载「详情」**。
不抄 DSH 的 dockkit（pane 预算 / 浮窗 / 历史 / 布局持久化，`deepseek-harness.md` §6-N4）；也不抄「详情从这里
滑出」的现状（`index.html:19-20` 的注释主张「细节唯一入口 = 右侧滑出」，与 380 常驻事实矛盾，见 P1）。
理由：Cindy 的「协同 tab 常驻 singleton」与 T3 的「主线只有对话」说明——**右栏的价值是「不用切换上下文就能
处置」，不是「多一个看东西的地方」**。

**D4 卡片密度：两档 vs 四档**
我们的选择：**两档（详细 / 紧凑），默认详细**。不抄 DSH 的 work-details 四档（自适应与折叠时序是复杂度的
黑洞，`deepseek-harness.md` §6-N5）；但抄 OpenCode 的 verbosity 语义（low/medium/high，`opencode.md` §4.2）
的一档折中：内部 `low`→紧凑、`medium`→详细，`high` 不做（等于 A-1）。理由：默认「详细」= 每个工具一行摘要
（不是原文），这既是「像 CodingAgent」的体感来源，也不违反「不铺事件」。

**D5 状态点语义：几态？**
我们的选择：**视觉 4 态（blocked / working / failed / done）+ 文字 6 值**。Misaka 给 4 态并强调「聚合取最
紧急」（§4-5）；Cindy 给「三档优先级 + 完成不冒泡」（§4-3）；现状代码已有 6 值词表（`ST_LABEL`，
`index.html:596`）。理由：多点一色会让「等你」和「在跑」长得一样（Cindy 的原话），但词表不必砍——词表进
中栏顶部与右栏条目，视觉点只留 4 个。

**D6 审批：模态 vs 就地**
我们的选择：**非模态：中栏 inline 卡 + 右栏置顶，两处同源（PRD R3）**。OMP 的 dock、T3 的时间线行、DSH 的
card+自动聚焦都指向「不夺焦」。理由：审批的本质是「一句话能答完」，模态把 3 秒的事变成 10 秒（切进→读→
选→切回），且让「我顺便说一句」无处安放。

**D7 审批动作：2 个还是 3 个**
我们的选择：**3 个 + 自由输入**（允许一次 / 允许并记住这类 / 拒绝并说明），且**选项由服务端 `opts[]` 生成**，
前端不硬编码。CC 与 Codex 双证「选项是数据」（`claude-code.md` §4-1、`codex.md` §4-1）；OpenCode 的
`always` 会展开说明「保存什么」（§4.4）——我们要抄这一句，因为「记住」必须说清记住的粒度。

**D8 投递：排队 vs 转向**
我们的选择：**R1 只做 `queue`，并在 UI 明示「本轮结束后送达」**；`steer/restart` 显式返回 `unsupported`
（PRD M9 / `t3code.md` A3）。理由：OpenCode 证明「排队是用户显式动作，不是默认」（§4.4）；Cindy 的 6 个排队
工具我们判定不抄（§6-2）——但**「已排队」必须可见**，否则就是「写了 spec.reply 但进程看不到」的老坑。

**D9 diff：全文 vs 徽标**
我们的选择：**徽标 `+N −M`（文件级）+ 每文件展开 unified（前 40 行）**；回滚留 R2，且 R1 不放假按钮。
Codex 两粒度（§3.8）；CC 三端三密度（§3.8）；OpenCode 的 `revert.stage` 是「消息回滚与文件回滚同一动作的
两个面」（§3）。理由：diff 是「要不要接受」的决策件，不是「看代码」的阅读件；密度不够就没有决策，正文
不给就没法复核。

**D10 子代理：独立页 vs 主线摘要**
我们的选择：**主线只留「状态句」，细节进右栏「子代理」页签**。OMP 的「子代理有独立视图，避免主 transcript
被子代理日志淹没」（§4.2-3）；Misaka 的「研究节点各占一个 tab」（§4-4）；Cindy 的「worker 不进侧栏，只把
异常汇总到 lead 行」（§4-1、§4-3）。理由：我们的 DAG 已经在树上了，重复呈现会制造三个「现在怎样」。

**D11 通知：OS 通知 vs 只角标**
我们的选择：**只有「需要你」才通知，200 字符上限，首次派发时申请权限**（现状已实现权限申请，
`index.html:638-651`）。CC 的 `PushNotification` 契约（<200 字符 + `status:"proactive"`，§3.8）是唯一有量化
的范本。理由：通知是打扰，只能给「不处理就停住」的事；完成通知会训练用户忽略通知。

**D12 主题：双主题 vs 单套 token**
我们的选择：**保留暖纸/近黑双主题（Anthropic 语言的一部分），但只维护一份语义 token 表 + 两套值**。
DSH 的建议是「单文件版先用 `color-scheme` + 少量变量，不做双套全量 token」（§4.6）——我们不采纳其
「单主题」结论，采纳其「token 少而稳」的方法。理由：dir-5/dir-6 的定稿语言依赖「暖纸」与「近黑」两种
底色对照（`direction-approved.md:5-6`），这是产品身份，不是偏好项。

---

## 4 对 `docs/workbench-ui.md` 的修订（P1–P20）

> 每条格式：**被谁支持 / 改成什么 / 为什么**。带「新增」的条目是现规范没有的；带「修订」的是现规范有但
> 需要改口径的；带「负向」的是要写进「不做」清单的。
> 基线（临时）：`direction-approved.md`（dir-5 骨架 × dir-6 语言）+ PRD v3 §5（R1–R5、六态）+ 现网令牌。

**P1（修订）三栏职责：右栏是「决策队列」，不是「详情区」。**
被谁支持：DSH §4.1 / §3.7(c)、T3 Code §4（主线只有对话）、Cindy §4-1（协同 tab 常驻 singleton）、PRD §5.1。
改成什么：左 256 = 索引；中 1fr = **唯一详情**；右 380 = 只有「需要你 / 产物 / 子代理」三段，默认「需要你」，
宽度锁定、不可拖拽、不做 docking。删掉 `index.html:19-20` 注释里「细节唯一入口 = 右侧滑出」的说法（与 380
常驻的事实矛盾）。
为什么：详情能出现在两个地方，「这条 run 现在怎么样」就没有唯一答案；而待裁决项的价值恰恰是「不切上下文
就能处置」。

**P2（修订）主线 = 一条对话；工具 / 审批 / 计划是可折叠工作条目。**
被谁支持：T3 Code §4-1、DSH §4.2、OpenCode §4.1-§4.2、CC §4-2。
改成什么：中栏自上而下固定顺序「用户 → 结论 → 工具组 → 内联审批卡 → 尾部状态」；工具组默认**每组一行统计
标签**（`3 命令 · 1 编辑 · 42s`），组内每条工具行是单行摘要。
为什么：PRD A-1「事件泄漏」的唯一解药是分组；四家独立收敛，说明这不是风格是纪律。

**P3（修订）一条信息只出现一次（R1 强化，带可核对判据）。**
被谁支持：DSH 的「隐藏行」规则（`ui-chat:57`：系统提示/context 注入/permission 命令行在任何档都不显示）、
OpenCode 的分组去重、T3 Code 的「主线唯一」。
改成什么：goal 只出现在标题栏；spec/验收清单降级为 1 行折叠条（「验收 · 3 条」）；气泡里不再重复 goal；
展开后也只出现条目的 `content`，不重复 goal。
为什么：截图实证 3 次重复（§1.5-1），这是「没有重心」最直接的来源。

**P4（修订）结论优先于过程（R2 落成具体形状）。**
被谁支持：DSH §4.2 第 1 层（本轮最终答复是唯一有 12px 上下留白的内容）、OpenCode 完成组的统计标签、
T3 Code 工作组可折叠。
改成什么：结论块常驻在最新一步之后（流式中则在末尾追加）；本轮结束后结论**上浮到工具组之前**，工具组
折叠为统计行。
为什么：「先看到结论、再决定要不要看过程」是人读日志的默认顺序；反过来就是日志浏览器。

**P5（修订）待裁决两处同源 + 聚合取最紧急（R3 补上「聚合」这一半）。**
被谁支持：Misaka §4-5（`red ● blocked`，space 取 pane 最紧急）、Cindy §4-3（红 > 蓝 > lead，盖过运行中）、
OpenCode §4.1（被挡工具固定组外）、DSH §4.3（审批卡自动聚焦）。
改成什么：run 行的状态点 = `max(子节点状态)`，优先级 `blocked > failed > working > done`；`blocked`
**只**来自「有未答 gate / 未答提问」；`done` 不冒泡（Cindy：「worker 的完成不汇总」）。
为什么：父行看不出子在等审批 = 用户必须逐个点开才知道工作台在等自己，这是最耗时的一种失败。

**P6（修订）状态只有一个权威表达（R4 落成「4 视觉 + 6 词」）。**
被谁支持：Misaka 四态、Cindy 三档优先级、现状词表（`ST_LABEL`，`index.html:596`）。
改成什么：视觉 4 态（blocked / working / failed / done），颜色只承担这 4 个语义；文字 6 值
（进行中 / 等你回复 / 已完成 / 排队中 / 等依赖 / 失败）**只在中栏顶部与右栏条目各出现一次**；run 行不再
同时给「色点 + 进度条 + 徽标」三套。
为什么：状态是最高频扫视对象，多一套表达就多一次解码。

**P7（修订）留白是信息（R5 量化成间距刻度）。**
被谁支持：DSH 把间距写成业务规则（普通流 4px、组标题与内容 8px、答复与相邻过程行 12px、完成轮控件 16px、
动作行 20px；且**折叠不改变答复前的 12px**，`deepseek-harness.md:338`）。
改成什么：写死四档刻度 `4 / 8 / 12 / 20`，并规定「折叠不改变答复间距」；一屏内最多 2 个视觉块。
为什么：人文感主要来自节奏稳定；间距随状态变化，观感立刻「晃」。

**P8（新增）等待态 = 一行 shimmer + 工具名 + 已用时；不显示 step 计数。**
被谁支持：DSH §4.3（shimmer + 当前工具名 + 已用时；step 计数是噪声）、OpenCode §4.1（稳定 busy label）、
T3 Code §4（live 计时）。
改成什么：运行中只渲染一行，文案形如「正在运行 bash · 12s」；`prefers-reduced-motion` 下退化为静态点。
为什么：PRD A-2「等待态消失」的正面解法；同时避免「每步闪一个词」的抖动。

**P9（新增）错误四色 + 中间重试不产生终结行。**
被谁支持：DSH §4.3 四色（红终结 / 琥珀预算 / 灰被拒 / 蓝重试中）、Codex 的 `Declined`（被拒≠失败）、
CC 的 `retry:true` 语义。
改成什么：失败行 = 红点 + 一句人话 + 展开原始事件 + 「重试」主按钮；预算/输出上限用琥珀；被拒用灰并带
「可以换个方式重试」提示；重试中不出终结行。
为什么：四色编码一次就能教会用户「这条要不要我管」，混成一色等于全部要管。

**P10（新增）审批卡：服务端 `opts[]` 生成 + 键盘语义 + 防误批。**
被谁支持：CC §4-1 / Codex §4-1（选项是数据）、OMP §4.1（0.5s 内忽略批准键；有草稿时高亮落在 Deny）、
DSH §4.4（pending 锁；Enter 只给有限 scope）、Cindy A3（deny 带理由）。
改成什么：卡片内容 = 命令原文（等宽）+ 一行「为什么要跑它」+ 3 个动作（由 `opts[]` 渲染）+ 自由输入框；
键盘 `Enter`=允许一次、`Esc`=拒绝、卡片出现 500ms 内 Enter 不生效；`always` 动作旁边必须写清「记住什么」。
为什么：审批是唯一「人必须在环」的地方，键盘语义错一次就慢一倍；误批一次就可能不可挽回。

**P11（新增）挂起时输入框语义切换。**
被谁支持：T3 Code A4（`ChatComposer.tsx:3414-3429` 五态一个表达式）、OMP A5（有草稿时高亮落在 Deny）、
Codex §3.8（Esc 恒 Cancel）。
改成什么：有未答 gate 时 placeholder 变「回复=拒绝并说明原因」；发送文字 → `gate-ans{decision:"deny",
feedback}`；无未答 gate 时恢复「派发任务，或回复等待中的问题…」。
为什么：「拒绝」不该是唯一表达；但「想补充一句」也不该变成误拒——所以只在有 gate 时启用（`t3code.md` §6-10）。

**P12（新增）结果诚实性：截断必须标注，账目不完整就不显示。**
被谁支持：DSH §3.7(b)（`ui-chat:77`，不完整整行隐藏）+ §4.3 红线、OpenCode §5 A5（头截断 + 全文路径 +
marker）、Cindy §3（`tool_result` / `tool_result_full` 分层）。
改成什么：工具输出被截断时显示「共 N 行，已显示前 M 行」并可展开；token/耗时四项缺一 → 整行不显示，
不得显示 `?` 或部分合计。
为什么：工作台的信任是一次性的；一次静默省略，之后每个数字都要怀疑。

**P13（新增）diff 两粒度。**
被谁支持：Codex §3.8 / §4-2（徽标 + unified）、CC §3.8（三端三密度）、OpenCode §4.1（工具特定渲染）、
Cindy §3（`turn_diff`）。
改成什么：文件级行 = 文件名 + `+N −M` + 状态；点开 = unified diff（前 40 行，超出标「还有 N 行」）；
每文件「接受 / 回滚」在 R2 前不出现（负向）。
为什么：diff 是决策件；密度不够就没有决策，正文不给就没法复核。

**P14（新增）分组与 verbosity：两档（详细 / 紧凑），默认详细。**
被谁支持：OpenCode §4.2（三档 verbosity + 分组路径）、DSH §6-N5（四档是复杂度黑洞，我们只取两档）、
T3 Code §4（工作组折叠）。
改成什么：紧凑 = 只留结论 + 每轮一行「N 步 / M 秒 / Σtok」；详细 = 每组统计标签 + 每条工具单行摘要；
档位存 `localStorage`；切换不改变「答复前 12px」。
为什么：默认要「像 CodingAgent」（看得到命令），但不能是原文；`high`（每条 part 不折叠）等于 A-1，不做。

**P15（新增）键盘最小集 + 命令面板 + 焦点规矩。**
被谁支持：DSH §4.5（`Ctrl/Cmd+K`、Esc 还焦、「任何快捷键必须有鼠标入口」）、OpenCode §4.3（palette +
interrupt）、OMP §4.1（`Alt+A`）、Misaka §4（navigator）。
改成什么：`Ctrl/Cmd+K` 命令面板、`J/K` 选 run、`A` 批准首个待裁决、`R` 拒绝、`/` 聚焦输入、
`Esc` 关层（关层 ≠ 批准）/ 中断（有确认）；每个快捷键配鼠标等价入口；关闭弹层后焦点回到触发元素。
为什么：CodingAgent 的体感一半来自「手不离键盘」；而焦点丢失是最容易让人放弃键盘的一件小事。

**P16（新增）断线态显式化。**
被谁支持：DSH §4.3（Connection 用 generation 建模；断线显式显示「已断开，重连中」而不是静默停在最后一条
delta）、OpenCode §5 A16（SSE 是 volatile、HTTP GET 才是可靠状态源）、现状（poll 5s + SSE 并存，
`index.html:614-640`）。
改成什么：断线 → 顶部黄条「桥已断开，正在重连」+ 重连成功自动消失 + 提供手动刷新；重连后**以
`/api/v1/view` 全量校准**，不重放 delta。
为什么：本地桥会重启（S16/S21 就在改它）；静默停在最后一条 delta 会让用户对着「假的运行中」等下去。

**P17（新增）通知契约。**
被谁支持：CC §3.8（`PushNotification` <200 字符 + `status:"proactive"`）、现状（`notifyNewInbox` 首拉建基线
不轰炸，`index.html:638-651`）。
改成什么：只有「需要你」通知；文案 ≤200 字符；首次派发时申请权限；区分 `blocked`（卡在审批）与
`proactive`（模型主动找人）两种文案。
为什么：通知是打扰，只能给「不处理就停住」的事。

**P18（新增）子代理的呈现边界。**
被谁支持：OMP §4.2-3（子代理有独立视图）、Misaka §4-4（节点各占 tab）、Cindy §4-1/§4-3（worker 不进侧栏，
只汇总异常）。
改成什么：主线只显示「状态句」（如「子代理 research-2 正在读 3 个文件」）与树上的状态点；完整过程进右栏
「子代理」页签；子代理的 `done` 不冒泡到 run 行。
为什么：三处都呈现「现在怎样」= 没有一处是权威。

**P19（修订）主题与排版：双主题 + 单 token 表。**
被谁支持：DSH §4.6（圆角刻度统一、等宽只给工具/代码、过程行统一 tertiary、动效 reduced-motion 退化）、
`direction-approved.md:5-6`（暖纸/近黑是定稿语言）、现状令牌（`index.html:24-41`：clay 只给 agent presence、
blue 给操作、三档圆角 8/12/14、三档动效 60/120/200ms）。
改成什么：保留双主题；token 只维护一份语义表 + 两套值；等宽字体**只**用于工具/代码/路径；圆角按角色
（控件 8 / 卡 12 / composer 14）；所有动效在 `prefers-reduced-motion` 下退化为无位移。
为什么：主题是产品身份，token 数量是维护成本；两者要分开决策。

**P20（负向）明确不做：docking / 四档折叠 / pane-tab 终端复用 / 自动滚动抢占。**
被谁支持：DSH §6-N4（dockkit）、DSH §6-N5（四档）、OMP §6-6（Hub 全屏 TUI / 差分渲染）、Misaka §6-4
（panel/tab/prefix key）、PRD A-6（自动滚动打架）。
改成什么：写进规范的「不做」清单，并各给一句理由，避免下一轮又被提起。
为什么：不做清单和做清单同等重要——它是「重心」的另一半。

---

## 5 关键界面（线框级文字描述）

> 模板：**区域 / 内容 / 层级 / 默认折叠态**。四行说完一个界面，不画 ASCII 图。

### 5.1 Run 列表（左 256）

- **区域**：`+ 新任务` 一行 → 「进行中」（卡片列表）→ 「等你」（仅在非空时出现）→ 「已结束」（紧凑行）→
  底部只有主题切换与状态指示，不放第二个按钮。
- **内容**：每条 = 状态点 + 一句话标题（goal 首行，最多 1 行，超出 `…`）+ 右对齐的「本轮耗时（口径见 P6，
  超过 1h 转 `1h19m`）」；进行中卡片额外一行「最新动作」；等你卡片额外一行「在等什么」（如「bash 审批 ·
  rm -rf build」）。
- **层级**：标题是唯一 14px 文本；状态点 4 态色（P6）；「等你」分组的标题带计数徽标 `等你 · 2`；已结束行
  12px tertiary，悬停才出删除。
- **默认折叠态**：「已结束」默认折叠为「已结束 · 17」一行，点开才展开；默认只显示最近 7 天；`smoke-*` /
  测试 run 归入「测试」分组，默认折叠（PRD §5.1）。

### 5.2 Run 详情（中 1fr：对话 + 工具 + 审批）

- **区域**：标题栏（goal 一次 + 右端「刷新/中止」）→ 结论块 → 工具组（可折叠）→ 内联审批卡（有 gate 时
  插在结论块之后）→ 尾部状态行（耗时 / Σtok / 状态词）→ composer。
- **内容**：结论块 = 1 段正文（≤3 行折叠，超出「展开」）；工具组 = 组头统计标签 + 单行工具行（`图标 工具名
  参数首行 状态点 耗时`）；审批卡见 5.3；尾部状态行 = 状态词 + 本轮耗时 + Σtok（四项缺一整行不显示，P12）。
- **层级**：结论 15px 正体、最重；工具行 13px tertiary、等宽只给参数与输出；状态词 12px muted 且**只在此处
  与左栏各一次**；goal 不再出现在任何气泡里。
- **默认折叠态**：工具组默认折叠为统计行（详细档展开组内单行）；单条工具行默认单行摘要，点开才显示原文
  （等宽、上限 40 行 + 「还有 N 行」）；spec/验收清单折成 1 行「验收 · 3 条」。

### 5.3 审批卡（内联 + 右栏同源）

- **区域**：卡片顶部一行「需要你批准 · 来自 <节点路径>」→ 命令原文块 → 一行「为什么要跑它」→ 动作行。
- **内容**：命令原文（等宽，最多 6 行，超出可展开）；三个动作由 `opts[]` 渲染（允许一次 / 允许并记住这类 /
  拒绝并说明）+ 自由输入框；`always` 动作旁小字写「记住：bash · rm -rf build/ 前缀」。
- **层级**：卡片是唯一带 1px 强调边框的块；`允许一次` 为主按钮；`拒绝` 为文本按钮；命令原文是卡内最大字号
  的等宽文本（12.5–13px）。
- **默认折叠态**：卡片不折叠；但「为什么」一行默认 1 行，超出部分省略号 + tooltip；卡片出现 500ms 内忽略
  Enter（P10）；关闭 ≠ 批准，关闭后卡片消失但 run 行仍是 `blocked` 并显示一行「未批准，worker 仍在等待」。

### 5.4 diff 卡

- **区域**：文件行列表（每文件一行）→ 展开后的 unified diff 块 → 底部动作行（R1 为空）。
- **内容**：文件行 = 路径（等宽，相对仓库根，中间省略）+ `+N −M` + 状态色；diff 块 = unified（前 40 行）；
  截断时尾行「还有 N 行」。
- **层级**：`+N` 绿 / `−M` 红，其余中性；路径与 diff 用等宽；卡片标题只写「改动 · 2 个文件」。
- **默认折叠态**：全部折叠为文件行；一次只允许展开一个文件的 diff；R1 不出现「接受/回滚」按钮（P13、P20）。

### 5.5 需要你（右 380，默认页签）

- **区域**：页签头（需要你 / 产物 / 子代理）→ 条目列表（按阻塞程度排序）→ 底部一行当前档位与主题。
- **内容**：每条 = 一行「是什么」+ 一行「在哪」（`run › 节点`，纯文本面包屑，无盒）+ 动作（点开即裁决）；
  排序 `gate > 提问 > 失败待处理 > 完成通知`（PRD §5.4-4）。
- **层级**：条目 ≤3 行；`gate` 条目带强调边框，其余为发丝线；计数徽标在页签上。
- **默认折叠态**：条目默认折叠到 2 行（问题 + 来源）；点开在中栏定位并聚焦（不替换右栏内容）。空态必须
  解释原因（见 5.10）。

### 5.6 产物

- **区域**：文件行列表（文件名 · 大小）→ 点击在右栏内预览（HTML 迷你渲染 / 图片 / 文本前 N 行）。
- **内容**：文件行 = 文件名 + 大小 + 来源节点；预览区顶部一行「打开方式：在资源管理器 / 复制路径」。
- **层级**：文件名 13px 正体；大小 12px tertiary；预览区与列表同一栏宽，无弹窗。
- **默认折叠态**：无折叠（产物本来就少）；超过 10 个文件时列表区自己滚动，页签头固定。

### 5.7 子代理

- **区域**：页签内是「返回行 + DAG 行」；返回行是唯一的扁平行（现状已如此，`index.html:452`）。
- **内容**：每行 = 状态点 + 节点名 + 一句自然语言状态（「正在读 3 个文件」）+ 耗时；点开下钻一级。
- **层级**：与中栏树同一套行样式（现状复用是对的）；状态点跟 P6 的 4 态。
- **默认折叠态**：只显示直接子级（level 1），更深层靠下钻；主线不重复这些内容，只留状态句（P18）。

### 5.8 派发输入区（composer）

- **区域**：输入框（单行起、自适应到 6 行）→ 左侧 chips 行（档位/模型/附加）→ 右侧发送按钮。
- **内容**：placeholder 三态（空闲 / 有 gate / 运行中排队），见 P11；chips 行不允许被视口底边裁切（PRD §5.4-5，
  截图里贴着底边是缺陷）。
- **层级**：输入框是页面最圆的面（14px 圆角）+ 唯一阴影；发送按钮是 clay 实心圆（agent presence 色，不是
  操作蓝——操作蓝留给链接与次级动作）。
- **默认折叠态**：chips 行默认单行，多余收进「⋯」；`Ctrl/Cmd+Enter` 发送、`Shift+Enter` 换行、`/` 聚焦。

### 5.9 空态（三处，各有各的话）

- **区域**：空态占据它本来要占的那块区域，不弹出、不铺满。
- **内容**：左栏空 = 「还没有任务。按 `+ 新任务` 派一件，或按 `/` 直接说一句。」；中栏空 = 「选一条任务看过程；
  没有任务时，这里会把最近一次的结论放在最上面。」；右栏空 = 「这个 run 没有待裁决项；3 条历史裁决已折叠。」
  （PRD §5.3 要求解释「为什么空」）。
- **层级**：空态文本 13px muted，绝不用插画；只有一处行动入口（链接式）。
- **默认折叠态**：无；但空态消失时不做动画（避免「闪一下」）。

### 5.10 错误态 / 断线态

- **区域**：断线 = 顶部黄条（横跨中栏，不遮标题）；错误 = 中栏尾部状态行 + 可展开的原始事件；桥级故障 =
  右栏顶部一条。
- **内容**：断线条 = 「桥已断开，正在重连…」+ 右侧「手动刷新」；重连成功 1.5s 后自动消失；错误行 = 红点 +
  一句人话（「worker 退出（code -1）」）+ 「重试」+ 「展开原始事件」。
- **层级**：黄条只占 1 行、不改变布局高度（用 sticky 覆盖而非挤压）；错误行的红色**只**给终结性失败。
- **默认折叠态**：原始事件默认折叠；重试默认是主按钮；断线期间 composer 保持可输入但发送按钮禁用并写原因
  （「重连后可发送」），不允许静默丢弃输入。

---

## 6 可执行的 UI 验收清单（U01–U28）

> 每条都可由人在真机上 3 分钟内核对，或由脚本（CDP / DOM 断言 / `node --test`）自动核对。
> 标注：`[脚本]` 可自动化、`[人工]` 需人眼、`[夹具]` 需要先造数据。

- [ ] U01 `[脚本]` 1426×863 视口下三栏宽度为 256 / 1fr / 380，实测误差 ≤1px（量 `getBoundingClientRect`）。
- [ ] U02 `[脚本]` 中栏第一屏内 goal 文本出现次数**恰为 1**（统计中栏可见文本里标题字符串的出现次数）。
- [ ] U03 `[脚本]` spec/验收清单默认渲染为 1 行「验收 · N 条」折叠条；展开后才出现条目行。
- [ ] U04 `[脚本][夹具]` 有未答 gate 时：右栏「需要你」置顶且中栏出现内联审批卡，两处卡片指向同一 `gate.id`。
- [ ] U05 `[脚本][夹具]` run 行状态点 = 子节点最紧急态；构造「一个 blocked 子节点 + 一个 working 子节点」→ 父行必须是 blocked。
- [ ] U06 `[脚本][夹具]` 同一 run 内 blocked 与 working 并存时，run pill 显示「等你」而非「进行中」。
- [ ] U07 `[脚本]` 工具行默认单行显示「图标 + 工具名 + 参数首行 + 状态点 + 耗时」，行高 ≤28px 且不换行。
- [ ] U08 `[脚本]` 展开单条工具行显示等宽原文，最多 40 行，超出显示「还有 N 行」。
- [ ] U09 `[脚本][夹具]` 喂 10000 行输出的夹具 → DOM 必须含「共 10000 行」与已显示行数，不得静默省略。
- [ ] U10 `[人工]` 运行中只有**一行** shimmer 状态（无 step 计数、无逐 step 闪烁）；`prefers-reduced-motion` 下无位移。
- [ ] U11 `[人工][夹具]` 失败行 = 红点 + 一句人话 + 「重试」主按钮 + 「展开原始事件」，展开可见事件 JSON。
- [ ] U12 `[脚本][夹具]` 注入 2 次中间重试事件 → 终结行数量为 1，且中间重试不出终结行。
- [ ] U13 `[脚本]` 审批卡按钮严格来自 view 的 `opts[]`：改 `opts[]` 内容后按钮文案随之变化，前端无硬编码动作文案。
- [ ] U14 `[脚本]` 审批卡 `Enter` = 允许一次、`Esc` = 拒绝；卡片出现后 500ms 内按 `Enter` 不产生决定。
- [ ] U15 `[脚本]` 有未答 gate 时 composer placeholder 变为「回复=拒绝并说明原因」；发送文字后 `gate-ans.decision==="deny"` 且 `feedback` 非空。
- [ ] U16 `[脚本]` 关闭审批卡（`Esc`）后：卡消失、run 行仍为 blocked、出现一行「未批准，worker 仍在等待」。
- [ ] U17 `[脚本][夹具]` diff 卡显示每文件 `+N −M` 与状态；展开后是 unified diff 且可滚动。
- [ ] U18 `[人工]` R1 阶段 diff 卡**不出现**「接受/回滚」按钮，也不出现「即将支持」之类的假承诺。
- [ ] U19 `[脚本]` 右栏空态文本包含原因（解释为什么空，长度 >12 字且含「没有/已折叠」等因果词），不是一句「没有」。
- [ ] U20 `[脚本][夹具]` kill 桥 → 顶部黄条出现（≤2s）；重启桥后黄条 ≤3s 消失；期间输入不被丢弃、发送按钮禁用并给出原因。
- [ ] U21 `[脚本]` 首屏从加载到首条内容可见 ≤2s（`performance.now()` 口径）。
- [ ] U22 `[脚本][夹具]` 500 个 run 时 `GET /api/v1/view` p50 ≤100ms（PRD Q6）。
- [ ] U23 `[脚本]` 键盘：`Ctrl/Cmd+K` 打开命令面板、`J/K` 切 run、`A` 批准首个、`R` 拒绝、`/` 聚焦输入、`Esc` 中断（有确认）。
- [ ] U24 `[脚本]` 上述每个快捷键都有对应可点击入口；关闭弹层后 `document.activeElement` 回到触发元素。
- [ ] U25 `[脚本]` 两主题下正文对比度 ≥4.5:1；clay 只出现在 agent presence（头像/发送/状态）上，链接与次级动作是蓝色。
- [ ] U26 `[脚本]` `emulateMedia({reducedMotion:'reduce'})` 下无位移/缩放动画，仅保留透明度变化。
- [ ] U27 `[人工]` 一屏内视觉块 ≤2（结论块 + 待办块），其余要么折叠要么在右栏（PRD R5）。
- [ ] U28 `[脚本]` composer 的 chips 行不被视口底边裁切（`rect.bottom ≤ innerHeight - 12`），且 `+ 新任务` 与 send 都可见可点。

---

## 7 未覆盖与需复核

1. **`docs/workbench-ui.md` 不存在**（见文首）。若该文件由另一任务落盘，请以 P1–P20 编号合入；§5 的线框描述
   可直接作为它的第 3 章。
2. **Codex / CC / Cindy 的键盘与主题**研究稿只覆盖到「有 keybinding / 有 spinnerVerbs / 未见」，逐键表与
   颜色值**需复核**。
3. **T3 Code 的 diff 视图**（§1.3）研究稿只覆盖 checkpoint/rollback 语义，未覆盖 diff 组件的呈现方式，**需复核**。
4. **OpenCode TUI 的视觉细节**由研究稿自陈未读（`opencode.md:511`），本文只采其结构结论。
5. **DSH 的 diff 呈现**未覆盖（`deepseek-harness.md` §4 无 diff 小节），本文未据此给结论。
6. 截图里的 `1315:03` 这类时长口径**需现场确认**是「累计 worker 时间」还是「本轮耗时」——P6 要求统一口径后再
   决定展示形态。

---

## 8 出处汇总

- `docs/prd-workbench-v3.md:302-355`（§5 UI：三栏职责 / R1–R5 / 六态 / 关键界面 / 键盘）、`:231-240`（反模式 A-1…A-6）、
  `:109-129`（M1–M15）、`:250`（G-6 UI 门）。
- `workbench/prototype/design-demos/direction-approved.md:5-7`（dir-5 定稿、dir-6 深化方向、用户原话）。
- `workbench/public/v1/index.html`：`:19-20`（旧主张：右栏滑出）、`:24-45`（clay/serif/圆角/三档宽）、
  `:568-570`（右栏三页签）、`:596`（6 值状态词表）、`:614-651`（poll+SSE、通知基线）、`:714-751`（pill、run 列表）、
  `:452`（子代理页签：与中栏同一套 DAG 行，「返回行是唯一的扁平行」的样式注释）。
- 研究稿：`deepseek-harness.md` §3.7、§4.1–§4.6、§6；`opencode.md` §4.1–§4.5、§5、§6、`:511`；
  `claude-code.md` §3.3.3、§3.3.4、§3.8、§4；`codex.md` §2.2、§3.8、§4；`t3code.md` §4、§3.10、§6；
  `oh-my-pi.md` §4.1–§4.2、§5、§6；`misaka-agent.md` §4、§5、§6；`cindy.md` §3、§4、§5、§6。
- 真机截图：`C:\Users\Administrator\ego\aica-inspect-20261104-1410\shot-app-cdp.png`、`shot-app-run.png`
  （1426×863，三栏 256 / 790 / 380）。

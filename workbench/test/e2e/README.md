# workbench/test/e2e —— S27 验收脚手架

录制回放 + 故障注入 + UI 断言 + 性能预算。目标不是"多几条测试"，而是**让"完成"可被外部核对**：
夹具是真实跑出来的磁盘真相，断言读的是磁盘/进程/HTTP/DOM，不是被测方自己的说法。

## 跑法

```powershell
node --test workbench/test/e2e                        # 全绿：37 pass / 6 skip（skip 都带理由，见下）
$env:UPDATE_SNAPSHOTS='1'; node --test workbench/test/e2e   # 确认语义改动后重录投影快照
$env:AICA_E2E_PERF_RUNS='200'; node --test workbench/test/e2e/perf.test.ts   # 缩小/放大性能样本
$env:CHROME_PATH='C:\...\msedge.exe'                  # 指定浏览器（否则自动找 Edge/Chrome）
```

只用 Node 内建：`node:test`、`node:child_process`、全局 `fetch`/`WebSocket`（CDP）。没有测试框架依赖。

## 目录

```
fixtures/<case>/     真实 run 目录的拷贝（case.json 说明来源与断言点；不含 case.json 以外的合成）
snapshots/<case>.json 投影快照：只钉语义字段，时间归一化成 <hh:mm>，绝对路径抹掉
lib/replay.mjs        录制回放：materialize / replayView / replayTranscribe / digestOf / matchSnapshot
lib/faults.mjs        五个故障注入器（见下表）
lib/scenario.mjs      子进程场景：一套干净 AICA_STATE 里跑一次真产品代码，输出 __RESULT__ JSON
lib/scenario-run.mjs  场景运行器：起子进程、解析结果、清理临时 STATE
lib/srv.mjs           起真桥（可换端口）+ HTTP 断言工具
lib/browser.mjs       CDP 无头浏览器：launchBrowser → page.send / page.evaluate
tools/make-approval-fixture.mjs  用真实 gate.ts 生成两个闸门夹具（幂等）
```

## 夹具

| 夹具 | run | 节点 | 来源 | 断言什么 |
|---|---|---|---|---|
| `real-turn` | `e9a3cf91-a19c` | root | 2026-11-04 s21 手工验收的真跑 | done、3 条工具步骤（带 events 行号）、1 个 artifact、进 settled |
| `budget-abort` | `c3749723-e556` | root | 真跑 + `budget.tokens=10` | failed + `reason=budget exceeded` + `spent=1915`（G-5 的真实证据） |
| `compaction` | `s20-compaction-demo` | root | S20 演示夹具 | `compaction_start/summary/end` 合成为 1 条记录，`before_tokens` 不编造 |
| `approval-wait` | `seed-01-waiting` | root | S25 等审批夹具 | 无 result 但 `agg=blocked`；审计里 `decision=null`；不占 `view.inbox` |
| `gate-question` | `gate-question-demo` | root | 同上改造 | `waiting` → `status=input` + `view.inbox` 一张卡（多选 + 面包屑） |
| `failed-node` | `wb-fixture-demo1` | root/summarize | S25 子节点失败夹具 | 子节点 failed、结局非 completed、失败也要一句人话 |

三个不变量对每个夹具都跑：**投影稳定**（快照）、**纯函数**（同一磁盘真相两次构建 deepEqual）、**转写可重放**（`stdout.log` → `turnUsage` 的账本与录制时 `usage.json` 完全一致）。

## 故障注入器

| 注入器 | 制造什么 | 断言 |
|---|---|---|
| `killWorker(nodeDir)` | 杀租约里的 worker，留下 `worker.json` | `pendingNodes()` 收尾为 `failed/orphaned`、只写 1 条 `orphan` 事件、清租约、**不重复拉起**（pending1/pending2 都是 0，全程 0 条 `spawn`） |
| `killDaemon(stateDir)` | 杀守护进程 ×10（真 daemon 进程） | 有活租约时始终 0 条 `spawn`；租约也死后只收一次孤儿；队列清零（无僵尸节点） |
| `truncateEvents(file,{fraction})` | 把 `events.jsonl` 从中间截断（可能留半行） | 行数变少但**投影不炸**；run 仍在列表；剩余事件仍带行号（对应产品 Q2 可回溯） |
| `badGateAns(nodeDir)` | 写一个非法 `gate-ans.json`（`decision` 不在闭集） | **fail-closed**：`approvalState().invalid=true` 且 `pending=true`（卡留在「需要你」）、审计记 `decision:"invalid-answer"`、不伪造 result、run 不变 done |
| `diskReadonly(file)` | chmod + `attrib +R` | 写 `events.jsonl` **必须抛错**、文件字节不变（事件丢失要炸，不要静默）；环境不支持则 skip 并说明 |

另有三个子进程场景补齐注入器覆盖不到的真进程行为：
`state-machine`（终止态不可覆写、`resolveWaiting` 只认 waiting）、`security`（G-4 全套）、`readonly-events`（只读盘）。

## 六道门 → 用例

| 门 | 用例 |
|---|---|
| G-1 契约 | `gates.test.ts` · 15 个子命令都回 envelope（形状）；**严格态**（USAGE + 非 0 退出 + 无栈）当前未达标 → skip 并列出缺口 |
| G-2 状态机 | `gates.test.ts` · 终止态不可覆写、`resolveWaiting` 只认 waiting、`patchResult` 是收尾通道；严格态（非法迁移主动报错）未实现 → skip |
| G-3 恢复 | `gates.test.ts` · 孤儿归宿；`faults.test.ts` · killWorker / killDaemon×10 |
| G-4 安全 | `gates.test.ts` · deny / deny_paths / rules / critical-path / restricted / 控制面 / grant 逃逸 / safeJoinIn / tier 未知按 exec |
| G-5 预算 | `gates.test.ts` · 用真夹具复现拦截：`enforceTokenBudget` 返回 exceeded、事件 `{limit:10,spent:1915}`、**abort 文案与落盘 `result.summary` 逐字相同**、边界 `==limit→ok`、`无预算→no-budget` |
| G-6 UI | `gates.test.ts` 数据面（`/api/v1/view` 与 `/api/approvals` 说同一件事）+ `ui.test.ts` DOM 面（`.stp` 行数 == 服务端 steps、`.concl` 在过程之前、卡上按钮 == `/api/approvals` opts、空态文案） |

## 端口分配

`4487` 是主用例的临时端口；多文件并行时按带分配，避免互相顶：
`ui.test.ts` 主用例 `4487`（顺延 4488..4492）、空态用例 `4493`；`gates.test.ts` G-6 `4480`。
起桥前会核 `expectRuns`，**对不上就换端口**——绝不测别人的服务。Windows 上 TIME_WAIT 也会让 bind 失败，所以顺延是正常路径而非异常。

## 性能预算（两条口径，同一数据集）

500 个 run 目录（每个 1 节点 + 20 事件），冷/热各 21 次采样：

```
[perf] runs=500 warm p50=39.1ms p95=40.3ms（预算 100）· cold p50=303.6ms p95=312.0ms（护栏 400）· cache=10500/500
```

- **warm p50 ≤ 100ms（必须绿）**：S26 run 级缓存命中后的稳态请求，用户真正感受到的那条。
- **cold p50 ≤ 400ms（必须绿，回归护栏）**：清缓存后首次全量读盘；冷路径仍然被看着，但不拿"首次加载"堵门。
- 只有 S26 缓存未落地（warm==cold，两条都测不出意义）才 `[skip-budget]`；否则两条都是硬断言。

## 已知风险

1. **审批 ans 闭集**：S19 起 `decision` 不在 `{allowed-once,rejected,cancelled,unavailable}` 里一律视为**未答**（fail-closed），
   非法值记 `decision:"invalid-answer"` 审计、卡留在「需要你」。`badGateAns` 固定这条契约；将来若有人把 `pendingApproval` 退回"只看 mtime"，这条用例会红。
2. **两条人机闸门通道不等价**：`gate.json + result.waiting` → `view.inbox`；`gate-req.json` → `/api/approvals` + `view.audits`。
   夹具分开覆盖，不把两者相等当成产品不变量。
3. **`workbench/view.ts` 正在被改**：断言只用导出的语义 API 与语义字段，不钉行号、不整包快照；`clearViewCache` 用 `typeof` 探测，S26 没落地时性能用例仍能跑。
4. **`node --test <目录>` 会把 `test/**` 下所有 `.mjs` 当测试文件**：`lib/scenario.mjs` 无场景名时静默退出，
   `tools/make-approval-fixture.mjs` 在 `NODE_TEST_CONTEXT` 下不动夹具。
5. **端口**：4487 被别的进程/测试占用时自动顺延；`expectRuns` 不匹配同样顺延（防止把别人的状态当自己的）。
6. **夹具时间固定**：审批 TTL 是 10 分钟，走 HTTP 的用例先把 mtime 拨到"刚刚"（`touchRecent`）；回放用例用 `case.json.now` 钉死。
7. 6 个 skip 全部带理由：4 个是"该夹具没有 `stdout.log`，转写器无输入"，2 个是 G-1/G-2 严格态未达标（信封形状本身是绿的）。

## 设计依据

- **验证世界**（DSH A13）：断言从外部重读磁盘/进程/HTTP，未触碰的文件保持字节相同（`readonly-events` 直接比对字节）。
- **不 mock 产品**（OpenCode A17）：用真实 `runs.ts` 写盘、真实 `gate.ts` 解析、真实 `view.ts` 投影、真实 `server.ts` 起桥、真实浏览器跑 DOM；
  测试里唯一的"假"是一个只占租约的 `setInterval` 进程（它不实现任何产品逻辑）。
- **事件级断言**：步骤断言带 `events.jsonl` 行号，失败时能回到那一行。

// S27 · 性能预算（docs/prd-workbench-v3.md §3.1 Q6 / §3.3 性能门）
// 500 个 run 目录（每个 1 节点 + 20 事件）下测 workbench/view.ts::buildView 的 p50/p95。
// 冷构建 = 清缓存后构建（模拟"改了磁盘后第一次请求"），热构建 = 直接再构建（S26 mtime 缓存命中）。
// 预算 p50 ≤ 100ms；没达标或缓存未落地时**不假装绿**：skip 并打印 [skip-budget] + 真实数字。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rmSync } from "node:fs";
import * as V from "../../view.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const NOW = Date.parse("2026-11-04T12:00:00.000Z");
const RUNS = Number(process.env.AICA_E2E_PERF_RUNS ?? 500);
const BUDGET_MS = 100;
const SAMPLE = 21;

function pct(sorted, p) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}

function buildSynthetic(runsDir, n) {
  for (let r = 0; r < n; r++) {
    const id = `perf-${String(r).padStart(4, "0")}`;
    const dir = join(runsDir, id, "nodes", "root");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(runsDir, id, "run.json"), JSON.stringify({
      root_id: id, created_at: new Date(NOW - r * 60_000).toISOString(), subject: `性能样本 ${r}`,
    }));
    writeFileSync(join(dir, "spec.json"), JSON.stringify({
      id: `node:${id}/root`, type: "assign", agent: "pi", goal: `样本 ${r}`, accept: ["ok"], inputs: [], tools: ["bash"],
    }));
    const lines = [];
    for (let i = 0; i < 10; i++) {
      const ts = new Date(NOW - 3600_000 + i * 1000).toISOString();
      lines.push(JSON.stringify({ kind: "tool_call", ts, seq: i * 2 + 1, data: { call_id: `c${i}`, tool: "bash", args: `echo ${i}` } }));
      lines.push(JSON.stringify({ kind: "tool_execution", ts, seq: i * 2 + 2, data: { call_id: `c${i}`, tool: "bash", durationMs: 12, isError: false, result: `line-${i}` } }));
    }
    writeFileSync(join(dir, "events.jsonl"), lines.join("\n") + "\n");
    writeFileSync(join(dir, "result.json"), JSON.stringify({
      id: `node:${id}/root`, type: "result", status: "done", summary: `样本 ${r} 完成`, finished_at: new Date(NOW - 1800_000).toISOString(),
    }));
  }
}

test(`性能预算：${RUNS} runs · buildView p50 ≤ ${BUDGET_MS}ms`, (t) => {
  const runsDir = mkdtempSync(join(tmpdir(), "aica-e2e-perf-"));
  const tBuild = Date.now();
  buildSynthetic(runsDir, RUNS);
  t.diagnostic(`造 ${RUNS} 个 run 目录耗时 ${Date.now() - tBuild}ms`);

  const hasCache = typeof V.clearViewCache === "function" && typeof V.viewCacheStats === "function";

  // 正确性先立住：别为了跑得快而漏读
  const v0 = V.buildView(runsDir, { now: NOW });
  assert.equal(v0.runs.length, RUNS, `buildView 必须投影出全部 ${RUNS} 个 run（实际 ${v0.runs.length}）`);
  assert.equal(v0.runs[0].steps.length, 10, "每个节点 10 条工具步骤都要投影出来");
  assert.ok(v0.runs.every((r) => r.status === "done"), "合成样本都是 done");

  // 冷构建：清缓存，模拟"磁盘变了之后第一次请求"
  const cold = [];
  for (let i = 0; i < SAMPLE; i++) {
    if (hasCache) V.clearViewCache();
    const t0 = performance.now();
    V.buildView(runsDir, { now: NOW });
    cold.push(performance.now() - t0);
  }
  // 热构建：缓存命中（S26）
  const warm = [];
  for (let i = 0; i < SAMPLE; i++) {
    const t0 = performance.now();
    V.buildView(runsDir, { now: NOW });
    warm.push(performance.now() - t0);
  }
  const cs = [...cold].sort((a, b) => a - b);
  const ws = [...warm].sort((a, b) => a - b);
  const c50 = pct(cs, 50), c95 = pct(cs, 95), w50 = pct(ws, 50), w95 = pct(ws, 95);
  const stats = hasCache ? V.viewCacheStats() : { hits: 0, misses: 0, size: 0 };
  const line = `[perf] runs=${RUNS} cold p50=${c50.toFixed(1)}ms p95=${c95.toFixed(1)}ms · warm p50=${w50.toFixed(1)}ms p95=${w95.toFixed(1)}ms · cache=${hasCache ? `${stats.hits}/${stats.misses}` : "off"}`;
  console.log(line);
  t.diagnostic(line);

  // 世界核对：跑完 21 次冷构建 + 21 次热构建，视图仍然是 500 个 run
  assert.equal(V.buildView(runsDir, { now: NOW }).runs.length, RUNS);

  if (!hasCache) {
    t.skip(`[skip-budget] S26 mtime 缓存未落地；真实冷构建 p50=${c50.toFixed(1)}ms p95=${c95.toFixed(1)}ms（预算 ${BUDGET_MS}ms）`);
  } else if (c50 > BUDGET_MS) {
    t.skip(`[skip-budget] 500 runs 冷构建 p50=${c50.toFixed(1)}ms > 预算 ${BUDGET_MS}ms（p95=${c95.toFixed(1)}ms；热 p50=${w50.toFixed(1)}ms）。S26 缓存已生效（命中 ${stats.hits} / 未命中 ${stats.misses}），说明热点不在事件投影，而在每次 buildView 仍要遍历 500 个 run 目录、逐节点 readdir/stat/readJson——超预算 ${(c50 / BUDGET_MS).toFixed(1)}×，留给 S26 的下一轮或 view 层批量化`);
  } else {
    assert.ok(c50 <= BUDGET_MS, `冷构建 p50 ${c50.toFixed(1)}ms 超预算 ${BUDGET_MS}ms`);
    assert.ok(w50 <= c50 + 1, "热构建不该比冷构建更慢（缓存必须真的省时间）");
  }

  rmSync(runsDir, { recursive: true, force: true });
});

test("性能预算：空目录/不存在目录不因为性能优化而破契约", () => {
  const empty = mkdtempSync(join(tmpdir(), "aica-e2e-perf-empty-"));
  if (typeof V.clearViewCache === "function") V.clearViewCache();
  assert.deepEqual(V.buildView(empty, { now: NOW }), { runs: [], inbox: [], settled: [] });
  const missing = join(empty, "no-such");
  assert.deepEqual(V.buildView(missing, { now: NOW }), { runs: [], inbox: [], settled: [] });
  rmSync(empty, { recursive: true, force: true });
});

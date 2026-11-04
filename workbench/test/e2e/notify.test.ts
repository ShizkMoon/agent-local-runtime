// R6：通知与未读 —— 标题 (N)、失焦时才打扰、一次去重。
// DOM 层断言：真桥 + 真浏览器（CDP）；Notification 用桩（headless 里没法真弹系统通知），
// 桩在页面脚本之前注入，断言的是"应用确实构造了通知"而不是"系统真的弹了"。
import test from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkTmp, materialize, touchRecent } from "./lib/replay.mjs";
import { findBrowser, launchBrowser } from "./lib/browser.mjs";
import { E2E_PORT, startServer, waitFor } from "./lib/srv.mjs";
import { rmSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "fixtures");
const PORT = Number(process.env.AICA_E2E_NOTIFY_PORT ?? 4507);

/** 在页面脚本执行前注入：Notification 桩 + 把窗口伪装成"失焦/不可见" */
const STUB = `(() => {
  try {
    window.__notes = [];
    class FakeNotification {
      static permission = "granted";
      static requestPermission() { return Promise.resolve("granted"); }
      constructor(title, opts) {
        window.__notes.push({ title: String(title), body: String((opts || {}).body || ""), tag: String((opts || {}).tag || "") });
      }
      close() {}
    }
    Object.defineProperty(window, "Notification", { value: FakeNotification, configurable: true });
    Object.defineProperty(document, "visibilityState", { get: () => "hidden", configurable: true });
    Object.defineProperty(document, "hasFocus", { value: () => false, configurable: true });
  } catch (e) { window.__stubErr = String(e); }
})()`;

async function withPage(t, runs, fn) {
  const exe = findBrowser();
  if (!exe) { t.skip("没找到浏览器（可设 CHROME_PATH）；通知断言按约定 skip"); return; }
  const state = mkTmp("aica-e2e-notify-");
  const runsDir = join(state, "runs");
  for (const [caseName, opts] of runs) {
    const m = materialize(join(FIX, caseName), runsDir);
    if (opts?.recent) touchRecent(m.nodeDir);   // 审批 TTL 只有 10 分钟
  }
  let srv = null, br = null;
  try {
    try { srv = await startServer({ stateDir: state, port: PORT, expectRuns: runs.length }); }
    catch (e) { if (String(e?.message ?? e).startsWith("PORT_BUSY")) { t.skip(`端口全占：${String(e.message)}`); return; } throw e; }
    try { br = await launchBrowser({ exe, timeoutMs: 25000 }); }
    catch (e) { t.skip(`浏览器起不来：${String(e?.message ?? e)}`); return; }
    await br.page.send("Page.addScriptToEvaluateOnNewDocument", { source: STUB });
    await br.page.send("Page.navigate", { url: `${srv.base}/v1/index.html` });
    await fn(br.page, srv);
  } finally {
    if (br) await br.kill();
    if (srv) await srv.stop();
    rmSync(state, { recursive: true, force: true });
  }
}

test("通知：有一条待处理 → 标题 (1)，且失焦时真的构造了通知", async (t) => {
  await withPage(t, [["gate-question"]], async (page) => {
    const title = await waitFor(async () => {
      const v = await page.evaluate(`document.title`);
      return v && /^\(1\) /.test(v) ? v : null;
    }, { timeoutMs: 20000, intervalMs: 150, label: "标题出现 (1)" });
    assert.equal(title, "(1) AICA 工作台", "未读数必须写进标题");

    const notes = await waitFor(async () => {
      const v = await page.evaluate(`window.__notes || []`);
      return v && v.length > 0 ? v : null;
    }, { timeoutMs: 20000, intervalMs: 150, label: "Notification 构造" });
    assert.ok(notes.length >= 1, "失焦 + 有卡 → 必须弹一次");
    assert.equal(notes[0].title, "需要你：SSE 断线后要不要自动重连？", `通知标题应带问题首行：${notes[0].title}`);
    assert.ok(notes[0].tag.startsWith("inbox:"), `tag 要能去重：${notes[0].tag}`);

    // 一次去重：轮询多轮也只弹一次
    const after = await page.evaluate(`(async () => { await new Promise(r => setTimeout(r, 2500)); return (window.__notes || []).length; })()`);
    assert.equal(after, notes.length, "同一条卡不许反复弹");
  });
});

test("通知：没有待处理 → 标题不带 (N)，一条通知都不弹", async (t) => {
  await withPage(t, [["real-turn"]], async (page) => {
    await waitFor(async () => {
      const n = await page.evaluate(`(typeof RUNS !== "undefined" ? RUNS.length : 0)`);
      return n > 0 ? n : null;
    }, { timeoutMs: 20000, intervalMs: 150, label: "视图加载" });
    const snap = await page.evaluate(`(async () => { await new Promise(r => setTimeout(r, 1200)); return { title: document.title, notes: (window.__notes || []).length }; })()`);
    assert.equal(snap.title, "AICA 工作台", "没有未读就不该有 (N) 前缀");
    assert.equal(snap.notes, 0, "没有待处理不该弹通知");
  });
});

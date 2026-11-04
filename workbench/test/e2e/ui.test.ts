// S27 · UI 断言（G-6 DOM 层）
// 起真桥（4487）+ 真浏览器（CDP，无头 Edge/Chrome），断言三条：
//   ① #threadScroll .stp 行数 == /api/v1/view 里该 run 的根节点 steps 数
//   ② .concl（结论）在过程组之前（P4：结论优先于过程）
//   ③ 审批卡按钮文案 == /api/approvals 的 opts[]（服务端生成、前端只渲染，不硬编码）
// 没有浏览器就 skip 并打印原因——不许失败，也不许假装通过。
import test from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rmSync, writeFileSync } from "node:fs";
import { findBrowser, launchBrowser } from "./lib/browser.mjs";
import { materialize, mkTmp, touchRecent } from "./lib/replay.mjs";
import { E2E_PORT, getJson, startServer, waitFor } from "./lib/srv.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "fixtures");
// 端口分带：主用例占 4487，空态用例让开，避免并行文件互相顶
const E2E_EMPTY_PORT = Number(process.env.AICA_E2E_EMPTY_PORT ?? 4493);

const MARK = "__e2e_done";

async function openApp(page, base) {
  // 产品的真实入口是 /v1/index.html（workbench/shell/main.go:30 的 viewURL），不是根路径
  await page.send("Page.navigate", { url: `${base}/v1/index.html` });
  // 等到"应用自己画完"：出现过程行或结论，且 view 已经拉过至少一次
  await waitFor(
    async () => {
      const state = await page.evaluate(`(() => {
        const stp = document.querySelectorAll("#threadScroll .stp").length;
        const concl = document.querySelectorAll("#threadScroll .concl").length;
        return { ready: document.readyState, stp, concl };
      })()`);
      return state && state.stp > 0 && state.concl > 0 ? state : null;
    },
    { timeoutMs: 25000, intervalMs: 200, label: "首屏渲染（.stp + .concl）" },
  );
}

test("G-6 UI：步骤行数、结论在过程之前、审批卡 opts 与服务端一致", async (t) => {
  const exe = findBrowser();
  if (!exe) {
    t.skip("没找到 Chrome/Edge/Chromium（可设 CHROME_PATH）；UI 断言在无浏览器环境按约定 skip");
    return;
  }

  const state = mkTmp("aica-e2e-ui-");
  const runsDir = join(state, "runs");
  const real = materialize(join(FIX, "real-turn"), runsDir);
  const aw = materialize(join(FIX, "approval-wait"), runsDir);
  touchRecent(aw.nodeDir); // 服务端按 Date.now() 判审批 TTL
  // 视图默认选中最新的 run；这里把 real-turn 拨成最新，保证首屏就是"有结论 + 有过程"的那条
  writeFileSync(join(runsDir, real.case.runId, "run.json"), JSON.stringify({
    root_id: real.case.runId, kind: real.case.kind, subject: real.case.subject,
    created_at: "2026-11-04T09:30:00.000Z",
  }, null, 2) + "\n", "utf8");

  let srv = null, br = null;
  try {
    try { srv = await startServer({ stateDir: state, port: E2E_PORT, expectRuns: 2 }); }
    catch (e) { if (String(e?.message ?? e).startsWith("PORT_BUSY")) { t.skip(`端口全占：${String(e.message)}`); return; } throw e; }
    const view = await getJson(`${srv.base}/api/v1/view`);
    const approvals = await getJson(`${srv.base}/api/approvals`);
    const runView = (view.json?.runs ?? []).find((r) => r.id === real.case.runId);
    assert.ok(runView, "服务端视图里应有 real-turn");
    const expectSteps = (runView.steps ?? []).length;
    const expectOpts = (approvals.json?.approvals ?? []).flatMap((a) => (a.opts ?? []).map((o) => o.label));
    assert.ok(expectSteps > 0, "real-turn 必须有工具步骤，否则这条 UI 断言没意义");
    assert.ok(expectOpts.length >= 2, `审批卡应有 ≥2 个动作（服务端给了 ${expectOpts.length}）`);

    try {
      br = await launchBrowser({ exe, timeoutMs: 25000 });
    } catch (e) {
      t.skip(`浏览器起不来（${exe}）：${String(e?.message ?? e).slice(0, 200)}`);
      return;
    }
    const { page } = br;
    await openApp(page, srv.base);

    const dom = await page.evaluate(`(() => {
      const stp = Array.from(document.querySelectorAll("#threadScroll .stp"));
      const concl = document.querySelector("#threadScroll .concl");
      const card = document.querySelector("#pane-inbox .incard.approve");
      const opts = card ? Array.from(card.querySelectorAll(".opt")).map((b) => b.textContent.trim()) : [];
      const before = !!(concl && stp.length && (concl.compareDocumentPosition(stp[0]) & Node.DOCUMENT_POSITION_FOLLOWING));
      return {
        stp: stp.length,
        concl: concl ? (concl.textContent || "").trim().slice(0, 80) : null,
        conclBeforeSteps: before,
        approveCard: !!card,
        opts,
      };
    })()`);

    // ① 步骤行数 == 服务端投影的步骤数（UI 不多画也不少画）
    assert.equal(dom.stp, expectSteps, `#threadScroll .stp 行数 ${dom.stp} != /api/v1/view steps ${expectSteps}`);

    // ② 结论在过程组之前（P4）
    assert.ok(dom.concl, "结论区 .concl 必须存在（该 run 有 summary）");
    assert.equal(dom.conclBeforeSteps, true, "结论必须在过程行之前（DOM 顺序）");

    // ③ 审批卡 opts 与服务端一致
    assert.equal(dom.approveCard, true, "右栏应渲染出审批卡（#pane-inbox .incard.approve）");
    assert.deepEqual(dom.opts, expectOpts, `卡上按钮 ${JSON.stringify(dom.opts)} != /api/approvals ${JSON.stringify(expectOpts)}`);

    t.diagnostic(`浏览器：${br.browserVersion}；端口 ${srv.port}；steps=${dom.stp}；opts=${dom.opts.length}；结论「${dom.concl}」`);
  } finally {
    if (br) await br.kill();
    if (srv) await srv.stop();
    rmSync(state, { recursive: true, force: true });
  }
});

test("G-6 UI（负向）：空状态不装忙——没有 run 时给下一步，而不是空白", async (t) => {
  const exe = findBrowser();
  if (!exe) {
    t.skip("没找到浏览器；空态断言按约定 skip");
    return;
  }
  const state = mkTmp("aica-e2e-ui-empty-");
  let srv = null, br = null;
  try {
    try { srv = await startServer({ stateDir: state, port: E2E_EMPTY_PORT, expectRuns: 0 }); }
    catch (e) { if (String(e?.message ?? e).startsWith("PORT_BUSY")) { t.skip(`端口全占：${String(e.message)}`); return; } throw e; }
    try {
      br = await launchBrowser({ exe, timeoutMs: 25000 });
    } catch (e) {
      t.skip(`浏览器起不来：${String(e?.message ?? e)}`);
      return;
    }
    await br.page.send("Page.navigate", { url: `${srv.base}/v1/index.html` });
    const txt = await waitFor(async () => {
      const v = await br.page.evaluate(`(() => { const e = document.querySelector("#threadScroll .empty-note"); return e ? e.textContent.trim() : ""; })()`);
      return v && v.length > 0 ? v : null;
    }, { timeoutMs: 20000, intervalMs: 200, label: "空态文案" });
    assert.match(txt, /还没有任务/, "空态必须解释「为什么空 + 下一步做什么」（P17）");
    assert.match(txt, /派发|\//, "空态要给下一步动作（派发 / 快捷键）");
    t.diagnostic(`空态文案：${txt.replace(/\s+/g, " ").slice(0, 120)}`);
  } finally {
    if (br) await br.kill();
    if (srv) await srv.stop();
    rmSync(state, { recursive: true, force: true });
  }
});








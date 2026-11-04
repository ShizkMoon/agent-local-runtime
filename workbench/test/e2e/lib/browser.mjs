// S27 e2e · 无头浏览器（CDP）。找得到浏览器就真跑三条 UI 断言；找不到就让调用方 skip 并打印原因。
// 只用 Node 内置 WebSocket + fetch，不装 puppeteer。
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CANDIDATES = [
  process.env.CHROME_PATH,
  process.env.EDGE_PATH,
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean);

export function findBrowser() {
  for (const p of CANDIDATES) if (existsSync(p)) return p;
  return null;
}

async function pollJson(url, timeoutMs) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (r.ok) return await r.json();
    } catch (e) { last = e; }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`CDP 未就绪：${url}（${String(last?.message ?? last)}）`);
}

/** 一条 CDP 连接（page 级） */
class Page {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener("message", (msg) => {
      let m;
      try { m = JSON.parse(msg.data); } catch { return; }
      if (!m.id) return;
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.error) p.reject(new Error(`${m.error.message} (${JSON.stringify(m.error.data ?? null)})`));
      else p.resolve(m.result);
    });
  }
  send(method, params = {}, timeoutMs = 20000) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP ${method} 超时`)); }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(t); resolve(v); },
        reject: (e) => { clearTimeout(t); reject(e); },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r?.exceptionDetails) {
      throw new Error(`页面内异常：${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    }
    return r?.result?.value;
  }
  close() { try { this.ws.close(); } catch {} }
}

/**
 * 起一个无头浏览器并连上 about:blank 页。
 * @returns {Promise<{page:Page, exe:string, kill:()=>Promise<void>, userDataDir:string}>}
 */
export async function launchBrowser(o = {}) {
  const exe = o.exe ?? findBrowser();
  if (!exe) throw new Error("没找到 Chrome/Edge/Chromium（可设 CHROME_PATH）");
  const port = o.port ?? 9500 + Math.floor(Math.random() * 300);
  const userDataDir = o.userDataDir ?? mkdtempSync(join(tmpdir(), "aica-e2e-cdp-"));
  const proc = spawn(exe, [
    "--headless=new",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-sync",
    "--metrics-recording-only",
    "about:blank",
  ], { stdio: ["ignore", "ignore", "ignore"], windowsHide: true });

  const version = await pollJson(`http://127.0.0.1:${port}/json/version`, o.timeoutMs ?? 20000);
  // 新建一个 page target（老版本只支持 GET，新版本要求 PUT：先 PUT 再退回 GET）
  let target = null;
  for (const method of ["PUT", "GET"]) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method, signal: AbortSignal.timeout(2000) });
      if (r.ok) { target = await r.json(); break; }
    } catch { /* 换下一种方法 */ }
  }
  if (!target) {
    const list = await pollJson(`http://127.0.0.1:${port}/json/list`, 5000);
    target = (list ?? []).find((t) => t.type === "page");
  }
  if (!target?.webSocketDebuggerUrl) {
    try { proc.kill(); } catch {}
    throw new Error("CDP 没有可用的 page target");
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("CDP WebSocket 连接超时")), 10000);
    ws.addEventListener("open", () => { clearTimeout(t); resolve(); });
    ws.addEventListener("error", (e) => { clearTimeout(t); reject(new Error(`CDP WebSocket 失败：${String(e?.message ?? e)}`)); });
  });
  const page = new Page(ws);
  await page.send("Page.enable");
  await page.send("Runtime.enable");
  const kill = async () => {
    page.close();
    try { proc.kill(); } catch {}
    await new Promise((r) => { const t = setTimeout(r, 1500); proc.once("exit", () => { clearTimeout(t); r(); }); });
    try { rmSync(userDataDir, { recursive: true, force: true }); } catch {}
  };
  return { page, exe, kill, userDataDir, browserVersion: version?.Browser ?? "unknown", port };
}

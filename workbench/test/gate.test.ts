// S19 审批重做 —— gate.ts 的闭集 / 三件套分离 / 危险路径硬拒 / 卡 opts，
// 以及 server.ts 的 approve 路由与「挂起时回复 = 拒绝 + 说明原因」语义。
// 依赖：gate 的超时/轮询在模块加载时读 env，故先设小值再动态 import（测试里不等待真 2min）。
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { once } from "node:events";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const GATE_URL = pathToFileURL(join(HERE, "../../aica-pi/extensions/gate.ts")).href;
const SERVER = join(HERE, "../server.ts");

process.env.AICA_GATE_TIMEOUT_MS = "150";
process.env.AICA_GATE_POLL_MS = "15";
const gate: any = await import(GATE_URL);

/** 假 pi：只收 tool_call 一个 handler（真 pi 的 on 是同一签名） */
const onToolCall: any = (() => {
  const hs: any[] = [];
  gate.default({ on: (_e: string, h: any) => hs.push(h) });
  return hs[0];
})();

interface Fixture { base: string; dir: string }

/** 每个用例一个独立 run/节点目录；env 指向它（gate 每次调用现读 env 与 spec） */
function fixture(spec: Record<string, unknown>, t: any): Fixture {
  const base = mkdtempSync(join(tmpdir(), "gate-s19-"));
  const dir = join(base, "runs", "r1", "nodes", "root");
  mkdirSync(dir, { recursive: true });
  process.env.AICA_STATE = base;
  process.env.AR_ROOT_ID = "r1";
  process.env.AR_NODE_PATH = "root";
  writeFileSync(join(dir, "spec.json"), JSON.stringify(spec, null, 2), "utf8");
  writeFileSync(join(dir, "events.jsonl"), "", "utf8");
  t.after(() => { try { rmSync(base, { recursive: true, force: true }); } catch { } });
  return { base, dir };
}

const reqFile = (dir: string): string => join(dir, "gate-req.json");
const ansFile = (dir: string): string => join(dir, "gate-ans.json");
const readJson = <T,>(f: string): T => JSON.parse(readFileSync(f, "utf8")) as T;

async function waitFor(cond: () => boolean, ms = 2000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 5));
  }
  return cond();
}

/** 发起一次工具调用，等 gate 写出 req 后按指定应答（不等到超时） */
async function callWithAnswer(
  fix: { dir: string },
  call: { tool: string; id: string; args: unknown },
  answer: { decision: string; feedback?: string; remember?: unknown },
): Promise<{ result: any; req: any }> {
  const p = onToolCall({ toolName: call.tool, toolCallId: call.id, input: call.args }, {});
  assert.ok(await waitFor(() => existsSync(reqFile(fix.dir))), "gate 应写出 gate-req.json");
  const req = readJson<any>(reqFile(fix.dir));
  writeFileSync(ansFile(fix.dir), JSON.stringify(answer), "utf8");
  return { result: await p, req };
}

async function eventsOf(dir: string): Promise<any[]> {
  return readFileSync(join(dir, "events.jsonl"), "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}

// ---------- M3：危险路径硬拒（任何档与 grant 都无权放行） ----------

test("硬拒：rm -rf ~ / $HOME / .. / 盘根 → 直接 block，不弹卡；permission=full 与宽 grant 也放不开", async (t) => {
  const { dir } = fixture({ permission: "full" }, t);
  // 伪造一条宽授权（整个工具名）：硬拒先于 grant，不该有任何作用
  writeFileSync(join(dir, "grants.json"), JSON.stringify({ v: 2, grants: [{ tool: "bash", tier: "exec", target: "*" }] }), "utf8");
  const cases = ["rm -rf ~", "rm -rf $HOME", "rm -rf ..", "rm -rf C:\\", "rm -rf /", 'rm -rf "$HOME"/*'];
  for (const [i, cmd] of cases.entries()) {
    const r = await onToolCall({ toolName: "bash", toolCallId: `hard-${i}`, input: { command: cmd } }, {});
    assert.equal(r?.block, true, `${cmd} 必须被硬拒`);
    assert.match(String(r.reason), /critical-path/, `${cmd} 的理由要点名 critical-path`);
    assert.equal(existsSync(reqFile(dir)), false, `${cmd} 不得弹审批卡`);
  }
  // 普通删除照常走档位（full → 放行）
  assert.equal(await onToolCall({ toolName: "bash", toolCallId: "hard-ok", input: { command: "rm -rf ./dist" } }, {}), undefined);
});

// ---------- M2：三件套分离 ----------

test("deny：恒拒不弹窗（工具名 + deny_paths），reason 带命中模式", async (t) => {
  const { dir } = fixture({ permission: "supervised", deny: ["bash"], deny_paths: ["*.pem"] }, t);
  const r1 = await onToolCall({ toolName: "bash", toolCallId: "d1", input: { command: "npm test" } }, {});
  assert.equal(r1?.block, true);
  assert.match(String(r1.reason), /deny 列表/);
  assert.equal(existsSync(reqFile(dir)), false, "deny 不写 gate-req");

  const r2 = await onToolCall({ toolName: "write", toolCallId: "d2", input: { path: "C:/work/private/key.pem", content: "x" } }, {});
  assert.equal(r2?.block, true);
  assert.match(String(r2.reason), /deny_paths/);
  assert.match(String(r2.reason), /\.pem/);
  assert.equal(existsSync(reqFile(dir)), false);
});

test("deny_paths：整段匹配，不再误伤 mysecrets.md（旧实现是裸子串）", async (t) => {
  const { dir } = fixture({ permission: "full", deny_paths: ["secrets"] }, t);
  assert.equal(await onToolCall({ toolName: "read", toolCallId: "s1", input: { path: "C:/work/mysecrets.md" } }, {}), undefined,
    "mysecrets.md 不含 secrets 整段，应放行");
  const hit = await onToolCall({ toolName: "read", toolCallId: "s2", input: { path: "C:/work/secrets/a.txt" } }, {});
  assert.equal(hit?.block, true);
  assert.equal(existsSync(reqFile(dir)), false);
});

test("restricted：必问且不可记住（restricted_paths 压过 grant）", async (t) => {
  const { dir } = fixture({ permission: "full", restricted_paths: ["secrets"] }, t);
  const target = join(dir, "secrets", "a.txt");
  // 预置一条命中该文件的 grant：restricted 先于 grant，仍然要问
  writeFileSync(join(dir, "grants.json"), JSON.stringify({ v: 2, grants: [{ tool: "read", tier: "read", target }] }), "utf8");
  const p = onToolCall({ toolName: "read", toolCallId: "r1", input: { path: target } }, {});
  assert.ok(await waitFor(() => existsSync(reqFile(dir))), "restricted 必须产 req");
  const req = readJson<any>(reqFile(dir));
  assert.equal(req.restricted, true);
  assert.equal(req.rememberable, false);
  assert.equal(req.opts.some((o: any) => o.scope), false, "restricted 卡不得给「记住」动作");
  writeFileSync(ansFile(dir), JSON.stringify({ decision: "allowed-once", remember: { tool: "read", tier: "read", target } }));
  await p;
  const g = readJson<any>(join(dir, "grants.json"));
  assert.equal(g.grants.length, 1, "伪造 remember 不得追加 grant（只剩预置那条）");
});

test("控制面：写 spec.json 恒问，任何档都不放行、不能记住", async (t) => {
  const { dir } = fixture({ permission: "full" }, t);
  const p = onToolCall({ toolName: "write", toolCallId: "c1", input: { path: join(dir, "spec.json"), content: "{}" } }, {});
  assert.ok(await waitFor(() => existsSync(reqFile(dir))));
  const req = readJson<any>(reqFile(dir));
  assert.match(String(req.reason), /控制面/);
  assert.equal(req.restricted, true);
  writeFileSync(ansFile(dir), JSON.stringify({ decision: "rejected" }));
  const r = await p;
  assert.equal(r?.block, true);
});

test("数据面：full 档下 artifacts 写入不问（控制面不误伤）", async (t) => {
  const { dir } = fixture({ permission: "full" }, t);
  assert.equal(await onToolCall({ toolName: "write", toolCallId: "a1", input: { path: join(dir, "artifacts", "out.txt"), content: "x" } }, {}), undefined);
});

// ---------- M2：grant 只对命中的资源生效 ----------

test("grants：记住的是「这次命中的资源」，npm test 放行后 npm publish 仍问", async (t) => {
  const fix = fixture({ permission: "supervised" }, t);
  const { dir } = fix;
  const { result, req } = await callWithAnswer(
    fix,
    { tool: "bash", id: "g1", args: { command: "npm test" } },
    { decision: "allowed-once", remember: { tool: "bash", tier: "exec", target: "npm test" } },
  );
  assert.equal(result, undefined, "允许一次应放行");
  assert.equal(req.target, "npm test", "卡的 target 是命令资源，不是工具名");
  const grants = readJson<any>(join(dir, "grants.json")).grants;
  assert.deepEqual(grants.map((g: any) => [g.tool, g.tier, g.target]), [["bash", "exec", "npm test"]]);

  assert.equal(await onToolCall({ toolName: "bash", toolCallId: "g2", input: { command: "npm test" } }, {}), undefined,
    "同一资源第二次不再问");
  assert.equal(existsSync(reqFile(dir)), false, "grant 命中不写 req");

  const p = onToolCall({ toolName: "bash", toolCallId: "g3", input: { command: "npm publish" } }, {});
  assert.ok(await waitFor(() => existsSync(reqFile(dir))), "换命令必须重新问");
  assert.equal(readJson<any>(reqFile(dir)).target, "npm publish");
  writeFileSync(ansFile(dir), JSON.stringify({ decision: "rejected", feedback: "先别发版" }));
  const r = await p;
  assert.equal(r?.block, true);
  assert.equal(String(r.reason), "先别发版", "拒绝理由原样回注模型");
});

test("grants：不同工具/不同 tier 不共享（bash 的授权不覆盖 write）", async (t) => {
  const fix = fixture({ permission: "supervised" }, t);
  const { dir } = fix;
  await callWithAnswer(
    fix,
    { tool: "bash", id: "t1", args: { command: "npm test" } },
    { decision: "allowed-once", remember: { tool: "bash", tier: "exec", target: "npm test" } },
  );
  const p = onToolCall({ toolName: "write", toolCallId: "t2", input: { path: join(dir, "notes.md"), content: "x" } }, {});
  assert.ok(await waitFor(() => existsSync(reqFile(dir))), "write 不在 bash 的 grant 里，必须问");
  writeFileSync(ansFile(dir), JSON.stringify({ decision: "allowed-once" }));
  await p;
  assert.equal(readJson<any>(join(dir, "grants.json")).grants.length, 1, "allowed-once 不写 grant");
});

// ---------- M1：决策闭集 + fail-closed ----------

test("超时：无应答 → decision=unavailable 并 block（不与 rejected 混计）", async (t) => {
  const { dir } = fixture({ permission: "supervised" }, t);
  const r = await onToolCall({ toolName: "bash", toolCallId: "to1", input: { command: "ping 127.0.0.1" } }, {});
  assert.equal(r?.block, true);
  assert.match(String(r.reason), /审批通道不可用/);
  const dec = (await eventsOf(dir)).filter((e) => e.kind === "approve_decide");
  assert.equal(dec.length, 1);
  assert.equal(dec[0].data.decision, "unavailable");
  assert.equal(dec[0].data.source, "timeout");
  assert.equal(dec.some((e) => e.data.decision === "rejected"), false, "超时不得记成 rejected");
});

test("坏决策值（v2 的 allow/deny）→ unavailable，不当成 rejected", async (t) => {
  const fix = fixture({ permission: "supervised" }, t);
  const { dir } = fix;
  const { result } = await callWithAnswer(fix, { tool: "bash", id: "bad1", args: { command: "echo closed-set" } }, { decision: "allow" });
  assert.equal(result?.block, true);
  const dec = (await eventsOf(dir)).filter((e) => e.kind === "approve_decide").pop();
  assert.equal(dec.data.decision, "unavailable");
  assert.equal(dec.data.source, "invalid-decision");
});

test("cancelled：中止信号 → cancelled（既不是 rejected 也不是 unavailable）", async (t) => {
  const { dir } = fixture({ permission: "supervised" }, t);
  const ctrl = new AbortController();
  const p = onToolCall({ toolName: "bash", toolCallId: "ab1", input: { command: "echo abort-me" } }, { signal: ctrl.signal });
  assert.ok(await waitFor(() => existsSync(reqFile(dir))));
  ctrl.abort();
  const r = await p;
  assert.equal(r?.block, true);
  const dec = (await eventsOf(dir)).filter((e) => e.kind === "approve_decide").pop();
  assert.equal(dec.data.decision, "cancelled");
  assert.equal(existsSync(reqFile(dir)), false, "决策后清 req");
});

test("拒绝带 feedback 原样回注；不带 feedback 用默认理由", async (t) => {
  const fix = fixture({ permission: "supervised" }, t);
  const { dir } = fix;
  const a = await callWithAnswer(fix, { tool: "bash", id: "f1", args: { command: "curl http://x" } },
    { decision: "rejected", feedback: "别联网，用本地夹具" });
  assert.equal(String(a.result.reason), "别联网，用本地夹具");

  const b = await callWithAnswer(fix, { tool: "bash", id: "f2", args: { command: "wget http://y" } }, { decision: "rejected" });
  assert.match(String(b.result.reason), /调用被拒绝/);
  assert.equal(existsSync(reqFile(dir)), false);
});

// ---------- M4：卡 opts 由服务端生成 + 挂起时输入语义（HTTP 端到端） ----------

const PORT = 4489;

function makeServerFixture(t: any): { base: string; dir: string } {
  const base = mkdtempSync(join(tmpdir(), "gate-srv-"));
  const dir = join(base, "runs", "r1", "nodes", "root");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "spec.json"), JSON.stringify({ id: "node:r1/root", type: "assign", goal: "s19", accept: ["x"], permission: "supervised" }), "utf8");
  writeFileSync(join(dir, "events.jsonl"), "", "utf8");
  t.after(() => { try { rmSync(base, { recursive: true, force: true }); } catch { } });
  return { base, dir };
}

/** 卡内容由 gate 生成（opts 的唯一真相）；这里直接落 gate-req.json 喂给桥 */
function writeReq(dir: string, callId: string, command: string): any {
  const res = gate.resolveCall({ permission: "supervised" }, "bash", { command }, [], dir);
  const req = {
    v: 2, call_id: callId, tool: "bash", tier: res.tier, target: res.target,
    restricted: res.restricted, rememberable: true, reason: res.reason, hit: res.hit,
    args: { command }, targets: [], opts: gate.buildOpts("bash", res),
    asked_at: new Date().toISOString(),
  };
  writeFileSync(join(dir, "gate-req.json"), JSON.stringify(req, null, 2), "utf8");
  return req;
}

async function getJson(url: string): Promise<{ status: number; body: any }> {
  const r = await fetch(url);
  return { status: r.status, body: await r.json() };
}

async function postJson(url: string, body: unknown): Promise<{ status: number; body: any }> {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}

/** 轮询等 server listen（首次 fetch 可能 ECONNREFUSED） */
async function waitForHttp(url: string, ms = 8000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(url);
      if (r.ok) return true;
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

test("server：/api/approvals 出卡 + approve 落闭集 + 挂起时 reply 转成拒绝（不是新消息）", async (t) => {
  const { base, dir } = makeServerFixture(t);
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, WB_PORT: String(PORT), AICA_STATE: base },
    stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  t.after(async () => { try { child.kill(); await once(child, "exit"); } catch { /* 已退 */ } });
  let out = "";
  child.stdout!.on("data", (c: Buffer) => { out += c.toString(); });
  child.stderr!.on("data", (c: Buffer) => { out += c.toString(); });

  const baseUrl = `http://127.0.0.1:${PORT}`;
  assert.ok(await waitForHttp(`${baseUrl}/api/daemon`), `server 未就绪：${out.slice(-400)}`);

  // 1) 无 pending
  assert.deepEqual((await getJson(`${baseUrl}/api/approvals`)).body, { approvals: [], count: 0 });

  // 2) gate 生成的卡原样透出（前端不硬编码动作）
  const req = writeReq(dir, "srv-1", "npm test");
  const list = (await getJson(`${baseUrl}/api/approvals`)).body;
  assert.equal(list.count, 1);
  const card = list.approvals[0];
  assert.equal(card.id, "ap:r1/root:srv-1");
  assert.equal(card.tool, "bash");
  assert.equal(card.target, "npm test");
  assert.deepEqual(card.opts.map((o: any) => o.label), req.opts.map((o: any) => o.label));
  assert.ok(card.opts[1].scope, "「记住这类」必须带 scope（记住什么）");
  assert.match(card.opts[1].label, /记住这类.*npm test/);

  // 3) 伪造 remember（把整个工具放行）→ 桥只回显 gate 给过的 scope
  const ap1 = await postJson(`${baseUrl}/api/runs/r1/node/root/approve`,
    { decision: "allowed-once", remember: { tool: "bash", tier: "exec", target: "*" } });
  assert.equal(ap1.status, 200);
  assert.equal(ap1.body.remember, null, "伪造 scope 不得落盘");
  const ans1 = JSON.parse(readFileSync(join(dir, "gate-ans.json"), "utf8"));
  assert.equal(ans1.decision, "allowed-once");
  assert.equal(ans1.remember, undefined);

  // 4) 闭集校验：旧值/未知值 400
  writeReq(dir, "srv-2", "npm run lint");
  const bad = await postJson(`${baseUrl}/api/runs/r1/node/root/approve`, { decision: "allow" });
  assert.equal(bad.status, 400);
  assert.match(String(bad.body.error), /allowed-once/);

  // 5) 挂起时 reply = 拒绝 + 反馈；不写 reply.txt、不改 spec.reply
  const before = readFileSync(join(dir, "spec.json"), "utf8");
  const rep = await postJson(`${baseUrl}/api/runs/r1/node/root/reply`, { text: "先别跑 lint，改完再说" });
  assert.equal(rep.status, 200);
  assert.equal(rep.body.mode, "gate");
  assert.equal(rep.body.decision, "rejected");
  const ans2 = JSON.parse(readFileSync(join(dir, "gate-ans.json"), "utf8"));
  assert.equal(ans2.decision, "rejected");
  assert.equal(ans2.feedback, "先别跑 lint，改完再说");
  assert.equal(existsSync(join(dir, "reply.txt")), false, "挂起时不得当新消息写 reply.txt");
  assert.equal(readFileSync(join(dir, "spec.json"), "utf8"), before, "挂起时不得改 spec.reply");
  assert.equal((await getJson(`${baseUrl}/api/approvals`)).body.count, 0, "已答的卡立即消失");

  // 6) 没有 pending 时 approve → 404
  const none = await postJson(`${baseUrl}/api/runs/r1/node/root/approve`, { decision: "rejected" });
  assert.equal(none.status, 404);

  // 7) 过期 req 不进卡（worker 被 kill、gate 来不及清的情况）
  rmSync(join(dir, "gate-ans.json"), { force: true });
  writeReq(dir, "srv-3", "npm outdated");
  const old = new Date(Date.now() - 11 * 60_000);
  utimesSync(join(dir, "gate-req.json"), old, old);
  assert.equal((await getJson(`${baseUrl}/api/approvals`)).body.count, 0);
});


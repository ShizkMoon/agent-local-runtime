// 生成两个"人机闸门"夹具的服务端文件——用真实 gate.ts 生成，不手写协议：
//   fixtures/approval-wait/  gate-req.json（v2 协议）+ approve_ask 事件：worker 卡在审批里，没有 result
//   fixtures/gate-question/  e2e 专用：result{status:waiting} + gate.json（ev_gate 提问通道），投影成 inbox 卡
// 幂等：重复运行只重写这两个文件，不重复追加事件。
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildOpts, extractTargets, resolveCall } from "../../../../aica-pi/extensions/gate.ts";

// 被 
ode --test workbench/test/e2e 当测试文件扫到时不要动夹具（手工运行才生成）
if (process.env.NODE_TEST_CONTEXT) process.exit(0);

const HERE = dirname(fileURLToPath(import.meta.url));      // workbench/test/e2e/tools
const FIX = join(HERE, "..", "fixtures");
const ASKED_AT = "2026-11-04T08:16:55.000Z";
const COMMAND = "npm run build --workspace workbench";

function ensureEvent(file, kind) {
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  return text.split("\n").some((l) => l.includes(`"kind":"${kind}"`));
}

// ---- 1. approval-wait：gate-req + approve_ask
const aw = join(FIX, "approval-wait");
const spec = JSON.parse(readFileSync(join(aw, "spec.json"), "utf8"));
const gateSpec = {
  permission: "supervised",
  approve: ["bash"],
  deny: [],
  deny_paths: [".env", "secrets"],
};
const args = { command: COMMAND };
const res = resolveCall(gateSpec, "bash", args, [], process.cwd());
const opts = buildOpts("bash", res);
const req = {
  v: 2,
  call_id: "c3",
  tool: "bash",
  tier: res.tier,
  target: res.target,
  restricted: res.restricted,
  rememberable: opts.some((o) => !!o.scope),
  reason: res.reason,
  hit: res.hit,
  args,
  targets: extractTargets(args),
  opts,
  asked_at: ASKED_AT,
};
writeFileSync(join(aw, "gate-req.json"), JSON.stringify(req, null, 2) + "\n", "utf8");
const evFile = join(aw, "events.jsonl");
if (!ensureEvent(evFile, "approve_ask")) {
  appendFileSync(evFile, JSON.stringify({
    kind: "approve_ask",
    ts: ASKED_AT,
    data: {
      call_id: "c3", tool: "bash", tier: res.tier, target: res.target,
      args: COMMAND, targets: req.targets, reason: res.reason, restricted: res.restricted,
      opts: opts.map((o) => ({ label: o.label, decision: o.decision, scope: o.scope ?? null })),
    },
  }) + "\n", "utf8");
}

// ---- 2. gate-question：ev_gate 提问通道（result=waiting + gate.json），投影成 inbox 卡
const gq = join(FIX, "gate-question");
mkdirSync(gq, { recursive: true });
for (const f of ["events.jsonl", "spec.json", "worker.json"]) {
  if (existsSync(join(aw, f))) copyFileSync(join(aw, f), join(gq, f));
}
const question = "SSE 断线后要不要自动重连？";
// spec.id 必须指向本夹具的 run，否则 inbox 卡片的 id 会串到别的 run
const gateOpts = ["自动重连（推荐）", "只提示不重连"];
const gqSpec = JSON.parse(readFileSync(join(gq, "spec.json"), "utf8"));
writeFileSync(join(gq, "spec.json"), JSON.stringify({ ...gqSpec, id: "node:gate-question-demo/root" }, null, 2) + "\n", "utf8");
writeFileSync(join(gq, "result.json"), JSON.stringify({
  id: "node:gate-question-demo/root",
  type: "result",
  status: "waiting",
  summary: question,
  finished_at: "2026-11-04T08:17:00.000Z",
}, null, 2) + "\n", "utf8");
writeFileSync(join(gq, "gate.json"), JSON.stringify({ question, opts: gateOpts, ts: "2026-11-04T08:17:00.000Z" }, null, 2) + "\n", "utf8");
// 清掉不属于提问通道的审批文件，避免两个通道串味
for (const f of ["gate-req.json", "gate-ans.json"]) {
  const p = join(gq, f);
  if (existsSync(p)) unlinkSync(p);
}
writeFileSync(join(gq, "case.json"), JSON.stringify({
  case: "gate-question",
  runId: "gate-question-demo",
  nodePath: "root",
  subject: "SSE 断线策略：等一个人答",
  createdAt: "2026-11-04T08:13:54.867Z",
  now: "2026-11-04T08:30:00.000Z",
  kind: "meta.ui",
  note: "ev_gate 提问通道：result.status=waiting + gate.json（由 tools/make-approval-fixture.mjs 生成）→ 应进 view.inbox 的『需要你』卡",
}, null, 2) + "\n", "utf8");

console.log(`approval-wait: gate-req.json ${Buffer.byteLength(JSON.stringify(req))}B, opts=${opts.map((o) => o.label).join(" | ")}`);
console.log(`gate-question: result.json + gate.json 就绪`);



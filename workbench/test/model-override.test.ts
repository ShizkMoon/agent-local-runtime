// R6：--model 覆盖 —— dispatch/node-create 写 spec.model，daemon.modelFor 优先用它，launcher 真的把 -m 传下去。
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const STATE = mkdtempSync(join(tmpdir(), "aica-r6-model-"));
process.env.AICA_STATE = STATE;
const R = await import("../../src/runs.ts");
const D = await import("../../src/daemon.ts");
const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "cli.ts");
const NODE = process.execPath;
const env = { ...process.env, AICA_STATE: STATE };
const run = (args: string[], input?: string) =>
  spawnSync(NODE, [CLI, ...args], { encoding: "utf8", env, input });
const last = (r: any) => JSON.parse(String(r.stdout).trim().split("\n").pop()!);

test("node-create --model 写入 spec.model；--context-tokens 写入 budget", () => {
  const rc = last(run(["run-create", "--subject", "模型覆盖"]));
  const rootId = rc.data.root_id;
  const r = run(["node-create", "--run", rootId, "--path", "a", "--goal", "g", "--model", "deepseek-x", "--context-tokens", "64000"]);
  assert.equal(r.status, 0, String(r.stdout));
  const spec: any = R.readSpec(rootId, "a");
  assert.equal(spec.model, "deepseek-x");
  assert.equal(spec.budget.context_tokens, 64000);
});

test("dispatch：JSON model 与 --model 旗标都落到 spec.model（JSON 优先）", () => {
  const a = last(run(["dispatch"], JSON.stringify({ subject: "json 模型", model: "m-json" })));
  assert.equal(R.readSpec(a.data.root_id, "root")?.model, "m-json");

  const b = last(run(["dispatch", "--model", "m-flag"], JSON.stringify({ subject: "旗标模型" })));
  assert.equal(R.readSpec(b.data.root_id, "root")?.model, "m-flag");

  const c = last(run(["dispatch", "--model", "m-flag"], JSON.stringify({ subject: "两者都有", model: "m-json" })));
  assert.equal(R.readSpec(c.data.root_id, "root")?.model, "m-json", "JSON 里的显式 model 优先");
});

test("modelFor：spec.model 优先；否则 AICA_PI_MODEL；再否则内置默认", () => {
  const base: any = { id: "node:x/root", type: "assign", goal: "g", accept: ["a"] };
  assert.equal(D.modelFor({ ...base, model: "m-spec" }), "m-spec");

  const prev = process.env.AICA_PI_MODEL;
  process.env.AICA_PI_MODEL = "m-env";
  try {
    assert.equal(D.modelFor(base), "m-env");
  } finally {
    if (prev === undefined) delete process.env.AICA_PI_MODEL; else process.env.AICA_PI_MODEL = prev;
  }
  const withRoles = D.modelFor(base);
  assert.equal(typeof withRoles, "string");
  assert.ok(withRoles.length > 0);
});

test("launcher 把 model 传进 pi 命令行（--model <m>）", () => {
  const spec: any = { id: "node:x/root", type: "assign", goal: "g", accept: ["a"], model: "m-launch" };
  const { args, desc } = D.launcher(spec);
  const i = args.indexOf("--model");
  assert.ok(i >= 0, "命令行里必须有 --model");
  assert.equal(args[i + 1], "m-launch");
  assert.match(String(desc), /m-launch/);
});

// R3 收尾：workbench server 拉起 daemon 时的 env —— 生产 STATE 在仓库外，@src/x.ts 必须靠 AICA_REPO_ROOT 解析
import test from "node:test";
import assert from "node:assert/strict";
import { arEnv, repoRoot, spawnDaemon } from "../spawn.ts";

const FILE_URL = "file:///C:/repo/workbench/server.ts";

test("spawn daemon 的 env 里含 AICA_REPO_ROOT，且仓库根 = workbench/..", () => {
  const calls: { cmd: string; argv: string[]; opts: any }[] = [];
  const mockSpawn = ((cmd: string, argv: string[], opts: any) => {
    calls.push({ cmd, argv, opts });
    return { unref() {}, on() {}, pid: 4242 } as any;
  }) as any;

  spawnDaemon(mockSpawn, {
    execPath: "node.exe",
    cli: "C:/repo/src/cli.ts",
    logFd: 7,
    env: arEnv("C:/prod-state", {} as NodeJS.ProcessEnv, FILE_URL),
  });

  assert.equal(calls.length, 1, "必须真的 spawn 一次");
  const { cmd, argv, opts } = calls[0];
  assert.equal(cmd, "node.exe");
  assert.deepEqual(argv, ["C:/repo/src/cli.ts", "daemon"]);
  assert.equal(opts.detached, true);
  assert.deepEqual(opts.stdio, ["ignore", 7, 7]);
  assert.equal(opts.env.AICA_STATE, "C:/prod-state");
  assert.ok(opts.env.AICA_REPO_ROOT, "spawn 的 env 必须带 AICA_REPO_ROOT");
  assert.equal(opts.env.AICA_REPO_ROOT, repoRoot({} as NodeJS.ProcessEnv, FILE_URL));
  assert.match(String(opts.env.AICA_REPO_ROOT), /repo$/, "仓库根由 workbench/.. 推出");
});

test("AICA_REPO_ROOT 已设则原样用（生产可外部注入），AICA_STATE 以桥为准", () => {
  const env = arEnv("D:/state", { AICA_REPO_ROOT: "D:/prod-repo", AICA_STATE: "D:/stale" } as NodeJS.ProcessEnv, FILE_URL);
  assert.equal(env.AICA_REPO_ROOT, "D:/prod-repo");
  assert.equal(env.AICA_STATE, "D:/state", "旧 AICA_STATE 不能盖掉桥解析出来的");
  // 空串不算已设
  assert.equal(arEnv("D:/state", { AICA_REPO_ROOT: "  " } as NodeJS.ProcessEnv, FILE_URL).AICA_REPO_ROOT, repoRoot({} as NodeJS.ProcessEnv, FILE_URL));
});

// workbench/spawn.ts —— 子进程（daemon / ar CLI）的 env 组装与拉起。
// 抽成独立模块是为了可测：生产环境 STATE 在仓库外，daemon 必须拿到 AICA_REPO_ROOT 才能解析 @src/x.ts。
import { fileURLToPath } from "node:url";
import type { spawn as nodeSpawn } from "node:child_process";

/**
 * 仓库根：env 已设则原样用（生产可由外部注入），否则按本文件位置推 —— workbench/.. 。
 * 与 server.ts 里 AR_CLI 的定位逻辑同类（都相对 import.meta.url）。
 */
export function repoRoot(env: NodeJS.ProcessEnv = process.env, fileUrl: string = import.meta.url): string {
  const set = String(env.AICA_REPO_ROOT ?? "").trim();
  if (set) return set;
  return fileURLToPath(new URL("../", fileUrl)).replace(/[\\/]+$/, "");
}

/** 子进程环境：显式给 AICA_STATE（空串会让 runs.ts 落相对路径）+ AICA_REPO_ROOT（@file 解析用） */
export function arEnv(state: string, env: NodeJS.ProcessEnv = process.env, fileUrl: string = import.meta.url): NodeJS.ProcessEnv {
  return { ...env, AICA_STATE: state, AICA_REPO_ROOT: repoRoot(env, fileUrl) };
}

export interface SpawnDaemonOpts {
  execPath: string;
  cli: string;
  /** daemon.log 的 fd，或 "ignore" */
  logFd: number | "ignore";
  env: NodeJS.ProcessEnv;
}

/** detached 拉起 `node <cli> daemon`，日志重定向；spawnFn 可注入（测试用 mock） */
export function spawnDaemon(
  spawnFn: typeof nodeSpawn,
  { execPath, cli, logFd, env }: SpawnDaemonOpts,
): ReturnType<typeof nodeSpawn> {
  return spawnFn(execPath, [cli, "daemon"], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    windowsHide: true,
    env,
  });
}

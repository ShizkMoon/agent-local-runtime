// workbench/git.ts —— R5 Git 面板的服务端实现（status / diff / commit）。
// 关键约束：commit 是"两段式"—— `POST /api/git/commit` 只落一张 ask 卡（git-ask.json），
// 真正执行只在 approve 路由里调 gitCommit()；reject 只删 ask，不碰 git。
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface GitFile { path: string; code: string; add: number; del: number }
export interface GitStatus { repo: boolean; branch: string | null; files: GitFile[]; error?: string }
export interface GitAsk { id: string; message: string; files: string[]; created_at: string }

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd, windowsHide: true, encoding: "utf8", timeout: 20_000, maxBuffer: 16 * 1024 * 1024,
  });
}

export function isGitRepo(cwd: string): boolean {
  if (!cwd || !existsSync(cwd)) return false;
  try { return git(cwd, ["rev-parse", "--is-inside-work-tree"]).trim() === "true"; } catch { return false; }
}

/** 改动的文件 + A/M/D + ±行数（未跟踪文件按整文件行数算 +） */
export function gitStatus(cwd: string): GitStatus {
  if (!isGitRepo(cwd)) return { repo: false, branch: null, files: [] };
  let branch: string | null = null;
  try { branch = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).trim() || null; } catch { branch = null; }
  const files: GitFile[] = [];
  const seen = new Map<string, GitFile>();
  try {
    const out = git(cwd, ["status", "--porcelain=v1", "-uall"]);
    for (const line of out.split("\n")) {
      if (!line.trim() || line.length < 4) continue;
      const code = line.slice(0, 2).trim();
      let path = line.slice(3).trim();
      if (path.includes(" -> ")) path = path.split(" -> ").pop()!.trim();
      path = path.replace(/^"|"$/g, "");
      const f: GitFile = { path, code: code === "??" ? "A" : code.slice(0, 1) || "M", add: 0, del: 0 };
      files.push(f); seen.set(path, f);
    }
    // ±行数：已跟踪走 numstat；未跟踪整文件第数
    try {
      const num = git(cwd, ["diff", "HEAD", "--numstat"]);
      for (const line of num.split("\n")) {
        const m = line.split("\t");
        if (m.length < 3) continue;
        const f = seen.get(m[2].trim());
        if (!f) continue;
        f.add = m[0] === "-" ? 0 : Number(m[0]) || 0;
        f.del = m[1] === "-" ? 0 : Number(m[1]) || 0;
      }
    } catch { /* 没有 HEAD（空仓库）就只给状态 */ }
    for (const f of files) {
      if (f.add || f.del || f.code !== "A") continue;
      try {
        const buf = readFileSync(join(cwd, f.path), "utf8");
        f.add = buf ? buf.split("\n").length - (buf.endsWith("\n") ? 1 : 0) : 0;
      } catch { /* 二进制/读不到就留 0 */ }
    }
  } catch (e) {
    return { repo: true, branch, files, error: String(e).slice(0, 200) };
  }
  return { repo: true, branch, files };
}

/** 单文件补丁（复用 UI 的 diff 组件；未跟踪文件用 --no-index 造一个"新增"补丁） */
export function gitDiff(cwd: string, path: string): { ok: boolean; patch: string; error?: string } {
  if (!isGitRepo(cwd)) return { ok: false, patch: "", error: "不是 git 仓库" };
  if (!path || path.includes("\0")) return { ok: false, patch: "", error: "bad path" };
  try {
    let patch = "";
    try { patch = git(cwd, ["diff", "HEAD", "--", path]); } catch { patch = ""; }
    if (!patch.trim()) {
      try { patch = git(cwd, ["diff", "--no-index", "--", "/dev/null", path]); } catch (e: any) { patch = String(e?.stdout ?? ""); }
    }
    return { ok: true, patch };
  } catch (e) {
    return { ok: false, patch: "", error: String(e).slice(0, 200) };
  }
}

/** 真正执行提交（只允许 server 的 approve 路由调用） */
export function gitCommit(cwd: string, message: string): { ok: boolean; sha?: string; error?: string } {
  if (!isGitRepo(cwd)) return { ok: false, error: "不是 git 仓库" };
  const msg = String(message ?? "").trim();
  if (!msg) return { ok: false, error: "commit message 不能为空" };
  // 没配身份时给个兜底，避免 add 完卡在 commit（那样会留下半截 index）
  let idArgs: string[] = [];
  try { if (!git(cwd, ["config", "user.email"]).trim()) idArgs = ["-c", "user.email=aica@localhost", "-c", "user.name=AICA"]; }
  catch { idArgs = ["-c", "user.email=aica@localhost", "-c", "user.name=AICA"]; }
  try {
    git(cwd, [...idArgs, "add", "-A"]);
    git(cwd, [...idArgs, "commit", "-m", msg]);
    return { ok: true, sha: git(cwd, ["rev-parse", "HEAD"]).trim() };
  } catch (e: any) {
    const out = [e?.stdout, e?.stderr, e?.message].filter(Boolean).join("\n").trim();
    return { ok: false, error: (out || "git commit 失败").slice(0, 400) };
  }
}

// ---------------------------------------------------------------- 提交审批（ask）

export function askPath(runsDir: string, runId: string): string {
  return join(runsDir, runId, "git-ask.json");
}

export function readAsk(runsDir: string, runId: string): GitAsk | null {
  try {
    const a: any = JSON.parse(readFileSync(askPath(runsDir, runId), "utf8"));
    if (!a || typeof a.message !== "string") return null;
    return {
      id: String(a.id ?? "git-ask"), message: a.message,
      files: Array.isArray(a.files) ? a.files.map(String) : [],
      created_at: typeof a.created_at === "string" ? a.created_at : new Date().toISOString(),
    };
  } catch { return null; }
}

export function writeAsk(runsDir: string, runId: string, ask: GitAsk): void {
  writeFileSync(askPath(runsDir, runId), JSON.stringify(ask, null, 2), "utf8");
}

export function clearAsk(runsDir: string, runId: string): void {
  try { rmSync(askPath(runsDir, runId), { force: true }); } catch { /* 已经没了 */ }
}

/** run 的工作目录：run.json.cwd（派发时写死）优先，否则 fallback（仓库根） */
export function runCwd(runsDir: string, runId: string, fallback: string): string {
  try {
    const meta: any = JSON.parse(readFileSync(join(runsDir, runId, "run.json"), "utf8"));
    if (typeof meta?.cwd === "string" && meta.cwd && existsSync(meta.cwd)) return meta.cwd;
  } catch { /* 读不到就用 fallback */ }
  try { if (existsSync(join(runsDir, runId))) return fallback; } catch { /* ignore */ }
  return fallback;
}

/** 测试/诊断用：仓库根下能否读到某个文件（防止路径逃逸） */
export function safeRepoPath(root: string, rel: string): string | null {
  if (!rel || rel.includes("\0")) return null;
  const p = join(root, rel);
  try { statSync(p); return p; } catch { return null; }
}

// S28 自进化：提案流水线（PRD v3 §9）——提案与生效分离
//
// 事实源：`<STATE>/proposals/<slug>/`（也接受节点目录下的 `proposals/<slug>/`，见 listProposals）：
//   proposal.md  动机 / 预期效果 / 风险 / 影响文件
//   patch.diff   unified diff（只允许白名单路径）
//   verify.json  {cmd, timeout_ms}（默认 node --test workbench/test）
//   meta.json    {slug, created_at, risk, files[], verify, source}
//   applied.json 应用历史（7 天内最多 3 次；第 4 次标 stale）
//   rejected.json / backup/ 由 reject / apply 产生
//
// 安全底座（§9.2 / §9.4）：
//   1) 白名单三级：low 可一键、high 需 --force、其余（含禁止级）一律拒绝；不在表里 = 拒绝（默认拒绝）。
//   2) 路径归一化：`\`→`/`、去 `./`、拒绝绝对路径与任何 `..` 段；应用前再查符号链接（lstat + realpath 必须落在仓库内）。
//   3) 应用先在 `<STATE>/tmp/apply-<slug>/` 的整树副本里打补丁 → 跑 verify → 全绿才落盘；
//      落盘前备份被改文件、失败即按字节回滚（sha256 断言）。
//   4) 同一 slug 7 天内 apply > 3 次 → stale，防"改不好就一直试"。
import {
  existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, readdirSync, statSync, lstatSync, realpathSync,
  rmSync, cpSync, renameSync, unlinkSync,
} from "node:fs";
import { join, resolve, dirname, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { STATE, RUNS_DIR, appendEvent, nodeDir } from "./runs.ts";
import { readSettings } from "./settings.ts";

// ---------- 常量与路径 ----------

export const DEFAULT_VERIFY_CMD = "node --test workbench/test";
export const DEFAULT_VERIFY_TIMEOUT_MS = 180_000;
export const MAX_APPLIES_PER_7D = 3;
const SEVEN_DAYS = 7 * 24 * 60 * 60_000;
const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** 仓库根：测试用 AICA_REPO_ROOT 指到副本；生产按本文件位置推（src/ 的上一级） */
export function repoRoot(): string {
  return resolve(process.env.AICA_REPO_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
}
export function proposalsRoot(): string {
  return join(STATE, "proposals");
}
function tmpRoot(): string {
  return join(STATE, "tmp");
}
function ensureDir(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}
function writeJson(file: string, data: unknown): void {
  ensureDir(dirname(file));
  writeFileSync(file, JSON.stringify(data, null, 2) + "\n", "utf8");
}
function readJson<T>(file: string): T | null {
  try { return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as T) : null; } catch { return null; }
}
function sha256(buf: Buffer | string): string {
  return createHash("sha256").update(buf).digest("hex");
}
function sha256File(file: string): string | null {
  try { return existsSync(file) ? sha256(readFileSync(file)) : null; } catch { return null; }
}

// ---------- 白名单（§9.2） ----------

export type RiskLevel = "low" | "high" | "forbidden";
const LOW_PATHS = [/^aica-pi\/skills\//, /^aica-pi\/hooks\//, /^aica-pi\/prompts\//, /^docs\//, /^workbench\/public\//];
const HIGH_PATHS = [/^src\//, /^aica-pi\/extensions\//, /^workbench\/server\.ts$/, /^workbench\/view\.ts$/];
// 禁止：shell 壳、.git、审批门本身；package.json 是供应链入口（§9.2 禁 scripts 字段 → 这里整文件禁，比字面更严）
const FORBIDDEN_PATHS = [/^workbench\/shell\//, /^\.git\//, /^aica-pi\/extensions\/gate\.ts$/, /^package\.json$/];

const RANK: Record<RiskLevel, number> = { low: 0, high: 1, forbidden: 2 };
export function maxRisk(a: RiskLevel, b: RiskLevel): RiskLevel { return RANK[a] >= RANK[b] ? a : b; }

/** 单一相对路径的风险级；不在白名单内的路径按禁止级处理（默认拒绝） */
export function classifyPath(rel: string): RiskLevel {
  const p = normRelPath(rel);   // 非法路径直接抛
  if (FORBIDDEN_PATHS.some((re) => re.test(p))) return "forbidden";
  if (LOW_PATHS.some((re) => re.test(p))) return "low";
  if (HIGH_PATHS.some((re) => re.test(p))) return "high";
  return "forbidden";
}

export class ProposalError extends Error {
  code: string;
  detail?: unknown;
  constructor(code: string, message: string, detail?: unknown) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

/** 归一化仓库相对路径：拒绝绝对路径 / `..` / 空段（§9.2 "按归一化后的相对路径判定"） */
export function normRelPath(raw: string): string {
  let s = String(raw ?? "").trim().replace(/\\/g, "/");
  if (!s) throw new ProposalError("BAD_PATH", "空路径");
  s = s.replace(/^\.\//, "");
  if (s.startsWith("/") || /^[a-zA-Z]:/.test(s) || isAbsolute(s)) {
    throw new ProposalError("BAD_PATH", `绝对路径不允许：${raw}`);
  }
  const segs = s.split("/");
  if (segs.some((x) => !x || x === "." || x === "..")) {
    throw new ProposalError("BAD_PATH", `路径含空段/. /..：${raw}`);
  }
  return segs.join("/");
}

// ---------- unified diff 解析与应用 ----------

export interface Hunk { oldStart: number; oldCount: number; newStart: number; newCount: number; lines: string[] }
export interface ParsedFile { oldPath: string | null; newPath: string | null; path: string; hunks: Hunk[] }

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const stripAB = (p: string): string => {
  let s = p.trim().split(/\s+/)[0];
  if (s === "/dev/null") return "";
  s = s.replace(/^[ab]\//, "");
  return s;
};

/** 解析 unified diff（支持多文件、新建、删除；不支持 rename/binary → 结构化报错） */
export function parsePatch(text: string): ParsedFile[] {
  const lines = String(text ?? "").split(/\r?\n/);
  const files: ParsedFile[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^diff --git /.test(line)) { i += 1; continue; }
    if (/^(index |new file mode |deleted file mode |similarity index |rename from |rename to )/.test(line)) {
      if (/^(rename from|rename to) /.test(line)) throw new ProposalError("BAD_PATCH", "不支持 rename 补丁（请拆成删除 + 新建）");
      i += 1; continue;
    }
    if (/^--- /.test(line)) {
      if (!/^\+\+\+ /.test(lines[i + 1] ?? "")) throw new ProposalError("BAD_PATCH", `第 ${i + 1} 行：--- 之后缺少 +++`);
      const oldRaw = stripAB(line.slice(4));
      const newRaw = stripAB((lines[i + 1] ?? "").slice(4));
      const pathRaw = newRaw || oldRaw;
      let path: string;
      try { path = normRelPath(pathRaw); }
      catch (e) { throw new ProposalError("BAD_PATH", `补丁路径不合法：${pathRaw}（${(e as Error).message}）`); }
      const hunks: Hunk[] = [];
      i += 2;
      while (i < lines.length) {
        const h = HUNK_RE.exec(lines[i]);
        if (!h) break;
        const hunk: Hunk = {
          oldStart: Number(h[1]), oldCount: Number(h[2] ?? "1"),
          newStart: Number(h[3]), newCount: Number(h[4] ?? "1"), lines: [],
        };
        i += 1;
        let oldRem = hunk.oldCount, newRem = hunk.newCount;
        while (i < lines.length && (oldRem > 0 || newRem > 0)) {
          const l = lines[i];
          if (l.startsWith("\\")) { i += 1; continue; }          // "\ No newline at end of file"
          if (l === "") { hunk.lines.push(""); oldRem -= 1; newRem -= 1; i += 1; continue; }
          const c = l[0];
          if (c === " ") { oldRem -= 1; newRem -= 1; }
          else if (c === "-") { oldRem -= 1; }
          else if (c === "+") { newRem -= 1; }
          else throw new ProposalError("BAD_PATCH", `hunk 内出现非法行（第 ${i + 1} 行）：${l.slice(0, 40)}`);
          hunk.lines.push(l);
          i += 1;
        }
        if (oldRem !== 0 || newRem !== 0) throw new ProposalError("BAD_PATCH", `hunk @@ -${hunk.oldStart} 行数与头不一致`);
        hunks.push(hunk);
      }
      if (!hunks.length) throw new ProposalError("BAD_PATCH", `文件 ${path} 没有任何 hunk`);
      files.push({ oldPath: oldRaw || null, newPath: newRaw || null, path, hunks });
      continue;
    }
    i += 1;
  }
  if (!files.length) throw new ProposalError("BAD_PATCH", "补丁里没有可应用的文件段（需要 ---/+++/@@）");
  return files;
}

/** 补丁涉及的文件与风险级（apply 与 ev_propose 共用同一判定） */
export function classifyPatch(text: string): { files: { path: string; level: RiskLevel }[]; risk: RiskLevel } {
  const parsed = parsePatch(text);
  const files = parsed.map((f) => ({ path: f.path, level: classifyPath(f.path) }));
  const risk = files.reduce<RiskLevel>((acc, f) => maxRisk(acc, f.level), "low");
  return { files, risk };
}

/** 在给定仓库根上应用补丁（先全部校验通过再写，避免半套） */
export function applyPatchToRepo(root: string, patchText: string): { ok: true; files: { path: string; action: "create" | "update" | "delete"; content: Buffer | null }[] } | { ok: false; error: string } {
  let parsed: ParsedFile[];
  try { parsed = parsePatch(patchText); } catch (e) { return { ok: false, error: (e as Error).message }; }
  const out: { path: string; action: "create" | "update" | "delete"; content: Buffer | null }[] = [];
  for (const pf of parsed) {
    const abs = join(root, ...pf.path.split("/"));
    const exists = existsSync(abs);
    if (pf.oldPath === null) {
      if (exists) return { ok: false, error: `新建文件已存在：${pf.path}` };
    } else if (!exists) {
      return { ok: false, error: `要修改的文件不存在：${pf.path}` };
    }
    const oldText = exists ? readFileSync(abs, "utf8") : "";
    const eol = oldText.includes("\r\n") ? "\r\n" : "\n";
    let lines = oldText.length ? oldText.split(/\r?\n/) : [];
    const trailing = lines.length > 0 && lines[lines.length - 1] === "";
    if (trailing) lines.pop();
    let offset = 0;
    for (const [hi, hunk] of pf.hunks.entries()) {
      const expect: string[] = [], repl: string[] = [];
      for (const l of hunk.lines) {
        const c = l === "" ? " " : l[0];
        const body = l === "" ? "" : l.slice(1);
        if (c === " ") { expect.push(body); repl.push(body); }
        else if (c === "-") expect.push(body);
        else repl.push(body);
      }
      const at = hunk.oldStart === 0 ? 0 : hunk.oldStart - 1 + offset;
      for (let k = 0; k < expect.length; k++) {
        if (lines[at + k] !== expect[k]) {
          return { ok: false, error: `hunk ${hi + 1} @@ -${hunk.oldStart} 不匹配：期望 ${JSON.stringify(expect[k] ?? "<EOF>")}，实际 ${JSON.stringify(lines[at + k] ?? "<EOF>")}` };
        }
      }
      lines.splice(at, expect.length, ...repl);
      offset += repl.length - expect.length;
    }
    if (pf.newPath === null) {
      out.push({ path: pf.path, action: "delete", content: null });
    } else {
      const body = lines.join(eol) + (trailing || pf.oldPath === null ? eol : "");
      out.push({ path: pf.path, action: pf.oldPath === null ? "create" : "update", content: Buffer.from(body, "utf8") });
    }
  }
  // 全部 hunk 校验通过后才真正落盘（调用方若是临时树，写入也无所谓；真实树走 backup+commit）
  for (const f of out) {
    const abs = join(root, ...f.path.split("/"));
    if (f.action === "delete") { try { unlinkSync(abs); } catch { /* 已不在 */ } continue; }
    ensureDir(dirname(abs));
    const tmp = `${abs}.s28tmp`;
    writeFileSync(tmp, f.content!);
    renameSync(tmp, abs);
  }
  return { ok: true, files: out };
}

// ---------- 提案读写 ----------

export interface VerifySpec { cmd: string; timeout_ms: number }
export interface ProposalFileMeta { path: string; action: "create" | "update" | "delete"; sha256: string | null }
export interface ProposalMeta {
  slug: string;
  created_at: string;
  risk: RiskLevel;
  files: ProposalFileMeta[];
  verify: VerifySpec;
  source?: { root_id?: string; node?: string; path?: string };
}
export interface ProposalRecord {
  slug: string;
  dir: string;
  meta: ProposalMeta;
  proposal: string;
  patch: string;
  verify: VerifySpec;
  risk: RiskLevel;
  status: "pending" | "applied" | "rejected" | "stale";
  applies_7d: number;
  applied_at?: string | null;
  rejected?: { at: string; reason: string } | null;
}
export interface ProposalSummary {
  slug: string; dir: string; created_at: string; risk: RiskLevel; status: ProposalRecord["status"];
  files: number; applies_7d: number; verify_cmd: string;
}

export interface CreateProposalInput {
  slug: string;
  /** 四个提案文件的写法一：{proposal, patch, verify, meta} */
  files?: Partial<{ proposal: string; patch: string; verify: Partial<VerifySpec>; meta: Partial<ProposalMeta> }>;
  /** 写法二：顶层同名字段（与 files 合并，顶层优先） */
  proposal?: string;
  patch?: string;
  verify?: Partial<VerifySpec>;
  meta?: Partial<ProposalMeta>;
  /** 落盘目录（默认 <STATE>/proposals；ev_propose 传节点目录下的 proposals/） */
  root?: string;
  source?: ProposalMeta["source"];
}

export function validSlug(slug: string): boolean { return SLUG_RE.test(String(slug ?? "")); }

function proposalDirOf(slug: string, root = proposalsRoot()): string {
  return join(root, slug);
}

/** 已落盘的提案目录（先看默认根，再看 run 节点下的 proposals/） */
export function findProposalDir(slug: string): string | null {
  if (!validSlug(slug)) return null;
  const direct = proposalDirOf(slug);
  if (existsSync(join(direct, "meta.json"))) return direct;
  for (const dir of scanProposalDirs()) {
    if (dir.endsWith(`/proposals/${slug}`)) return dir;
  }
  return null;
}

/** 扫描：<STATE>/proposals 与 runs/<r>/nodes 下各层的 proposals 目录 */
function scanProposalDirs(): string[] {
  const out: string[] = [];
  const root = proposalsRoot();
  if (existsSync(root)) {
    for (const ent of readdirSync(root, { withFileTypes: true })) {
      if (ent.isDirectory()) out.push(join(root, ent.name));
    }
  }
  if (existsSync(RUNS_DIR)) {
    for (const run of readdirSync(RUNS_DIR, { withFileTypes: true })) {
      if (!run.isDirectory()) continue;
      const nodesRoot = join(RUNS_DIR, run.name, "nodes");
      const walk = (dir: string, depth: number): void => {
        if (depth > 6) return;
        const pdir = join(dir, "proposals");
        if (existsSync(pdir)) {
          for (const ent of readdirSync(pdir, { withFileTypes: true })) {
            if (ent.isDirectory()) out.push(join(pdir, ent.name));
          }
        }
        for (const ent of readdirSync(dir, { withFileTypes: true })) {
          if (ent.isDirectory() && !["artifacts", "inputs", "session", "proposals"].includes(ent.name)) walk(join(dir, ent.name), depth + 1);
        }
      };
      if (existsSync(nodesRoot)) walk(nodesRoot, 0);
    }
  }
  return out;
}

/** 应用历史（7 天内计数）+ 最近一次 */
function applyHistory(dir: string): { history: any[]; last: any | null } {
  const j = readJson<{ history?: any[] }>(join(dir, "applied.json"));
  const history = Array.isArray(j?.history) ? j!.history! : [];
  return { history, last: history.length ? history[history.length - 1] : null };
}

function appliesWithin7d(dir: string, now = Date.now()): number {
  return applyHistory(dir).history.filter((h) => {
    const t = Date.parse(String(h?.at ?? ""));
    return Number.isFinite(t) && now - t <= SEVEN_DAYS;
  }).length;
}

function statusOf(dir: string, now = Date.now()): ProposalRecord["status"] {
  if (existsSync(join(dir, "rejected.json"))) return "rejected";
  const n = appliesWithin7d(dir, now);
  if (n >= MAX_APPLIES_PER_7D) return "stale";
  return existsSync(join(dir, "applied.json")) ? "applied" : "pending";
}

/**
 * 写一个新提案（只写提案目录，不碰仓库）。
 * 白名单违规直接抛 ProposalError（ev_propose 会把它变成工具错误文本）。
 */
export function createProposal(input: CreateProposalInput): ProposalRecord {
  const slug = String(input?.slug ?? "");
  if (!validSlug(slug)) throw new ProposalError("BAD_SLUG", `slug 不合法：${slug}（需匹配 ${SLUG_RE}）`);
  const f = input.files ?? {};
  const patch = String(input.patch ?? f.patch ?? "");
  const proposal = String(input.proposal ?? f.proposal ?? "");
  if (!patch.trim()) throw new ProposalError("BAD_PATCH", "patch.diff 为空");
  const cls = classifyPatch(patch);                       // 解析 + 白名单（禁止级也在这里抛不出去，走下面判定）
  const forbidden = cls.files.filter((x) => x.level === "forbidden").map((x) => x.path);
  if (forbidden.length) {
    throw new ProposalError("FORBIDDEN", `补丁包含禁止级路径：${forbidden.join(", ")}（§9.2 白名单外 = 拒绝）`, { paths: forbidden });
  }
  const root = input.root ?? proposalsRoot();
  const dir = proposalDirOf(slug, root);
  if (existsSync(join(dir, "applied.json")) || existsSync(join(dir, "rejected.json"))) {
    throw new ProposalError("EXISTS", `提案 ${slug} 已应用/已拒绝，换 slug 再提`);
  }
  const repo = repoRoot();
  // §9.2：符号链接一律拒绝（提案阶段就报，不等应用）
  for (const x of cls.files) {
    const abs = join(repo, ...x.path.split("/"));
    if (existsSync(abs) && lstatSync(abs).isSymbolicLink()) {
      throw new ProposalError("SYMLINK", `符号链接不允许：${x.path}`);
    }
  }
  const files: ProposalFileMeta[] = cls.files.map((x) => ({
    path: x.path,
    action: "update",
    sha256: sha256File(join(repo, ...x.path.split("/"))),
  }));
  // 新建/删除的文件动作按补丁头修正（meta 是给人看的，apply 会重新解析）
  const parsed = parsePatch(patch);
  for (const pf of parsed) {
    const hit = files.find((x) => x.path === pf.path);
    if (hit) hit.action = pf.oldPath === null ? "create" : pf.newPath === null ? "delete" : "update";
  }
  const verify: VerifySpec = {
    cmd: String(input.verify?.cmd ?? f.verify?.cmd ?? DEFAULT_VERIFY_CMD),
    timeout_ms: Number(input.verify?.timeout_ms ?? f.verify?.timeout_ms ?? DEFAULT_VERIFY_TIMEOUT_MS),
  };
  const meta: ProposalMeta = {
    ...(input.meta ?? {}),
    slug,
    created_at: new Date().toISOString(),
    risk: cls.risk,
    files,
    verify,
    ...((input.source ?? input.meta?.source) ? { source: input.source ?? input.meta?.source } : {}),
  };
  ensureDir(dir);
  writeFileSync(join(dir, "patch.diff"), patch.endsWith("\n") ? patch : patch + "\n", "utf8");
  writeFileSync(join(dir, "proposal.md"), proposal.trim() ? proposal.trim() + "\n" : `# ${slug}\n\n（未填写动机；risk=${cls.risk}，改动 ${files.length} 个文件）\n`, "utf8");
  writeJson(join(dir, "verify.json"), verify);
  writeJson(join(dir, "meta.json"), meta);
  return { slug, dir, meta, proposal, patch, verify, risk: cls.risk, status: "pending", applies_7d: 0 };
}

function loadRecord(dir: string, slug: string): ProposalRecord | null {
  const meta = readJson<ProposalMeta>(join(dir, "meta.json"));
  if (!meta) return null;
  const patch = existsSync(join(dir, "patch.diff")) ? readFileSync(join(dir, "patch.diff"), "utf8") : "";
  let risk: RiskLevel = meta.risk ?? "forbidden";
  try { risk = maxRisk(risk, classifyPatch(patch).risk); } catch { /* 坏补丁留给 apply 报 BAD_PATCH */ }
  const verify = readJson<VerifySpec>(join(dir, "verify.json")) ?? meta.verify;
  const rejected = readJson<{ at: string; reason: string }>(join(dir, "rejected.json"));
  const hist = applyHistory(dir);
  return {
    slug, dir, meta, proposal: existsSync(join(dir, "proposal.md")) ? readFileSync(join(dir, "proposal.md"), "utf8") : "",
    patch, verify: verify ?? { cmd: DEFAULT_VERIFY_CMD, timeout_ms: DEFAULT_VERIFY_TIMEOUT_MS },
    risk, status: statusOf(dir), applies_7d: appliesWithin7d(dir),
    applied_at: hist.last?.at ?? null, rejected,
  };
}

export function showProposal(slug: string): ProposalRecord | null {
  const dir = findProposalDir(slug);
  return dir ? loadRecord(dir, slug) : null;
}

export function listProposals(): ProposalSummary[] {
  const seen = new Map<string, ProposalSummary>();
  for (const dir of scanProposalDirs()) {
    const slug = dir.split(/[\\/]/).pop()!;
    const rec = loadRecord(dir, slug);
    if (!rec) continue;
    const prev = seen.get(slug);
    // 同名 slug 取 created_at 更新的那份（多节点各自提案时）
    if (prev && String(prev.created_at) > String(rec.meta.created_at)) continue;
    seen.set(slug, {
      slug, dir, created_at: rec.meta.created_at, risk: rec.risk, status: rec.status,
      files: rec.meta.files?.length ?? 0, applies_7d: rec.applies_7d, verify_cmd: rec.verify.cmd,
    });
  }
  return [...seen.values()].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

// ---------- 应用与回滚（§9.4） ----------

export interface ApplyResult {
  ok: boolean;
  code?: string;
  message?: string;
  slug: string;
  risk?: RiskLevel;
  forced?: boolean;
  /** R4：低风险自动应用（settings.auto_apply_low）时为 true */
  auto?: boolean;
  files?: { path: string; action: string; sha256: string | null }[];
  verify?: { cmd: string; exit: number | null; ms: number; tail: string };
  tail?: string;
  rolled_back?: boolean;
  applied_at?: string;
}

const COPY_SKIP = new Set([".git", "node_modules", "dist", ".dsh", "tmp"]);

/** 整树复制到临时 worktree（排除 .git/node_modules/dist 等大目录）
 *  例外：aica-pi/node_modules 里是 worker 扩展的运行时依赖（通常是 junction），
 *  少了它 verify 里的 `node --test` 会在 import tools.ts 时失败；按真实文件复制（dereference）。 */
function copyRepoTo(dst: string): void {
  ensureDir(dst);
  const src = repoRoot();
  cpSync(src, dst, {
    recursive: true,
    filter: (p) => {
      const base = p.split(/[\\/]/).pop()!;
      if (COPY_SKIP.has(base)) return false;
      if (p.includes(`${join("workbench", "shell")}${process.platform === "win32" ? "\\" : "/"}dist`)) return false;
      return true;
    },
  });
  const extDeps = join(src, "aica-pi", "node_modules");
  if (existsSync(extDeps)) {
    try { cpSync(extDeps, join(dst, "aica-pi", "node_modules"), { recursive: true, dereference: true }); }
    catch { /* 扩展依赖复制失败不阻断（verify 会如实报错） */ }
  }
}

/** 符号链接防御：目标文件本身或其最近存在的祖先 realpath 必须落在仓库内 */
function assertInsideRepo(abs: string): void {
  const repo = realpathSync(repoRoot());
  let cur = abs;
  for (let i = 0; i < 40; i++) {
    if (existsSync(cur)) {
      if (lstatSync(cur).isSymbolicLink()) throw new ProposalError("SYMLINK", `路径含符号链接：${relative(repo, cur)}`);
      const real = realpathSync(cur);
      if (!real.startsWith(repo)) throw new ProposalError("ESCAPE", `路径逃出仓库：${relative(repo, cur)}`);
      return;
    }
    cur = dirname(cur);
  }
  throw new ProposalError("ESCAPE", "无法确认路径归属");
}

function runVerify(cwd: string, verify: VerifySpec): { exit: number | null; ms: number; tail: string; out: string } {
  const t0 = Date.now();
  const timeout = Math.max(1000, Number(verify.timeout_ms) || DEFAULT_VERIFY_TIMEOUT_MS);
  const r = spawnSync(verify.cmd, { cwd, shell: true, timeout, encoding: "utf8", windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? `\n[spawn] ${String(r.error)}` : ""}`;
  const tail = out.split(/\r?\n/).slice(-40).join("\n");
  return { exit: r.status, ms: Date.now() - t0, tail, out };
}

/** 落盘：备份 → 原子写 → 失败按字节回滚（调用方已确认 verify 全绿） */
function commitFiles(dir: string, repo: string, files: { path: string; action: string; content: Buffer | null }[]): { ok: true; files: { path: string; action: string; sha256: string | null }[] } | { ok: false; error: string } {
  const backupRoot = ensureDir(join(dir, "backup"));
  const rolled: { abs: string; prev: Buffer | null }[] = [];
  const written: { path: string; action: string; sha256: string | null }[] = [];
  for (const f of files) {
    const abs = join(repo, ...f.path.split("/"));
    assertInsideRepo(abs);
    const prev = existsSync(abs) ? readFileSync(abs) : null;
    const bak = join(backupRoot, ...f.path.split("/"));
    try {
      if (prev) { ensureDir(dirname(bak)); writeFileSync(bak, prev); }
    } catch { /* 备份失败不阻断（tmp 树仍有副本），继续 */ }
    rolled.push({ abs, prev });
    try {
      if (f.action === "delete") { if (existsSync(abs)) unlinkSync(abs); }
      else {
        ensureDir(dirname(abs));
        const tmp = `${abs}.s28tmp`;
        writeFileSync(tmp, f.content!);
        renameSync(tmp, abs);
      }
      written.push({ path: f.path, action: f.action, sha256: f.content ? sha256(f.content) : null });
    } catch (e) {
      // 字节级回滚：按倒序恢复
      for (const r of rolled.reverse()) {
        try {
          if (r.prev === null) { if (existsSync(r.abs)) unlinkSync(r.abs); }
          else writeFileSync(r.abs, r.prev);
        } catch { /* 回滚失败要如实上报，不吞成成功 */ }
      }
      return { ok: false, error: `落盘失败并已回滚：${String(e)}` };
    }
  }
  return { ok: true, files: written };
}

/**
 * 应用提案：临时树 → verify → 备份 + 原子落盘；任何一步失败都不改真实仓库（verify 失败 = 零写入）。
 * high 风险必须 force；禁止级/白名单外直接拒；7 天内第 4 次直接 stale。
 */
export function applyProposal(slug: string, opts: { force?: boolean; now?: number } = {}): ApplyResult {
  const rec = showProposal(slug);
  if (!rec) return { ok: false, code: "NOT_FOUND", slug, message: `没有提案 ${slug}` };
  if (rec.status === "rejected") return { ok: false, code: "REJECTED", slug, message: `提案已被拒绝：${rec.rejected?.reason ?? ""}` };
  const applies = appliesWithin7d(rec.dir, opts.now ?? Date.now());
  if (applies >= MAX_APPLIES_PER_7D) {
    return { ok: false, code: "STALE", slug, risk: rec.risk, message: `7 天内已应用 ${applies} 次（上限 ${MAX_APPLIES_PER_7D}），标 stale，拒绝再试` };
  }
  let cls: { files: { path: string; level: RiskLevel }[]; risk: RiskLevel };
  try { cls = classifyPatch(rec.patch); }
  catch (e) { return { ok: false, code: "BAD_PATCH", slug, message: (e as Error).message }; }
  const forbidden = cls.files.filter((x) => x.level === "forbidden").map((x) => x.path);
  if (forbidden.length) return { ok: false, code: "FORBIDDEN", slug, risk: cls.risk, message: `禁止级路径：${forbidden.join(", ")}` };
  if (cls.risk === "high" && !opts.force) {
    return { ok: false, code: "NEEDS_FORCE", slug, risk: cls.risk, message: `高风险提案（${cls.files.map((x) => x.path).join(", ")}）需要 --force 二次确认` };
  }
  // R4：低风险 + settings.auto_apply_low 开 + 未显式 force → 自动应用（high 永不自动）
  const autoApply = cls.risk === "low" && !opts.force && readSettings().auto_apply_low;
  const repo = repoRoot();
  const tmp = join(tmpRoot(), `apply-${slug}-${Date.now().toString(36)}`);
  try {
    copyRepoTo(tmp);
    const staged = applyPatchToRepo(tmp, rec.patch);
    if (!staged.ok) return { ok: false, code: "BAD_PATCH", slug, message: staged.error };
    const verify = runVerify(tmp, rec.verify);
    if (verify.exit !== 0) {
      return {
        ok: false, code: "VERIFY_FAILED", slug, risk: cls.risk, rolled_back: true,
        message: `verify 失败（exit=${verify.exit}）：未落盘，仓库零改动`,
        verify: { cmd: rec.verify.cmd, exit: verify.exit, ms: verify.ms, tail: verify.tail },
        tail: verify.tail,
      };
    }
    const committed = commitFiles(rec.dir, repo, staged.files);
    if (!committed.ok) return { ok: false, code: "COMMIT_FAILED", slug, risk: cls.risk, rolled_back: true, message: committed.error };
    const at = new Date().toISOString();
    const applied = {
      at, risk: cls.risk, forced: !!opts.force, auto: autoApply,
      verify: { cmd: rec.verify.cmd, exit: verify.exit, ms: verify.ms, tail: verify.tail },
      files: committed.files,
    };
    const hist = applyHistory(rec.dir);
    writeJson(join(rec.dir, "applied.json"), { slug, updated: at, auto: autoApply, history: [...hist.history, applied].slice(-20) });
    // §9.5：应用成功的提案给来源节点写一条 learn 事件（下一轮 learned.md 注入时可见）
    const src = rec.meta.source;
    if (src?.root_id && src.path) {
      try {
        appendEvent(src.root_id, src.path, { kind: "learn", data: { proposal: slug, risk: cls.risk, files: committed.files.map((f) => f.path), verify: { exit: verify.exit } } });
      } catch { /* 来源节点已归档也不影响应用结果 */ }
    }
    // R4：自动应用的审计（index.jsonl 恒写；有来源节点再补一条节点事件）
    if (autoApply) {
      const audit = { slug, risk: cls.risk, auto: true, files: committed.files.map((f) => f.path), verify: { exit: verify.exit } };
      try {
        mkdirSync(RUNS_DIR, { recursive: true });
        appendFileSync(join(RUNS_DIR, "index.jsonl"), JSON.stringify({ ts: at, event: "auto_applied", ...audit }) + "\n", "utf8");
      } catch { /* 审计写不进不阻断应用 */ }
      if (src?.root_id && src.path) {
        try { appendEvent(src.root_id, src.path, { kind: "auto_applied", data: audit }); } catch { /* 同上 */ }
      }
    }
    return { ok: true, slug, risk: cls.risk, forced: !!opts.force, auto: autoApply, applied_at: at, files: committed.files,
      verify: { cmd: rec.verify.cmd, exit: verify.exit, ms: verify.ms, tail: verify.tail } };
  } catch (e) {
    return { ok: false, code: "APPLY_ERROR", slug, message: String((e as Error)?.message ?? e) };
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* 临时树清不掉不阻断 */ }
  }
}

/** 拒绝提案：写 rejected.json（带理由），之后 apply 一律拒绝 */
export function rejectProposal(slug: string, reason: string): { ok: boolean; code?: string; message?: string; slug: string; rejected_at?: string } {
  const dir = findProposalDir(slug);
  if (!dir) return { ok: false, code: "NOT_FOUND", slug, message: `没有提案 ${slug}` };
  const text = String(reason ?? "").trim();
  if (!text) return { ok: false, code: "USAGE", slug, message: "reject 需要 --reason" };
  const at = new Date().toISOString();
  writeJson(join(dir, "rejected.json"), { at, reason: text.slice(0, 2000) });
  return { ok: true, slug, rejected_at: at };
}

/** 目录里是否已有提案（测试与 CLI 用） */
export function proposalExists(slug: string): boolean { return !!findProposalDir(slug); }

/** 节点目录约定：worker 的 ev_propose 写到 <node>/proposals（PRD §9.1） */
export function nodeProposalsRoot(rootId: string, path: string): string {
  return join(nodeDir(rootId, path), "proposals");
}

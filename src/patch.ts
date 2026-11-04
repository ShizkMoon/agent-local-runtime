// R5：apply_patch 的核心 —— unified diff（多文件）在内存里应用到一棵树。
// 关键性质：all-or-nothing —— 任何文件/hunk 失败都只返回错误，不写盘；写盘由调用方（工具）在全部成功后再做。
// 复用 src/proposals.ts 的 parsePatch（同一套归一化/路径规则），保证提案与 worker 编辑语法一致。
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parsePatch, type ParsedFile, type Hunk } from "./proposals.ts";

export interface PatchFileResult {
  path: string;
  action: "create" | "update" | "delete";
  add: number;
  del: number;
  before: string | null;
  after: string | null;
  /** 该文件自己的 unified diff 片段（写 file_edit 事件用） */
  diff: string;
}

export type PatchOutcome =
  | { ok: true; files: PatchFileResult[] }
  | { ok: false; code: "BAD_PATCH" | "BAD_PATH" | "CONTEXT" | "NEEDS_READ"; message: string; path?: string; line?: number; needs?: string[] };

export interface PatchOptions {
  /** 本次会话已 read 过的文件（相对 root 的 posix 路径）；update/delete 必须命中 */
  readSet?: Set<string>;
}

function hunkToText(h: Hunk): string {
  return [`@@ -${h.oldStart},${h.oldCount} +${h.newStart},${h.newCount} @@`, ...h.lines].join("\n");
}

function fileDiff(pf: ParsedFile): string {
  const old = pf.oldPath === null ? "/dev/null" : `a/${pf.path}`;
  const nw = pf.newPath === null ? "/dev/null" : `b/${pf.path}`;
  return [`--- ${old}`, `+++ ${nw}`, ...pf.hunks.map(hunkToText)].join("\n");
}

/** 把一个文件的 hunks 应用到旧文本上；不匹配时报"第 N 行上下文不匹配" */
function applyHunks(path: string, oldText: string, hunks: Hunk[]): { ok: true; text: string; add: number; del: number } | { ok: false; line: number; message: string } {
  const eol = oldText.includes("\r\n") ? "\r\n" : "\n";
  const lines = oldText.length ? oldText.split(/\r?\n/) : [];
  const trailing = lines.length > 0 && lines[lines.length - 1] === "";
  if (trailing) lines.pop();
  let offset = 0;
  let add = 0, del = 0;
  for (const hunk of hunks) {
    const expect: string[] = [], repl: string[] = [];
    for (const l of hunk.lines) {
      const c = l === "" ? " " : l[0];
      const body = l === "" ? "" : l.slice(1);
      if (c === " ") { expect.push(body); repl.push(body); }
      else if (c === "-") { expect.push(body); del++; }
      else if (c === "+") { repl.push(body); add++; }
    }
    const at = hunk.oldStart === 0 ? 0 : hunk.oldStart - 1 + offset;
    for (let k = 0; k < expect.length; k++) {
      if (lines[at + k] !== expect[k]) {
        return {
          ok: false,
          line: hunk.oldStart + k,
          message: `第 ${hunk.oldStart + k} 行上下文不匹配：期望 ${JSON.stringify(expect[k] ?? "<EOF>")}，实际 ${JSON.stringify(lines[at + k] ?? "<EOF>")}`,
        };
      }
    }
    lines.splice(at, expect.length, ...repl);
    offset += repl.length - expect.length;
  }
  return { ok: true, text: lines.join(eol) + (trailing ? eol : ""), add, del };
}

/** 纯内存应用：不碰磁盘（除了读旧内容），任何失败 → 返回错误，调用方保证零写入 */
export function applyPatchInMemory(root: string, patchText: string, opts: PatchOptions = {}): PatchOutcome {
  let parsed: ParsedFile[];
  try { parsed = parsePatch(patchText); }
  catch (e) { return { ok: false, code: "BAD_PATCH", message: String((e as Error)?.message ?? e) }; }
  if (!parsed.length) return { ok: false, code: "BAD_PATCH", message: "补丁里没有可应用的文件段" };

  // 路径：parsePatch 已归一化（拒绝绝对路径与 `..`）；这里再拦 .git
  for (const pf of parsed) {
    if (pf.path.split("/").includes(".git")) return { ok: false, code: "BAD_PATH", path: pf.path, message: `.git 目录不可修改：${pf.path}` };
  }

  // read-before-edit：改/删已存在的文件必须先 read 过（新建文件不受限）
  if (opts.readSet) {
    const needs = parsed
      .filter((pf) => pf.oldPath !== null && !opts.readSet!.has(pf.path))
      .map((pf) => pf.path);
    if (needs.length) {
      return { ok: false, code: "NEEDS_READ", needs, message: `先 read ${needs.join(", ")}（read-before-edit：本次会话还没读过这些文件）` };
    }
  }

  const out: PatchFileResult[] = [];
  for (const pf of parsed) {
    const abs = join(root, ...pf.path.split("/"));
    const exists = existsSync(abs);
    if (pf.oldPath === null) {
      if (exists) return { ok: false, code: "BAD_PATCH", path: pf.path, message: `新建文件已存在：${pf.path}` };
      const lines: string[] = [];
      let add = 0;
      for (const h of pf.hunks) {
        for (const l of h.lines) {
          const c = l === "" ? " " : l[0];
          if (c === "+" || c === " ") { lines.push(l.slice(1)); add++; }
        }
      }
      out.push({ path: pf.path, action: "create", add, del: 0, before: null, after: lines.join("\n") + (lines.length ? "\n" : ""), diff: fileDiff(pf) });
      continue;
    }
    if (!exists) return { ok: false, code: "BAD_PATCH", path: pf.path, message: `要修改的文件不存在：${pf.path}` };
    const oldText = readFileSync(abs, "utf8");
    if (pf.newPath === null) {
      // 删除：整文件按 - 行核对（空 hunk 视为直接删）
      let del = 0;
      for (const h of pf.hunks) for (const l of h.lines) if ((l === "" ? " " : l[0]) === "-") del++;
      out.push({ path: pf.path, action: "delete", add: 0, del, before: oldText, after: null, diff: fileDiff(pf) });
      continue;
    }
    const r = applyHunks(pf.path, oldText, pf.hunks);
    if (!r.ok) {
      return { ok: false, code: "CONTEXT", path: pf.path, line: r.line, message: `${pf.path}：${r.message}（建议先 read ${pf.path} 拿到当前内容再重试）` };
    }
    out.push({ path: pf.path, action: "update", add: r.add, del: r.del, before: oldText, after: r.text, diff: fileDiff(pf) });
  }
  return { ok: true, files: out };
}

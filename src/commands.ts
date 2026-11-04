// R5：斜杠命令预设 —— 以 aica-pi/prompts/cmd-*.md 文件存在为准（不硬编码长文本）。
// 文件格式：可选 YAML 头（--- 之间 title/profile/tools: a,b），正文即 prompt。
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface CommandPreset {
  name: string;
  title: string;
  prompt: string;
  profile: string;
  tools?: string[];
}

const AICA_PI = join(dirname(fileURLToPath(import.meta.url)), "..", "aica-pi");

export function promptsDir(): string {
  return process.env.AICA_PROMPTS || join(AICA_PI, "prompts");
}

export function parseCommandFile(file: string, name: string): CommandPreset {
  const raw = readFileSync(file, "utf8");
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  const meta: Record<string, string> = {};
  let body = raw;
  if (m) {
    for (const line of m[1].split(/\r?\n/)) {
      const i = line.indexOf(":");
      if (i > 0) meta[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
    }
    body = m[2];
  }
  return {
    name,
    title: meta.title || name,
    prompt: body.trim(),
    profile: meta.profile || "worker",
    ...(meta.tools ? { tools: meta.tools.split(",").map((s) => s.trim()).filter(Boolean) } : {}),
  };
}

/** 列出内置命令（按名字排序；目录不存在返回空数组，不抛） */
export function listCommands(dir = promptsDir()): CommandPreset[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^cmd-.+\.md$/i.test(f))
    .sort()
    .map((f) => parseCommandFile(join(dir, f), f.replace(/^cmd-/i, "").replace(/\.md$/i, "")));
}

export function findCommand(name: string, dir = promptsDir()): CommandPreset | null {
  return listCommands(dir).find((c) => c.name === name) ?? null;
}

// aica-pi · paths：Worker 外部工具二进制解析
// 约束：tools.ts 用 execFileSync 直拉进程、不经 shell —— Windows 下 execFile 不认 .cmd/PATHEXT，
// 必须解析到真实 .exe 绝对路径。解析顺序：显式环境变量覆盖 → 本机已知安装位 → PATH 查找。
import { existsSync } from "node:fs";
import { join, delimiter } from "node:path";

const USERPROFILE = process.env.USERPROFILE ?? "";
const LOCALAPPDATA = process.env.LOCALAPPDATA ?? (USERPROFILE ? join(USERPROFILE, "AppData", "Local") : "");

// 每个外部工具的环境变量覆盖名（运维改路径不用改代码）
const ENV_OVERRIDE: Record<string, string> = {
  "agent-desktop": "AICA_AGENT_DESKTOP",
  "ego-browser": "AICA_EGO_BROWSER",
  kn: "AICA_KN",
};

// 本机已知安装位（见 docs：agent-desktop 源码在 %USERPROFILE%\agent-src\tools\，ego 走版本目录）
const KNOWN: Record<string, string[]> = {
  "agent-desktop": [join(USERPROFILE, "agent-src", "tools", "agent-desktop", "agent-desktop.exe")],
  "ego-browser": [join(LOCALAPPDATA, "share", "ego", "active_version_dir", "ego-browser.exe")],
  kn: [], // 知识库 CLI 仍在设计阶段，无已知安装位（占位：实现后补路径）
};

const cache = new Map<string, string | undefined>();

// PATH 逐项找可执行体；Windows 只试 .exe 与裸名（.cmd/.bat 走不了 execFile）
function fromPath(name: string): string | undefined {
  const exts = process.platform === "win32" ? [".exe", ""] : [""];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = join(dir, name + ext);
      if (existsSync(p)) return p;
    }
  }
  return undefined;
}

/** 解析工具二进制绝对路径；找不到返回 undefined（调用方决定降级文案） */
export function resolveBin(name: string): string | undefined {
  if (cache.has(name)) return cache.get(name);
  let found: string | undefined;
  const override = ENV_OVERRIDE[name] ? process.env[ENV_OVERRIDE[name]] : undefined;
  if (override && existsSync(override)) found = override;
  if (!found) {
    for (const c of KNOWN[name] ?? []) {
      if (existsSync(c)) { found = c; break; }
    }
  }
  if (!found) found = fromPath(name);
  cache.set(name, found);
  return found;
}

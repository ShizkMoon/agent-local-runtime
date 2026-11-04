// R6 设计令牌的机器断言：`node --test workbench/test/tokens.test.ts`
// 只读 tokens.css，不依赖浏览器；色彩对比度用 WCAG 2.x 相对亮度公式现算。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../public/v1/tokens.css", import.meta.url), "utf8");

/* ---------------------------------------------------------------- 工具 */
/* 注意：文件头注释里也出现了 [data-theme="dark"] 这个字符串，必须按"选择器 + {"定位，
   不能用 indexOf，否则会把亮色块切没（这个坑踩过一次）。 */
const darkMatch = /\[data-theme="dark"\]\s*\{/.exec(css);
assert.ok(darkMatch, "tokens.css 必须同时有亮色与 [data-theme=dark] 两套");
const darkAt = darkMatch!.index;
const lightCss = css.slice(0, darkAt);
const darkCss = css.slice(darkAt);
assert.ok(lightCss.includes("--bg:"), `亮色块解析失败（长度 ${lightCss.length}），请检查切片起点`);

function vars(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}
const LIGHT = vars(lightCss);
const DARK = vars(darkCss);

function rgb(hex: string): [number, number, number] {
  const s = hex.trim().replace("#", "");
  const n = s.length === 3 ? s.split("").map((c) => c + c).join("") : s;
  return [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16)) as [number, number, number];
}
function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string): number {
  const L1 = luminance(a);
  const L2 = luminance(b);
  return (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
}

/* ------------------------------------------------- 1. 字号只有 6 档 */
const FONT_SCALE = [12, 13, 14, 16, 20, 28];
test("tokens.css：字号只有 6 档（12/13/14/16/20/28），且没有半像素档", () => {
  const fs = Object.entries(LIGHT)
    .filter(([k]) => /^--fs-\d+$/.test(k))
    .map(([, v]) => Number(v.replace("px", "")))
    .sort((a, b) => a - b);
  assert.deepEqual(fs, FONT_SCALE, `字号阶必须正好是 ${FONT_SCALE.join("/")}，实际 ${fs.join("/")}`);
  assert.equal(Object.keys(LIGHT).filter((k) => /^--fs-\d+$/.test(k)).length, 6, "字号 token 必须是 6 个");

  for (const [, v] of Object.entries(LIGHT).filter(([k]) => /^--fs-\d+$/.test(k))) {
    assert.match(v, /^\d+px$/, `字号必须写成整像素（不许 em/rem/半像素）：${v}`);
    assert.equal(Number(v.replace("px", "")) % 1, 0, `字号不许有小数：${v}`);
  }

  /* 文件里不允许再出现裸的 font-size: 13.5px —— 一律走 var(--fs-n) */
  const raw = [...css.matchAll(/font-size:\s*([0-9.]+)px/g)].map((m) => m[1]);
  assert.deepEqual(raw, [], `tokens.css 里不许有裸 font-size px 值（发现 ${raw.join(",")}），请改成 var(--fs-n)`);

  const half = [...Object.values(LIGHT), ...Object.values(DARK)].filter((v) => /^\d+\.\d+px$/.test(v));
  assert.deepEqual(half, [], `不许出现半像素 token：${half.join(",")}`);
});

/* --------------------------------------------- 2. 间距全 4 的倍数 */
test("tokens.css：间距 7 档、全部 4 的倍数，且没有裸 px 间距", () => {
  const sp = Object.entries(LIGHT)
    .filter(([k]) => /^--sp-\d+$/.test(k))
    .map(([, v]) => Number(v.replace("px", "")))
    .sort((a, b) => a - b);
  assert.deepEqual(sp, [4, 8, 12, 16, 20, 24, 32], `间距阶必须是 4/8/12/16/20/24/32，实际 ${sp.join("/")}`);
  for (const v of sp) assert.equal(v % 4, 0, `间距 ${v}px 不是 4 的倍数`);

  /* 任何 padding/margin/gap 的 px 值都必须落在 4 的倍数上（0 除外） */
  const decls = [...css.matchAll(/(?:^|[;{\s])(padding|padding-[a-z]+|margin|margin-[a-z]+|gap|row-gap|column-gap)\s*:\s*([^;{}]+);/g)];
  const bad: string[] = [];
  for (const m of decls) {
    for (const tok of m[2].trim().split(/\s+/)) {
      const px = /^(-?)([0-9.]+)px$/.exec(tok);
      if (!px) continue;                       // var(--sp-n) / 0 / auto 都放过
      const v = Number(px[2]);
      if (v !== 0 && v % 4 !== 0) bad.push(`${m[1]}:${tok}`);
    }
  }
  assert.deepEqual(bad, [], `间距出现非 4 倍数：${bad.join(", ")}`);
});

/* ------------------------------------- 3. --warn 亮底对比度 ≥ 4.5 */
test("tokens.css：--warn 在亮色下对比度 ≥ 4.5:1（旧值 #b07b4f 只有 3.53:1）", () => {
  const warn = LIGHT["--warn"];
  const bg = LIGHT["--bg"];
  assert.ok(warn && bg, "亮色主题必须定义 --warn 与 --bg");
  const r = contrast(warn, bg);
  assert.ok(r >= 4.5, `--warn ${warn} on --bg ${bg} = ${r.toFixed(2)}:1，低于 AA 4.5`);
  assert.ok(r < 12, `对比度 ${r.toFixed(2)}:1 过大，说明颜色选得太黑（warn 应是琥珀系，不是纯黑）`);
});

test("tokens.css：两套主题的正文色都 ≥ 4.5:1（--warn 也要过）", () => {
  const checks: [string, Record<string, string>][] = [["light", LIGHT], ["dark", DARK]];
  for (const [name, t] of checks) {
    for (const key of ["--text", "--text-2", "--text-3", "--accent", "--danger", "--warn", "--ok"]) {
      const fg = t[key];
      assert.ok(fg, `${name} 主题缺 ${key}`);
      const r = contrast(fg, t["--bg"]);
      assert.ok(r >= 4.5, `${name} 主题 ${key} ${fg} on ${t["--bg"]} = ${r.toFixed(2)}:1，低于 4.5`);
    }
  }
});

test("tokens.css：--brand（clay）只做 presence，不做文字色", () => {
  /* clay 在亮底只有 ~3:1，作为"文字色"会不达标；这条断言把纪律钉在文件里：
     只要有人把它放进文字色清单，就会先撞上对比度这条。 */
  const r = contrast(LIGHT["--brand"], LIGHT["--bg"]);
  assert.ok(r < 4.5, `--brand 突然满足 4.5:1（${r.toFixed(2)}），请同步更新这条纪律与 design-tokens.md`);
});

/* --------------------------------------------- 4. reduced-motion */
test("tokens.css：prefers-reduced-motion 全关动画，骨架屏退化为静态块", () => {
  const m = css.match(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*)\}\s*$/);
  assert.ok(m, "缺少 prefers-reduced-motion 媒体查询");
  const block = m![1];
  assert.match(block, /animation-duration:\s*0\.01ms\s*!important/, "reduced-motion 必须把 animation-duration 压到 0.01ms");
  assert.match(block, /transition-duration:\s*0\.01ms\s*!important/, "reduced-motion 必须把 transition-duration 压到 0.01ms");
  assert.match(block, /\.sk::after\s*\{[^}]*display:\s*none/, "reduced-motion 下骨架屏 shimmer 必须关掉（display:none）");
});

test("tokens.css：骨架屏 .sk + shimmer 关键帧存在，且两套主题都有底色", () => {
  assert.match(css, /\.sk\s*\{[^}]*background:\s*var\(--bg-1\)/, "缺少 .sk 基础块（底色走 --bg-1）");
  assert.match(css, /@keyframes\s+sk-shimmer\s*\{/, "缺少 sk-shimmer 关键帧");
  assert.match(css, /\.sk-line\b/, "缺少 .sk-line 变体");
  assert.match(css, /\.sk-block\b/, "缺少 .sk-block 变体");
  assert.match(css, /\.sk-circle\b/, "缺少 .sk-circle 变体");
});

/* ------------------------------------------------ 5. 焦点 / 两套主题 */
test("tokens.css：唯一的焦点样式走 --accent，鼠标点击不出现焦点环", () => {
  assert.match(css, /:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--accent\)/, "缺少统一 :focus-visible 规则");
  assert.match(css, /outline-offset:\s*2px/, ":focus-visible 必须有 outline-offset: 2px");
  assert.match(css, /:focus:not\(:focus-visible\)\s*\{[^}]*outline:\s*none/, "鼠标点击不应出现焦点环");
});

test("tokens.css：两套主题都定义了同一组语义色", () => {
  const keys = ["--bg", "--bg-1", "--bg-2", "--line", "--text", "--text-2", "--text-3",
    "--accent", "--danger", "--warn", "--ok", "--brand"];
  for (const k of keys) {
    assert.ok(LIGHT[k], `亮色主题缺 ${k}`);
    assert.ok(DARK[k], `暗色主题缺 ${k}`);
  }
});

/* ------------------------------------------- 6. 圆角 / 阴影 各 3 档 */
test("tokens.css：圆角与阴影各 3 档，动效只有 2 档", () => {
  const r = Object.keys(LIGHT).filter((k) => /^--r-\d+$/.test(k));
  const s = Object.keys(LIGHT).filter((k) => /^--sh-\d+$/.test(k));
  const d = Object.keys(LIGHT).filter((k) => /^--dur-\d+$/.test(k));
  assert.equal(r.length, 3, `圆角必须 3 档，实际 ${r.join(",")}`);
  assert.equal(s.length, 3, `阴影必须 3 档，实际 ${s.join(",")}`);
  assert.equal(d.length, 2, `动效必须 2 档，实际 ${d.join(",")}`);
  assert.ok(LIGHT["--ease"], "缺少统一缓动 --ease");
});

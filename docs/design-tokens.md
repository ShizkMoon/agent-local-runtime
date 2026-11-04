# 设计令牌（R6）

> 目标：把工作台从"手写样式"变成"有 token 的系统"。`workbench/public/v1/tokens.css` 是**唯一样式来源**，
> 下一轮 `index.html` 换装时把硬编码值按本文 §3 的清单机械替换即可。
> 机器断言：`node --test workbench/test/tokens.test.ts`（10 条，读数见 §5）。
> 生成方式：盘点脚本读 `index.html` 的 CSS 声明（2026-11-04 R4 合入前的 HEAD），下文所有"现有 x 处"都是数出来的。

---

## 1. 令牌总表

### 1.1 字号（6 档，`--fs-1..6`）

| Token | 值 | 用途 | 说明 |
|---|---|---|---|
| `--fs-1` | 12px | 元信息：时间、计数、快捷键提示、徽标 | 现有 12px 用了 58 次，是"事实上的正文"，仍归到最小档 |
| `--fs-2` | 13px | 标签：节标题、分组头、pill | |
| `--fs-3` | 14px | 正文默认：说明、卡片描述、composer | 全站默认字号 |
| `--fs-4` | 16px | 强调：对话正文、卡片标题 | |
| `--fs-5` | 20px | 标题：中栏标题、弹层标题 | |
| `--fs-6` | 28px | 空态主句（"还没有任务"那一级） | |

行高：`--lh-1:1.45`（密）/`--lh-2:1.55`（阅读）/`--lh-3:1.35`（标题）。

### 1.2 间距（7 档，全部 4 的倍数，`--sp-1..7`）

| Token | 值 | 用途 |
|---|---|---|
| `--sp-1` | 4px | 图标与文字、行内微间距 |
| `--sp-2` | 8px | 同一块内元素之间 |
| `--sp-3` | 12px | 卡片头与正文 |
| `--sp-4` | 16px | 块与块之间（默认纵向节奏） |
| `--sp-5` | 20px | 结论块与验收条之间这类"大块" |
| `--sp-6` | 24px | 面板内边距 |
| `--sp-7` | 32px | 面板与画布、空态留白 |

> **1–2px 的光学微调不进间距阶**：需要"贴一点"的地方用 `transform: translateY(1px)`、`outline-offset`、
> `border-width`，不要写 `margin: 1px`——这是本文最容易被违反的一条。

### 1.3 颜色（亮/暗两套，语义名不带色相）

| Token | 亮色 | 暗色 | 用途 | 亮底对比度 |
|---|---|---|---|---|
| `--bg` | `#fcfcfb` | `#151515` | 画布 | — |
| `--bg-1` | `#f9f9f7` | `#0b0b0b` | 沉降面：左栏、代码底 | — |
| `--bg-2` | `#ffffff` | `#1a1a19` | 抬升面：卡片、气泡、composer | — |
| `--line` | `rgba(0,0,0,.08)` | `rgba(255,255,255,.09)` | 发丝线 | — |
| `--line-strong` | `rgba(0,0,0,.16)` | `rgba(255,255,255,.18)` | 强分割 | — |
| `--text` | `#0b0b0b` | `#f0efec` | 主文本 | **19.2:1** |
| `--text-2` | `#52514e` | `#c3c2b7` | 次要文本 | **7.7:1** |
| `--text-3` | `#67655d` | `#898781` | 弱化文本（最低档，不许更淡） | **5.7:1** |
| `--accent` | `#184f95` | `#86b6ef` | 可点 / 链接 / 焦点环 | **7.9:1** |
| `--danger` | `#b04a6e` | `#c46686` | 终结失败、破坏性动作 | **5.1:1** |
| `--warn` | **`#8f5f36`** | `#d4a27f` | 待裁决 / 预算告警 | **5.3:1**（旧值 `#b07b4f` 只有 **3.5:1**，不合格） |
| `--ok` | `#5f7a45` | `#8fb573` | 通过 / 已完成 | **4.7:1** |
| `--brand` | `#d97757` | `#d97757` | **只做 agent presence**（状态点、发送键、头像） | 3.1:1 —— 因此**不做文字色** |

软底：`--accent-soft / --danger-soft / --warn-soft / --ok-soft`（`--text-3` 压在软底上仍 ≥4.9:1，实测见 §5）。
其它：`--hov`（悬停）、`--sk-hi`（骨架屏高光）、`--on-accent`、`--on-brand`。

### 1.4 圆角 / 阴影 / 动效 / 布局

| 组 | Token | 值 |
|---|---|---|
| 圆角 3 档 | `--r-1 / --r-2 / --r-3` | 8 / 12 / 16px（另有 `--r-pill:999px`，胶囊不算一档） |
| 阴影 3 档 | `--sh-1 / --sh-2 / --sh-3` | 悬停 / 弹层 / 模态 |
| 动效 2 档 | `--dur-1 / --dur-2` | 120ms（颜色、位移）/ 200ms（展开、弹层），统一 `--ease` |
| 布局 | `--w-side / --w-right / --w-thread` | 256 / 380 / 720px |
| 字体族 | `--f-sans / --f-serif / --f-mono` | 系统无衬线 / 阅读衬线（结论）/ 等宽（工具、路径） |
| 层级 | `--z-netbar / --z-pop` | 18 / 40 |

### 1.5 焦点 / 骨架屏 / 动效降级

```css
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
:focus:not(:focus-visible) { outline: none; }        /* 鼠标点击不出环 */
```

- `.sk` / `.sk-line` / `.sk-block` / `.sk-circle` + `@keyframes sk-shimmer`（1.4s）；
- `@media (prefers-reduced-motion: reduce)` 里把 `animation-duration` 与 `transition-duration` 压到 `0.01ms`，
  并把 `.sk::after` 关掉（退化为静态灰块）。

---

## 2. 换装的收益（为什么值得动这一刀）

| 现状 | 换装后 |
|---|---|
| 字号 14 档，含 6 个半像素档（10.5 / 11.5 / 12.5 / 13.5 / 14.5 / 15.5） | 6 档整像素 |
| 字号声明 138 处、间距声明 256 处，绝大多数是硬编码 | 全部 `var(--fs-n)` / `var(--sp-n)` |
| 间距只有 38% 落在 4 的倍数上（奇数 46 处；index.html 一直在动，R5 审计时是 42%） | 全部 4 的倍数（断言强制） |
| `--warn` 亮底 3.5:1，「等你」状态词不达 AA | 5.3:1 |
| 焦点样式散落（`:focus-visible` 仅 3 条、`outline:none` 5 处） | 一条全局规则 + 一条"鼠标不出环" |
| 无骨架屏 | `.sk` 三变体 + shimmer + reduced-motion 退化 |

---

## 3. 「旧值 → 新值」机械替换清单

> 用法：按 §4 的脚本逐条替换；每条都给了"现有处数"，替换完对一遍总数即可。

### 3.1 字号（14 档 → 6 档，共 138 处）

| 旧值 | 处数 | 新 token | 备注 |
|---|---|---|---|
| `font-size:10px` | 1 | `var(--fs-1)` | |
| `font-size:10.5px` | 4 | `var(--fs-1)` | |
| `font-size:11px` | 9 | `var(--fs-1)` | 时间/计数/提示 |
| `font-size:11.5px` | 11 | `var(--fs-1)` | |
| `font-size:12px` | 58 | `var(--fs-1)` | 不变 |
| `font-size:12.5px` | 15 | `var(--fs-2)` | |
| `font-size:13px` | 22 | `var(--fs-2)` | 不变 |
| `font-size:13.5px` | 2 | `var(--fs-3)` | |
| `font-size:14px` | 8 | `var(--fs-3)` | 不变 |
| `font-size:14.5px` | 2 | `var(--fs-4)` | 若换装后觉得过大，可改 `--fs-3`，**但不许自造 15px** |
| `font-size:15px` | 2 | `var(--fs-4)` | |
| `font-size:15.5px` | 2 | `var(--fs-4)` | 卡片标题（serif） |
| `font-size:16px` | 1 | `var(--fs-4)` | 不变 |
| `font-size:18px` | 1 | `var(--fs-5)` | |

### 3.2 间距（20 档 → 7 档，共 256 处）

| 旧值 | 处数 | 新 token |
|---|---|---|
| `1px` | 3 | `var(--sp-1)` |
| `2px` | 19 | `var(--sp-1)`（若是描边/光学微调，改用 `border-width`/`transform`，见 §1.2 注） |
| `3px` | 4 | `var(--sp-1)` |
| `4px` | 19 | `var(--sp-1)` |
| `5px` | 14 | `var(--sp-2)` |
| `6px` | 36 | `var(--sp-2)` |
| `7px` | 11 | `var(--sp-2)` |
| `8px` | 48 | `var(--sp-2)` |
| `9px` | 11 | `var(--sp-3)` |
| `10px` | 45 | `var(--sp-3)` |
| `11px` | 3 | `var(--sp-3)` |
| `12px` | 17 | `var(--sp-3)` |
| `14px` | 7 | `var(--sp-4)` |
| `16px` | 10 | `var(--sp-4)` |
| `18px` | 2 | `var(--sp-5)` |
| `20px` | 3 | `var(--sp-5)` |
| `24px` | 1 | `var(--sp-6)` |
| `32px` | 0 | `var(--sp-7)` |
| `34px` | 1 | `var(--sp-7)`（原值是 `--sb-w` 之外的固定宽，换装时归到 32） |
| `60px` `86px` | 各 1 | **不是间距**：是高度/尺寸，按布局 token 处理或保留 px |

### 3.3 颜色与其它变量（改名 + 改值）

| 旧变量 | 新变量 | 是否改值 |
|---|---|---|
| `--s0` | `--bg-1` | 否 |
| `--s1` | `--bg` | 否 |
| `--s2` `--s3` `--pop` | `--bg-2` | 否（三个抬升面收敛成一个，需要区分的用阴影 `--sh-*`） |
| `--ln` / `--ln-hi` | `--line` / `--line-strong` | 否 |
| `--t1` / `--t2` / `--t3` | `--text` / `--text-2` / `--text-3` | 否 |
| `--accent` + `--accent-soft` | 同名保留 | 否 |
| `--fig` / `--fig-soft` | `--danger` / `--danger-soft` | 否（改名：`fig` 是"玫瑰色"的色相名，语义是危险） |
| `--ok` | `--ok` + 新增 `--ok-soft` | 否 |
| **`--warn`** | `--warn` | **是**：亮色 `#b07b4f` → `#8f5f36`（3.5:1 → 5.3:1）；`--warn-soft` 随之 `rgba(176,123,79,.13)` → `rgba(143,95,54,.12)` |
| `--brand` / `--brand-active` | `--brand` | 否（clay 只做 presence；`--brand-active` 用 `filter: brightness(.94)` 代替） |
| `--hov` | `--hov` | 否 |
| `--bub` | `--bg-1` | 气泡底色并入沉降面（暖灰 `#f2f0ec` 取消，改用 `--bg-1`） |
| `--on-brand` | `--on-brand` | 否 |
| `--shadow-pop` | `--sh-3` | 否 |
| `--r-ctl` / `--r-card` / `--r-composer` | `--r-1` / `--r-2` / `--r-3` | 否（8 / 12 / 16，composer 从 14 → 16） |
| `--t-fast` / `--t-ui` / `--t-med` | `--dur-1` / `--dur-1` / `--dur-2` | 是：60ms → 120ms（60ms 太快，看不出过渡） |
| `--e` / `--e-pop` | `--ease` | 是：弹层回弹取消（`--e-pop` 的回弹在 reduced-motion 下也要关，统一一个 ease 更安全） |
| `--f-chrome` / `--f-serif` / `--f-mono` | `--f-sans` / `--f-serif` / `--f-mono` | 否 |
| `--sb-w` / `--rp-w` | `--w-side` / `--w-right` | 否（新增 `--w-thread:720px`） |

### 3.4 替换后必须消失的东西（grep 清单）

```text
font-size:\s*\d+\.\d+px        # 半像素字号，必须为 0
font-size:\s*\d+px             # 裸字号，必须为 0（一律 var(--fs-n)）
var\(--(s0|s1|s2|s3|pop|ln|ln-hi|t1|t2|t3|fig|fig-soft|bub|t-fast|t-ui|t-med|e-pop|r-ctl|r-card|r-composer|sb-w|rp-w|f-chrome)\)
                               # 旧变量名，必须为 0
outline:\s*none                # 除 tokens.css 里 :focus:not(:focus-visible) 那一处，必须为 0
#b07b4f                        # 旧 warn，必须为 0
```

---

## 4. 替换脚本（伪代码，下一轮直接用）

```js
// scripts/migrate-tokens.mjs —— 只在 <style> 区间内替换，dry-run 默认不写盘
import { readFileSync, writeFileSync, copyFileSync } from "node:fs";

const FILE = "workbench/public/v1/index.html";
const html = readFileSync(FILE, "utf8");
const open = html.indexOf("<style>"), close = html.indexOf("</style>");
const head = html.slice(0, open), css = html.slice(open, close), tail = html.slice(close);
let out = css;
const log = [];

// 1) 字号：精确整值表（不要用"就近取整"函数——14.5 该去 16 而不是 14）
const FONT = { "10": 1, "10.5": 1, "11": 1, "11.5": 1, "12": 1,
               "12.5": 2, "13": 2, "13.5": 3, "14": 3,
               "14.5": 4, "15": 4, "15.5": 4, "16": 4, "18": 5 };
for (const [px, n] of Object.entries(FONT)) {
  const re = new RegExp(`font-size:\\s*${px.replace(".", "\\.")}px`, "g");
  const hit = out.match(re)?.length || 0;
  out = out.replace(re, `font-size: var(--fs-${n})`);
  log.push(`font ${px}px -> --fs-${n}: ${hit}`);
}

// 2) 间距：只动 padding/margin/gap，不动 width/height/top/left
const SPACE = { 1: 1, 2: 1, 3: 1, 4: 1, 5: 2, 6: 2, 7: 2, 8: 2, 9: 3, 10: 3,
                11: 3, 12: 3, 14: 4, 16: 4, 18: 5, 20: 5, 24: 6, 32: 7, 34: 7 };
const PU = "(?:padding|padding-top|padding-right|padding-bottom|padding-left|" +
           "margin|margin-top|margin-right|margin-bottom|margin-left|gap|row-gap|column-gap)";
for (const [px, n] of Object.entries(SPACE)) {
  // 多值简写也要处理：padding: 6px 10px → padding: var(--sp-2) var(--sp-3)
  const re = new RegExp(`(${PU}:\\s*[^;{}]*?)\\b${px}px`, "g");
  let hit = 0;
  out = out.replace(re, (m, pre) => { hit++; return `${pre}var(--sp-${n})`; });
  log.push(`space ${px}px -> --sp-${n}: ${hit}`);
}

// 3) 变量改名（先长后短，避免 --s1 被 --s10 之类误伤；本仓没有 --s10，但仍按长度降序）
const RENAME = { "s0": "bg-1", "s1": "bg", "s2": "bg-2", "s3": "bg-2", "pop": "bg-2",
                 "ln-hi": "line-strong", "ln": "line",
                 "t1": "text", "t2": "text-2", "t3": "text-3",
                 "fig-soft": "danger-soft", "fig": "danger",
                 "bub": "bg-1", "t-fast": "dur-1", "t-ui": "dur-1", "t-med": "dur-2",
                 "e-pop": "ease", "e": "ease",
                 "r-ctl": "r-1", "r-card": "r-2", "r-composer": "r-3",
                 "sb-w": "w-side", "rp-w": "w-right", "f-chrome": "f-sans" };
for (const [from, to] of Object.entries(RENAME).sort((a, b) => b[0].length - a[0].length)) {
  const re = new RegExp(`--${from.replace(/-/g, "\\-")}\\b`, "g");
  const hit = out.match(re)?.length || 0;
  out = out.replace(re, `--${to}`);
  log.push(`var --${from} -> --${to}: ${hit}`);
}

console.log(log.join("\n"));
if (process.argv.includes("--write")) {
  copyFileSync(FILE, `${FILE}.bak.${Date.now()}`);
  writeFileSync(FILE, head + out + tail, "utf8");
  console.log("written; 接着跑 tokens.test.ts 与 §3.4 的 grep 清单");
}
```

**执行顺序**（顺序错了会互相踩）：

1. `tokens.css` 以 `<link rel="stylesheet" href="tokens.css">` 接在现有 `<style>` **之前**（token 先定义，旧样式引用时才有值）；
2. 跑脚本 **dry-run**，把 `log` 里的处数与 §3.1/§3.2 的表对上（对不上说明 HEAD 变了，先重跑盘点脚本）；
3. `--write` 落盘，备份文件留在原地，**不要提交**；
4. 跑 `node --test workbench/test`（含 `tokens.test.ts` 与快照）；
5. 跑 §3.4 的 5 条 grep，全部为 0 才算换装完成；
6. 删掉 `index.html` 里已迁进 `tokens.css` 的 `:root` / `[data-theme]` 两段（否则同一个变量定义两遍，调试时容易看错源头）。

---

## 5. 断言读数（`node --test workbench/test/tokens.test.ts`）

```text
✔ 字号只有 6 档（12/13/14/16/20/28），且没有半像素档
✔ 间距 7 档、全部 4 的倍数，且没有裸 px 间距
✔ --warn 在亮色下对比度 ≥ 4.5:1（旧值 #b07b4f 只有 3.53:1）
✔ 两套主题的正文色都 ≥ 4.5:1（--warn 也要过）
✔ --brand（clay）只做 presence，不做文字色
✔ prefers-reduced-motion 全关动画，骨架屏退化为静态块
✔ 骨架屏 .sk + shimmer 关键帧存在，且两套主题都有底色
✔ 唯一的焦点样式走 --accent，鼠标点击不出现焦点环
✔ 两套主题都定义了同一组语义色
✔ 圆角与阴影各 3 档，动效只有 2 档
ℹ tests 10 / pass 10 / fail 0
```

实测对比度（WCAG 相对亮度公式，脚本算的）：

| 组合 | 比值 | 判定 |
|---|---|---|
| `--warn #8f5f36` on `--bg #fcfcfb` | **5.30:1** | ✅（旧值 3.53:1） |
| `--warn-soft(#f0eae5)` 上的 `--text-3` | 4.90:1 | ✅ |
| `--text #0b0b0b` on `--bg` | 19.17:1 | ✅ |
| `--text-3 #67655d` on `--bg` | 5.69:1 | ✅ |
| `--ok #5f7a45` on `--bg` | 4.70:1 | ✅（最紧的一档，再暗就不合格，别调） |
| 暗色 `--danger #c46686` on `--bg #151515` | 4.86:1 | ✅（暗色里最紧的一档） |
| `--brand #d97757` on `--bg` | 3.07:1 | ⚠️ 只做 presence —— 断言里钉死了这条纪律 |

---

## 6. 不做的事

1. **不引入 CSS 框架 / Tailwind**。令牌是"配置"，不是要再叠一层构建。
2. **不做第 3、第 4 档字号**。6 档够用；不够就说明排版问题没解决，加档只是把问题挪走。
3. **不把 `--brand` 当文字色**（3.07:1）；clay 只表达"agent 在场"。
4. **不为兼容旧变量名留别名**（`--s1: var(--bg)` 这种）。要么换干净，要么不换——留别名等于两套并行。
5. **不做主题"自定义配色"**。双主题 + 单一语义表已经够；用户改色会破坏对比度断言。

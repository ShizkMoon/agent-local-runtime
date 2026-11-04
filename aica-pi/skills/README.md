# aica-pi skills

Pi 的技能库。一个 skill = 一个目录 + `SKILL.md`（frontmatter 给 `name`/`description`，正文给步骤）。

Pi 的加载是**渐进披露**：启动时只把每个 skill 的 `name` + `description` + 路径放进 system prompt，正文不加载；模型判断任务匹配后才去读 `SKILL.md`（pi `docs/skills.md:41-45`）。所以 `description` 要同时写清「做什么」和「什么时候用」——它是唯一的路由依据。

## 一览

| skill | 用途 | 什么时候会触发 |
|---|---|---|
| `desktop` | Windows 桌面 GUI 自动化（UIA 无障碍树，按 ref 点击/输入/截图） | 需要操作本机 GUI 程序时 |
| `code-review` | 标准 + 规格两轴审查改动，出带 `file:line` 的分级 finding | 提交前自审、审分支、reviewer 节点验收 |
| `test-first` | 最小 TDD：一个失败用例 → 最小实现 → 绿 → 重构 | 加新行为、修可复现 bug |
| `release-notes` | 从 git 历史生成中文发版说明，单列破坏性变更 | 发 tag / 写 CHANGELOG |
| `db-migrate` | 迁移安全顺序：备份→幂等 forward→rollback→副本演练→分步上线 | 改表结构、数据回填 |
| `ui-polish` | 界面打磨六项硬指标（间距/字号/对比度/焦点/三态/极值） | 前端改动收尾、审界面 PR |

每个 `SKILL.md` 固定四段：**适用**（何时用 / 何时不用）、**步骤**、**验收**、**反例**。

## 怎么被 daemon 挂载

`src/daemon.ts` 的 `launcher()` 按 `spec.skills` 逐项拼参数（`src/daemon.ts:377-378`）：

```
--no-skills ... --skill <AICA_PI>/skills/<name>
```

- 进程**永远带 `--no-skills`**：自动发现被关闭，worker 只能加载显式列出的 skill。
- `--skill` 后跟的是**目录路径**（不是 `SKILL.md`），Pi 支持文件或目录，且可重复（pi `docs/cli.md:200-203`）。`--no-skills` 只关掉发现，显式 `--skill` 仍然加载。
- 所以 spec 里写名字即可：`{"skills": ["code-review"]}` → `--skill .../aica-pi/skills/code-review`。

## 新加一个（3 步）

1. **建目录**：`aica-pi/skills/<kebab-case-name>/SKILL.md`。目录名与 frontmatter `name` 保持一致（Pi 不强校验，但保持一致才可移植）。
2. **写 frontmatter**：`name`（小写字母/数字/连字符，≤64 字符）+ `description`（一句话写清做什么 + 什么时候用，≤1024 字符）。**缺 description 或格式坏掉的 skill 会被静默丢弃**（pi `docs/skills.md:85`）。
3. **写正文四段**：适用 / 步骤（3–7 步）/ 验收 / 反例，正文中文短句，控制在 60 行内；然后在 spec 里加 `skills: ["<name>"]` 验证一次真拉起。

## 验证是否真被注入

跑一次 worker 后看节点 session 文件：Pi 会把首个请求的完整 system prompt 分段持久化，其中有一段 `skills`（pi `docs/session-format.md:80-84`）。

```powershell
Select-String -Path <node>\session\*.jsonl -Pattern 'code-review' -SimpleMatch
```

命中说明 `--skill` 生效。看不到就依次查：目录里是否有 `SKILL.md`、frontmatter 是否有 `description`、`spec.skills` 里的名字与目录名是否一致。

### 没有 API key 时怎么验（离线）

`--skill` 走的加载器就是 SDK 导出的 `loadSkills` / `formatSkillsForPrompt`（pi `dist/index.d.ts:23`），可以不起 worker 直接验：

```js
const { loadSkills, formatSkillsForPrompt } = await import(
  "file:///<npm-global>/@earendil-works/pi-coding-agent/dist/index.js")
const r = loadSkills({
  cwd: "<repo>", agentDir: "<home>/.pi/agent", includeDefaults: false,
  skillPaths: ["<repo>/aica-pi/skills/code-review"],   // 等价于一个 --skill 目录
})
console.log(r.diagnostics, formatSkillsForPrompt(r.skills, "read"))
```

输出里出现 `<name>code-review</name>` + `<location>…/SKILL.md</location>` 即通过；`diagnostics` 非空要逐条看（缺 `description` 会被丢弃并报 `description is required`）。

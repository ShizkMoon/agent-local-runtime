# workbench/shell — AICA 工作台窗口壳（MyGo）

[MyGo](https://github.com/egoist/mygo)（Go 单二进制 + 系统 WebView2）壳，替代
`workbench.cmd` 的 Edge `--app` 方案。壳很薄：只管窗口与 node 桥的生命周期，
`/api/*`、SSE、daemon 拉起全在 `../server.ts`。

## 行为

启动时（`main.go`）：

1. 单实例：第二个进程拿到锁失败 → 把参数交给已运行的实例（`OnSecondInstance`：
   `Show/Restore/Focus`）后直接退出，不会开出第二个窗口；
2. `GET http://127.0.0.1:4399/api/daemon` 返回 200 → 复用已在跑的桥，跳过 spawn；
3. 否则 `spawn node <repo>/workbench/server.ts`，env 透传并补 `WB_PORT=4399`、
   `AICA_STATE`（缺省 `%LOCALAPPDATA%\aica\state`），输出落
   `<AICA_STATE>\workbench-server.log`，`CREATE_NO_WINDOW` 保证不弹控制台；
4. 轮询 `GET /api/v1/view` 直到 200（每 250ms，15s 超时 → 原生报错对话框后退出）；
5. 开 1440×900 窗口「AICA 工作台」加载 `/v1/index.html`；关窗口 = 收起到托盘，
   托盘「退出」才真正退出；退出时只杀自己拉起的 node——复用的不动，桥内 detached
   的 ar daemon 也不管。
6. 窗口位置/大小/最大化记在 `<AICA_STATE>\window.json`，下次启动恢复；显示器拔掉
   导致原坐标不可见时，MyGo 会夹到主屏工作区并居中，不会把窗口丢到屏幕外。
7. 全局热键 `Ctrl+Alt+A` 显隐窗口；拖文件进窗口会在 composer 插入 `@绝对路径`；
   磁盘代码比运行中的桥新时，窗口底部弹一次「代码已更新，重启生效」。
8. 托盘红点跟随 `/api/approvals` 的待裁决数（30s 轮询 + 窗口聚焦即时刷新）；
   `Ctrl+/` 打开快捷键速查；壳自己拉起的桥崩了会按 1s/2s/4s 退避重启，
   3 次失败落到本地错误页（重试 / 打开日志）。

壳自己的日志落 `<AICA_STATE>\workbench-shell.log`（GUI 子系统没有 stderr，
启动失败只能从这里查；超过 1MB 自动清空重写）。

`server.ts` 定位顺序：

1. 环境变量 `AICA_WB_SERVER`；
2. `%LOCALAPPDATA%\aica\shell.json` 的 `{"server": "..."}`（装到 Program Files 这类
   远离源码树的位置时用它指路）；
3. 源码相对（`shell/../server.ts`，`go run` 与源码树内构建可用）；
4. 可执行文件所在目录逐级上溯 ≤8 层，找 `<dir>/workbench/server.ts` 或
   `<dir>/server.ts`，要求同级有 `public/` 或 `src/` 作为标记——覆盖
   `dist/windows-amd64/` 这类打包位置；
5. cwd 逐级上溯 ≤8 层，同上。

## 托盘与热键

### 窗口记忆 `window.json`

`<AICA_STATE>\window.json`（缺省 `%LOCALAPPDATA%\aica\state\window.json`），
就是 `mygo.WindowState` 的 JSON：

```json
{ "x": 200, "y": 120, "width": 1440, "height": 900, "maximized": false }
```

- 壳用 `mygo.App.SetWindowStateStore` 替换了 MyGo 默认的 `window-state.json`，
  写入走「临时文件 + rename」，窗口移动/缩放后 300ms 防抖捕获，关闭/退出时落盘；
- 启动时 MyGo 的 `restoreWindowState` 负责恢复；坐标不在任何显示器工作区、
  或尺寸大于工作区时，它会夹到主屏工作区并居中（多显示器拔掉后的兜底），
  所以**不会恢复到屏幕外**；
- 只记主窗口（StateKey `main`）；改 `AICA_STATE` 即换一套记忆。

### 托盘（`resources/icon.png`）

- 菜单三项：**显示工作台** / **新建任务**（显示窗口并聚焦 composer）/**退出**；
- 点窗口关闭按钮 = `OnClose` 里 `PreventDefault` + `Hide`，进程留在托盘；
  托盘「退出」才会 `Quit`（并把 `nodeCmd` 指向的桥杀掉，复用的桥不动）；
- 首次收起发一条系统通知说明「仍在运行 + 热键」，标记文件
  `<AICA_STATE>\tray-hint-shown` 保证只提示一次；
- MyGo 托盘只收 PNG 字节，所以运行时用 `resources/icon.png`（`go:embed` 内嵌）；
  `resources/icon.ico` 继续给 `mygo.json` 打包 exe 图标用。
- **红点徽标**：`GET /api/approvals` 的 `count` > 0 时切换到运行时生成的
  「右上角红点」PNG，tooltip 变「AICA 工作台 · 待你 N」；归零切回原图。
  轮询 30s，窗口 `OnShow/OnFocus`、热键唤出、桥重启成功都会立即刷一次；
  切图标只在数量变化时做（`badge.go`）。

### 全局热键 `Ctrl+Alt+A`

- `mygo.GlobalShortcut.Register("CmdOrCtrl+Alt+A", ...)`：Windows 上就是
  `RegisterHotKey` + 应用消息循环（`WM_HOTKEY`），不是壳自己开的窗口钩子；
- 行为：窗口在前台 → 收起；否则显示/还原并聚焦；
- 注册失败（被别的程序占用）只在 `workbench-shell.log` 记一行，**不阻断启动**，
  窗口/tray 照常可用；退出时 `UnregisterAll`。

### 拖文件 → composer 插入 `@path`

不改 `public/v1/index.html`，由 `WindowOptions.Page.PreloadScript` 注入：

1. `dragenter/dragover/drop` 一律 `preventDefault`，WebView2 不会把窗口导航到
   被拖入的 `file://` 文件；`OnWillNavigate` 再兜一层，`file:`/`data:`/`blob:`
   导航一律拦掉，外链交给系统浏览器；
2. MyGo 在原生 surface 层接管文件拖放，`OnFileDrop` 拿到绝对路径；
   壳把 `http://127.0.0.1:4399` 放进 `PageOptions.TrustedOrigins`，页面因此能收到
   `mygo:file-drop` 事件，preload 监听后插入到 `#cText`；
3. 插入格式：普通路径 `@C:\a\b.txt`，含空格/引号 `@"C:\sp ace\c.txt"`；
   用 `setRangeText` 等价逻辑改 `value` 并派发 `input`，页面的 autogrow/发送
   逻辑能感知；
4. 页面将来若自己处理 DOM `drop`，置 `window.__aicaHandlesDrop = true` 即可让
   preload 不再重复插入（也可直接调 `window.__aicaInsertPaths(paths)`）。

### Ctrl+/ 快捷键面板

preload 注入，不改 `public/v1/index.html`：`Ctrl+/`（含 `?`，兼容不同键盘布局）
打开居中 overlay，列出 Ctrl+K 命令面板、Ctrl+, 设置、Ctrl+/ 本面板、J/K 切任务、
A 批准、R 拒绝、/ 聚焦、Esc 关层、Ctrl+Alt+A 全局唤出；`Esc` 或再按一次关闭。
面板用静态 HTML 生成，不读页面状态、不拦截其他按键。

### 桥崩溃自愈

只监控**壳自己 spawn 的** node（复用别人已在跑的桥时没有子进程可等，README 前提里
说明）。`superviseBridge` 阻塞在 `cmd.Wait()`：

1. 进程退出且不是退出流程 → 按 **1s → 2s → 4s** 退避最多重启 3 次，
   每次 `startServer` + `waitReady(15s)`；失败会先 `stopServer` 清掉半死进程；
2. 重启成功 → `Page.LoadURL(viewURL)` 刷新 WebView2，并立即刷新托盘徽标；
3. 3 次都失败 → 本地错误页（`127.0.0.1` 随机端口，`bridge.go`）：
   展示最近错误与两份日志路径，按钮「重试」（再走 3 次退避）「打开日志」
   （`Shell.OpenPath` 打开 `workbench-shell.log`）。错误页只在 loopback 提供服务，
   `OnWillNavigate` 把它加入白名单。

日志关键字（`workbench-shell.log`）：`桥进程退出`、`桥重启 n/3`、`桥重启成功`、
`桥自愈失败`、`错误页服务: http://127.0.0.1:<port>/`。

### 更新提示（静默不重启）

启动时读一次 `GET /api/health`（`version` + `uptime_s`），与仓库根
`package.json` 的 `version`、以及 `workbench/server.ts` / `docs/prd-workbench-v3.md`
的 mtime 比较：磁盘版本更高，或代码 mtime 晚于桥的启动时间，就在页面底部渲染
一枚「代码已更新，重启工作台后生效」提示（15s 自动消失，可点掉）。

- 只提示，**绝不自动重启**；
- 同一「磁盘版本 + mtime」只提示一次，记录在 `<AICA_STATE>\update-notice.json`；
- 拿不到 `/api/health` 或推不出仓库根时静默跳过，不影响启动。

### 状态文件一览

| 文件 | 用途 |
| --- | --- |
| `window.json` | 主窗口位置/大小/最大化 |
| `tray-hint-shown` | 首次收起托盘提示的一次性标记 |
| `update-notice.json` | 已提示过的磁盘版本 + 代码 mtime |
| `workbench-shell.log` | 壳日志（含托盘/热键/更新判定结果） |
| `workbench-server.log` | 壳拉起的 node 桥输出 |

### 自检

```sh
cd workbench/shell
go build ./...        # 编译
go test ./...         # window.json 往返/损坏兜底、preload 在 node DOM 桩里验证
                      # 拖拽 preventDefault、@path 插入、更新提示渲染
```

preload 的 node 行为测试需要 `PATH` 里有 node；没有就自动 skip。

## 前提

- Go ≥ 1.27（`winget install GoLang.Go`）
- node ≥ 26（type stripping 直跑 `server.ts`），在 `PATH` 里
- Windows 11 自带 WebView2；Windows 10 需装 WebView2 Runtime
- pi CLI 可选（工作台派发任务时才用到，壳本身不依赖）
- 不需要 Bun：前端由 node 桥托管（`public/v1/`），不走 MyGo 的 Vite 前端链

## 构建 / 运行

```sh
cd workbench/shell

# 日常使用：测过的 GUI 二进制（无控制台窗口），双击 aica-workbench.exe 或桌面快捷方式
go build -ldflags "-H windowsgui -s -w" -o aica-workbench.exe .

# 正式打包（MyGo CLI 作为 go tool 已 pin 在 go.mod；产出 dist/windows-amd64/ 下的
# AICA 工作台.exe + 安装包，走 mygo.json 的名称/图标/标识，图标来自 resources/icon.png）
go tool mygo build

# 开发：go run 会带一个控制台（编译期临时二进制是 console 子系统），只适合看日志
go run .
```

桌面 / 开始菜单快捷方式指向 `dist/windows-amd64/AICA 工作台.exe`（图标已内嵌）；
重装系统后重建：

```powershell
$ws = New-Object -ComObject WScript.Shell
$lnk = $ws.CreateShortcut("$env:USERPROFILE\Desktop\AICA 工作台.lnk")
$lnk.TargetPath      = "$PWD\dist\windows-amd64\AICA 工作台.exe"
$lnk.WorkingDirectory = "$PWD\dist\windows-amd64"
$lnk.IconLocation     = "$PWD\dist\windows-amd64\AICA 工作台.exe,0"
$lnk.Save()
```

`go tool mygo dev` 亦可：改 .go 自动重建重启。

> 只跑一个构建：MyGo 打包版按 `mygo.json` 的 `identifier` 加锁、`go build` 的裸二进制
> 只按应用名加锁，两者算不同实例；同时开会抢同一个 WebView2 用户数据目录，第二个窗口
> 会以 `HRESULT 0x8007139f` 失败。日常用 `dist/windows-amd64/` 里的那个。

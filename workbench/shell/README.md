# workbench/shell — AICA 工作台窗口壳（MyGo）

[MyGo](https://github.com/egoist/mygo)（Go 单二进制 + 系统 WebView2）壳，替代
`workbench.cmd` 的 Edge `--app` 方案。壳很薄：只管窗口与 node 桥的生命周期，
`/api/*`、SSE、daemon 拉起全在 `../server.ts`。

## 行为

启动时（`main.go`）：

1. `GET http://127.0.0.1:4399/api/daemon` 返回 200 → 复用已在跑的桥，跳过 spawn；
2. 否则 `spawn node <repo>/workbench/server.ts`，env 透传并补 `WB_PORT=4399`、
   `AICA_STATE`（缺省 `%LOCALAPPDATA%\aica\state`），输出落
   `<AICA_STATE>\workbench-server.log`，`CREATE_NO_WINDOW` 不弹控制台；
3. 轮询 `GET /api/v1/view` 直到 200（每 250ms，15s 超时 → 原生报错对话框后退出）；
4. 开 1440×900 窗口「AICA 工作台」加载 `/v1/index.html`；退出（窗口全关/Quit）
   只杀自己拉起的 node——复用的不动，桥内 detached 的 ar daemon 也不管。

`server.ts` 定位顺序：环境变量 `AICA_WB_SERVER` → 源码相对（`shell/../server.ts`，
`go run` 可用）→ 可执行文件相对（`../server.ts`、`../../workbench/server.ts`、
`../../server.ts`）→ cwd 的 `workbench/server.ts`。

## 前提

- Go ≥ 1.27（`winget install GoLang.Go`）
- node ≥ 26（type stripping 直跑 `server.ts`），在 `PATH` 里
- Windows 11 自带 WebView2；Windows 10 需装 WebView2 Runtime
- pi CLI 可选（工作台派发任务时才用到，壳本身不依赖）
- 不需要 Bun：前端由 node 桥托管（`public/v1/`），不走 MyGo 的 Vite 前端链

## 构建 / 运行

```sh
cd workbench/shell

# 开发：直接跑（会带一个控制台窗口，方便看 [aica-shell] 日志）
go run .

# 简单二进制（GUI 子系统，无控制台）
go build -ldflags "-H windowsgui" -o aica-workbench.exe .

# 正式打包（MyGo CLI 作为 go tool 已 pin 在 go.mod；产出 build/windows-amd64/ 下
# 的 AICA 工作台.exe + 安装包，走 mygo.json 的名称/图标/标识）
go tool mygo build
```

`go tool mygo dev` 亦可：改 .go 自动重建重启。

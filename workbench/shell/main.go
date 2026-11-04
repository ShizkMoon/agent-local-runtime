// aica workbench shell — MyGo 窗口壳
//
// 单窗口打开 http://127.0.0.1:4399/v1/index.html：
//  1. 探测 GET /api/daemon，200 则复用已在跑的桥（workbench/server.ts）；
//  2. 未跑则 spawn `node <repo>/workbench/server.ts`（WB_PORT=4399，env 透传）；
//  3. 轮询 GET /api/v1/view 直到 200（15s 超时 → 原生报错对话框）；
//  4. 开窗口「AICA 工作台」，恢复上次位置/大小（window.json），越界则回主屏居中；
//  5. 托盘常驻（显示/新建任务/退出），关闭窗口 = 收起到托盘，Ctrl+Alt+A 全局显隐；
//  6. 退出时只杀自己拉起的 node。
//
// 桥本身（daemon 拉起、/api/*、SSE）全在 server.ts，壳只管窗口、托盘与 node 生命周期。
package main

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"github.com/egoist/mygo"
)

const (
	appTitle  = "AICA 工作台"
	baseURL   = "http://127.0.0.1:4399"
	viewURL   = baseURL + "/v1/index.html"
	probeURL  = baseURL + "/api/daemon"
	readyURL  = baseURL + "/api/v1/view"
	healthURL = baseURL + "/api/health"

	readyTimeout = 15 * time.Second
	pollEvery    = 250 * time.Millisecond

	// 主窗口在 MyGo WindowStateStore 里的键；window.json 只存它一个。
	mainStateKey = "main"
	// 全局热键：Windows 上 CmdOrCtrl 解析为 Ctrl，即 Ctrl+Alt+A。
	hotkeyAccel = "CmdOrCtrl+Alt+A"
)

//go:embed resources/icon.png
var trayIconPNG []byte

var client = &http.Client{Timeout: 1500 * time.Millisecond}

// nodeCmd 是本进程拉起的桥；为 nil 说明复用了已有 server，退出时不动它。
var nodeCmd *exec.Cmd

// mainWin 是唯一的主窗口；第二次启动时用它把已有窗口提到前台。
var mainWin *mygo.Window

// tray 必须保住引用，否则 GC 后图标会消失。
var tray *mygo.Tray

// quitting 区分「收起到托盘」与「真的退出」。
var quitting atomic.Bool

func main() {
	log.SetPrefix("[aica-shell] ")
	// GUI 子系统没有 stderr，日志必须落文件，否则启动失败时无从查起。
	if f := openLog(); f != nil {
		defer f.Close()
		log.SetOutput(io.MultiWriter(f, os.Stderr))
	}

	mygo.App.SetName(appTitle)

	// 窗口记忆：放在 %LOCALAPPDATA%\aica\state\window.json（或 AICA_STATE），
	// 由 mygo 在窗口移动/缩放/关闭/退出时回调。必须在第一个带 StateKey 的窗口前设置。
	state := ensureStateDir()
	if state != "" {
		mygo.App.SetWindowStateStore(&windowStore{path: filepath.Join(state, "window.json")})
	}

	// 单实例：第二次启动不再开第二个窗口，而是唤醒已运行的那个（参数交给它后退出）。
	if !mygo.App.RequestSingleInstanceLock() {
		return
	}
	mygo.App.OnSecondInstance(func(args []string, workingDir string) {
		showWindow()
	})

	mygo.App.WhenReady(func() {
		if serverUp() {
			log.Printf("复用已有 workbench 桥 %s", baseURL)
		} else if err := startServer(); err != nil {
			fail("无法启动 workbench 桥", err)
			return
		}
		if err := waitReady(readyTimeout); err != nil {
			fail("workbench 桥未就绪", err)
			return
		}

		// 错误页服务要先起：窗口的导航白名单里要放行它。
		startErrorServer()

		// 代码是否比运行中的桥新：只决定底部一次性提示，不自动重启。
		notice := detectUpdate()

		mainWin = mygo.NewWindow(mygo.WindowOptions{
			Title:     appTitle,
			URL:       viewURL,
			Width:     1440,
			Height:    900,
			MinWidth:  960,
			MinHeight: 600,
			// StateKey 打开 MyGo 的窗口记忆：它负责捕获、边界检查与
			// 越界时的「主屏居中」回落（restoreWindowState）。
			StateKey: mainStateKey,
			Page: mygo.PageOptions{
				// 注入拖拽 @path、#new 聚焦与更新提示；页面无需改动。
				PreloadScript: buildPreload(notice),
				// mygo:file-drop 事件只发给受信任的源；信任本机桥。
				TrustedOrigins: []string{baseURL},
			},
		})
		wireWindow(mainWin)
		createTray()
		registerHotkey()
		startApprovalsWatch()
		if currentBridge() != nil {
			go superviseBridge()
			log.Printf("桥自愈监控已启动（本进程拉起的 bridge）")
		} else {
			log.Printf("复用的外部桥不归本进程监控（没有子进程可等）")
		}
	})

	// App.Quit / 托盘退出都会走到这里；只回收自己拉起的 node。
	mygo.App.OnWillQuit(func(*mygo.QuitEvent) {
		mygo.GlobalShortcut.UnregisterAll()
		stopServer()
	})

	if err := mygo.App.Run(); err != nil {
		stopServer()
		log.Fatal(err)
	}
}

// wireWindow 挂窗口级行为：关闭→收起、拖放日志、防 file:// 导航。
func wireWindow(win *mygo.Window) {
	if win == nil {
		return
	}
	win.OnClose(func(e *mygo.CloseEvent) {
		if quitting.Load() {
			return // 托盘「退出」：放行真正关闭
		}
		e.PreventDefault()
		win.Hide()
		if markOnce("tray-hint-shown") {
			notify(
				"AICA 工作台仍在运行",
				"已收起到托盘。Ctrl+Alt+A 可随时唤出，托盘菜单可退出。",
			)
		}
	})

	// 窗口重新出现/获得焦点时立刻刷新待裁决徽标，不等 30s 轮询。
	win.OnShow(requestApprovalRefresh)
	win.OnFocus(requestApprovalRefresh)

	// 页面自己拿不到 WebView2 里 File 的绝对路径；MyGo 的原生拖放事件有。
	// preload 已订阅 mygo:file-drop 做插入，这里只留诊断日志。
	win.OnFileDrop(func(e *mygo.FileDropEvent) {
		log.Printf("文件拖入 %d 项（页面侧以 @path 插入）: %v", len(e.Paths), e.Paths)
	})

	// 拖入文件时 WebView2 的默认动作是导航到 file://。原生 drop 已经在
	// surface 层被 MyGo 接管，这里再兜一层：任何非本应用的导航都拦下。
	if page := win.Page(); page != nil {
		page.OnWillNavigate(func(e *mygo.NavigateEvent) {
			u, err := url.Parse(e.URL)
			if err != nil {
				e.PreventDefault()
				return
			}
			switch {
			case strings.HasPrefix(e.URL, viewURL), e.URL == "about:blank":
				return // 本应用页面（含 #new 之类的 hash）
			case errorBase != "" && strings.HasPrefix(e.URL, errorBase):
				return // 自愈失败时的本地错误页
			case u.Scheme == "file", u.Scheme == "data", u.Scheme == "blob":
				e.PreventDefault()
				log.Printf("已拦截拖入/点击的本地导航: %s", e.URL)
			case u.Scheme == "http" || u.Scheme == "https":
				// 外链交给系统浏览器，不在工作台里开新页。
				e.PreventDefault()
				link := e.URL
				go func() { _ = mygo.Shell.OpenExternal(link) }()
			default:
				e.PreventDefault()
			}
		})
	}
}

// createTray 建托盘图标与三项菜单。失败只记日志：没有托盘仍然能正常用窗口。
func createTray() {
	if len(trayIconPNG) == 0 {
		log.Printf("托盘图标资源为空，跳过托盘")
		return
	}
	menu := mygo.NewMenu([]*mygo.MenuItem{
		{Label: "显示工作台", Click: func(*mygo.MenuItem, *mygo.Window) { showWindow() }},
		{Label: "新建任务", Click: func(*mygo.MenuItem, *mygo.Window) {
			showWindow()
			focusNewTask()
		}},
		mygo.Separator(),
		{Label: "退出", Click: func(*mygo.MenuItem, *mygo.Window) { quitApp() }},
	})
	t, err := mygo.NewTray(mygo.TrayOptions{
		ID:      "aica-workbench",
		Icon:    trayIconPNG,
		ToolTip: appTitle + "（Ctrl+Alt+A 显隐）",
		Menu:    menu,
	})
	if err != nil {
		log.Printf("托盘创建失败（不影响窗口）: %v", err)
		return
	}
	tray = t
	log.Printf("托盘已创建：显示工作台 / 新建任务 / 退出")
}

// registerHotkey 注册 Ctrl+Alt+A；失败只记日志，不阻断启动。
func registerHotkey() {
	if err := mygo.GlobalShortcut.Register(hotkeyAccel, toggleWindow); err != nil {
		log.Printf("全局热键 %s 注册失败（继续运行）: %v", hotkeyAccel, err)
		return
	}
	log.Printf("全局热键已注册: %s", hotkeyAccel)
}

// showWindow 把窗口从托盘/最小化恢复并聚焦。
func showWindow() {
	if mainWin == nil {
		return
	}
	if mainWin.IsMinimized() {
		mainWin.Restore()
	}
	if !mainWin.IsVisible() {
		mainWin.Show()
	}
	mainWin.Focus()
	requestApprovalRefresh() // 回到前台立刻刷新一次待裁决徽标
}

// toggleWindow 是热键行为：已在前台 → 收起；否则显示并聚焦。
func toggleWindow() {
	if mainWin == nil {
		return
	}
	if mainWin.IsVisible() && mainWin.IsFocused() {
		mainWin.Hide()
		return
	}
	showWindow()
}

// focusNewTask 让页面聚焦 composer。#new=<ts> 只改 hash，不重载页面；
// preload 监听 hashchange（以及带 hash 的首屏）后执行 focus。
func focusNewTask() {
	if mainWin == nil {
		return
	}
	page := mainWin.Page()
	if page == nil {
		return
	}
	target := viewURL + "#new=" + strconv.FormatInt(time.Now().UnixMilli(), 10)
	if err := page.LoadURL(target); err != nil {
		log.Printf("新建任务：聚焦 composer 失败: %v", err)
	}
}

// quitApp 是托盘的「退出」：标记后放行 OnClose，再走正常退出流程。
func quitApp() {
	quitting.Store(true)
	if tray != nil {
		tray.Destroy()
		tray = nil
	}
	mygo.App.Quit()
}

// notify 发一条系统通知；失败只记日志（托盘气泡能力因系统而异）。
func notify(title, body string) {
	n := mygo.NewNotification(mygo.NotificationOptions{Title: title, Body: body})
	if err := n.Show(); err != nil {
		log.Printf("通知未送达（%s）：%v", title, err)
	}
}

// ---------------------------------------------------------------- 更新提示

type healthInfo struct {
	Version string `json:"version"`
	UptimeS int64  `json:"uptime_s"`
}

// fetchHealth 读一次 /api/health；失败返回 ok=false（壳照常启动）。
func fetchHealth() (healthInfo, bool) {
	var h healthInfo
	res, err := client.Get(healthURL)
	if err != nil {
		return h, false
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return h, false
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&h); err != nil {
		return h, false
	}
	return h, h.Version != ""
}

// repoRoot 定位仓库根：AICA_REPO_ROOT 优先，否则由 server.ts 位置推出。
func repoRoot() string {
	if root := os.Getenv("AICA_REPO_ROOT"); root != "" {
		if st, err := os.Stat(root); err == nil && st.IsDir() {
			return root
		}
	}
	server, err := serverPath()
	if err != nil {
		return ""
	}
	dir := filepath.Dir(server) // <root>/workbench
	if filepath.Base(dir) == "workbench" {
		return filepath.Dir(dir)
	}
	return dir
}

// diskVersion 读仓库根的 package.json version。
func diskVersion(root string) string {
	raw, err := os.ReadFile(filepath.Join(root, "package.json"))
	if err != nil {
		return ""
	}
	var pkg struct {
		Version string `json:"version"`
	}
	if json.Unmarshal(raw, &pkg) != nil {
		return ""
	}
	return pkg.Version
}

// codeMTime 取「运行时代码」的最新修改时间：server.ts 与 v3 PRD（若在）。
func codeMTime(root string) time.Time {
	var latest time.Time
	for _, rel := range []string{
		filepath.Join("workbench", "server.ts"),
		filepath.Join("docs", "prd-workbench-v3.md"),
	} {
		if st, err := os.Stat(filepath.Join(root, rel)); err == nil && st.ModTime().After(latest) {
			latest = st.ModTime()
		}
	}
	return latest
}

// semverNewer 粗比较点分数字版本；任何一段不是数字就按字符串比较。
func semverNewer(candidate, running string) bool {
	if candidate == "" || running == "" || candidate == running {
		return false
	}
	c, r := strings.Split(candidate, "."), strings.Split(running, ".")
	for i := 0; i < len(c) || i < len(r); i++ {
		var ci, ri int
		if i < len(c) {
			ci, _ = strconv.Atoi(c[i])
		}
		if i < len(r) {
			ri, _ = strconv.Atoi(r[i])
		}
		if ci != ri {
			return ci > ri
		}
	}
	return candidate > running
}

// detectUpdate 判定「磁盘代码比运行中的桥新」，且同一版本+时间只提示一次。
// 判据：磁盘 package.json 版本更高，或 server.ts/PRD 的 mtime 晚于桥启动时间。
func detectUpdate() *updateNotice {
	h, ok := fetchHealth()
	if !ok {
		return nil
	}
	root := repoRoot()
	if root == "" {
		return nil
	}
	disk := diskVersion(root)
	if disk == "" {
		disk = h.Version
	}
	mod := codeMTime(root)
	startedAt := time.Now().Add(-time.Duration(h.UptimeS) * time.Second)

	newerVersion := semverNewer(disk, h.Version)
	newerCode := !mod.IsZero() && mod.After(startedAt.Add(2*time.Second))
	if !newerVersion && !newerCode {
		return nil
	}

	// 一次性：同一 disk 版本 + 同一 mtime 只提示一次。
	state := ensureStateDir()
	if state != "" {
		recPath := filepath.Join(state, "update-notice.json")
		rec := loadUpdateRecord(recPath)
		if rec.Disk == disk && rec.ModUnix == mod.Unix() {
			return nil
		}
		saveUpdateRecord(recPath, updateRecord{Disk: disk, ModUnix: mod.Unix()})
	}
	log.Printf("检测到代码更新：运行 %s，磁盘 %s，代码时间 %s", h.Version, disk, mod.Format(time.RFC3339))
	return &updateNotice{Running: h.Version, Disk: disk}
}

// openLog 打开 <state>/workbench-shell.log（超过 1MB 先清空）；打不开就只写 stderr。
func openLog() *os.File {
	path := shellLogPath()
	if path == "" {
		return nil
	}
	flags := os.O_APPEND | os.O_CREATE | os.O_WRONLY
	if st, err := os.Stat(path); err == nil && st.Size() > 1<<20 {
		flags = os.O_TRUNC | os.O_CREATE | os.O_WRONLY
	}
	f, err := os.OpenFile(path, flags, 0o644)
	if err != nil {
		return nil
	}
	return f
}

// fail 报错并退出：原生对话框（窗口尚未创建，WebView 不可用）。
func fail(what string, err error) {
	log.Printf("%s: %v", what, err)
	stopServer()
	mygo.Dialog.Error(appTitle, fmt.Sprintf("%s\n\n%v", what, err))
	mygo.App.Exit(1)
}

// serverUp：GET /api/daemon 返回 200 即已有桥在跑（重复启动安全）。
func serverUp() bool {
	res, err := client.Get(probeURL)
	if err != nil {
		return false
	}
	res.Body.Close()
	return res.StatusCode == http.StatusOK
}

// waitReady 轮询 GET /api/v1/view 直到 200 或超时。
func waitReady(timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for {
		res, err := client.Get(readyURL)
		if err == nil {
			res.Body.Close()
			if res.StatusCode == http.StatusOK {
				return nil
			}
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("GET %s 在 %s 内未返回 200", readyURL, timeout)
		}
		time.Sleep(pollEvery)
	}
}

// serverPath 定位 <repo>/workbench/server.ts。候选按序：
//  1. 环境变量 AICA_WB_SERVER（显式覆盖）；
//  2. %LOCALAPPDATA%\aica\shell.json 的 {"server": "..."}（装机到 Program Files 时显式指路）；
//  3. 源码位置（runtime.Caller）：shell/../server.ts —— go run 与源码树内构建均有效；
//  4. 可执行文件所在目录逐级上溯（≤8 层），找 <dir>/workbench/server.ts 或 <dir>/server.ts，
//     且同级要有 public/ 或 src/ 作为标记 —— 覆盖 shell/dist/windows-amd64/ 这类打包位置；
//  5. 当前目录逐级上溯（≤8 层），同上（从仓库根或任意子目录启动都行）。
func serverPath() (string, error) {
	var explicit []string
	if p := os.Getenv("AICA_WB_SERVER"); p != "" {
		explicit = append(explicit, p)
	}
	if p := configServer(); p != "" {
		explicit = append(explicit, p)
	}
	if _, file, _, ok := runtime.Caller(0); ok {
		explicit = append(explicit, filepath.Join(filepath.Dir(file), "..", "server.ts"))
	}
	for _, c := range explicit {
		if abs, err := filepath.Abs(c); err == nil {
			if st, err := os.Stat(abs); err == nil && !st.IsDir() {
				return abs, nil
			}
		}
	}

	var discovered []string
	if exe, err := os.Executable(); err == nil {
		discovered = append(discovered, ancestors(filepath.Dir(exe))...)
	}
	if wd, err := os.Getwd(); err == nil {
		discovered = append(discovered, ancestors(wd)...)
	}
	for _, c := range discovered {
		if st, err := os.Stat(c); err == nil && !st.IsDir() && looksLikeWorkbench(c) {
			return c, nil
		}
	}
	return "", fmt.Errorf("找不到 server.ts（试过 %v）；可设 AICA_WB_SERVER 或在 %%LOCALAPPDATA%%\\aica\\shell.json 写 {\"server\": \"...\"}", append(explicit, discovered...))
}

// ancestors 返回 dir 及其上溯各级目录下的 workbench/server.ts 与 server.ts。
func ancestors(dir string) []string {
	out := make([]string, 0, 16)
	for i := 0; i < 8; i++ {
		out = append(out,
			filepath.Join(dir, "workbench", "server.ts"),
			filepath.Join(dir, "server.ts"),
		)
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	return out
}

// looksLikeWorkbench：server.ts 旁边有 public/ 或 src/ 才算工作台桥，避免误认同名文件。
func looksLikeWorkbench(serverTS string) bool {
	dir := filepath.Dir(serverTS)
	for _, marker := range []string{"public", "src"} {
		if st, err := os.Stat(filepath.Join(dir, marker)); err == nil && st.IsDir() {
			return true
		}
	}
	return false
}

// configServer 读 %LOCALAPPDATA%\aica\shell.json 的 server 字段；没有就返回空。
func configServer() string {
	base := os.Getenv("LOCALAPPDATA")
	if base == "" {
		return ""
	}
	raw, err := os.ReadFile(filepath.Join(base, "aica", "shell.json"))
	if err != nil {
		return ""
	}
	var cfg struct {
		Server string `json:"server"`
	}
	if json.Unmarshal(raw, &cfg) != nil {
		return ""
	}
	return cfg.Server
}

// startServer 拉起 `node <repo>/workbench/server.ts`，env 透传并补 WB_PORT/AICA_STATE，
// 输出落 <state>/workbench-server.log。hideConsole（spawn_windows.go）保证无控制台窗口。
func startServer() error {
	server, err := serverPath()
	if err != nil {
		return err
	}
	node, err := exec.LookPath("node")
	if err != nil {
		return fmt.Errorf("PATH 中没有 node（需要 node ≥ 26 直接跑 .ts）: %w", err)
	}

	env := os.Environ()
	if os.Getenv("WB_PORT") == "" {
		env = append(env, "WB_PORT=4399")
	}
	state := os.Getenv("AICA_STATE")
	if state == "" {
		state = filepath.Join(os.Getenv("LOCALAPPDATA"), "aica", "state")
		env = append(env, "AICA_STATE="+state)
	}

	// AICA_REPO_ROOT 让页面/桥知道源码根；更新提示与打包定位都靠它。
	if os.Getenv("AICA_REPO_ROOT") == "" {
		root := filepath.Dir(filepath.Dir(server))
		if filepath.Base(filepath.Dir(server)) != "workbench" {
			root = filepath.Dir(server)
		}
		env = append(env, "AICA_REPO_ROOT="+root)
	}

	cmd := exec.Command(node, server)
	cmd.Env = env
	hideConsole(cmd)

	if err := os.MkdirAll(state, 0o755); err == nil {
		if f, err := os.OpenFile(filepath.Join(state, "workbench-server.log"),
			os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644); err == nil {
			cmd.Stdout, cmd.Stderr = f, f
		}
	}

	if err := cmd.Start(); err != nil {
		setBridge(nil)
		return fmt.Errorf("spawn node %s: %w", server, err)
	}
	setBridge(cmd)
	log.Printf("拉起 workbench 桥 pid=%d  %s %s", cmd.Process.Pid, node, server)
	return nil
}

// stopServer 只杀自己拉起的 node（Process.Kill ≈ TerminateProcess）；
// 桥内 detached 的 ar daemon 不属于它，留给 server.ts 的进程表去重管。
func stopServer() {
	bridgeMu.Lock()
	cmd := nodeCmd
	if nodeCmd == cmd {
		nodeCmd = nil
	}
	bridgeMu.Unlock()
	if cmd == nil || cmd.Process == nil {
		return
	}
	if cmd.ProcessState == nil { // 已退出过的不再杀
		if err := cmd.Process.Kill(); err == nil {
			log.Printf("已回收 workbench 桥 pid=%d", cmd.Process.Pid)
		}
	}
}

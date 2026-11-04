// aica workbench shell — MyGo 窗口壳
//
// 单窗口打开 http://127.0.0.1:4399/v1/index.html：
//  1. 探测 GET /api/daemon，200 则复用已在跑的桥（workbench/server.ts）；
//  2. 未跑则 spawn `node <repo>/workbench/server.ts`（WB_PORT=4399，env 透传）；
//  3. 轮询 GET /api/v1/view 直到 200（15s 超时 → 原生报错对话框）；
//  4. 开 1440×900 窗口「AICA 工作台」；退出时只杀自己拉起的 node。
//
// 桥本身（daemon 拉起、/api/*、SSE）全在 server.ts，壳只管窗口与 node 生命周期。
package main

import (
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"time"

	"github.com/egoist/mygo"
)

const (
	appTitle = "AICA 工作台"
	baseURL  = "http://127.0.0.1:4399"
	viewURL  = baseURL + "/v1/index.html"
	probeURL = baseURL + "/api/daemon"
	readyURL = baseURL + "/api/v1/view"

	readyTimeout = 15 * time.Second
	pollEvery    = 250 * time.Millisecond
)

var client = &http.Client{Timeout: 1500 * time.Millisecond}

// nodeCmd 是本进程拉起的桥；为 nil 说明复用了已有 server，退出时不动它。
var nodeCmd *exec.Cmd

func main() {
	log.SetPrefix("[aica-shell] ")

	mygo.App.SetName(appTitle)
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
		mygo.NewWindow(mygo.WindowOptions{
			Title:  appTitle,
			URL:    viewURL,
			Width:  1440,
			Height: 900,
		})
	})
	// 窗口全关 / App.Quit 都会走到 quit；只回收自己拉起的 node。
	mygo.App.OnWillQuit(func(*mygo.QuitEvent) { stopServer() })

	if err := mygo.App.Run(); err != nil {
		stopServer()
		log.Fatal(err)
	}
}

// fail 报错并退出：原生对话框（窗口尚未创建，WebView 不可用）。
func fail(what string, err error) {
	log.Printf("%s: %v", what, err)
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
//  2. 源码位置（runtime.Caller）：shell/../server.ts —— go run 与源码树内构建均有效；
//  3. 可执行文件相对：../server.ts（壳放 workbench/shell/）、../../workbench/server.ts
//     （壳被拷到仓库根的 build/ 之类位置）、../../server.ts（壳放仓库根下两级目录）；
//  4. 当前目录的 workbench/server.ts（从仓库根启动）。
func serverPath() (string, error) {
	var cands []string
	if p := os.Getenv("AICA_WB_SERVER"); p != "" {
		cands = append(cands, p)
	}
	if _, file, _, ok := runtime.Caller(0); ok {
		cands = append(cands, filepath.Join(filepath.Dir(file), "..", "server.ts"))
	}
	if exe, err := os.Executable(); err == nil {
		dir := filepath.Dir(exe)
		cands = append(cands,
			filepath.Join(dir, "..", "server.ts"),
			filepath.Join(dir, "..", "..", "workbench", "server.ts"),
			filepath.Join(dir, "..", "..", "server.ts"),
		)
	}
	if wd, err := os.Getwd(); err == nil {
		cands = append(cands, filepath.Join(wd, "workbench", "server.ts"))
	}
	for _, c := range cands {
		if abs, err := filepath.Abs(c); err == nil {
			if st, err := os.Stat(abs); err == nil && !st.IsDir() {
				return abs, nil
			}
		}
	}
	return "", fmt.Errorf("找不到 server.ts（试过 %v）；可设 AICA_WB_SERVER 指定", cands)
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

	nodeCmd = exec.Command(node, server)
	nodeCmd.Env = env
	hideConsole(nodeCmd)

	if err := os.MkdirAll(state, 0o755); err == nil {
		if f, err := os.OpenFile(filepath.Join(state, "workbench-server.log"),
			os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644); err == nil {
			nodeCmd.Stdout, nodeCmd.Stderr = f, f
		}
	}

	if err := nodeCmd.Start(); err != nil {
		nodeCmd = nil
		return fmt.Errorf("spawn node %s: %w", server, err)
	}
	log.Printf("拉起 workbench 桥 pid=%d  %s %s", nodeCmd.Process.Pid, node, server)
	return nil
}

// stopServer 只杀自己拉起的 node（Process.Kill ≈ TerminateProcess）；
// 桥内 detached 的 ar daemon 不属于它，留给 server.ts 的进程表去重管。
func stopServer() {
	if nodeCmd == nil || nodeCmd.Process == nil {
		return
	}
	if nodeCmd.ProcessState == nil { // 已退出过的不再杀
		if err := nodeCmd.Process.Kill(); err == nil {
			log.Printf("已回收 workbench 桥 pid=%d", nodeCmd.Process.Pid)
		}
	}
	nodeCmd = nil
}

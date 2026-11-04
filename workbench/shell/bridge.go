package main

// bridge.go —— 桥进程自愈 + 崩溃错误页。
//
// 只监控「本进程 spawn 的」node（nodeCmd）：复用别人已在跑的桥时没有子进程可等，
// 由 approvals 轮询发现不可用，但重启权留给启动它的那个进程（README 有说明）。
//
// 崩溃 → 1s/2s/4s 退避重启，最多 3 次；成功则刷新 WebView2；
// 3 次都失败 → 本地错误页（127.0.0.1 随机端口，只服务错误页），
// 带「重试」「打开日志」。重试仍走同一套 3 次重启逻辑。

import (
	"encoding/json"
	"fmt"
	"html"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/egoist/mygo"
)

var (
	bridgeMu        sync.Mutex // 保护 nodeCmd
	bridgeRestartMu sync.Mutex // 串行化重启/重试
	bridgeRetryOK   = make(chan struct{}, 1)
	errorBase       string // 错误页根 URL，形如 http://127.0.0.1:xxxxx/

	bridgeErrMu   sync.Mutex
	lastBridgeErr error
)

// ---------------------------------------------------------------- nodeCmd 访问

func currentBridge() *exec.Cmd {
	bridgeMu.Lock()
	defer bridgeMu.Unlock()
	return nodeCmd
}

func setBridge(cmd *exec.Cmd) {
	bridgeMu.Lock()
	nodeCmd = cmd
	bridgeMu.Unlock()
}

func setLastBridgeErr(err error) {
	bridgeErrMu.Lock()
	lastBridgeErr = err
	bridgeErrMu.Unlock()
}

func bridgeErrorText() string {
	bridgeErrMu.Lock()
	defer bridgeErrMu.Unlock()
	if lastBridgeErr == nil {
		return "未知错误"
	}
	return lastBridgeErr.Error()
}

// shellLogPath / serverLogPath 供错误页与「打开日志」共用。
func shellLogPath() string {
	if dir := ensureStateDir(); dir != "" {
		return filepath.Join(dir, "workbench-shell.log")
	}
	return ""
}

func serverLogPath() string {
	if dir := ensureStateDir(); dir != "" {
		return filepath.Join(dir, "workbench-server.log")
	}
	return ""
}

// ---------------------------------------------------------------- 自愈

// superviseBridge 等当前 node 退出；退出后按 1s/2s/4s 重启。
// 3 次失败则挂起等待错误页的手动重试（bridgeRetryOK）。
func superviseBridge() {
	for {
		cmd := currentBridge()
		if cmd == nil {
			log.Printf("没有本进程拉起的桥，停止自愈监控")
			return
		}
		err := cmd.Wait()
		if quitting.Load() {
			return
		}
		log.Printf("桥进程退出（%v），开始自愈", err)
		if restartBridge(3) {
			log.Printf("桥自愈成功，刷新工作台页面")
			reloadWorkbench()
			requestApprovalRefresh()
			continue
		}
		log.Printf("桥自愈失败（连续 3 次），显示错误页")
		if !showBridgeError(err) {
			return
		}
		<-bridgeRetryOK
		log.Printf("手动重试成功，继续监控新桥进程")
	}
}

// restartDelay 返回第 attempt 次重启前的退避：1s、2s、4s（封顶 8s）。
func restartDelay(attempt int) time.Duration {
	if attempt < 1 {
		attempt = 1
	}
	if attempt > 4 {
		attempt = 4
	}
	return time.Duration(1<<(attempt-1)) * time.Second
}

// restartBridge 同步重试 maxAttempts 次；成功返回 true。
func restartBridge(maxAttempts int) bool {
	bridgeRestartMu.Lock()
	defer bridgeRestartMu.Unlock()

	var lastErr error
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		if quitting.Load() {
			return false
		}
		delay := restartDelay(attempt)
		log.Printf("桥重启 %d/%d：%s 后重试", attempt, maxAttempts, delay)
		time.Sleep(delay)
		if quitting.Load() {
			return false
		}

		stopServer() // 清掉可能还活着但没就绪的旧进程
		if err := startServer(); err != nil {
			lastErr = err
			log.Printf("桥重启 %d/%d 失败: %v", attempt, maxAttempts, err)
			continue
		}
		if err := waitReady(readyTimeout); err != nil {
			lastErr = err
			log.Printf("桥重启 %d/%d 未就绪: %v", attempt, maxAttempts, err)
			stopServer()
			continue
		}
		log.Printf("桥重启成功（第 %d 次尝试）", attempt)
		setLastBridgeErr(nil)
		return true
	}
	setLastBridgeErr(lastErr)
	return false
}

// reloadWorkbench 把页面导航回工作台（错误页之后也走这里）。
func reloadWorkbench() {
	if mainWin == nil {
		return
	}
	if page := mainWin.Page(); page == nil {
		return
	} else if err := page.LoadURL(viewURL); err != nil {
		log.Printf("刷新工作台页面失败: %v", err)
	}
}

// ---------------------------------------------------------------- 错误页

func bridgeErrorDetail(cause error) string {
	msg := bridgeErrorText()
	if msg == "未知错误" && cause != nil {
		msg = cause.Error()
	}
	return fmt.Sprintf("工作台桥连续 3 次重启失败。\n\n最近错误: %s\n\n壳日志: %s\n桥日志: %s",
		msg, shellLogPath(), serverLogPath())
}

// showBridgeError 显示错误页；错误页起不来时退回原生对话框。
func showBridgeError(cause error) bool {
	if errorBase != "" && mainWin != nil {
		if page := mainWin.Page(); page != nil {
			if err := page.LoadURL(errorBase); err == nil {
				return true
			} else {
				log.Printf("加载错误页失败: %v", err)
			}
		}
	}
	mygo.Dialog.Error(appTitle, bridgeErrorDetail(cause))
	return false
}

// startErrorServer 在 loopback 随机端口起一个只服务错误页的小 HTTP 服务。
// 失败只记日志：自愈仍会重试，只是失败后用原生对话框。
func startErrorServer() {
	mux := http.NewServeMux()
	mux.HandleFunc("/", handleErrorIndex)
	mux.HandleFunc("/retry", handleBridgeRetry)
	mux.HandleFunc("/log", handleOpenLog)

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		log.Printf("错误页服务启动失败: %v", err)
		return
	}
	errorBase = "http://" + ln.Addr().String() + "/"
	go func() {
		if err := http.Serve(ln, mux); err != nil {
			log.Printf("错误页服务退出: %v", err)
		}
	}()
	log.Printf("错误页服务: %s", errorBase)
}

func handleErrorIndex(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write([]byte(errorPageHTML(bridgeErrorDetail(nil))))
}

func handleBridgeRetry(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"ok": false, "error": "POST only"})
		return
	}
	if quitting.Load() {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"ok": false, "error": "正在退出"})
		return
	}
	// 已经恢复（可能被别人重启了）就直接刷新，不重复 spawn。
	if _, ok := fetchHealth(); ok {
		reloadWorkbench()
		signalBridgeRetry()
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "note": "桥已在线"})
		return
	}
	if restartBridge(3) {
		reloadWorkbench()
		signalBridgeRetry()
		requestApprovalRefresh()
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
		return
	}
	writeJSON(w, http.StatusBadGateway, map[string]any{"ok": false, "error": bridgeErrorText()})
}

func signalBridgeRetry() {
	select {
	case bridgeRetryOK <- struct{}{}:
	default:
	}
}

func handleOpenLog(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodPost {
		w.Header().Set("Allow", "GET, POST")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	path := shellLogPath()
	if path == "" {
		http.Error(w, "没有日志目录", http.StatusInternalServerError)
		return
	}
	if _, err := os.Stat(path); err != nil {
		http.Error(w, "日志还不存在: "+path, http.StatusNotFound)
		return
	}
	if err := mygo.Shell.OpenPath(path); err != nil {
		http.Error(w, "打开日志失败: "+err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	fmt.Fprintf(w, "已打开日志: %s\n", path)
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

// errorPageHTML 用占位符替换，避免 CSS 里的 % 被 Sprintf 吃掉。
func errorPageHTML(detail string) string {
	view, _ := json.Marshal(viewURL)
	return strings.NewReplacer(
		"__DETAIL__", html.EscapeString(detail),
		"__VIEW__", string(view),
		"__SHELL_LOG__", html.EscapeString(shellLogPath()),
		"__SERVER_LOG__", html.EscapeString(serverLogPath()),
	).Replace(errorPageTemplate)
}

const errorPageTemplate = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>AICA 工作台 · 桥未响应</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         background:#18181b; color:#fafafa; font:14px/1.6 system-ui,"Segoe UI",sans-serif; }
  main { width:min(640px, calc(100vw - 48px)); background:#232326; border:1px solid #3f3f46;
         border-radius:14px; padding:28px 30px; box-shadow:0 18px 60px rgba(0,0,0,.45); }
  h1 { margin:0 0 6px; font-size:20px; }
  .sub { color:#a1a1aa; margin:0 0 18px; }
  .detail { white-space:pre-wrap; word-break:break-word; background:#18181b; border:1px solid #3f3f46;
            border-radius:10px; padding:12px 14px; color:#d4d4d8; font:12px/1.6 ui-monospace,Consolas,monospace; }
  .row { display:flex; gap:10px; margin-top:18px; }
  button { appearance:none; border:0; border-radius:9px; padding:9px 18px; font:inherit; cursor:pointer; }
  #retry { background:#e5484d; color:#fff; }
  #retry:disabled { opacity:.6; cursor:default; }
  #log { background:#3f3f46; color:#fafafa; }
  #msg { margin-top:12px; min-height:20px; color:#f4a3a5; font-size:13px; }
  .paths { margin-top:16px; color:#71717a; font-size:12px; }
  code { color:#a1a1aa; }
</style></head>
<body><main>
  <h1>工作台桥没有起来</h1>
  <p class="sub">已自动重试 3 次（1s / 2s / 4s 退避）仍失败。工作台不会静默重启，修好后点「重试」。</p>
  <div class="detail">__DETAIL__</div>
  <div class="row">
    <button id="retry">重试</button>
    <button id="log">打开日志</button>
  </div>
  <div id="msg"></div>
  <div class="paths">壳日志 <code>__SHELL_LOG__</code><br>桥日志 <code>__SERVER_LOG__</code></div>
</main>
<script>
  const view = __VIEW__;
  const btn = document.getElementById('retry');
  const logBtn = document.getElementById('log');
  const msg = document.getElementById('msg');
  btn.addEventListener('click', async () => {
    btn.disabled = true; btn.textContent = '重试中…'; msg.textContent = '';
    try {
      const r = await fetch('/retry', { method: 'POST' });
      const j = await r.json().catch(() => ({}));
      if (r.ok) { location.replace(view); return; }
      msg.textContent = j.error || ('重试失败（HTTP ' + r.status + '）');
    } catch (e) {
      msg.textContent = '重试失败: ' + e;
    }
    btn.disabled = false; btn.textContent = '重试';
  });
  logBtn.addEventListener('click', () => { fetch('/log', { method: 'POST' }).catch(() => {}); });
</script>
</body></html>
`

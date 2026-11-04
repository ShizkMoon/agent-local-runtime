package main

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// harnessJS 是一个最小 DOM 桩：让 preload 脚本在 node 里跑一遍，
// 验证「拖拽拦截 / @path 插入 / 快捷键面板 / 更新提示」四条真实行为。
const harnessJS = `
const fs = require('fs');
const vm = require('vm');
const code = fs.readFileSync(process.argv[2], 'utf8');

const calls = { input: 0, prevented: [], focus: 0 };
const listeners = Object.create(null);
const handlers = Object.create(null);
const byId = Object.create(null);
const appended = [];

function makeTextarea() {
  return {
    tagName: 'TEXTAREA',
    value: '',
    selectionStart: 0,
    selectionEnd: 0,
    style: {},
    addEventListener: function () {},
    dispatchEvent: function (e) { if (e && e.type === 'input') calls.input++; return true; },
    focus: function () { calls.focus++; },
    scrollIntoView: function () {},
    remove: function () {},
  };
}
const ta = makeTextarea();

function makeElement(tag) {
  return {
    tagName: tag || 'DIV',
    id: '',
    style: {},
    innerHTML: '',
    textContent: '',
    title: '',
    addEventListener: function () {},
    remove: function () { if (this.id) delete byId[this.id]; },
    stopPropagation: function () {},
  };
}

const document = {
  readyState: 'complete',
  getElementById: function (id) {
    if (id === 'cText') return ta;
    return byId[id] || null;
  },
  querySelector: function () { return null; },
  createElement: function (tag) { return makeElement(tag); },
  addEventListener: function () {},
  body: { appendChild: function (el) { appended.push(el); if (el.id) byId[el.id] = el; } },
};

const win = {
  addEventListener: function (type, fn, capture) {
    (listeners[type] || (listeners[type] = [])).push({ fn: fn, capture: !!capture });
  },
  mygo: { on: function (name, fn) { handlers[name] = fn; } },
};

const sandbox = {
  window: win,
  document: document,
  location: { hash: '' },
  requestAnimationFrame: function (fn) { fn(); },
  setTimeout: function () { return 0; },
  Event: function (type) { this.type = type; },
  console: console,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(code, sandbox);

function fire(type, files) {
  const ev = {
    type: type,
    dataTransfer: { types: ['Files'], files: files, dropEffect: '' },
    preventDefault: function () { calls.prevented.push(type); },
  };
  const ls = listeners[type] || [];
  for (const l of ls) l.fn(ev);
  return ev;
}

function key(opts) {
  const ev = Object.assign({ type: 'keydown', preventDefault: function () {}, stopPropagation: function () {} }, opts);
  const ls = listeners['keydown'] || [];
  for (const l of ls) l.fn(ev);
  return ev;
}

fire('dragover', [{}]);
fire('drop', [{}]);

win.__aicaInsertPaths(['C:/a/b.txt', 'C:/sp ace/c.txt']);
const valueAfterApi = ta.value;

ta.value = '';
ta.selectionStart = 0;
ta.selectionEnd = 0;
if (handlers['mygo:file-drop']) handlers['mygo:file-drop']({ paths: ['C:/x.txt'] });
const valueAfterEvent = ta.value;

// 托盘「新建任务」：壳只改 hash，preload 收到 hashchange 后聚焦 composer。
sandbox.location.hash = '#new=123';
const hs = listeners['hashchange'] || [];
for (const l of hs) l.fn({ type: 'hashchange' });
const focusAfterHash = calls.focus;

// Ctrl+/ 打开快捷键面板，Esc 关闭。
key({ key: '/', code: 'Slash', ctrlKey: true, altKey: false, metaKey: false });
const shortcutEl = document.getElementById('aica-shortcuts');
const shortcutOpen = !!shortcutEl;
const shortcutHTML = shortcutEl ? String(shortcutEl.innerHTML) : '';
key({ key: 'Escape' });
const shortcutClosed = !document.getElementById('aica-shortcuts');

const pillEl = appended.filter(function (e) { return e.id === 'aica-update-pill'; })[0];
process.stdout.write(JSON.stringify({
  prevented: calls.prevented,
  inputEvents: calls.input,
  valueAfterApi: valueAfterApi,
  valueAfterEvent: valueAfterEvent,
  focusAfterHash: focusAfterHash,
  shortcutOpen: shortcutOpen,
  shortcutHTML: shortcutHTML,
  shortcutClosed: shortcutClosed,
  pillCount: appended.filter(function (e) { return e.id === 'aica-update-pill'; }).length,
  pillText: pillEl ? String(pillEl.textContent) : '',
}));
`

type preloadResult struct {
	Prevented      []string `json:"prevented"`
	InputEvents    int      `json:"inputEvents"`
	ValueAfterAPI  string   `json:"valueAfterApi"`
	ValueAfterEvt  string   `json:"valueAfterEvent"`
	FocusAfterHash int      `json:"focusAfterHash"`
	ShortcutOpen   bool     `json:"shortcutOpen"`
	ShortcutHTML   string   `json:"shortcutHTML"`
	ShortcutClosed bool     `json:"shortcutClosed"`
	PillCount      int      `json:"pillCount"`
	PillText       string   `json:"pillText"`
}

// runPreload 在 node 里执行 preload，返回结构化结果；没有 node 就跳过。
func runPreload(t *testing.T, script string) preloadResult {
	t.Helper()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("PATH 中没有 node，跳过 preload 行为测试")
	}
	dir := t.TempDir()
	preloadPath := filepath.Join(dir, "preload.js")
	harnessPath := filepath.Join(dir, "harness.js")
	if err := os.WriteFile(preloadPath, []byte(script), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(harnessPath, []byte(harnessJS), 0o644); err != nil {
		t.Fatal(err)
	}

	// 先做语法检查：注入脚本语法错误会让整个页面起不来。
	check := exec.Command(node, "--check", preloadPath)
	if out, err := check.CombinedOutput(); err != nil {
		t.Fatalf("preload 语法错误: %v\n%s", err, out)
	}

	cmd := exec.Command(node, harnessPath, preloadPath)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("node harness 失败: %v\n%s", err, out)
	}
	var res preloadResult
	if err := json.Unmarshal(out, &res); err != nil {
		t.Fatalf("harness 输出不是 JSON: %v\n%s", err, out)
	}
	return res
}

func TestPreloadDragGuardAndInsertion(t *testing.T) {
	res := runPreload(t, buildPreload(nil))

	joined := strings.Join(res.Prevented, ",")
	if !strings.Contains(joined, "dragover") || !strings.Contains(joined, "drop") {
		t.Fatalf("dragover/drop 没有被 preventDefault: %v", res.Prevented)
	}
	if res.InputEvents < 2 {
		t.Fatalf("插入后应派发 input 事件（autogrow/发送逻辑依赖它），got %d", res.InputEvents)
	}
	wantAPI := `@C:/a/b.txt @"C:/sp ace/c.txt"`
	if res.ValueAfterAPI != wantAPI {
		t.Fatalf("DOM API 插入 = %q, want %q", res.ValueAfterAPI, wantAPI)
	}
	if res.ValueAfterEvt != "@C:/x.txt" {
		t.Fatalf("mygo:file-drop 插入 = %q, want %q", res.ValueAfterEvt, "@C:/x.txt")
	}
	if res.FocusAfterHash < 1 {
		t.Fatalf("#new hash 应聚焦 composer（托盘「新建任务」依赖它），focus=%d", res.FocusAfterHash)
	}
	if res.PillCount != 0 {
		t.Fatalf("没有更新时不应出现提示 pill，got %d", res.PillCount)
	}
}

func TestPreloadShortcutsPanel(t *testing.T) {
	res := runPreload(t, buildPreload(nil))
	if !res.ShortcutOpen {
		t.Fatal("Ctrl+/ 应打开快捷键面板")
	}
	for _, want := range []string{"Ctrl+K", "Ctrl+,", "Ctrl+/", "Ctrl+Alt+A", "Esc", "批准", "拒绝"} {
		if !strings.Contains(res.ShortcutHTML, want) {
			t.Errorf("快捷键面板缺少 %q", want)
		}
	}
	if !res.ShortcutClosed {
		t.Fatal("Esc 应关闭快捷键面板")
	}
}

func TestPreloadUpdateNotice(t *testing.T) {
	res := runPreload(t, buildPreload(&updateNotice{Running: "0.1.0", Disk: "0.2.0"}))
	if res.PillCount != 1 {
		t.Fatalf("应有 1 个更新提示 pill，got %d", res.PillCount)
	}
	if !strings.Contains(res.PillText, "代码已更新") || !strings.Contains(res.PillText, "0.2.0") {
		t.Fatalf("提示文案不对: %q", res.PillText)
	}
}

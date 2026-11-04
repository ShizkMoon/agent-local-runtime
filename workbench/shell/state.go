package main

// state.go —— 壳自己的持久化状态。
//
// 职责：
//  1. stateDir：<AICA_STATE> 或 %LOCALAPPDATA%\aica\state；
//  2. windowStore：MyGo 的 WindowStateStore 实现，把窗口位置/大小/最大化
//     写成用户可读的 window.json（而不是 MyGo 默认的 window-state.json）；
//  3. 一次性标记：托盘首次提示、更新提示去重。
//
// 所有写入都走「临时文件 + rename」，掉电/并发读写不会留下半截 JSON。

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/egoist/mygo"
)

// stateDir 返回壳的状态目录，并确保存在。openLog 与各状态文件共用。
func stateDir() string {
	dir := os.Getenv("AICA_STATE")
	if dir == "" {
		dir = filepath.Join(os.Getenv("LOCALAPPDATA"), "aica", "state")
	}
	return dir
}

// ensureStateDir 建目录；失败返回空串，让调用方降级为「不持久化」。
func ensureStateDir() string {
	dir := stateDir()
	if dir == "" {
		return ""
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return ""
	}
	return dir
}

// writeFileAtomic 写临时文件再 rename；同目录保证原子替换。
func writeFileAtomic(path string, data []byte) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// ---------------------------------------------------------------- 窗口记忆

// windowStore 实现 mygo.WindowStateStore：
// 磁盘格式就是单个 WindowState —— {"x":..,"y":..,"width":..,"height":..,"maximized":..}
// 正好是任务要求的 window.json schema；键名来自 mygo.WindowState 的 json tag。
type windowStore struct {
	path string
	mu   sync.Mutex
}

func (s *windowStore) LoadWindowStates() (map[string]mygo.WindowState, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	raw, err := os.ReadFile(s.path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var st mygo.WindowState
	if err := json.Unmarshal(raw, &st); err != nil {
		// 损坏的文件当作没有：MyGo 会用创建参数，下一次保存覆盖它。
		return nil, nil
	}
	if st.Width <= 0 || st.Height <= 0 {
		return nil, nil
	}
	return map[string]mygo.WindowState{mainStateKey: st}, nil
}

func (s *windowStore) SaveWindowStates(states map[string]mygo.WindowState) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	st, ok := states[mainStateKey]
	if !ok {
		// 只有主窗口一个 StateKey；真出现别的键也不丢数据：挑第一个保存，
		// window.json 的契约是「主窗口的位置」。
		for _, v := range states {
			st, ok = v, true
			break
		}
	}
	if !ok || st.Width <= 0 || st.Height <= 0 {
		return nil
	}
	raw, err := json.MarshalIndent(st, "", "  ")
	if err != nil {
		return err
	}
	raw = append(raw, '\n')
	if err := writeFileAtomic(s.path, raw); err != nil {
		return err
	}
	return nil
}

// ---------------------------------------------------------------- 一次性标记

// markOnce 在首次调用时返回 true 并落一个标记文件；之后返回 false。
// 用于「首次收起到托盘提示一次」。
func markOnce(name string) bool {
	dir := ensureStateDir()
	if dir == "" {
		return true // 没法持久化就每次提示，总比静默好
	}
	path := filepath.Join(dir, name)
	if _, err := os.Stat(path); err == nil {
		return false
	}
	if err := os.WriteFile(path, []byte(time.Now().Format(time.RFC3339)+"\n"), 0o644); err != nil {
		return true
	}
	return true
}

// updateRecord 记住「上次已经提示过的磁盘版本 + 代码时间」，避免每次启动都弹。
type updateRecord struct {
	Disk    string `json:"disk"`
	ModUnix int64  `json:"mod_unix"`
}

func loadUpdateRecord(path string) updateRecord {
	var rec updateRecord
	raw, err := os.ReadFile(path)
	if err != nil {
		return rec
	}
	_ = json.Unmarshal(raw, &rec)
	return rec
}

func saveUpdateRecord(path string, rec updateRecord) {
	raw, err := json.MarshalIndent(rec, "", "  ")
	if err != nil {
		return
	}
	_ = writeFileAtomic(path, append(raw, '\n'))
}

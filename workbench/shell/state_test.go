package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/egoist/mygo"
)

func TestWindowStoreRoundTrip(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "window.json")
	store := &windowStore{path: path}

	want := mygo.WindowState{X: 120, Y: 80, Width: 1440, Height: 900, Maximized: true}
	if err := store.SaveWindowStates(map[string]mygo.WindowState{mainStateKey: want}); err != nil {
		t.Fatalf("save: %v", err)
	}

	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	var flat struct {
		X         int  `json:"x"`
		Y         int  `json:"y"`
		Width     int  `json:"width"`
		Height    int  `json:"height"`
		Maximized bool `json:"maximized"`
	}
	if err := json.Unmarshal(raw, &flat); err != nil {
		t.Fatalf("window.json 不是合法 JSON: %v\n%s", err, raw)
	}
	if flat.X != 120 || flat.Y != 80 || flat.Width != 1440 || flat.Height != 900 || !flat.Maximized {
		t.Fatalf("window.json 字段不对: %+v", flat)
	}

	loaded, err := store.LoadWindowStates()
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	got, ok := loaded[mainStateKey]
	if !ok || got != want {
		t.Fatalf("round trip = %+v (ok=%v), want %+v", got, ok, want)
	}
}

func TestWindowStoreCorruptFileIsIgnored(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "window.json")
	if err := os.WriteFile(path, []byte("{not json"), 0o644); err != nil {
		t.Fatal(err)
	}
	store := &windowStore{path: path}
	states, err := store.LoadWindowStates()
	if err != nil {
		t.Fatalf("损坏文件应被当作没有状态: %v", err)
	}
	if states != nil {
		t.Fatalf("损坏文件应返回 nil，得到 %+v", states)
	}
}

func TestWindowStoreSkipsEmptyBounds(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "window.json")
	store := &windowStore{path: path}
	if err := store.SaveWindowStates(map[string]mygo.WindowState{mainStateKey: {Width: 0, Height: 0}}); err != nil {
		t.Fatalf("save: %v", err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("空尺寸不应写文件，err=%v", err)
	}
}

func TestSemverNewer(t *testing.T) {
	cases := []struct {
		candidate, running string
		want               bool
	}{
		{"0.2.0", "0.1.0", true},
		{"0.1.0", "0.2.0", false},
		{"0.1.1", "0.1.0", true},
		{"1.0", "0.9.9", true},
		{"0.1.0", "0.1.0", false},
		{"", "0.1.0", false},
	}
	for _, c := range cases {
		if got := semverNewer(c.candidate, c.running); got != c.want {
			t.Errorf("semverNewer(%q,%q) = %v, want %v", c.candidate, c.running, got, c.want)
		}
	}
}

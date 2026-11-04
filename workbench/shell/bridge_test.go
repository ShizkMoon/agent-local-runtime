package main

import (
	"strings"
	"testing"
	"time"
)

func TestRestartDelay(t *testing.T) {
	want := []time.Duration{time.Second, 2 * time.Second, 4 * time.Second, 8 * time.Second}
	for i, d := range want {
		if got := restartDelay(i + 1); got != d {
			t.Errorf("restartDelay(%d) = %v, want %v", i+1, got, d)
		}
	}
	if got := restartDelay(99); got != 8*time.Second {
		t.Errorf("restartDelay 封顶应为 8s，got %v", got)
	}
}

func TestErrorPageHTML(t *testing.T) {
	doc := errorPageHTML("boom <script>alert(1)</script>")
	for _, want := range []string{"重试", "打开日志", "工作台桥没有起来", baseURL, shellLogPath()} {
		if !strings.Contains(doc, want) {
			t.Errorf("错误页缺少 %q", want)
		}
	}
	if strings.Contains(doc, "<script>alert(1)</script>") {
		t.Fatal("错误详情必须转义，不能原样注入 script")
	}
	if !strings.Contains(doc, "&lt;script&gt;alert(1)&lt;/script&gt;") {
		t.Fatalf("错误详情转义形式不对")
	}
}

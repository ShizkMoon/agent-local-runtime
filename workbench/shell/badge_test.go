package main

import (
	"bytes"
	"image/png"
	"strings"
	"testing"
)

func TestBadgeIconAddsRedDot(t *testing.T) {
	out, err := makeBadgeIcon(trayIconPNG)
	if err != nil {
		t.Fatalf("生成徽标失败: %v", err)
	}
	if bytes.Equal(out, trayIconPNG) {
		t.Fatal("徽标应与原图不同")
	}

	orig, err := png.Decode(bytes.NewReader(trayIconPNG))
	if err != nil {
		t.Fatal(err)
	}
	badged, err := png.Decode(bytes.NewReader(out))
	if err != nil {
		t.Fatalf("徽标不是合法 PNG: %v", err)
	}
	if orig.Bounds() != badged.Bounds() {
		t.Fatalf("尺寸变了: %v -> %v", orig.Bounds(), badged.Bounds())
	}

	// 红点在右上角（82%, 18%），中心像素应为徽标红。
	w, h := orig.Bounds().Dx(), orig.Bounds().Dy()
	r, g, b, a := badged.At(w*82/100, h*18/100).RGBA()
	if a == 0 {
		t.Fatal("红点像素完全透明")
	}
	if r>>8 < 180 || g>>8 > 130 || b>>8 > 140 {
		t.Fatalf("右上角不是红点: rgba=(%d,%d,%d,%d)", r>>8, g>>8, b>>8, a>>8)
	}

	// 左下角应保持原样（没被红点覆盖）。
	if got, want := badged.At(w/10, h/10), orig.At(w/10, h/10); got != want {
		t.Fatalf("左下角被意外修改: %v -> %v", want, got)
	}
}

func TestTrayTooltip(t *testing.T) {
	if tip := trayTooltip(0); strings.Contains(tip, "待你") || !strings.Contains(tip, "Ctrl+Alt+A") {
		t.Fatalf("空状态 tooltip 不对: %q", tip)
	}
	if tip := trayTooltip(3); !strings.Contains(tip, "待你 3") {
		t.Fatalf("有待办 tooltip 不对: %q", tip)
	}
}

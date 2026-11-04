package main

// badge.go —— 托盘红点徽标 + 待裁决数量轮询。
//
// 数据源：GET /api/approvals 的 count（server.ts 已把 gate-req 的未答卡聚合好）。
// 展示：MyGo 的 Tray.SetIcon 只收 PNG 字节，所以「两套图标」用
//   - 无待办：go:embed 的 resources/icon.png；
//   - 有待办：同一张图在运行时叠加右上角红点（白描边）生成 PNG。
// 切换 + tooltip 都只在数量变化时做，避免每 30s 无谓重建托盘图标。

import (
	"bytes"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/draw"
	"image/png"
	"io"
	"log"
	"net/http"
	"sync"
	"time"
)

const approvalsURL = baseURL + "/api/approvals"

// ---------------------------------------------------------------- 徽标图标

var badgeIcon struct {
	once sync.Once
	png  []byte
	err  error
}

// badgeTrayIcon 返回叠加红点后的托盘图标；生成失败退回原图（不阻断托盘）。
func badgeTrayIcon() []byte {
	badgeIcon.once.Do(func() {
		badgeIcon.png, badgeIcon.err = makeBadgeIcon(trayIconPNG)
	})
	if badgeIcon.err != nil || len(badgeIcon.png) == 0 {
		return trayIconPNG
	}
	return badgeIcon.png
}

// makeBadgeIcon 解码 src，在右上角画一个白描边红点，再编码成 PNG。
// 纯函数，单测直接验像素。
func makeBadgeIcon(src []byte) ([]byte, error) {
	img, err := png.Decode(bytes.NewReader(src))
	if err != nil {
		return nil, err
	}
	bounds := img.Bounds()
	w, h := bounds.Dx(), bounds.Dy()
	if w < 16 || h < 16 {
		return nil, fmt.Errorf("图标太小: %dx%d", w, h)
	}
	dst := image.NewRGBA(image.Rect(0, 0, w, h))
	draw.Draw(dst, dst.Bounds(), img, bounds.Min, draw.Src)

	// 圆点放在右上，留 3% 边距；1024 图标上红点直径约 22%。
	cx := w * 82 / 100
	cy := h * 18 / 100
	outer := min(w, h) * 15 / 100
	inner := min(w, h) * 11 / 100
	if outer < 4 {
		outer = 4
	}
	if inner < 3 {
		inner = 3
	}
	fillCircle(dst, cx, cy, outer, color.RGBA{R: 255, G: 255, B: 255, A: 255})
	fillCircle(dst, cx, cy, inner, color.RGBA{R: 229, G: 72, B: 77, A: 255})

	var buf bytes.Buffer
	if err := png.Encode(&buf, dst); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// fillCircle 用平方距离填充实心圆（图标一次性生成，不必抗锯齿）。
func fillCircle(dst *image.RGBA, cx, cy, r int, c color.Color) {
	rr := r * r
	for y := cy - r; y <= cy+r; y++ {
		for x := cx - r; x <= cx+r; x++ {
			if x < dst.Rect.Min.X || x >= dst.Rect.Max.X || y < dst.Rect.Min.Y || y >= dst.Rect.Max.Y {
				continue
			}
			dx, dy := x-cx, y-cy
			if dx*dx+dy*dy <= rr {
				dst.Set(x, y, c)
			}
		}
	}
}

// ---------------------------------------------------------------- 数量轮询

// trayTooltip 是托盘悬停文案；有未答审批时把数量带上。
func trayTooltip(pending int) string {
	if pending > 0 {
		return fmt.Sprintf("%s · 待你 %d", appTitle, pending)
	}
	return appTitle + "（Ctrl+Alt+A 显隐）"
}

// fetchApprovalCount 读 /api/approvals 的 count。
func fetchApprovalCount() (int, bool) {
	res, err := client.Get(approvalsURL)
	if err != nil {
		return 0, false
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return 0, false
	}
	var body struct {
		Count int `json:"count"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 4<<20)).Decode(&body); err != nil {
		return 0, false
	}
	if body.Count < 0 {
		body.Count = 0
	}
	return body.Count, true
}

var (
	badgeMu      sync.Mutex
	badgeApplied = -1 // -1：还没切过；首次强制设置一次
)

// setTrayBadge 按待裁决数切换托盘图标与 tooltip。
func setTrayBadge(pending int) {
	if tray == nil {
		return
	}
	badgeMu.Lock()
	defer badgeMu.Unlock()
	if pending == badgeApplied {
		return
	}
	icon := trayIconPNG
	if pending > 0 {
		icon = badgeTrayIcon()
	}
	if err := tray.SetIcon(icon, false); err != nil {
		log.Printf("托盘徽标切换失败（保持原图标）: %v", err)
		return
	}
	tray.SetToolTip(trayTooltip(pending))
	badgeApplied = pending
	log.Printf("托盘徽标: %s", trayTooltip(pending))
}

// refreshTrayBadge 先确认桥活着，再取审批数并更新托盘。
// 桥挂掉时保持现状：自愈流程会负责重启并在成功后刷新。
func refreshTrayBadge() {
	if tray == nil {
		return
	}
	if _, ok := fetchHealth(); !ok {
		return
	}
	n, ok := fetchApprovalCount()
	if !ok {
		return
	}
	setTrayBadge(n)
}

// approvalsRefresh 由窗口显示/聚焦、桥重启成功等事件触发立即刷新（缓冲 1，合并突发）。
var approvalsRefresh = make(chan struct{}, 1)

func requestApprovalRefresh() {
	select {
	case approvalsRefresh <- struct{}{}:
	default:
	}
}

// startApprovalsWatch 启动 30s 轮询；进程退出时 goroutine 随进程结束。
func startApprovalsWatch() {
	go func() {
		refreshTrayBadge()
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				refreshTrayBadge()
			case <-approvalsRefresh:
				refreshTrayBadge()
			}
		}
	}()
}

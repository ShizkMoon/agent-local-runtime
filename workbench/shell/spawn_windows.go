//go:build windows

package main

import (
	"os/exec"
	"syscall"
)

// hideConsole 等价于 node 的 windowsHide：GUI 子系统下 spawn node.exe
// 不弹控制台窗口（CREATE_NO_WINDOW）。
func hideConsole(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: 0x08000000, // CREATE_NO_WINDOW
	}
}

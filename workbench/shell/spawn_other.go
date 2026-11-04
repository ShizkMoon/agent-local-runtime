//go:build !windows

package main

import "os/exec"

// hideConsole 非 Windows 无控制台窗口概念，空实现。
func hideConsole(*exec.Cmd) {}

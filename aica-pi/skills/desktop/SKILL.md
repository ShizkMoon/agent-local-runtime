---
name: desktop
description: Windows 桌面 GUI 自动化（UIA）：用 agent_desktop 工具读取桌面窗口无障碍树、按元素 ref 做点击/输入/按键，并可截图取证。
---

# desktop

`agent_desktop` 工具包装本机 `agent-desktop.exe`（UIA 无障碍树）。参数是 argv 数组（不经 shell），大输出自动落盘 `artifacts/` 并回 `ref=`，按 ref 再精确切片读。

## 典型流程

1. **看窗口**：`['windows']` 列顶层窗口（标题/handle/进程），先确认目标程序在不在。
2. **快照**：`['snapshot']` 全桌面无障碍树；`['snapshot','--app','<窗口名>']` 限定单个窗口；交互式元素用 `['snapshot','-i']` 只看可控件。快照里每个元素带 `ref`（如 `e42`）。
3. **动作**：拿到 ref 后做语义动作——`['click','e42']`、`['type','e42','要输入的文本']`、`['press','Enter']`（具体子命令集以 `['--help']` 输出为准）。
4. **验证**：每个动作后**重新 snapshot** 确认效果，不要连打一串盲操作。
5. **取证**：`['screenshot']` 截图落盘，输出里给 png 路径；交付证据时把截图路径写进 result refs。

## 纪律

- 桌面操作有真实副作用：付款、删除、对外发布类动作一律不做，走 `ev_gate` 问人工。
- 快照可能很大：先 `--app` 限定范围，命中落盘 ref 后只读需要的那几段。
- 找不到目标元素时先刷新快照（窗口可能未就绪或已弹新窗），重复失败就截图取证再上报。

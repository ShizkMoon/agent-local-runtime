## 2026-11-04T05:28:01.109Z · sha1:60b53f5216
消费上游 artifact 时：先看 events.jsonl 里的 kind=input 记录，被跳过的 ref（源文件不存在/路径不存在）就已经在物化阶段确定，不要去重试或臆造内容；只对真实物化到 inputs/ 的文件算消费成功。

## 2026-11-04T05:27:42.190Z · sha1:07be148270
smoke-state run 目录下 spec.json 的 goal/accept 常是占位串（如 "root goal"/"a1"），先扫同 run 的 sub*/result.json 与 live1/events.jsonl 判断真实意图，别凭空扩范围；live1 的 "sleep forever" 类节点会导致 run 永不 settle，需上层超时。

## 2026-11-04T05:27:19.552Z · sha1:dea92634fc
测试经验B：art:// 引用要先物化

## 2026-11-04T05:27:19.551Z · sha1:957226e09e
测试经验A：agent-desktop 快照前先 windows 列窗口

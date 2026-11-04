# art1 执行摘要

上游 artifact 已消费：`inputs/hello.txt`（23 字节，内容 `hello-artifact-content`，sha256 `881578ea…a169`）读取成功；信封声明的另外两个输入（`art://…/root/missing.txt`、`C:/no/such/file.txt`）在物化阶段已被跳过，按缺失输入容错处理，未臆造内容、未阻塞节点。

证据：
- `artifacts/consume.log` — 输入清单、sha256、字节数
- `sha256sum inputs/hello.txt` → 退出码 0

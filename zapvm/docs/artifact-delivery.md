# Artifact 产物交付

Resident Agent 只能把产物写入 Guest 的固定目录 `/workspace/artifacts/<task-id>`。Task 成功后，Host daemon 使用 pinned-open 快照复核路径、类型、大小和 SHA-256，把文件复制到 owner-only 短期 spool，并生成 256-bit capability。Guest、模型和通用 Bash 都不会获得对象存储凭据。

## 数据链路

```text
Guest output directory
  -> Host verified spool + 15 minute capability
  -> zapvm-node registers immutable metadata with the active Task lease
  -> zapvm-node redeems the local capability over owner-only IPC
  -> mTLS PUT /v1/node/tasks/<task>/artifacts/<artifact>/content
  -> zapvm-control streams to a private S3-compatible bucket
  -> durable state changes pending -> available
  -> Web requests a five-minute signed HTTPS GET URL
```

Control derives tenant、project、Computer、Session、Task 和 Node ownership from the authenticated Node and active lease. The Node cannot submit those fields, the Web client cannot mutate Artifact metadata, and public responses never expose the internal object key, Node generation, lease token or storage credential.

## 状态与失败语义

- `pending`：metadata 已登记，内容尚未完成持久化；不能下载。
- `available`：S3 upload 的字节数与 SHA-256 已复核并完成状态提交；可以申请短期下载 URL。
- `failed`：产物上传失败；原 Agent Task 的执行成功语义不被篡改，同时事件流包含 `artifact.collect_failed`。
- `expired`：retention 已到期；立即停止签名下载。后台 GC 删除对象并写入 `artifact_delete` audit；失败会重试。

内部 object key 在 metadata 登记时由 scope hash、Artifact ID 和 SHA-256 确定，即使对象写入与 lease completion 之间发生故障，retention GC 仍能定位并清理潜在孤儿对象。

## 容量与保留

默认限制：单文件 5 GiB、单 Task 20 GiB、单 tenant/project scope 100 GiB、单 Task 100 个文件。`artifact_bytes_per_task` 和 `artifact_bytes_per_scope` 可在 Control 配置里收紧或放宽到安全上限。达到配额返回稳定的 `quota_exceeded`，不会创建新的 metadata 或对象。

Artifact retention 默认为 7 天，可在 1 小时到 30 天之间声明。bucket 必须保持 private，并建议额外配置 provider 侧 lifecycle 作为灾难恢复兜底；应用内状态和 audit 仍是下载授权与删除进度的权威来源。

对象删除后，expired metadata 额外保留 7 天用于 UI 解释和恢复审计，然后写入 `artifact_prune` audit 并移除。关联 Task/Event 只有在完整 Session 达到 Control retention 且全部 Artifact metadata 已退出后才会回收。

## S3-compatible 配置

```json
"artifact_store": {
  "endpoint": "https://objects.example.com",
  "region": "us-east-1",
  "bucket": "zapvm-artifacts",
  "access_key_file": "/run/zapvm-control/artifact-s3-access-key",
  "secret_key_file": "/run/zapvm-control/artifact-s3-secret-key"
}
```

Endpoint 必须是无 path、无 query、无内嵌 credential 的 HTTPS origin。Credential 文件必须为 owner-only；临时凭据可额外使用 `session_token_file`。`zapvm-control --validate` 会验证配置和 credential 文件，但不会在启动前打印或探测 bucket 内容。

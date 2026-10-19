# Host Artifact Collector

Host Artifact Collector 是 Remote Agent Task 与后续对象存储之间的本地安全边界。它只在 daemon 所在的真实 Host 上运行；Guest、浏览器和 Control 都不会获得 Host 路径、spool 路径或长期对象存储凭据。

## 输出目录契约

Control 为每个 Resident Agent Task 固定生成 `artifacts/<task_id>`，并通过受信的 Resident wrapper 注入：

```text
ZAPVM_ARTIFACT_DIR=/workspace/artifacts/<task_id>
```

用户请求不能覆盖该目录。wrapper 在启动 Zap 前创建目录，并向 Agent 的内部执行说明追加以下约束：只把最终可下载文件复制到该目录；只允许普通文件和目录；不得放入 symlink、设备文件、credential 或 secret。源码修改仍留在正常 workspace，不会被自动当成下载产物。

## Task 完成后的 Host 流程

1. Guest Task 到达 `succeeded`，Control Task 仍持有当前 Node lease。
2. Node 通过 owner-only daemon IPC 请求采集精确的 `task_id + computer_id`。
3. daemon 同时验证本地 Task 已成功、Task 属于该 Computer，并从 owner-only Computer store 取得真实 workspace；调用方不能提交 workspace 路径或 output 路径。
4. Collector 从固定目录建立不可变 Host spool 快照，计算 MIME、size 和 SHA-256。
5. daemon 返回 Artifact metadata 和 15 分钟本地 capability。Node 只把 metadata 发给 Control；原始 capability、spool 目录和 Host 路径不会离开 Host。
6. Control 从当前 lease 对应的 Task 推导 tenant/project/computer/session/task 归属，创建或幂等复用 `pending` Artifact。
7. Node 上传对象并等待全部 Artifact 转为 `available`，然后追加 `artifact.collect_completed` 事件（包含最终文件数量）。
8. Node 最后完成 Control Task。Web 必须以 Control 的 terminal Session 为准，不能把 Guest 的 `exec.result` 当成产物交付完成。

## 路径与文件安全

采集时每一级源路径都使用平台 pinned-open 语义重新打开：macOS/Linux 使用 `openat + O_NOFOLLOW`，Windows 使用 `FILE_FLAG_OPEN_REPARSE_POINT` 并检查 reparse attribute。Collector 会整体拒绝：

- workspace 外路径、绝对路径、`..`、反斜杠路径；
- `.git`、`.zapcode`；
- symlink、junction 和其他 reparse point；
- FIFO、socket、device 等特殊文件；
- 单文件超过 5 GiB、总量超过 20 GiB、文件数超过 100；
- 采集期间 size、identity 或 mtime 改变的文件；
- 空文件（当前 Artifact 契约要求 size 大于 0）。

任何一个条目失败都会废弃整个 staging 快照，不产生部分 capability。源 workspace 不会因采集失败而被修改。

## Capability 与清理

capability 是 256-bit 随机值。spool 目录只使用 capability 的 SHA-256 命名，manifest 不保存原始 capability。spool root、目录、文件和 manifest 在 POSIX Host 固定为 owner-only `0700/0600`；Windows 继承 daemon state root 的当前用户 ACL 边界。

daemon 每分钟清理过期 capability，启动和每次采集前也会清理；staging 崩溃残留在恢复时删除。后续 uploader 只能通过 daemon 内的 capability redeem API 打开快照文件，并仍需在上传流中复核 size/hash。Guest 永远不会接触 capability 或对象存储授权。

## 失败语义

Artifact 采集、metadata 登记或对象上传失败不会把已经成功的 Agent 执行改成失败。Node 会追加稳定的 `artifact.collect_failed` Task event（`artifact_collection_failed`），同时仍按执行结果完成 Task，使 Web 能明确显示“执行成功、产物不完整”，而不是把它误报为完整交付。成功路径会追加 `artifact.collect_completed`；即使文件数量为零，也能与“仍在收集”“收集失败”区分。

## 验证

```bash
go test ./internal/artifactcollector ./internal/workspacefs ./internal/cloudnode ./cmd/zapvm
go test -race ./internal/artifactcollector ./internal/workspacefs ./internal/cloudnode
```

测试覆盖正常快照/redeem、TTL/显式清理、symlink、受保护路径、FIFO、大小上限、失败原子性、Task/Computer 绑定、Node metadata 登记，以及 capability 不发送到 Control。

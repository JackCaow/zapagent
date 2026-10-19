# zapVM 远端 Agent 可观测性与排障手册

本文定义 P0 单 active Control + 多 Remote Host 形态的低敏观测契约。日志、指标和排障记录不得包含 prompt、credential value、模型响应正文、Host 绝对路径、Guest 文件内容或证书私钥。

## 1. 关联一次 Web Task

1. 浏览器请求经 BFF 获得 `X-Request-ID`；失败界面可显示该 ID。
2. BFF 访问日志记录同一个 `request_id`，并把它转发给 Control。
3. Control 访问日志记录 `request_id`、归一化 route、HTTP 状态和耗时；成功创建时另记 `operation=task_submit task_id=...`。
4. Node 对一次 Control 请求生成 `node-*` 请求 ID，同一幂等重试组复用该 ID；Task 生命周期日志以同一个 `task_id` 关联。
5. daemon 日志和 Guest Event Journal 都以 `task_id` 为主键；Guest command ID 固定等于 Task ID。

因此查询顺序为：`browser request_id -> BFF request_id -> Control task_submit task_id -> Node task_id -> daemon task_id -> Guest Event Journal task_id`。不要依赖 prompt 或本机路径做检索。

## 2. 健康与指标接口

- `GET /healthz`：进程存活和 mTLS 可达性；Store degraded 时仍可返回 `200`。
- `GET /readyz`：接流量就绪；Store closed/degraded 时返回 `503 store_degraded`。
- `GET /v1/admin/metrics`：仅管理员 mTLS 身份可访问，返回低基数聚合 JSON。

核心指标包括：

- Node 状态、daemon 状态和最旧 heartbeat age；
- Task 各状态数量、最旧 queue/running/canceling age；
- active Task 最大 event lag；
- terminal Task latency 与 cancel latency 的 count/total/max；
- VM start attempts/failures 与 boot duration total/max；
- PostgreSQL shadow mirror pending/failure/lag，以及 primary backend 是否启用；
- 按归一化 route/method/status 聚合的 HTTP count/latency。

指标不携带 tenant、project、Computer、Task、Operation 等高基数字段；逐 Task 排障使用结构化日志和审计链。

## 3. 内置告警

`store.alerts` 返回当前触发的稳定告警码：

| 告警码 | 默认阈值 | 首要检查 |
| --- | --- | --- |
| `node_offline` | Control 的 heartbeat TTL | Node 服务、出站 mTLS、Control `/readyz` |
| `task_queue_stuck` | queue age 2 分钟 | 在线且可调度 Node、capacity、daemon state |
| `task_event_stuck` | active event lag 5 分钟 | Node Task 日志、daemon Task、Guest Event Journal |
| `task_cancel_stuck` | canceling age 30 秒 | Node cancellation poll、daemon cancel、Guest 进程树终止 |
| `state_mirror_failed` | 首次实际 PostgreSQL mirror 写失败 | PostgreSQL 连接、migration、全表摘要漂移 |
| `state_mirror_lag` | pending 30 秒 | 数据库写延迟、连接池、快照规模 |

生产监控每 15 秒读取一次管理员指标；连续两次出现 critical 或连续四次出现 warning 才通知，恢复后发送 resolved。外部告警系统只保存告警码、计数、阈值和时间，不保存身份或任务内容。

## 4. 排障顺序

### Node offline

1. 确认 `/healthz=200` 且 `/readyz=200`。
2. 在管理员 Node 清单核对 generation、last heartbeat、daemon state、version 和 image digest。
3. 检查 Node 日志中的 `operation=heartbeat/register` 固定错误码。
4. 在 Host 执行 `zapvm daemon status`，确认 daemon IPC、镜像和 pool 状态；不得把 owner-only 配置或原始错误上传到公共工单。
5. Node 恢复后 generation fence 会将旧租约重排；确认没有双重有效执行。

### Task stuck

1. 用浏览器 request ID 在 BFF/Control 定位 Task ID。
2. 查询 Task snapshot、cursor 和最后事件时间。
3. 查看 Node `task_execute`，再查看 daemon `task_execute`；两层都只按 Task ID 查询。
4. 若 daemon 已结束但 Control 未终态，检查 Node complete/event POST；安全地复用同一幂等请求。
5. 若 Guest 无新事件，执行取消；30 秒仍未确认则隔离/销毁该 VM，不回池。

### Store degraded

1. `/healthz` 继续用于存活判断，立即停止把新流量送往 `/readyz=503` 的实例。
2. 保存 owner-only state 目录的只读副本并检查磁盘、权限、空间和审计链；不要手工编辑 `state.json`。启用 PostgreSQL 时同时检查 mirror/primary 指标与数据库连通性，禁止让本地文件反向覆盖已存在的 primary snapshot。
3. 只有明确命中旧 payload digest 故障时才离线使用 `zapvm-control --repair-payload-digests`。
4. 修复后重启单一 Control，确认 `/readyz=200`、Node generation 重新注册和租约收敛。

## 5. 验收证据

一次版本验收至少保留：测试版本/SHA、Host 平台、镜像 digest、开始结束时间、Task ID、各层低敏日志命中、指标前后快照、终态和清理结果。不得把访问令牌、模型密钥、证书私钥、prompt、Host 路径或 Guest 文件正文写入证据包。

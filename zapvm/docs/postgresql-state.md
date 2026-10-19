# PostgreSQL 一致性状态与分布式队列

GA-01 把单 active Control 的 `state.json` 迁移为事务化 PostgreSQL 状态。迁移分为 schema、在线镜像、主存储切换三个独立门禁；mirror 模式以单文件为权威，primary 模式以 PostgreSQL 为权威并持续维护单文件回滚缓存。

## GA-01a schema 与迁移器

- `internal/controlpostgres/migrations` 内嵌连续、带 SHA-256 的不可变 SQL migration。
- `zapvm-control-db migrate|status` 只从指定环境变量读取 DSN，不接受包含密码的 argv。
- 非 localhost 默认强制 PostgreSQL TLS；本地容器只有显式 `--development-insecure-localhost` 才允许 `sslmode=disable`。
- migration 使用 PostgreSQL advisory lock 和单 migration Serializable transaction；重复执行严格幂等，已应用 checksum/name 漂移或数据库版本高于二进制时 fail closed。
- 初始 schema 覆盖 Node、Node scope、Computer、Agent Session、Task、Event、Workspace/Git operation、Artifact、scope dispatch、Audit 和全局序列。
- Task/operation lease 字段由数据库 CHECK 保证状态一致，lease token hash 使用 partial unique index，Task/Event cursor 和 idempotency ID 使用唯一约束。
- 所有 tenant/project 表启用并强制 RLS。普通事务必须设置 `zapvm.tenant_id`、`zapvm.project_id`；调度/迁移事务必须显式设置 transaction-local `zapvm.bypass_rls=on`，且当前数据库角色必须是 `zapvm` schema owner 或其成员。普通角色自行设置 bypass 不会获得跨租户权限。

## GA-01b-1 文件快照导入与校验

- migration v2 把 Computer 与 Node 修正为多对多 `computers + computer_nodes`，兼容显式 Computer catalog 和 legacy scope-wide 调度；历史 Artifact 仍保留注册 Node，但不被当前 Node scope 反向删除。
- `zapvm-control-db import-file` 读取 owner-only Control config，取得与 Control 相同的独占 Store lock，并通过现有 Store loader 完成文件 schema migration、严格 JSON 解码、权限关系归一化和完整状态校验。
- 导入按外键顺序在一个 Serializable transaction 内替换 PostgreSQL 投影。任一行失败会整体回滚，错误输出不包含 Task payload、prompt、路径或 PostgreSQL failing row。
- `file_mirror_state` 保存私密源快照的 SHA-256、数据库全表规范摘要、逐表行数和导入时间；相同快照再次导入为零写入。
- 导入前会重算现有数据库摘要。已跟踪数据库发生漂移时默认拒绝覆盖，只有人工确认后加 `--repair-drift` 才重建；没有 mirror metadata 的非空数据库必须额外加 `--replace-untracked`。
- `verify-file` 同时比较文件 schema/源摘要、数据库全表摘要和逐表行数，完全只读。

## GA-01b-2 在线镜像

- `state.json` 仍是唯一写入确认和恢复权威；每次状态变更先以原有原子写落盘，再把同一份规范快照交给 PostgreSQL mirror worker。
- Control 启动时持有独占 Store lock，并同步 reconcile 当前文件快照。数据库 schema 未迁移、数据库包含未跟踪状态、mirror 漂移或连接失败时不会开始监听。
- 在线 worker 只保留最新 generation，高频 Event/Task 更新会合并，但 PostgreSQL 最终快照必须与最新 `state.json` 全量摘要一致。每次导入仍使用 migration/file-import advisory lock 和 Serializable transaction。
- worker 的一次真实写失败会把 `/healthz` 置为 not ready，并在管理员 operational snapshot 产生 `state_mirror_failed`；后续状态变更 fail closed。后台按配置重试，恢复并追平最新 generation 后 readiness 自动恢复。
- pending 超过 30 秒产生 `state_mirror_lag` warning。正常关闭会在仍持有文件 Store lock 时等待最新 generation 刷入 PostgreSQL；超过 `flush_timeout_seconds` 则进程以失败退出，不能静默丢弃尾部镜像。
- DSN 只从 owner-only、非 symlink 文件读取，错误与日志不会包含 DSN、用户名或密码。Control 不自动运行 migration，发布流程必须在启动前显式执行 `zapvm-control-db migrate`。

在 Control 配置中启用：

```json
"postgresql_mirror": {
  "dsn_file": "/etc/zapvm/postgres-dsn",
  "retry_interval_seconds": 5,
  "flush_timeout_seconds": 120
}
```

本地一次性 PostgreSQL 容器使用 `sslmode=disable` 时，还必须显式设置 `development_insecure_localhost: true`；生产数据库默认强制 TLS。

GA-01b-2 仍没有移除 `state.json`。PostgreSQL 主存储读写和单文件回滚演练属于 GA-01c。

## GA-01c PostgreSQL 主存储

- migration v3 新增全局 `primary_state`。一次 Control 状态提交会在同一个 Serializable transaction 内更新规范化表、mirror 摘要和完整规范快照；数据库事务成功后才更新本地 `state.json` 回滚缓存。
- 启动时先读取并校验 PostgreSQL 主快照、源摘要、全表摘要和逐表行数。只要主快照存在，本地文件缺失或损坏都不会覆盖数据库；Control 会从数据库恢复并原子修复文件缓存。
- 首次从 mirror 切到 primary 时，数据库尚无 `primary_state`，Control 只允许用当前有效 `state.json` 初始化。未跟踪数据、schema 漂移或 mirror 差异仍会 fail closed。
- owner-only 配置中的 Node/Scope/Computer provision 仍是权限权威。配置变化时，Control 先按新 provision 归一化数据库快照并同步提交，再开始监听。
- PostgreSQL 同步提交失败时，本次变更不会进入文件缓存，Store 立即 degraded；重启从上一个已提交数据库快照恢复。数据库已提交但文件缓存写失败时同样 fail closed，重启会用数据库修复缓存。
- primary 存在后，普通 `import-file` 和 mirror 写会被拒绝，避免旧文件反向覆盖数据库。确认 Control 已停止且本地缓存就是要恢复的权威时，显式 `import-file --repair-drift` 会在同一事务修复规范化投影并更新 primary snapshot。
- 该模式仍是单 active Control，并用完整快照事务保证一致性。多副本 claim、细粒度 SQL 调度、outbox/inbox 和 leader-free lease 属于 GA-02，不能仅因启用 primary 就扩容 Control。

确认 GA-01b-2 差异为零并停止 Control 后，把配置从 `postgresql_mirror` 改为：

```json
"postgresql_primary": {
  "dsn_file": "/etc/zapvm/postgres-dsn",
  "operation_timeout_seconds": 120
}
```

首次 primary 启动会原子建立 generation 1，此后每个成功状态变更递增 generation。生产连接继续强制 TLS；本地容器才允许 `development_insecure_localhost: true`。

## GA-02a PostgreSQL Queue、Lease 与 Fencing 原语

- migration v4 为 Task 增加 `payload_raw`，避免 `jsonb` 规范化改变下发字节后与 `payload_sha256` 不一致。升级后只要存在尚未由完整快照重建的 pending/active Task，Queue 就 fail closed，不能静默跳过。
- claim 在一个事务内锁定 Node、重收过期 lease，并用 `FOR UPDATE SKIP LOCKED` 竞争 pending Task；Node scope、Computer affinity、credential 隔离和实时 capacity 都在 SQL claim 路径校验。
- 每次 attempt 生成 256-bit 随机 lease token，只把 SHA-256 存入数据库。ack、续租、Event、完成和取消确认同时校验 Node ID、generation、attempt 的当前 token 与 expiry；过期 attempt 的旧 token 不能修改重领后的 Task。
- `task_transition_receipts` 以 attempt/action/token/request digest 固化 ack、completion 和 canceled 的幂等结果；同一 token 携带不同 completion 会冲突。Event 以 attempt/source cursor 去重，并在 Task 范围分配单调 cursor。
- `task_outbox` 用摘要 dedupe key，多个 Control replica 通过 `SKIP LOCKED` 抢占通知，claim 过期可由其他 replica 接管，只有当前 claim owner 能确认交付。
- 过期 lease 在 claim 事务内重排队；取消未确认或第 10 次 lease 耗尽进入明确失败终态。Node `in_flight` 同事务释放，renew proof 批次任一失效则整批回滚。
- GA-02b2 在相同事务边界上增加 Node register/heartbeat/report、generation 切换、Task/Resident Session submit/list/retry、Event replay/wait 和 PostgreSQL audit chain。Session admission 使用事务 advisory lock，两个副本不能同时创建同一 Session 的首个或 continuation turn；generation 切换会立即 requeue/fail 旧 generation 的 active Task 并使旧 token 失效。
- GA-02b3 增加 Artifact 与 Workspace/Git operation 的 PostgreSQL 权威状态、配额、过期、GC、lease 重领及 generation fencing。Workspace 成功结果同时保存可查询 JSONB 和用于 SHA-256 校验的原始字节；迁移遇到尚未过期的旧格式成功结果会 fail closed，不能用 JSONB 重排后的字节冒充 Agent 原始结果。
- Control 可在 `postgresql_primary.mode` 显式设为 `distributed` 时直接使用行级 PostgreSQL Backend。启动会校验 migration 已全部应用，并将 Node/Scope/Computer provision 与数据库权限集合做精确对账；缺失项可安全补齐，额外授权会拒绝启动。默认值仍为 `snapshot`，现有部署不会静默切换。
- 旧配置只有 Scope、没有显式 Computer 时，切换会接纳由历史 Task/Workspace/Artifact 实际引用且严格位于该 Scope 节点集合内的动态 Computer；无引用、越权或显式 Computer Scope 中的额外数据库行仍会拒绝启动。普通命令的 `SessionID` 不会再误投影为跨 Computer 唯一的 Resident Agent Session。
- 两个独立 Backend 实例共享同一 PostgreSQL 的验收已覆盖跨副本 submit/claim/ack/Event/long-poll/complete、heartbeat timeout、后台 lease 回收及 capacity 释放。Event 等待以数据库游标为权威，副本本地不保存不可恢复的 fan-out 状态。

`distributed` 已接入完整 HTTP Control Backend。本地 PostgreSQL 16 已验证独立连接池副本终止、替代副本启动、数据库暂停期间 readiness 失败、恢复后连接池重连和持久状态不丢；Railway 真实多副本滚动与网络故障注入尚未执行，因此 Railway 仍保持 1 个 Control replica。此限制是部署验收门禁，不是代码继续依赖单 active 完整快照。

切换前先应用当前全部 migration，确认没有旧格式成功 Workspace operation，然后把 primary 配置改为：

```json
"postgresql_primary": {
  "dsn_file": "/run/zapvm-control/postgres-dsn",
  "mode": "distributed",
  "placement_mode": "static",
	"computer_start_timeout_seconds": 120,
  "operation_timeout_seconds": 120
}
```

`placement_mode` 默认是 `static`，保持现有 `computer_nodes` 调度行为。P1/P2 灰度可显式改为 `dynamic`：Control 会为 Computer 创建唯一 active placement，以 epoch 绑定 Task，并只允许被分配 Node 的对应 generation Claim。Control 随后创建可租约、可 fencing 的 start operation；Node 通过 daemon `computer.start` 预热 VM，成功完成操作后 Task 才进入可 Claim 状态。并发 Task 共享同一 start operation，Node generation、drain、lease 和 deadline 都会阻止 stale completion。`computer_start_timeout_seconds` 不得超过全局 `task_dispatch_timeout_seconds`。

动态模式下 daemon 继续以 `idle_timeout` 作为唯一 Hot VM 空闲计时器。clean stop 后，Node heartbeat 回报仅含 Computer ID/runtime state 的有界 inventory；PostgreSQL 只释放该 Node generation 上已经成功启动且无 active Task 的 placement，随后新 Task 必须创建更高 epoch 并重新 start。它完成了本地 Hot→Warm 计算回收；远端状态盘挂载、对象存储 snapshot/restore、Cold 恢复和长期 idle soak 仍属于后续阶段。

`distributed` 模式不再把 `/data/state.json` 作为运行时写入或回滚缓存。回滚到 `snapshot` 或文件 Store 前，必须停止所有 Control 副本并执行专门的数据库导出/恢复流程；不得直接切换配置读取旧缓存。

## 本地验收

需要 Docker：

```bash
./scripts/acceptance-postgres-schema.sh
```

脚本启动一次性 PostgreSQL 16，重复执行 migration，验证真实约束、RLS、checksum、分布式 claim/fencing/outbox、双 Backend 副本事件恢复、独立副本终止与滚动替换、数据库暂停/恢复、Workspace/Git 与 Artifact 生命周期，并在退出时只删除该次精确命名的测试容器。

脚本还会创建真实 owner-only Control config/state，依次验证首次导入、幂等导入、全表校验、篡改拒绝、显式 repair、Control Store 持锁时 CLI fail closed、在线 mirror 关闭前追平、primary 初始化、同步提交、损坏文件恢复和切回单文件；Queue 部分验证并发只租一次、幂等 transition/Event、过期重领、旧 lease fencing、批量续租原子性和 outbox 单消费者。

手工连接生产兼容 PostgreSQL 时，DSN 必须通过 Secret 环境变量提供：

```bash
ZAPVM_POSTGRES_DSN='postgresql://...' zapvm-control-db migrate
ZAPVM_POSTGRES_DSN='postgresql://...' zapvm-control-db status
```

首次离线导入前必须停止 Control：

```bash
ZAPVM_POSTGRES_DSN='postgresql://...' \
  zapvm-control-db --control-config /etc/zapvm/cloud-control.json import-file

ZAPVM_POSTGRES_DSN='postgresql://...' \
  zapvm-control-db --control-config /etc/zapvm/cloud-control.json verify-file
```

`import-file` 会先应用当前 binary 内的 migration。CLI 只输出摘要和行数，不输出文件内容。若 Control 尚未停止，独占 state lock 获取失败，导入和校验都不会绕过锁读取。

Railway 镜像包含 migration binary。推荐把 DSN Base64 注入 `ZAPVM_POSTGRES_DSN_B64`，入口会落为 `/run/zapvm-control/postgres-dsn` 的 owner-only 文件；配置中的 `dsn_file` 必须指向该路径。首次部署或 binary 带新 migration 时，另设 `ZAPVM_POSTGRES_MIGRATE=1`，入口在启动 Control 前读取同一文件执行 migration，并立即清除临时 DSN 环境变量。也兼容只为 migration 提供 `ZAPVM_POSTGRES_DSN`，但运行时 mirror/primary 始终从文件读取。

## 回滚边界

GA-01b-2 回滚只需先停止 Control、用 `verify-file` 确认差异为零，然后删除 `postgresql_mirror`。GA-01c 正常关闭后，`state.json` 已是最后一次成功 PostgreSQL 提交的完整缓存；删除 `postgresql_primary` 并重启即切回单文件。若进程因文件缓存写失败而 degraded，必须先用同一 primary 配置重启一次，让数据库权威快照修复文件，确认干净关闭后再切回。禁止自动 down migration、`DROP` 表或在运行中切换配置；保留 PostgreSQL 数据直到回滚验收完成。

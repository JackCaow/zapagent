# 多租户云端 Agent

zapVM 云端形态由三个独立信任域组件组成：

1. `zapvm-control`：mTLS 控制面，持久化租户 Task、节点 lease、输出事件和 hash-chain 审计。
2. `zapvm-node`：部署在 VM Host，与控制面建立出站 mTLS 连接，将授权 Task 投递到同用户的本地 zapVM daemon。
3. 本地 daemon/Guest Agent：保持原 owner-only IPC、Computer、credential ID 和 VM 隔离协议，不向公网暴露 socket。

控制面不接收节点声明的租户权限。节点、容量和 tenant/project scope 只能来自 owner-only `cloud-control.json`。客户端 tenant/project 只能来自经过 CA 验证的 SPIFFE URI：

```text
spiffe://<trust-domain>/tenant/<tenant>/project/<project>/client/<client>
spiffe://<trust-domain>/node/<node>
spiffe://<trust-domain>/control/<control>
```

`nodes[].computers` 可以进一步把稳定 Computer ID 显式绑定到该 Node 已授权的 tenant/project scope。存在显式目录时，调度器只把 Task 交给声明了目标 Computer 的 Node；同 scope 中省略 `computers` 的旧 Node 也不能成为 wildcard 绕过。Web 端通过脱敏目录看到聚合后的 `online`、`draining` 或 `offline`，看不到 Node ID。只有整个 scope 都没有显式 Computer 时，旧配置才保留 scope-wide 调度兼容性；这类隐式 Computer 不进入可枚举目录。

## 执行与恢复语义

- Task ID + 严格 Computer Task payload 提供幂等提交；同 ID 不同 digest fail closed。
- 调度在节点授权 scope 内轮转，避免单一 tenant/project 长队列持续占用共享节点。
- 每次 claim 生成 256-bit lease token，磁盘只保存 SHA-256；节点 generation 变化会立即 fence 旧 worker。
- heartbeat 只续签携带有效 Task proof 的 lease；超时 Task 以同一 ID 重投，最多 10 次。
- 节点先 ack 再提交本地持久 Computer Task；本地输出按 attempt/source cursor 上传，控制面重新分配单调全局 cursor。
- Node 与 Control 为每个 active Task 建立一条出站 mTLS WebSocket Relay。Guest 事件按 25ms、64 条或 64 KiB 的最先命中边界合并，Control 持久化完整 batch 后返回 ACK；连接中断时 Node 以相同 batch/source cursor 重放，Store 的幂等规则避免重复。`relay_mode=required` 让生产节点在 Relay 不可用时 fail closed；`auto` 仅用于滚动升级，会回退旧逐事件 HTTPS；`off` 只用于兼容诊断。
- Relay 性能路径与 Browser ↔ Guest E2EE 的信任边界、激活门槛见 `docs/realtime-relay.md`；握手接线完成前不能把 mTLS 标记为端到端加密。
- 取消对 pending Task 立即生效；leased/running Task 进入持久 `canceling`，Node 用当前 generation 和 lease proof 拉取 intent，调用 daemon `computer.task.cancel` 终止 Guest 进程树，再显式确认 `canceled`。控制面或连接重启不会丢失 intent；未确认取消不会重新调度执行。
- state、输出和 redacted audit 使用单一 0600 原子快照，审计记录带连续 SHA-256 hash chain；损坏或写入失败后 fail closed。
- 控制面只传 credential ID，不接收 credential value。带 credential 的 Task 只会调度到单 tenant 节点；实际值继续由 Host 本地 owner-only broker 持有。

当前执行语义是带 fencing 的 at-least-once。节点失联后旧 Guest 进程可能短暂继续运行，但旧 lease 无法再上传事件或完成 Task；命令应使用 Task ID 作为外部副作用幂等键。

## 部署

示例配置：

- [cloud-control.json](../packaging/examples/cloud-control.json)
- [daemon.json](../packaging/examples/daemon.json)
- [cloud-node.json](../packaging/examples/cloud-node.json)
- [cloud-node-managed.json](../packaging/examples/cloud-node-managed.json)：短期证书自动注册/轮换

配置、私钥和控制面 state 目录必须 owner-only。先离线校验：

```bash
zapvm-control --config /etc/zapvm/cloud-control.json --validate
zapvm daemon run --config ~/.config/zapvm/daemon.json --validate
zapvm-node --config ~/.config/zapvm/cloud-node.json --validate
```

Linux 模板：

- [zapvm-control.service](../packaging/systemd/zapvm-control.service)：独立 `zapvm-control` 系统用户。
- [zapvm-daemon.service](../packaging/systemd/zapvm-daemon.service)：真实 VM Host 的同用户 daemon。
- [zapvm-node.service](../packaging/systemd/zapvm-node.service)：与本地 daemon 相同用户的 user unit。

生产 Linux Remote Host 使用带 release 验签、KVM/systemd/linger 前置门禁、原子升级和回滚的 [Host 安装器](./host-install-linux.md)。静态 unit 模板用于审查和手工集成，不能替代安装器的 release/config 验证。

macOS 除 `com.zapvm.daemon.plist.example` 和 `com.zapvm.node.plist.example` 外，还提供带签名检查、原子升级和回滚的用户级 [Remote Host 安装器](./host-install-macos.md)。Windows 使用 Authenticode trust anchor、受保护 ProgramData release 和原生 SCM service 的 [Remote Host 安装器](./host-install-windows.md)。三个平台的 service 都直接执行 JSON 配置，不经过 shell，也不通过环境变量传 credential value。先启动 daemon，再启动 Node；Node 在 daemon 不健康时仍 heartbeat，但不会领取新 Task。

只把单 active 控制面部署到 Railway 时，使用 [Railway 控制面部署](./railway.md)。Railway 不提供 VM Host 所需的 KVM、Hyper-V/HCS 或 Virtualization.framework，`zapvm-node` 和 daemon 仍部署在真实 Host。

生产配置应显式设置 `task_retention_seconds`。`0` 表示不自动删除；其他值必须在 1 小时到 365 天之间。Control 只按完整 Session/retry 组回收：组内任一 Task 仍活跃、最新 turn 尚在 retention 内，或仍有 Artifact metadata 引用时，Task 和 Event journal 都不会删除。默认示例使用 30 天。单 Task Event journal 还受 8 MiB 计量上限和 Control 24 MiB 总计量上限保护，达到边界返回稳定的 `quota_exceeded`，不会把 state 文件写爆。

生产上线必须使用不同的 control、node 和 client 证书，证书只包含一个 URI SAN，并由专用 CA/中间 CA 签发。启用 `node_identity` 后，Node 不再配置静态证书私钥：它使用 owner-only 单次 token 首次注册，本地生成私钥，并在到期前自动轮换短期证书。控制面端口只开放 TLS；daemon endpoint 永远不开放到公网。

## API

除首次 Node 注册外，所有 API 均要求 TLS 1.3 双向证书。`POST /v1/node/enroll` 只在 Control 显式启用 Node identity authority 时存在；它验证 Control 服务器证书并要求未消费、未过期、绑定精确 Node ID 的单次 token。其余接口分类如下：

- client：`POST /v1/tasks`、`GET|DELETE /v1/tasks/<id>`、`GET /v1/tasks/<id>/events`、Resident Agent 会话接口、`GET /v1/audit`
- node：register、heartbeat、claim、ack、event upload、complete
- node realtime：`GET /v1/node/tasks/<id>/relay` 使用 `zapvm.task-events.v1` WebSocket subprotocol，open frame 绑定 generation/lease，event batch 使用单调 batch ID 和 bounded ACK。
- administrator：节点列表和 drain
- node identity：当前有效 Node 证书续签；管理员按证书 serial 吊销并 fence 当前 generation

管理员节点目录还返回 Node/daemon 版本、活跃镜像摘要、daemon 健康和稳定故障码。daemon `paused`、`degraded` 或 `unreachable` 时，Node 继续 heartbeat 和处理已有取消，但不会领取新 Task；租户侧只看到对应 Computer 不可用。Drain、升级、generation fencing 和故障处置见 [Remote Node 运维手册](./node-operations.md)。

错误响应只返回固定 code，不返回 Host 路径、证书细节、payload 或内部错误。

### 本地开发闭环

无需 VMM 硬件即可运行 Control、Node 和 daemon 协议的黑盒开发基线：

```bash
make verify-cloud-dev
```

该命令动态生成固定 SPIFFE 身份的短期开发 CA/证书，启动真实 TLS 1.3 mTLS HTTP Control、持久 Store、`zapvm-node` Worker 和 owner-only 本地 daemon IPC。测试会通过 Agent Session API 提交成功和取消两种 turn，经过 node register/heartbeat/claim/ack、daemon submit/attach、取消下推、event upload 和 complete，再从 Web Client 视角验证脱敏状态、`canceling → canceled` 及 cursor replay。测试退出时删除临时证书、state、socket 和凭据材料。

这个开发门禁只替代 VMM/Guest 执行本身。带签名镜像、真实 Zap、Session 恢复和 Guest 凭据清理仍由 `scripts/verify-resident-agent.sh` 在真实 Remote Host 验收，不能用本测试结果替代。

真实 Host 已启动 Control、Node、daemon 且已提交两个连续 turn 时，可以在同一入口追加真实 VM 门禁：

```bash
./scripts/verify-cloud-dev.sh --real-vm
```

该模式先执行无硬件协议闭环，再使用 `verify-resident-agent.sh` 所需的 `ZAPVM_*` 环境变量检查签名 Guest、真实 Zap 和 Session continuation。

### Resident Agent 会话

内置 Zap 的已签名 Guest 镜像可以把 Agent 本身放进 VM，而不只是把 Host Agent 的 Bash 工具代理进 VM。Web 后端仍使用 tenant/project client mTLS 身份提交一次 turn：

```json
{
  "id": "turn-01",
  "computer_id": "computer-a",
  "session_id": "web-session-a",
  "prompt": "inspect the project and run its tests",
  "provider_base_url": "https://api.example.com/v1",
  "model": "model-name",
  "model_credential_id": "model-api-key",
  "search_credential_id": "search-api-key",
  "continue": false,
  "max_turns": 80,
  "timeout_ms": 7200000
}
```

接口为：

- `POST /v1/agent/sessions`：创建幂等 turn Task；`id` 是 Task ID，`session_id` 是跨 turn 稳定的 Guest Session。
- `GET /v1/agent/computers`：列出当前 tenant/project 显式 provision 的脱敏 Computer 和聚合在线状态。
- `GET /v1/agent/git/providers`：列出当前 tenant/project 显式 provision 的非秘密 Git 仓库描述；不返回 token、App/Installation ID 或私钥路径。
- `GET /v1/agent/sessions?after=<cursor>&limit=<n>`：按持久 creation cursor 分页列出当前 tenant/project 的脱敏 turn，供 Web 刷新后恢复目录。
- `GET /v1/agent/sessions/<id>`：查询状态，不回显 prompt 或内部 argv payload。
- `GET /v1/agent/sessions/<id>/events?after=<cursor>&limit=<n>`：读取 Zap `stream-json` 和任务生命周期事件。
- `GET /v1/agent/sessions/<id>/stream`：通过 SSE 实时发送脱敏 session 状态和 Task 事件；支持 `Last-Event-ID`/`after` 断点恢复，每条连接最多 25 秒或 1000 条事件。
- `DELETE /v1/agent/sessions/<id>`：请求取消，并通过 node、Host daemon、Guest Agent 终止执行进程树。
- `POST /v1/agent/sessions/<id>/retry`：仅对 failed/canceled turn 创建带 `retry_of` 的新 Task；请求只含新 ID，原 prompt 与授权 payload 由 Control 服务端复制。
- `POST /v1/agent/computers/<computer_id>/workspace/operations`：创建幂等的 `list`、`read` 或 `diff` 只读操作。
- `GET /v1/agent/computers/<computer_id>/workspace/operations/<operation_id>`：查询操作和有界结果；不返回 Host 路径、Node 身份或 lease。
- `POST /v1/agent/computers/<computer_id>/git/operations`：对已成功且同 scope/Computer 的 Agent Task 创建幂等 Host Git push 和 Pull Request；请求只能选择 provisioned provider，分支固定为 `zapvm/<operation_id>`，PR 由 Control 创建或严格复用。
- `GET|DELETE /v1/agent/computers/<computer_id>/git/operations/<operation_id>`：读取或删除脱敏终态；不返回 clone URL、base branch、token 或 Host 路径。

workspace 操作只接受显式 provision 的 Computer 和 portable 相对路径。Control 持久化请求后由 Node 出站领取，再调用本机 daemon；`.git/.zapcode` 不可见，每级路径拒绝 symlink/reparse，文件与 diff 最大 512 KiB。Control 与 Web 都不能直接访问 Host 文件系统。

公开错误只使用稳定 `code/category/action/retryable`，不回传内部错误字符串或 Host 路径。`retryable=true` 仅允许用户显式重试或 GET/SSE 恢复，不允许 Client 自动重放创建、取消、retry 或 workspace POST；同一 `X-Request-ID` 从 BFF 传入 Control 用于关联排障。

新 Session 的首个 turn 必须使用 `continue=false`；后续 turn 必须使用 `continue=true`、保持原 `computer_id`，并等待已有 turn 全部进入终态。Control 在同一 Store 锁内完成校验和 Task 创建，避免并发 continuation 共享 HOME 执行。

同一对 `computer_id`、`session_id` 的后续 turn 设置 `continue=true`，Zap 会从该 Session 私有 HOME 下恢复会话。不同 Session 不共享 HOME、Zap 状态或请求凭据。provider URL 必须是无 userinfo/query/fragment 的 HTTPS URL；其域名还必须预先进入 Computer restricted allowlist。控制面只允许固定 Resident runner、`stream-json`、`bypassPermissions`、`/workspace` 和有界 max-turns/timeout，调用方不能借该接口提交任意 argv。

模型和搜索 token 只以 credential ID 出现在 Task 中，实际值由目标 Host 的 owner-only daemon binding 提供，并按请求挂载到 Guest。Resident runner 不接受 token value 参数；Zap 使用 `ZAPCODE_CONSUME_ENV_CREDENTIALS=1` 在启动配置时捕获 token，随后删除 `OPENAI_API_KEY` 和 `SERPER_KEY`，因此 Agent 发起的 Bash、npm、pip 等子进程不会继承模型密钥。

## 当前交付边界

这一实现适合单 active control-plane、多个租户隔离 Host 的 Beta。64 MiB/10000 Task 的原子 state 上限是明确的 fail-closed 边界，不是横向扩展数据库。正式多区域 GA 仍需外部一致性数据库/KMS、自动 CA 轮换、备份恢复演练以及限流/配额计费。

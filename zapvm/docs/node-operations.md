# Remote Node 运维手册

`zapvm-node` 通过出站 mTLS 把真实 VM Host 接入 Control。Control 的管理员节点目录是运行状态的唯一云端视图；租户 API 只返回聚合后的 Computer `online`、`draining` 或 `offline`，不会暴露 Node ID、Host 路径或本地错误。

## 短期 Node 身份注册与轮换

GA-03c 只支持 distributed PostgreSQL Control。Control 配置中加入 signer 和单次 token 的 SHA-256；原始 token 只放在目标 Host 的 owner-only 文件，不上传到 Railway 配置：

```json
"node_identity": {
  "signing_certificate_file": "/run/zapvm-control/node-identity-ca.pem",
  "signing_private_key_file": "/run/zapvm-control/node-identity-ca.key",
  "certificate_ttl_seconds": 21600,
  "renew_before_seconds": 1800,
  "enrollment_tokens": [
    {
      "node_id": "host-a",
      "token_sha256": "64-lowercase-hex-characters",
      "expires_at": "2026-08-09T00:00:00Z"
    }
  ]
}
```

Node 使用 [managed 配置示例](../packaging/examples/cloud-node-managed.json)。首次启动在 Host 本地生成 P-256 私钥，通过 server-authenticated TLS 消费 token，并把版本化证书/私钥和原子 `current.json` 写入 `identity_directory`（目录 `0700`、文件 `0600`）；成功后删除 token 文件。重启时只加载 `current.json`，不会复用已消费 token。续签必须携带当前仍有效且未吊销的证书，每次生成新私钥；失败按 30 秒至 5 分钟退避，在旧证书有效期内继续服务。

Control 配置中保留同一已消费 token 哈希不会重新激活它。要重新注册必须生成新 token 和新哈希；从配置删除 active token 会在启动 reconcile 中将其事务性吊销。不要把原始 token 写进日志、命令参数或 JSON 配置。

管理员按精确证书 serial 吊销：

```bash
curl --fail --silent --show-error \
  --cacert control-ca.pem --cert admin.pem --key admin.key \
  -X POST \
  https://control.example.internal/v1/admin/nodes/host-a/certificates/CURRENT_SERIAL/revoke
```

吊销立即使该 serial 的所有 Node API 请求失败，并 fence 当前 generation 的 Task/workspace lease。轮换重叠窗口中的另一张证书不会被隐式吊销；演练时应分别核对目标 serial、Node 离线状态、Task 重排和 identity audit hash chain。

## 状态契约

管理员使用 client SPIFFE 管理员证书读取：

```bash
curl --fail --silent --show-error \
  --cacert control-ca.pem --cert admin.pem --key admin.key \
  https://control.example.internal/v1/admin/nodes
```

每个 Node 返回 provisioned `capacity`、当前 `in_flight`、`last_heartbeat`、Node/daemon 版本、活跃签名镜像 manifest SHA-256，以及以下 daemon 状态之一：

| `daemon_state` | 是否接收新 Task | 含义 |
|---|---:|---|
| `healthy` | 是 | daemon IPC 可达，池未暂停或 degraded |
| `paused` | 否 | Host/管理员已暂停 VM pool |
| `degraded` | 否 | daemon 可达，但 pool 或协议健康失败 |
| `unreachable` | 否 | owner-only daemon IPC 在 2 秒探测窗口内不可用 |
| `unknown` | 是（滚动升级兼容） | 旧版 Node 尚未报告运行信息；应尽快升级 |

`failure_code` 只会是稳定的 `daemon_unreachable`、`daemon_degraded` 或 `daemon_protocol_error`，不会包含 socket、workspace、证书或 Host 错误文本。原始诊断只保留在受保护的 Host service log。

## Drain、升级与回滚

升级前先读取当前 `generation`，再关闭新 admission：

```bash
curl --fail --silent --show-error \
  --cacert control-ca.pem --cert admin.pem --key admin.key \
  -H 'Content-Type: application/json' \
  -d '{"generation":"CURRENT_GENERATION","draining":true}' \
  https://control.example.internal/v1/admin/nodes/host-a/drain
```

等待 `in_flight=0` 后停止 `zapvm-node` 和 daemon，升级二进制与签名镜像，再先启动 daemon、后启动 Node。Node 进程每次启动生成新的随机 generation；旧 generation 的 ack、event、completion 和 lease proof 会被 Control fence。确认新版本、镜像摘要和 `daemon_state=healthy` 后，用新 generation 发送 `draining=false`。

升级失败时保持 drain，恢复上一套二进制和已验签 active image，重启 daemon/Node，确认新 generation 健康后再 undrain。不要复用旧 generation，也不要直接修改 Control state。

Linux user service 的基本检查：

```bash
systemctl --user status zapvm-daemon zapvm-node
journalctl --user-unit zapvm-node --since -30min
zapvm daemon status
zapvm doctor
```

生产 Node 配置必须使用 `"relay_mode":"required"`。滚动升级期间可以临时使用 `auto`，但只有 Node 日志出现 `operation=task_relay ... result=connected` 且 Control 的 WebSocket 101 指标持续增长后才能切换为 `required`。出现 `relay_unavailable` 回退表示仍在使用旧逐事件 HTTPS 路径，不应作为低延迟验收通过。

Linux 安装、升级、回滚和卸载使用 [Remote Host 安装器](./host-install-linux.md)。升级仍必须先 drain；安装器负责 Host 上的二进制、配置和 unit 事务，不会替管理员解除 Control drain。

macOS 使用用户级 [Remote Host 安装器](./host-install-macos.md) 管理 launchd daemon/Node 服务、升级和回滚；Windows 使用 [SCM Remote Host 安装器](./host-install-windows.md) 管理 Authenticode release、HCS/daemon/Node 服务和事务回滚。两者都使用统一的 `zapvm daemon status`/`zapvm doctor`。daemon IPC 始终是本机 Unix socket 或 Windows named pipe，不能为了排障改成公网 TCP listener。

## 故障处置

1. `state=offline`：检查 Node service、mTLS 证书有效期、Control URL 和出站网络；超过 heartbeat TTL 后运行中 lease 会按既有策略重排或失败。
2. `daemon_state=unreachable`：确认 daemon 与 Node 使用同一 OS 用户和 endpoint，先恢复 daemon；Node 会继续 heartbeat 并在恢复后自动重新开放 admission。
3. `daemon_state=degraded`：执行 `zapvm daemon status` 和 `zapvm diagnose`，保持 Node 不接新任务；处理失败 worker 后重启 daemon。
4. `daemon_state=paused`：确认是显式维护还是 Host suspend；只有所有 worker 成功 resume 后才会恢复 admission。
5. 版本或镜像摘要不符合发布清单：立即 drain。不得仅通过修改上报字段绕过，必须恢复已签名目标镜像并重启服务。

管理员 API 自身只接受配置中的管理员 SPIFFE identity。Node 上报的数据由该 Node 的 mTLS identity 认证，但属于 self-attested telemetry；生产发布系统应把期望版本和镜像摘要与独立发布清单比对。

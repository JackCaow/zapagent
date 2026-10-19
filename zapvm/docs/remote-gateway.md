# 单 Host 远程网关

`zapvm gateway` 是 Agent Computer data plane 的远程安全边界。它不把 owner-only daemon socket 暴露到 TCP；独立网关进程先完成双向 TLS、SPIFFE 主体认证、Computer 级授权和审计，再把一条已授权 RPC 转发给本机 daemon。

```text
Agent / existing adapter
        |
 owner-only local IPC
        |
 zapvm gateway tunnel
        |
 TLS 1.3 + mutual certificates
        |
 zapvm gateway serve -- policy -- audit
        |
 owner-only local daemon IPC
        |
 Agent Computer VM pool
```

这是单 Host、自托管远程接入基础，不是多租户公网控制面。Computer 仍由 Host 管理员在本地创建；网关不开放 Computer 创建、daemon status/pause/resume/shutdown、直接 exec 或 Task prune。

## 身份与策略

服务端证书必须且只能包含一个节点 URI SAN：

```text
spiffe://example.internal/node/host-a
```

客户端证书必须且只能包含一个主体 URI SAN：

```text
spiffe://example.internal/tenant/acme/project/weather/client/codex
```

Common Name、DNS SAN 和调用方提交的 tenant/project 字段都不参与授权。策略只接受 schema 1、已知权限和显式 Computer ID；不支持 wildcard。credential ID 还有独立白名单，远端调用方不能仅凭 `computer.exec` 选择 daemon 上其他已登记凭证。

```json
{
  "schema_version": 1,
  "trust_domain": "example.internal",
  "node_id": "host-a",
  "grants": [
    {
      "principal": "spiffe://example.internal/tenant/acme/project/weather/client/codex",
      "permissions": [
        "computer.list",
        "computer.inspect",
        "computer.exec",
        "computer.stop",
        "computer.task.submit",
        "computer.task.list",
        "computer.task.inspect",
        "computer.task.attach",
        "computer.task.cancel",
        "computer.task.retry"
      ],
      "computer_ids": ["weather-dev"],
      "credential_ids": ["github-readonly"]
    }
  ]
}
```

策略和私钥必须是 owner-only 普通文件，且父目录不能由 group/other 写入；symlink、超限文件、未知 JSON 字段、重复授权和非规范身份都会 fail closed。CA bundle 可以在轮换窗口同时包含新旧 CA；当前配置在进程启动时载入，变更后需要重启 gateway，在线节点注册和自动证书轮换尚未实现。

## Host 启动

先启动本地 daemon 并由管理员创建允许远程使用的 Computer，然后启动网关：

```bash
chmod 600 /etc/zapvm/gateway-policy.json /etc/zapvm/node.key

zapvm gateway serve \
  --listen 0.0.0.0:9443 \
  --daemon-endpoint /run/user/1000/zapvm.sock \
  --client-ca /etc/zapvm/client-ca.pem \
  --certificate /etc/zapvm/node.pem \
  --private-key /etc/zapvm/node.key \
  --policy /etc/zapvm/gateway-policy.json \
  --audit-log /var/lib/zapvm/remote-audit.jsonl
```

`--audit-log` 是必需项。网关在转发前同步写入 `authorized`，结束后写入 `success`、`daemon_error` 或 `transport_error`；拒绝请求写入 `rejected`。JSONL 只记录 node、SPIFFE principal、tenant/project、请求/Computer/Task ID、动作和结果，不记录 argv、输出、credential 内容或 Host workspace。记录带连续序号和 SHA-256 hash chain，64 MiB 后 fail closed，需在停网关后归档并创建新的 owner-only 文件。

## 配置驱动与后台运行

后台服务应使用单一配置文件，不把证书、策略和 endpoint 路径散落到 service manager 参数中。仓库提供 [`gateway-serve.json`](../packaging/examples/gateway-serve.json) 和 [`gateway-tunnel.json`](../packaging/examples/gateway-tunnel.json) 示例。配置 schema 固定为 1，只允许 `serve` 或 `tunnel` 其中一个对象；所有 authority 文件必须使用绝对路径，TCP 地址必须包含 1-65535 端口。未知字段、相对路径和 symlink 会拒绝；配置、私钥、策略和 audit log 还必须是 owner-only（Windows 使用 owner/DACL），其父目录不能对非授权主体可写。

```bash
install -d -m 700 ~/.config/zapvm
install -m 600 packaging/examples/gateway-serve.json ~/.config/zapvm/gateway-serve.json
# 编辑全部 /absolute/path 占位符后执行：
zapvm gateway validate --config ~/.config/zapvm/gateway-serve.json
zapvm gateway run --config ~/.config/zapvm/gateway-serve.json
```

`validate` 会加载并核对 SPIFFE certificate/key pair、CA、策略和 audit target，但不监听端口、不连接 daemon，也不创建缺失的 audit 文件。`run` 复用与显式 `serve`/`tunnel` 完全相同的 fail-closed 路径。

Linux 提供两个 systemd user unit：[`zapvm-gateway.service`](../packaging/systemd/zapvm-gateway.service) 和 [`zapvm-tunnel.service`](../packaging/systemd/zapvm-tunnel.service)。模板假定 binary 位于 `/usr/local/bin/zapvm`、配置位于 `~/.config/zapvm/`；安装前必须按实际包路径调整：

```bash
install -d -m 700 ~/.config/systemd/user
install -m 644 packaging/systemd/zapvm-tunnel.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now zapvm-tunnel.service
```

unit 设置 `UMask=0077`、最小 address family、`NoNewPrivileges` 和内核/系统目录保护。因为启用了 `PrivateTmp=true`，daemon endpoint 和 audit log 不应放在 `/tmp`。Host gateway 同理启用 `zapvm-gateway.service`，并确保同一用户的 daemon 已先运行。

macOS 提供 `packaging/macos/com.zapvm.gateway.plist.example` 和 `com.zapvm.tunnel.plist.example`。复制到 `~/Library/LaunchAgents/` 前必须替换 `REPLACE_ME` 和 binary 路径；模板直接执行 `gateway run`，不经过 shell，并设置后台运行、失败重启和 0077 umask。

Windows 现有 `zapvm service` 只承载需要 LocalSystem 的 HCS/ACL 窄协议，不能用来运行 gateway 或 tunnel。当前 Windows 可由受控进程管理器运行同一 JSON 配置，运行时会校验 owner/DACL；但原生 SCM gateway/tunnel wrapper、配置 ACL 的安装与升级事务仍是后续门禁，不能把远程私钥塞进现有 HCS service。

## Agent 侧无侵入接入

Agent 侧的 tunnel 把远端 mTLS 连接重新暴露为 owner-only 本地 IPC，因此现有 CLI、TUI 和 adapter 继续使用原 daemon 协议。默认监听平台的标准 daemon endpoint，调用方连 `--endpoint` 都不需要增加；如果本机 daemon 已占用默认 endpoint，再显式指定另一条 owner-only endpoint：

```bash
chmod 600 ./codex-client.key

zapvm gateway tunnel \
  --remote host-a.example.internal:9443 \
  --server-ca ./node-ca.pem \
  --certificate ./codex-client.pem \
  --private-key ./codex-client.key \
  --node-uri spiffe://example.internal/node/host-a

zapvm computer list
zapvm computer task submit weather-dev -- make test
zapvm computer task attach <task-id>
```

本机同时运行 daemon 时可改用 `--endpoint /path/in/0700-directory/remote.sock`，并让对应 adapter 指向该 endpoint。

客户端不使用 DNS/CN 代替节点身份：它验证 CA chain、serverAuth EKU 和精确 node URI。服务端同样验证 clientAuth chain 和精确 client URI。

## 当前泄露面与后续门禁

远端 Computer list/inspect 会移除 Host workspace 路径，Task/Computer 列表只返回策略允许的 Computer，daemon error 会转换为统一远端错误。Guest stdout/stderr、命令退出错误和 Task journal 本身仍属于调用方授权的数据，控制面必须按敏感内容处理。

上线多租户公网服务前仍需完成：在线节点注册与自动证书轮换、短 TTL credential broker、跨节点任务投递/ack、scheduler/drain/迁移、每 Computer 磁盘加密和配额、集中审计汇聚，以及 Web terminal/browser/file 通道的独立鉴权。

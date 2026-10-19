# Railway 控制面部署

Railway 承载 `zapvm-control` 和浏览器入口 `zapvm-web`，不承载 VM。`zapvm-node`、本地 daemon 和 VM 必须部署在具备 KVM、Hyper-V/HCS 或 Virtualization.framework 的真实 Host；节点通过出站 mTLS 连接 Railway。

浏览器产品入口使用独立的 `zapvm-web` Railway Service。它只监听 Railway 内部明文 HTTP，由 Railway ingress 终止公开 HTTPS；BFF 使用专用 tenant/project mTLS Client 身份访问 `zapvm-control`，Control 私钥和 Project access token 不进入浏览器。镜像由 `Dockerfile.web` 和 `railway.web.json` 构建。由于同一仓库根目录的 `railway.json` 属于 Control，Web Service 的 Settings → Config-as-code path 必须显式设置为 `/railway.web.json`，不能沿用默认文件。入口只接受以下 Base64 Secret：

- `ZAPVM_WEB_CONFIG_B64`
- `ZAPVM_WEB_SIGNING_KEY_B64`
- `ZAPVM_WEB_CONTROL_CA_B64`
- `ZAPVM_WEB_CONTROL_CERT_B64`
- `ZAPVM_WEB_CONTROL_KEY_B64`

`PORT` 必须固定为 `8080`。入口把 Secret 写入 `/run/zapvm-web` 的 owner-only 文件、清除环境变量、降权到 UID/GID 10001，先执行 `zapvm-web --validate` 再启动。公开 domain 必须与配置中的 `public_origin` 完全一致；Railway `/healthz` 检查通过后才切流。

Web Service 变量和发布命令如下。Base64 命令不得写入 shell history，生产环境应从 Secret Manager 或 CI protected secret 注入：

```bash
railway variable set PORT=8080 --service zapvm-web --skip-deploys
railway variable set RAILWAY_DOCKERFILE_PATH=Dockerfile.web --service zapvm-web --skip-deploys

base64 < /secure/path/web-bff.json | tr -d '\n' | railway variable set ZAPVM_WEB_CONFIG_B64 --service zapvm-web --stdin --skip-deploys
base64 < /secure/path/web-cookie-signing.key | tr -d '\n' | railway variable set ZAPVM_WEB_SIGNING_KEY_B64 --service zapvm-web --stdin --skip-deploys
base64 < /secure/path/control-ca.pem | tr -d '\n' | railway variable set ZAPVM_WEB_CONTROL_CA_B64 --service zapvm-web --stdin --skip-deploys
base64 < /secure/path/control-client.pem | tr -d '\n' | railway variable set ZAPVM_WEB_CONTROL_CERT_B64 --service zapvm-web --stdin --skip-deploys
base64 < /secure/path/control-client.key | tr -d '\n' | railway variable set ZAPVM_WEB_CONTROL_KEY_B64 --service zapvm-web --stdin --skip-deploys

railway up --service zapvm-web --detach
railway domain --service zapvm-web --port 8080
```

首次发布后依次验证公开 `/healthz`、登录换取 HttpOnly session、Computer 目录、Task 提交、SSE cursor 重放和终态。只验证首页或健康检查不构成 Agent 交付。

Host 上供 Web Agent 使用的 Computer 默认采用 `unrestricted`，让 Guest 的
出站 DNS/HTTPS 与 Host 保持一致，Agent 可以按任务访问模型、Git、包仓库和
其他公开服务。多租户部署仍可按合规要求显式改回 `restricted`：

```bash
zapvm computer create \
  --endpoint /absolute/path/to/daemon.sock \
  --id cloud-agent \
  --workspace /absolute/path/to/workspace \
  --network unrestricted
```

验收必须确认模型请求成功并至少执行一次工具调用；仅看到
`Agent 会话已建立` 不代表 Agent 可用。Computer 的网络策略变更后必须停止旧
VM，使下一次任务按新的网络模式启动。

## 安全与拓扑边界

- 使用 Railway TCP Proxy 暴露原始 TCP，不能使用会终止 TLS 的 HTTP Public Domain。
- `zapvm-control` 固定监听 `9444`；Railway 变量 `PORT` 必须显式设置为 `9444`。
- 单 active state 位于挂载到 `/data` 的持久卷，服务副本数必须保持为 1。
- mTLS 配置、CA、证书和私钥作为 Base64 Railway Secret 注入；入口在 `/run/zapvm-control` 落为 `0600` 文件、清除环境变量，然后降权到 UID/GID 10001。
- `cloud-control.railway.json` 内的路径不得修改为持久卷外的其他可写位置。

## 初始化

复制并编辑配置，保持端口和文件路径不变：

```bash
cp packaging/examples/cloud-control.railway.json /secure/path/cloud-control.railway.json
chmod 600 /secure/path/cloud-control.railway.json
```

证书必须由受信 CA 签发：

```text
control: spiffe://<trust-domain>/control/<control-id>       serverAuth
node:    spiffe://<trust-domain>/node/<node-id>             clientAuth
client:  spiffe://<trust-domain>/tenant/<t>/project/<p>/client/<id> clientAuth
```

控制面证书必须恰好包含一个 URI SAN；为了让通用 TLS 客户端连接 Railway TCP 域名，还应加入该域名的 DNS SAN。

## Railway 资源

登录并创建独立项目/服务后：

```bash
railway variable set PORT=9444 --skip-deploys
base64 < /secure/path/cloud-control.railway.json | tr -d '\n' | railway variable set ZAPVM_CONTROL_CONFIG_B64 --stdin --skip-deploys
base64 < /secure/path/clients-ca.pem | tr -d '\n' | railway variable set ZAPVM_CLIENT_CA_B64 --stdin --skip-deploys
base64 < /secure/path/control.pem | tr -d '\n' | railway variable set ZAPVM_CONTROL_CERT_B64 --stdin --skip-deploys
base64 < /secure/path/control.key | tr -d '\n' | railway variable set ZAPVM_CONTROL_KEY_B64 --stdin --skip-deploys

railway volume --service zapvm-control add --mount-path /data --json
railway up --service zapvm-control --detach
railway tcp-proxy create --service zapvm-control --port 9444 --json
```

启用 Artifact 上传和下载时，在 `cloud-control.railway.json` 增加私有 S3-compatible bucket 配置：

```json
"artifact_store": {
  "endpoint": "https://<s3-origin>",
  "region": "<region>",
  "bucket": "zapvm-artifacts",
  "access_key_file": "/run/zapvm-control/artifact-s3-access-key",
  "secret_key_file": "/run/zapvm-control/artifact-s3-secret-key"
}
```

然后单独注入 owner-only credential 文件。若使用临时凭据，再同时设置 session token，并在配置里填写 `session_token_file`：

```bash
printf '%s' "$S3_ACCESS_KEY" | base64 | tr -d '\n' | railway variable set ZAPVM_ARTIFACT_S3_ACCESS_KEY_B64 --stdin --skip-deploys
printf '%s' "$S3_SECRET_KEY" | base64 | tr -d '\n' | railway variable set ZAPVM_ARTIFACT_S3_SECRET_KEY_B64 --stdin --skip-deploys
```

bucket 必须保持 private。Node 通过 mTLS 把内容流式上传到 Control；Web 端只会得到最长 5 分钟的签名 GET URL，不持有 S3 credential。

启用 GA-01b-2 PostgreSQL 在线镜像时，在 `cloud-control.railway.json` 增加：

```json
"postgresql_mirror": {
  "dsn_file": "/run/zapvm-control/postgres-dsn",
  "retry_interval_seconds": 5,
  "flush_timeout_seconds": 120
}
```

然后注入 DSN 文件，并只在需要应用 migration 的部署设置迁移门禁：

```bash
printf '%s' "$DATABASE_URL" | base64 | tr -d '\n' | railway variable set ZAPVM_POSTGRES_DSN_B64 --stdin --skip-deploys
railway variable set ZAPVM_POSTGRES_MIGRATE=1 --skip-deploys
```

入口会先把 DSN 落为 owner-only 文件，再以临时环境变量执行 migration，随后清除环境变量并启动 Control。确认 migration 与在线 reconcile 成功后应移除 `ZAPVM_POSTGRES_MIGRATE`；DSN 文件变量必须保留。生产 Railway PostgreSQL 连接必须使用 TLS。在线 mirror 仍是 shadow，副本数继续保持 1，不能据此提前启用多 active Control。

完成 mirror 零差异观察窗并停止旧 Control 后，主存储切换只把同一配置块改名并移除 mirror 专用参数：

```json
"postgresql_primary": {
  "dsn_file": "/run/zapvm-control/postgres-dsn",
  "operation_timeout_seconds": 120
}
```

部署前必须再次设置一次 `ZAPVM_POSTGRES_MIGRATE=1` 以应用 primary-state migration；确认新实例 ready 后删除该迁移变量。primary 模式仍保持 `/data/state.json` 回滚缓存和单副本门禁。回滚时先停止服务，以 primary 配置完成一次干净启动/关闭来修复缓存，再删除 `postgresql_primary`；不得直接删除 PostgreSQL 数据。

完成 GA-02b 行级 Backend 验收后，可显式切换运行时（默认仍是上面的 `snapshot`）：

```json
"postgresql_primary": {
  "dsn_file": "/run/zapvm-control/postgres-dsn",
  "mode": "distributed",
  "placement_mode": "static",
	"computer_start_timeout_seconds": 120,
  "operation_timeout_seconds": 120
}
```

切换部署前必须再次设置 `ZAPVM_POSTGRES_MIGRATE=1`，并确认 migration 状态为 current。`distributed` 启动会精确核对 Node/Scope/Computer provision；旧的 Scope-only 配置只接纳被历史持久工作实际引用的动态 Computer，其他额外数据库授权仍 fail closed。`placement_mode` 默认保持 `static`；只有在 Host Pool 灰度时才显式设为 `dynamic`。动态模式会启用唯一 placement、Task epoch、Node generation fencing 和 start-then-task：Node 必须先完成 `computer.start`，Task 才可 Claim。`computer_start_timeout_seconds` 不得超过全局 `task_dispatch_timeout_seconds`，未配置时动态模式会取后者与 300 秒的较小值。daemon 的 `idle_timeout` 到期并 clean stop 后，Node heartbeat 会使无 active Task 的 placement 释放；后续 Task 重新走 start-then-task。当前仍未实现远端 snapshot/restore、Cold 恢复和长期 idle soak。该模式不再维护 `/data/state.json` 回滚缓存；切回旧模式前必须停止所有副本并走数据库导出/恢复流程。本地 PostgreSQL 16 已通过独立副本终止、替代副本启动和数据库暂停/恢复，但 Railway 真实多副本故障注入尚未执行，因此副本数继续保持 1。

GA-03b 开发/集成验收可在 distributed 配置增加下列显式 bootstrap wrapper：

```json
"credential_broker": {
  "development_static_key_file": "/run/zapvm-control/credential-wrapper.key",
  "capability_ttl_seconds": 300
}
```

注入的内容必须恰好是 32 个随机字节，而不是可打印密码：

```bash
openssl rand 32 | base64 | tr -d '\n' | railway variable set ZAPVM_CREDENTIAL_WRAPPER_KEY_B64 --stdin --skip-deploys
```

入口只把它写到 owner-only tmpfs 文件并清除环境变量；PostgreSQL 只保存被它包装的每-version DEK。该配置字段明确带 `development_` 前缀，只用于 GA-03b bootstrap 和集成环境，不能作为生产 KMS 交付证据。GA-03d 必须换成云 KMS/HSM provider、最小 key policy、独立审计和轮换/revocation 演练后才能对外宣称生产可用。

GA-03c Node 短期身份同样只允许 `postgresql_primary.mode=distributed`。Control 配置加入 `node_identity`，signer 路径固定为 `/run/zapvm-control/node-identity-ca.pem` 和 `/run/zapvm-control/node-identity-ca.key`，再注入专用签发 CA：

```bash
base64 < /secure/path/node-identity-ca.pem | tr -d '\n' | railway variable set ZAPVM_NODE_IDENTITY_CA_CERT_B64 --stdin --skip-deploys
base64 < /secure/path/node-identity-ca.key | tr -d '\n' | railway variable set ZAPVM_NODE_IDENTITY_CA_KEY_B64 --stdin --skip-deploys
```

`client_ca` bundle 必须信任该签发 CA。`node_identity.enrollment_tokens[].token_sha256` 只保存 Host 单次 token 的 SHA-256，不保存原文；同一已消费哈希在 Control 重启时保持 terminal，不会重新激活。从配置移除 active token会在启动 reconcile 中吊销它。Railway 入口把 signer 落为 `0600` tmpfs 文件并清除 Base64 变量；这仍是文件 signer 的单区域交付，GA-03d 需要 KMS/HSM signer 和 dual-CA 演练。

启用单个 GitHub App provision 时，在 Control 配置增加 `github_apps`（完整字段和安全边界见 [Git Provider](./git-provider.md)），并将 `private_key_file` 固定为 `/run/zapvm-control/github-app-private-key.pem`：

```bash
base64 < /secure/path/github-app-private-key.pem | tr -d '\n' | railway variable set ZAPVM_GITHUB_APP_PRIVATE_KEY_B64 --stdin --skip-deploys
```

该变量只负责 owner-only 私钥文件注入。App ID、Installation ID、tenant/project 和固定仓库仍必须写在 owner-only Control 配置中；不得把 installation token 配成 Railway 长期变量。

不要打印 `railway variable list --json` 或 `--kv`，这些命令包含 Secret 原文。

## 验证

Railway 的普通 HTTP health check 无法携带客户端证书，因此不配置 HTTP health path。部署状态先通过 CLI 和日志确认，再从外部使用管理员 mTLS 证书调用：

```bash
railway deployment list --service zapvm-control --json
railway logs --service zapvm-control --lines 100

curl --cacert control-ca.pem --cert admin.pem --key admin.key \
  https://<railway-tcp-host>:<railway-tcp-port>/healthz
```

启用 PostgreSQL mirror 后，`/readyz` 在 mirror 写失败时返回 not ready；管理员 operational snapshot 同时提供 `state_mirror_pending`、`state_mirror_failed`、连续失败数和 lag/last-success age。primary 模式通过 `state_primary_enabled` 标识，任一同步提交或本地缓存错误都会使 Store degraded。发布回滚前先停止 Control，并确认文件缓存由最后一次 primary 启动修复完成。

同一 `/data` 卷绝不能同时挂到两个 active 控制面实例。扩容前必须先迁移到外部一致性数据库；当前 Beta 不是多副本 HA。

如果从 state schema 1 升级期间已经把 JSON payload 规范化、但旧 digest 后来又被写回 schema 2，正常启动会按 fail-closed 拒绝该 state。确认日志错误仅为 `Task request or payload digest is invalid` 后，可临时设置 `ZAPVM_CONTROL_REPAIR_PAYLOAD_DIGESTS=1` 并部署一次。该显式离线恢复仍会逐 Task 验证严格 Computer Task schema、Computer/Task/credential authority，只重算通过验证的规范 payload digest；任一 payload 本身损坏都会中止且不写 state。日志输出修复数量并继续启动。服务恢复后必须删除该变量并再次部署，正常启动路径永远不会自动修复 digest。

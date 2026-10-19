# Web BFF 身份与安全边界

`zapvm-web` 是浏览器与 `zapvm-control` 之间的唯一入口。每个 owner-only Project provision 绑定一个应急 access token hash、一个固定 Control origin，以及一套 tenant/project 专属 mTLS Client 证书。正式用户入口支持限时签名邀请和可选的企业 OIDC；静态 access token 只保留为管理员应急入口。

浏览器不能提交或覆盖 tenant、project、SPIFFE URI、Control URL、证书或私钥。认证成功后只获得短期、HttpOnly、Secure、SameSite=Strict 的签名会话 Cookie；BFF 根据已签名会话选择预配置的 Project transport。

## 生成登录和 Cookie 密钥

```bash
umask 077
openssl rand -hex 32 > /etc/zapvm/web-cookie-signing.key
access_token=$(openssl rand -hex 32)
printf '%s' "$access_token" | shasum -a 256
```

只把 SHA-256 写入 [`web-bff.json`](../packaging/examples/web-bff.json)。access token 原文交付给对应用户后不要写入配置、shell history、前端 bundle 或日志。示例中的全零 hash 只能作为待替换占位符。

配置和密钥文件必须属于服务用户并为 `0600`。每个 Project 的 `client_uri` 必须与证书唯一 URI SAN 完全一致，`control_uri` 必须与 Control server 证书唯一 URI SAN 完全一致。启动前执行：

```bash
zapvm-web --config /etc/zapvm/web-bff.json --validate
```

## 邀请登录

管理员在 BFF Host 上生成 5 分钟到 7 天有效的邀请链接：

```bash
zapvm-web --config /etc/zapvm/web-bff.json \
  --issue-invite --invite-project acme-default --invite-user alice --invite-ttl 24h
```

Railway 部署不需要 SSH 进容器。拥有该 Railway 项目权限的管理员可在本仓库根目录运行：

```bash
scripts/issue-railway-web-invite.sh \
  <railway-project-id> <user-id> [workspace-id] [ttl]
```

脚本只在临时的 `0700` 目录中读取部署配置与签名材料，输出一条邀请 URL 后立即清理。标准 Web 客户端会自动读取 URL fragment、兑换 HttpOnly 会话并清除地址栏中的凭据。输出的 URL 是 bearer credential，必须私密发送，不能写入工单、Shell history 或日志。

链接把签名凭据放在 URL fragment 中；fragment 不会发给 HTTP Server，前端读取后会立刻清除地址栏并通过同源 `POST /auth/invite` 兑换会话。邀请可在有效期内重复兑换，并非一次性凭据，因此只能通过私密渠道交付。轮换 `signing_key_file` 会同时撤销现有邀请和登录会话。

## 企业 OIDC

`oidc` 为可选全局配置，并且必须显式固定到一个 Project 和至少一个允许的已验证邮箱域：

```json
{
  "oidc": {
    "issuer": "https://login.example.com",
    "client_id": "zapvm-web",
    "client_secret_file": "/etc/zapvm/oidc-client-secret",
    "project_id": "acme-default",
    "display_name": "Acme SSO",
    "allowed_email_domains": ["example.com"]
  }
}
```

在 IdP 注册的回调地址必须精确为 `<public_origin>/auth/oidc/callback`。BFF 使用 Authorization Code + PKCE、OIDC discovery 和 ID Token 校验；只有 `email_verified=true` 且邮箱域命中 allowlist 的身份才能获得绑定 Project 的会话。Client secret 文件必须为 owner-only，不能写入 JSON、环境日志或前端。

## Browser API

- `POST /auth/login`：同源 JSON `{ "access_token": "..." }`，成功后建立签名 Cookie，并返回 CSRF token。
- `GET /auth/options`：返回是否配置企业 OIDC 以及登录入口，不返回 issuer、client ID 或策略。
- `GET /auth/oidc/start`、`GET /auth/oidc/callback`：企业 OIDC Authorization Code + PKCE 登录。
- `POST /auth/invite`：同源兑换限时签名邀请，邀请凭据不会下传 Control。
- `GET /api/session`：恢复当前服务端选定的 Project、用户、角色、CSRF token 和过期时间。access token 登录获得 `admin` 角色；邀请与 OIDC 登录获得 `member` 角色。
- `POST /auth/logout`：要求 `X-CSRF-Token`，显式清除 Cookie。
- `/api/agent/*`：受控映射到 Control 的 `/v1/agent/*`；非 GET/HEAD 请求要求 `X-CSRF-Token`。
- `GET /api/admin/computers`：仅 `admin` 会话可用，读取当前 Workspace 的 Computer、placement、Node 归属和运行状态。
- `POST /api/admin/computers/{id}/lifecycle`：仅 `admin` 会话可用，接受严格的 `wake` 或 `release`；写请求仍要求 CSRF。`release` 遇到活动 Task 或生命周期切换时返回冲突，不会强停任务。
- `GET /healthz`：仅表示 BFF 进程可服务，不代表 Control、Node 或 VM 就绪。

`GET /` 提供内嵌、无外部 CDN 依赖的 Web Workspace：Computer/Session 选择、首 turn/continuation 提交、SSE cursor 恢复、事件去重、终态和取消。管理员通过 `/admin/computers` 进入独立运行环境控制台；该 deep link 支持直接打开和刷新。控制台只管理 VM 的唤醒与释放，Computer 的新增、删除和资源规格仍由 owner-only Control 配置声明，避免浏览器绕过基础设施变更流程。对话标题作为独立、最多 80 字符的 Session 元数据持久化到 Control；Control 不从私密 prompt 推导标题。浏览器 localStorage 只记录 Project provision ID、Computer/Session/Task ID 和最后 cursor；access token、prompt、事件正文、模型配置和 Credential ID 均不写入持久存储。页面刷新会从 cursor 0 重放当前 Task，恢复完整可见事件记录。

登录必须带与 `public_origin` 完全相同的 `Origin`，反向代理必须保留与该 origin 一致的原始 `Host`。所有跨源或错误 Host 请求均拒绝，服务不返回 CORS allow header。BFF 只向 Control 转发 `Accept`、`Content-Type`、`Last-Event-ID` 和服务端生成的 request ID；Cookie、Authorization、CSRF、tenant/project header、代理 header 和浏览器凭据不会下传。

## 连接和限流

- 全进程最多同时处理 128 个请求。
- 单 Project 最多 8 个上游请求，包括 SSE 连接。
- 同时最多处理 8 个登录校验。
- 请求正文最多 256 KiB；登录正文最多 2 KiB。
- Control SSE 单连接在 25 秒内关闭，BFF 写超时为 35 秒，避免慢或失联浏览器无限占用连接。

审计日志只记录 request ID、Project provision ID、user ID、method、path 和分类结果；不记录 query、prompt、access token、Cookie、CSRF、证书或 Control 原始错误。

## TLS 终止

`zapvm-web` 当前监听明文 HTTP，必须放在同机受控反向代理或 Railway HTTPS ingress 后。生产 `public_origin` 强制 HTTPS，并使用 `__Host-` Cookie。仅显式 `development_http=true` 时允许 `http://localhost`、`http://127.0.0.1` 或 `http://[::1]`，此模式不能公开部署。

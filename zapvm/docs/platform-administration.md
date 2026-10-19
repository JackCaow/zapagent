# Workspace 管理与商业化控制面

zapVM 的商业管理面统一位于 Web `/admin`，Control 是最终权限与资源事实源。Web
会话中的 `role` 只用于界面裁剪；每个管理请求都必须携带 BFF 注入的用户身份，并由
Control 重新读取 PostgreSQL `workspace_members` 后授权。

## 角色

| 角色 | 能力 |
|---|---|
| `owner` | Workspace 所有权、Owner 任命、成员、运行环境、配额 |
| `admin` | 成员、Computer、Node / Host Pool、模型、Agent、凭据、配额 |
| `operator` | 任务执行与 Computer 生命周期运维；不能改变成员和商业配额 |
| `member` | 创建和继续 Agent 任务 |
| `viewer` | 只读 Workspace 状态 |

首个有效签名邀请或应急 token 登录，可由 mTLS 认证且通过 SPIFFE URI 绑定到当前
tenant/project 的 Web BFF 初始化第一个 Owner。初始化在数据库事务中加锁，并在已有任何
成员后永久关闭；它不授予共享 Node 等平台级管理员权限。后续邀请和 OIDC 登录不会自动
创建成员，账号必须预先存在且状态为 `active`。Control 阻止删除最后一名有效 Owner。

## 资源关系

```text
Workspace
  ├─ Members / RBAC
  ├─ Host Pools ── Nodes
  ├─ Credentials ── Models ── Agents
  ├─ Computers ── Host Pool + Agent
  └─ Quota / Usage / Audit
```

创建自助 Computer 时，Control 同时写入规格、Agent 引用和 Host Pool 的 Node
集合。调度阶段会按 vCPU、内存、浏览器 slot 和 VM slot 筛选 Node。Start lease 对
自助 Computer 携带不含密钥的 Agent/vCPU/内存规格；Node 只在自己配置的
`workspace_root/<tenant>/<project>/<computer>` 下创建工作区，然后通过 owner-only
daemon IPC 创建并启动 VM。Control 不允许远端请求指定任意 Host 路径。

Workspace 与 Host Pool 的 Computer 上限会在同一事务锁内校验，避免并发创建绕过
配额。修改 Host Pool 的 Node 集合会原子刷新该 Pool 下所有自助 Computer 的调度
归属。Workspace 管理员只能排空独占该 Workspace 的 Node；共享 Node 必须由平台级
运维面操作，防止一个租户影响其他租户。

模型配置只保存 Provider URL、模型名和 Credential ID。Credential 明文由 envelope
broker 加密保存且永不回显。任务提交时，BFF 根据 Computer 动态解析
Computer → Agent → Model → Credential ID，并覆盖浏览器提供的任何运行时字段；声明式
Computer 没有 profile 时才使用项目静态 runtime 作为回退。

## 配额与计量

以下配额属于 Workspace，而不是单个浏览器会话：

- Computer 数量：创建时事务内校验。
- 并发任务：提交时事务内校验 `pending/leased/running/canceling`。
- 月任务时长：提交时校验已完成任务的月累计执行墙钟时间。
- Artifact 字节：注册 Artifact 时同时应用全局存储保护和更严格的 Workspace 上限。

模型 Token 计量需要受信 Agent runtime 提供结构化 usage 事件；当前版本尚未开放该配额，
也不会用输出文本长度推算账单。所有成员、Host Pool、模型、Agent、Computer 和配额写操作
都会产生 Control audit record。

## Node 配置

Cloud Node 配置需要声明专用工作区根目录：

```json
{
  "daemon_endpoint": "/absolute/path/to/zapvm-daemon.sock",
  "workspace_root": "/absolute/path/to/zapvm-workspaces"
}
```

该目录不应是文件系统根、用户 Home 或密钥目录。Node 进程需要拥有创建子目录的权限。
完整 Host 配置见 macOS、Linux 和 Windows 安装文档。

## 验收

```bash
go test ./...
cd web/client/react
npm run check
npm test -- --run
npm run test:e2e
```

PostgreSQL 集成验收必须在全新数据库中运行
`TestPostgreSQLSchemaIntegration` 与
`TestPostgreSQLPlatformAdminFoundationIntegration`。后者覆盖 Owner bootstrap、RBAC、
Host Pool、动态 runtime、自助 Computer provisioning lease 和硬配额。

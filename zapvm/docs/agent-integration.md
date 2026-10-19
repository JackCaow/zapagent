# Agent 接入手册

本文面向需要把 Claude Code、Codex CLI、OpenCode、Zap 或自研 Agent 接入 zapVM 的开发者。目标是让 Agent 在 Agent Computer 中执行命令、持续安装工具、恢复 Session、接收流式输出并交付产物，同时不获得 Host daemon socket、VMM、状态盘或宿主文件系统的泛化权限。

zapVM 当前提供执行环境、通用 Host adapter 层与 ACP Resident 协议。Dim 可作为签名 ACP Agent Layer 在 Guest 内运行；旧的 Dim sandbox runner protocol v1 仍是外部 Agent 的 Host codec。Claude Code、Codex CLI 和 OpenCode 可以通过 CLI 约定接入，其专用 codec 尚未实现。接入方必须按本文的支持状态向用户展示，不能静默退回 Host 执行。ACP Guest 契约见 [ACP Agent Runtime](./acp-agent-runtime.md)，Host adapter 的分层见 [Host Agent Adapter Layer](./agent-adapters.md)。

## 1. 选择接入模式

| 模式 | Agent 在哪里运行 | zapVM 提供什么 | 适用场景 |
| --- | --- | --- | --- |
| 外部 Agent + Computer CLI | Host、IDE 或其他服务 | 无 ZapCode 的 Host Runtime、持久 VM、命令执行、Task journal | Claude Code、Codex CLI、OpenCode 和自研 TUI |
| Parent-owned stdio worker | Agent 父进程旁 | 单 VM 长连接 JSONL 协议 | 自研 Agent runtime、单进程插件 |
| Remote Gateway | Agent 客户端一侧 | 到单台远端 Host 的 mTLS 本地 tunnel | 自托管远端开发机 |
| Resident Agent | Guest VM 内 | Agent、工具、Session HOME、产物收集 | zapVM Web、多节点云端 Agent |

不要混淆以下边界：

- `computer exec/task` 是 Agent 调用 VM 的稳定产品接口。
- `zapvm-agent` 是 Guest 内部组件，不是第三方 Agent SDK，不能直接暴露给调用方或公网。
- `zapvm gateway tunnel` 只把经过授权的远端能力映射为本地 owner-only IPC，不扩大权限。
- Resident Agent 是 Agent 本身运行在 Guest 内；外部 Agent 模式只是把执行工具委托给 Guest。
- 外部 Agent 应安装 `host-runtime` 镜像；它不包含 ZapCode 或 Agent 磁盘。`zapvm-resident-agent` 是 Guest 内的 ACP Client，本身不包含模型或 Agent 实现；当前独立包 schema 1 使用 `acp-resident-v1`，入口固定为 `/opt/zapvm-agent/bin/agent`。Web/远端 Resident 产品使用 `host-runtime` 加独立签名 ACP Agent 包。

## 2. 公共前置条件

接入前需要完成：

1. 安装与当前 Host 匹配的 `zapvm` 工具。
2. 安装并激活由受信根签名的 Guest 镜像。
3. 启动同一用户的 zapVM daemon。
4. 为项目创建稳定的 Agent Computer。
5. 确认 Agent 所需的网络、凭据和资源都已经由 Host 管理员显式授权。

安装和平台要求见[安装文档](./installation.md)与[支持矩阵](./support-matrix.md)。生产 daemon 应使用 owner-only 配置文件，而不是由 Agent 拼接 Host authority：

```bash
chmod 600 ~/.config/zapvm/daemon.json
zapvm daemon run --config ~/.config/zapvm/daemon.json --validate
zapvm daemon run --config ~/.config/zapvm/daemon.json
```

创建一个绑定项目目录的 Work Computer：

```bash
zapvm computer create \
  --id project-a \
  --agent zapcode@1.12.0 \
  --workspace /absolute/path/project-a \
  --network unrestricted

zapvm computer inspect project-a
```

安全敏感或服务器场景应使用 `off` 或 `restricted` 网络，并显式配置 `--allow-domain`、`--allow-port`。`unrestricted` 会使用平台后端提供的直接网络，不经过 restricted allowlist；它当前还是平台相关能力，Linux Host 不支持该模式。只有产品明确接受该风险并经过目标平台验收时才能启用。

## 3. 外部 Agent：推荐接入流程

外部 Agent 不应直接连接 VSOCK、Guest RPC 或 VMM。最小 adapter 只需要调用 `zapvm computer` CLI，并维护以下稳定标识：

- `computer_id`：项目或信任边界的稳定执行环境；
- `session_id`：一段 Agent 对话或任务链的稳定身份；
- `task_id`：单次执行的幂等键；
- `cursor`：已消费的最后一个 Task 事件位置。

### 3.1 启动时检查

adapter 启动时先检查 Computer，不要等第一条用户命令失败后才发现环境离线：

```bash
zapvm computer inspect project-a
zapvm daemon status
```

如果需要依赖安装、Resident Agent 或特定基础命令，还应由部署端检查已签名镜像能力：

```bash
zapvm capabilities \
  --image-root /absolute/path/images \
  --image-public-key /absolute/path/image-public.pem \
  --json
```

缺少必需能力时必须明确失败。禁止把被 zapVM 拒绝的命令直接改到 Host 执行。

### 3.2 同步命令

短命令可以直接执行：

```bash
zapvm computer exec \
  --session-id session-123 \
  --exec-timeout 10m \
  project-a -- go test ./...
```

`--` 后面是结构化 argv。自研 adapter 应保留参数边界，不要把参数重新拼成未经转义的 Host shell 字符串。

需要保护 Guest 内的项目控制目录时，每次请求都要显式声明：

```bash
zapvm computer exec \
  --session-id session-123 \
  --protect-workspace-path .git \
  --protect-workspace-path .zapcode \
  project-a -- go test ./...
```

保护策略属于请求 authority，不能只写在 Agent prompt 中。

### 3.3 异步 Task

Web、TUI 和可能断线的 Agent 应优先使用 Task 接口：

```bash
zapvm computer task submit \
  --task-id task-123 \
  --session-id session-123 \
  --exec-timeout 2h \
  --protect-workspace-path .git \
  --protect-workspace-path .zapcode \
  project-a -- go test ./...

zapvm computer task attach --json task-123
```

adapter 应保存最大的事件 `cursor`。断线后从该位置恢复：

```bash
zapvm computer task attach --json --after 42 task-123
```

关闭 `attach` 不会取消任务。用户明确停止时才调用：

```bash
zapvm computer task cancel task-123
```

相同 `task-id` 与相同请求可以幂等重试提交；相同 ID 配不同内容会被拒绝。失败、取消或中断后的业务重试必须创建新 Task，并重新提供完全相同的原始命令与 authority：

```bash
zapvm computer task retry \
  --task-id task-124 \
  --session-id session-123 \
  --exec-timeout 2h \
  --protect-workspace-path .git \
  --protect-workspace-path .zapcode \
  task-123 -- go test ./...
```

### 3.4 安装运行环境

Work Computer 的 `/` 保持签名只读。工具应安装到持久、rootless 的 `/nix`，项目依赖放进 `/workspace`：

```bash
zapvm computer exec project-a -- zap-pkg install go gopls
zapvm computer exec project-a -- python3 -m venv .venv
zapvm computer exec project-a -- .venv/bin/pip install -r requirements.txt
zapvm computer exec project-a -- npm ci
```

禁止在失败后改用 Host 的 `brew`、`apt` 或 `npm`。这会破坏隔离边界，也会让用户误以为依赖已经安装到 Computer。

## 4. Claude Code、Codex CLI 与 OpenCode

当前仓库尚未发布这些产品的官方 adapter 包。可以先采用“CLI 工具约定”接入：Host 管理员创建 Computer，项目说明文件要求 Agent 只通过 `zapvm computer exec/task` 运行构建、测试、下载和安装命令。

Claude Code 可把以下规则写入项目 `CLAUDE.md`，Codex 可写入 `AGENTS.md`，OpenCode 使用其项目级 instructions：

```text
本项目的 Work Computer ID 是 project-a。
所有构建、测试、依赖安装和联网命令必须通过 zapVM 执行。
短命令使用：zapvm computer exec --session-id <stable-session> project-a -- <argv...>
长任务使用：zapvm computer task submit/attach。
缺少工具时在 Computer 内使用 zap-pkg 或项目本地包管理器。
zapVM 拒绝或离线时明确报告错误，禁止退回 Host 执行。
不要访问 daemon socket、VMM、Guest RPC 或 Host credential 文件。
```

这只是兼容接入，不是强制安全边界：Agent 自带的 Read/Edit/Bash 工具仍可能操作 Host。商业产品集成应实现专用 tool adapter，并在 Agent 权限配置中关闭或限制直接 Host shell/file 工具，只向模型暴露以下高层动作：

```text
computer.inspect
computer.exec
task.submit
task.attach
task.cancel
task.retry
workspace.list
workspace.read
workspace.diff
artifact.list
artifact.download
```

adapter 必须把 argv、cwd、timeout、Session、credential ID 和 protected paths 作为独立字段传递。若目标 Agent 只提供一段 Bash 字符串，兼容层可以显式在 Guest 内运行 `/bin/sh -lc <command>`，但必须把整段字符串作为单个 argv 传给 zapVM，不能在 Host 再解释一次。

## 5. Parent-owned stdio worker

单个 Agent runtime 需要低延迟复用一台 VM 时，可以持有一个长生命周期 worker：

```bash
zapvm run \
  --image-root /absolute/path/images \
  --image-public-key /absolute/path/image-public.pem \
  --state-disk /absolute/path/project-a-state.raw \
  --console=false \
  --serve-stdio \
  --idle-timeout 1h
```

stdout 只用于 schema 1 JSONL，Host/VMM 诊断在 stderr。worker 首先输出 `ready`，随后接收：

```json
{"schema_version":1,"type":"ping","id":"health-1"}
{"schema_version":1,"type":"exec","command":{"id":"command-1","session_id":"session-123","argv":["go","test","./..."],"timeout_ms":600000}}
{"schema_version":1,"type":"pause","id":"pause-1"}
{"schema_version":1,"type":"resume","id":"resume-1"}
{"schema_version":1,"type":"shutdown"}
```

执行响应包含 `scheduled`、`started`、`output` 和 `result`；控制响应包含 `pong`、`paused`、`resumed`、`control_error`、`protocol_error`、`drained` 和最终 `vm_stopped`。`output.data` 是 JSON `[]byte` 的 base64 编码。调用方必须按 command ID 路由并发输出，并等待 `vm_stopped` 后才能认为状态已经 clean commit。

stdio worker 是 parent-owned process contract，不提供跨进程 registry、断线恢复或远程授权。需要这些能力时使用 daemon Computer/Task。

## 6. 单 Host 远程接入

远端 Host 管理员先创建 Computer、启动 daemon 和 `gateway serve`。Agent 侧运行 tunnel：

```bash
chmod 600 ./agent-client.key

zapvm gateway tunnel \
  --remote host-a.example.internal:9443 \
  --server-ca ./node-ca.pem \
  --certificate ./agent-client.pem \
  --private-key ./agent-client.key \
  --node-uri spiffe://example.internal/node/host-a
```

tunnel 默认提供与本地 daemon 相同的 owner-only endpoint，现有 adapter 可以继续调用：

```bash
zapvm computer list
zapvm computer task submit --task-id task-123 project-a -- make test
zapvm computer task attach --json task-123
```

远端权限由客户端证书 SPIFFE 主体、Computer ID、动作和 credential ID 的交集决定。网关不会开放 Computer 创建、daemon 管理或任意 Host workspace。完整配置见[单 Host 远程网关](./remote-gateway.md)。

## 7. Resident Agent：Agent 内置到 VM

Resident 模式不需要本地 Claude/Codex adapter。Runtime 包含通用
`zapvm-resident-agent` ACP Client；Dim 等具体 Agent 来自独立签名、只读
Agent Layer。部署端先安装 Agent，绑定
Computer，再由 Web/BFF 通过 Control 创建 Agent turn：

```bash
zapvm agent install \
  --root /absolute/path/agents \
  --public-key /absolute/path/agent-public.pem \
  --manifest ./agent.json --signature ./agent.sig
zapvm agent use \
  --root /absolute/path/agents \
  --public-key /absolute/path/agent-public.pem \
  zapcode@1.12.0
zapvm computer create --id computer-a --agent zapcode@1.12.0 \
  --workspace /absolute/path/project --network unrestricted
```

```http
POST /v1/agent/sessions
Content-Type: application/json
```

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

第二个 turn 复用同一 `session_id`、`computer_id` 并设置 `continue=true`。同一 Session 的前一个 turn 必须已经终态，Control 会原子拒绝并发 continuation。

Control 的 Node provision 必须同时声明同一精确 Agent 引用：

```json
{"id":"computer-a","tenant_id":"acme","project_id":"default","agent":"zapcode@1.12.0"}
```

Node 会在执行每个 lease 前读取本地 daemon 的 Computer 记录并核对 Agent；Control provision 与 Host 实际绑定不一致时，任务以 `computer_agent_mismatch` 明确失败。

客户端通过 SSE 消费实时事件：

```http
GET /v1/agent/sessions/turn-01/stream
Last-Event-ID: 42
```

SSE 断开不取消任务。客户端按 cursor 去重并重连，直到观察到终态；取消使用 `DELETE /v1/agent/sessions/<task-id>`。HTTP 契约、错误 envelope、workspace 和 Artifact API 见 [`docs/api`](./api/README.md)。浏览器不能直接持有 Control mTLS 私钥，应通过同源、认证且带 CSRF 防护的 `zapvm-web` BFF。

Resident Agent 的 Session 和 Task payload 只使用 credential ID。当前 credential API 会接收一次明文值并立即做 envelope encryption，只返回版本 metadata，且没有明文 read-back API；Node 随后在当前 Task lease 下兑换一次性 capability，并通过 owner-only daemon IPC 注入 Guest。Agent 不得把密钥写入 prompt、argv、镜像、workspace、Session HOME 或工具缓存。

## 8. 产物交付

Resident Agent 只应把可下载文件写入本次 Task 指定的 Artifact 输出目录。Host Collector 在命令终态后建立不可变快照，Node 上传到私有对象存储，Control 校验 size、MIME 和 SHA-256 后才把状态改为 `available`。

客户端流程：

1. `GET /v1/agent/sessions/<task-id>/artifacts` 列出当前 turn 的产物；
2. 只展示状态为 `available` 的下载动作；
3. `GET /v1/agent/artifacts/<artifact-id>/download` 获取短期签名 URL；
4. pending、failed、expired 不能显示为可下载。

不要从 Agent 最终回复里的 `/workspace/...` 文本推断产物。消息路径不是 Artifact 注册事实，完整契约见[Artifact 产物交付](./artifact-delivery.md)。

## 9. 错误与状态映射

adapter 至少要区分：

| 状态 | UI/Agent 行为 |
| --- | --- |
| Computer `offline`/daemon unavailable | 在提交前阻止任务，提示运行环境离线 |
| Task `queued` | 显示排队，应用产品级排队超时 |
| Task `running` | 流式追加事件，不重复创建历史消息 |
| Task `canceling` | 禁止重复取消，等待 Guest 进程树终态 |
| Task `succeeded` | 停止流式连接，刷新 Artifact metadata |
| Task `failed` | 展示稳定错误类别与显式重试入口 |
| Task `canceled`/`interrupted` | 保留已有输出，允许用户显式 retry |

不要把 Agent 文本中的“完成”当成 Task 成功，也不要把 HTTP 200 当成 Artifact 已上传。任务、事件和产物分别有独立事实状态。

## 10. 接入验收清单

在宣称一个 Agent 已接入前，至少验证：

- [ ] adapter 能在提交前识别 Computer 在线/离线；
- [ ] 所有命令实际运行在 Guest，Host 没有 fallback；
- [ ] 相同 Session 的连续命令能读取持久状态；
- [ ] `zap-pkg` 和项目本地依赖在 stop/restart 后仍可用；
- [ ] stdout/stderr 能按 cursor 断线恢复且不重复；
- [ ] cancel 能终止 Guest 进程树并产生明确终态；
- [ ] `.git`、`.zapcode` 等声明路径在 Guest 中不可写；
- [ ] credential 只按 ID 注入，日志、事件和产物中没有明文；
- [ ] 网络模式与产品声明一致，离线/拒绝不会回退 Host；
- [ ] Agent 回复中提到文件但未注册 Artifact 时，UI 不显示虚假下载；
- [ ] Host 休眠、daemon/node 重启、网络断开后状态能恢复或明确失败；
- [ ] 使用目标平台实体机完成验收，不用交叉编译代替运行时结论。

当前已验证 Resident Zap 的真实 macOS Web → Control → Node → daemon → VM → Agent 闭环。Claude Code、Codex CLI 与 OpenCode 专用 adapter 仍需分别完成端到端验收；在此之前应标注为 CLI-compatible，而不是 native integration。

## 11. 相关文档

- [Agent Computer 架构](./agent-computer.md)
- [多租户云端 Agent](./cloud-agent.md)
- [HTTP API 契约](./api/README.md)
- [单 Host 远程网关](./remote-gateway.md)
- [Artifact 产物交付](./artifact-delivery.md)
- [兼容性策略](./compatibility.md)
- [威胁模型](./threat-model.md)
- [诊断手册](./diagnostics.md)

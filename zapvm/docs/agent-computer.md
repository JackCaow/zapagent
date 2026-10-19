# Agent Computer 架构

Agent Computer 是 zapVM 面向用户和上层 Agent 的稳定产品身份。它不是“每条 Bash 启动一台 VM”，也不是把某个特定模型永久写入基础镜像；它把一个项目的授权、持久状态和可复用 VM 生命周期绑定到稳定 ID。

## 产品边界

```text
Web / Desktop / TUI / Agent adapter
                 |
 authenticated control plane / mTLS gateway
                 |
        zapVM Host daemon (local IPC)
          | registry | VM pool
                 |
       one VM per trust boundary
          | immutable rootfs
          | persistent state disk
          | rw,exec workspace
          | isolated Sessions
```

zapVM 仓库负责 Host data plane、Guest agent、镜像和本地控制协议。云服务控制面负责用户身份、租户授权、节点调度、任务队列、断线续传、审计汇聚、短期凭证签发和计费。控制面不得直接持有 Guest root 权限，Guest 也不能自行扩大 Host 授权。

## 当前 foundation

daemon 在 owner-only state root 的 `computers/` 下保存 schema 1 Computer 记录。记录包含：

- 稳定 Computer ID；
- Host 已解析并授权的 workspace；
- workspace 读写模式；
- `off`、`restricted` 或显式危险的 `unrestricted` 网络策略；
- vCPU 与内存规格；
- 由 daemon 写入的创建时间。

运行状态不落盘，而是从 pool 实时推导。daemon 重启后 Computer 自然显示 `stopped`，下一次 exec 从原状态盘恢复。状态盘只由 Computer ID 派生，与临时 route digest 分离；镜像、credential scope 或其他 authority 变化会产生新 VM route，但旧 worker 必须先 clean stop，禁止并发挂载同一状态盘。

当前生命周期：

```text
create -> stopped -> starting -> busy -> running
                    |             |        |
                    +---------- stopping <-+--- stop / idle recycle
                                   |
                                stopped
```

Host 全局 suspend 时，已驻留 Computer 报告 `paused`。`computer stop` 只接受无 active command 的 Computer，并保留定义与状态盘；破坏性的 delete/清盘能力尚未开放。

## 文件系统契约

- `/`：签名、只读、可替换的基础镜像。
- `/workspace`：默认 `rw,exec,nosuid,nodev`，用于源码、venv、node_modules 和构建产物。
- `/nix`：Computer 级持久、rootless、可执行工具存储；使用 `zap-pkg install <package>...`，profile 自动加入每条命令 PATH。
- state disk：持久 Session HOME、SDK/cache、`/nix` 和版本化 guest state；raw Computer 盘按需稀疏扩展到 16 GiB。
- `/tmp`：请求私有、临时、可执行并受资源限制。
- `.zapcode` 等控制路径：请求 namespace 内只读；`.git` 是否保护由调用方显式策略决定。
- credential：只通过 Host broker 按请求注入，不进入 Computer 记录或状态盘。

只读 rootfs 是基础镜像完整性边界，不等于“Computer 不能安装软件”。Agent 不得运行 `apk`、改写 `/usr`，也不得退回 Host 安装；缺少工具时使用 `zap-pkg`，受 Computer 的 restricted egress allowlist、磁盘容量和任务超时约束。安装进程使用内核文件锁，异常结束不会留下阻塞后续任务的陈旧锁。

## 异步 Task 与断线恢复

daemon 在 owner-only state root 的 `tasks/` 下保存每个 Task 的不可变事件 journal。`computer task submit` 先持久化 `task.created` 再返回；调用方可以指定稳定 Task ID，相同 ID 与相同请求 digest 是幂等重试，内容不同则 fail closed。执行租约归 daemon 所有，不归提交或 attach 连接所有，因此客户端断开不会停止 VM 命令。

Task 状态为 `queued`、`running`、`canceling`、`succeeded`、`failed`、`canceled` 或 `interrupted`。事件文件使用单调 cursor，并在对外通知前原子写入和同步；`computer task attach --after N` 可重放 N 之后的 stdout、stderr 和终态事件，再选择继续等待新事件。显式取消先持久化 `task.cancel_requested` 再取消执行 context；Host stdio 随后向对应 command ID 发 cancel，关闭该命令独占的 Guest Agent 连接，由 Agent 杀死进程树。收到命令终态后才把健康 worker 归还 pool；取消协议失败或超时则丢弃 VM。如果命令在竞态窗口内已经返回，最终 guest result 仍是事实终态，否则写入 `task.canceled`。

retry 不修改或复用旧 journal。只有 `failed`、`canceled` 和 `interrupted` Task 可作为源；调用方必须重新提供命令、Session、cwd、timeout、credential IDs 和受保护路径，daemon 验证其 digest 与源 Task 完全一致后创建带 `retry_of` 的新 ID。这样既保留审计链，也避免服务端无条件重放未知副作用命令。

输出与结果可能包含源码、路径或 Secret 派生数据，journal 与 Computer registry 采用同级 owner-only 保护，不应复制到非受信日志系统。retention 默认关闭；显式 prune 或 opt-in daemon GC 仅原子移出并删除超过 cutoff 的终态目录，有单批 1-10000 上限，自动 GC 每轮固定最多 100 个，永不选择非终态 Task。处于 retention 边界的旧 attach 可能收到 journal 已回收，远程控制面必须把 retention 契约暴露给客户端。

daemon 正常停止会关闭 task admission、取消未完成执行，并等待它们写入 `interrupted/daemon_stopped`；进程崩溃或 Host 重启后，启动恢复扫描会把普通未完成 journal 追加为 `interrupted/daemon_restarted`，已处于 `canceling` 的 journal 则完成为 `canceled`。当前不会自动重放命令，因为无法证明任意命令没有外部副作用；由上层根据终态、业务幂等键和审计决定是否显式 retry。

## Agent 接入

Claude Code、Codex CLI、OpenCode 或自研 Agent 应通过 adapter 调用 `computer exec`，而不是获得 daemon socket 或 VMM 权限。adapter 必须区分 Sandbox 与 Work Computer：Sandbox 缺少工具时明确失败；Work Computer 宣告 `runtime_package_management=persistent-rootless`，提示 Agent 使用 `zap-pkg`，并禁止 Host fallback。供应商 Token 仍只通过短期 credential broker 注入，不能固化进镜像或持久工具存储。

完整的模式选择、CLI/Task 示例、stdio 契约、远程 tunnel、Resident Agent API、错误映射和验收清单见[Agent 接入手册](./agent-integration.md)。

单 Host 远程接入可使用 `zapvm gateway serve` 和 Agent 侧的 `zapvm gateway tunnel`。tunnel 向现有 adapter 提供 owner-only 本地 IPC，远端链路使用 TLS 1.3 双向证书；Host 网关按 SPIFFE tenant/project/client 主体、精确 Computer ID、动作和 credential ID 二次授权。网关不会开放远端 Computer 创建或 Host daemon 管理能力。配置、威胁边界和操作方式见[单 Host 远程网关](./remote-gateway.md)。

## 远程阶段门禁

远程产品接口不能直接复用本地 IPC 的信任假设。进入远程 alpha 前至少完成：

1. Host 节点与控制面的双向 mTLS、节点注册和密钥轮换；静态 mTLS 节点身份已完成，在线注册与自动轮换待完成；
2. tenant/project/computer 三层授权，所有请求绑定不可伪造的主体；单 Host 精确授权与本地 hash-chain 审计已完成，集中策略和审计汇聚待完成；
3. 将本地 task/event journal、幂等 request ID、输出 cursor 和断线续传接入持久控制面，并补跨节点投递/ack；
4. 短 TTL credential broker，禁止生产长期 Token 写入 Guest；
5. 每 Computer 磁盘加密、快照、配额、备份和可审计销毁；
6. 调度 admission、节点 drain、故障迁移和容量指标；
7. Web terminal/browser/file 接管通道的独立鉴权与审计。

在这些门禁完成前，zapVM 可以作为本地或单租户自托管 Agent Computer data plane，但不宣称是安全的多租户公网服务。

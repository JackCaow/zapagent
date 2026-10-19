# 实施与验收计划

## 总体验收定义

“完成”要求 macOS、Windows、Linux 各自在真实 Host 上通过同一套黑盒测试，而不只是交叉编译成功：

1. 从签名镜像冷启动到 Ready。
2. 在授权工作区执行命令并正确流式返回 stdout/stderr/exit code。
3. 未授权路径不可读取；符号链接/junction 不能逃逸。
4. 网络关闭时无出口；restricted 模式按域名允许并阻断私网/metadata/DNS rebinding。
5. 超时、取消和 VM 强停后不残留 Session 进程或挂载。
6. 并发 Session 资源限制生效，彼此 HOME、TMP 和进程不可见。
7. 睡眠唤醒、VMM 崩溃、guest agent 崩溃、磁盘满和损坏镜像都有确定恢复结果。
8. 镜像升级失败可回滚，旧 state schema 不被静默破坏。

## M0：研究和架构基线

- [x] Claude 本地 VM 技术总结纳入仓库。
- [x] 三平台 VMM、RPC、文件共享和网络候选调研。
- [x] 威胁模型、平台后端和隔离单元定案。
- [x] 建立逐项验收定义。

验收：文档中每个关键结论能追溯到官方资料、源码验证或明确标记的设计选择。

## M1：控制面与协议

- [x] `zapvm doctor` 输出结构化平台能力。
- [x] VM spec 校验和基础生命周期状态机。
- [x] 有界 framing、协议版本和 hello/auth。
- [x] guest agent 的 exec streaming、timeout、signal、process-tree cleanup。
- [x] 单元测试覆盖畸形帧、超限输入、取消、timeout 和并发上限。

验收：`go test ./...`、三平台交叉编译；本机 transport loopback 黑盒测试通过且无 goroutine 泄漏。

## M2：镜像流水线

- [x] 锁定首版 Alpine kernel、基础用户态和必要工具。
- [x] 构建 `zapvm-agent`、initrd、raw ext4 rootfs。
- [x] 转换 VHDX 并生成 per-arch manifest。
- [x] 签名、hash 校验、原子安装、激活指针和验证后回滚。
- [x] state disk 模板创建、排他锁、dirty recovery、guest fsck/schema gate。
- [x] 跨 state schema migration：签名 manifest 声明 schema、legacy metadata 兼容、guest 幂等 1→2、Agent health 回报、Host clean commit；真实 macOS v1 盘迁移与二次重启已通过，Linux/Windows 随平台总验收复核。

验收：在干净机器上只依赖 manifest 安装；篡改任意字节都会被拒绝。

## M3：macOS 后端

- [x] direct kernel、只读 rootfs/可写 state block、entropy、serial 与 Virtio memory balloon 已接线并真机验收。
- [x] Virtio socket RPC。
- [x] VirtioFS 授权工作区读写与只读模式。
- [x] 请求级 PID/mount/UTS/IPC namespace、私有 HOME/TMP 和 cgroup v2 限制。
- [x] off/restricted 网络接线并在 Apple Silicon 真机验收；unrestricted NAT 已接线但尚未单独验收。
- [ ] entitlement/codesign 已通过本机 doctor，Host/VMM 同进程强杀、Agent 崩溃和显式 VZ pause/resume 已真机通过；自动睡眠通知与完整睡眠唤醒尚未验收。

验收：Apple Silicon 真机执行总体验收 1–8；Intel 支持需单独构建和验证，不能由 arm64 推断。

## M4：Linux 后端

- [x] Cloud Hypervisor Unix-socket HTTP API client：`vmm.ping`/`vm.info` Ready gate、`vm.shutdown`/`vmm.shutdown` 有序退出和进程 fallback。
- [x] 版本锁定的 Cloud Hypervisor/virtiofsd 二进制供应、provenance、manifest 签名安装和 active-image 绝对路径执行；arm64 与 amd64 实际产物均已验证，amd64 signed active image 已在 GitHub Ubuntu 24.04 nested-KVM Host 启动。
- [x] KVM capability doctor。
- [x] AF_VSOCK、virtiofsd、guest-to-Host egress proxy transport 已在真实 KVM 验证；restricted allow/deny 与 Agent RPC 均通过。
- [x] Host root 硬拒绝；supervisor、Cloud Hypervisor、virtiofsd 单一 systemd user transient scope、cgroup v2 资源硬限额和 unit 级全树 stop/kill；userspace 合约与 Ubuntu 24.04 amd64 nested-KVM 生命周期均已验证。
- [x] x86_64/aarch64 kernel、initramfs、raw/VHDX rootfs 与 state 模板及 manifest 构建。
- [x] 可保留证据的 Linux 目标机验收脚本；GitHub Ubuntu 24.04 真实 `/dev/kvm` runner 已分 7 阶段执行，覆盖 write/restart、持久化/隔离、只读、restricted、crash/dirty recovery 与单 VM daemon 生命周期。

验收：Ubuntu 24.04 hosted runner 已通过；该 nested-KVM 环境每台 runner 只允许一次 `KVM_CREATE_VM`，同一 Linux Host 的完整多 route/配额/LRU 仍需 self-hosted KVM，Fedora 仍需独立覆盖。无 `/dev/kvm` 时已给出明确不可用诊断。

## M5：Windows 后端

- [x] Windows LocalSystem service 安装/启动/停止/卸载、受保护安装目录、命名管道客户端模拟、SID owner、调用进程 fail-stop 和 HCS ACL schema 3 两阶段恢复账本；账本保存每条路径的精确 DACL 基线并协调并发 VM 的共享路径引用。acceptance-only 强杀 harness 覆盖 prepare、每次 grant 的 intent/API/commit、HCS create/start 与恢复重放，Windows Server 2025 x64 的 21 点专项 run 已通过。
- [x] Windows service 原地升级/回滚事务：注册契约校验、受保护单份备份、hash gate、Running + pipe ping、失败自动恢复；Windows x64 真机 install→upgrade→doctor→rollback 通过，SCM 断点/崩溃注入仍待验收。
- [ ] Remote Host 原生 SCM 交付：daemon/Node service runner、Authenticode signer 锁定、ProgramData ACL、install/doctor/upgrade/rollback/uninstall 和失败升级恢复已实现，PowerShell AST、全量 Go/race 和 Windows amd64/arm64 交叉门禁通过；仍需在无预存 zapVM service 的 Windows 20348+ Hyper-V Host 执行 `acceptance-host-install-windows.ps1` 并保留证据。
- [x] ComputeCore HCS Linux utility VM create/start/query/pause/resume/terminate 生命周期；Windows Server 2025 x64 真机通过。
- [x] HCN 2.0 NAT、per-VM endpoint、HCS NIC、静态 IPAM、guest DNS 只读覆盖、无入站映射和显式回收代码；不再混用旧 HNS v1 flags，Windows x64 真机已验证外网访问与回收，arm64/更多 build 仍待覆盖。
- [x] HCN stateful return-flow 与显式全入站 deny 的目标机定案/验收：真实 NAT VM 证明 HCN Host/WFP ACL 不阻断 Host→Guest，最终采用 HCN Switch/VFP ACL + 签名 guest fail-closed nftables input policy；Host TCP 被拒绝且同一 guest HTTPS 出站成功。
- [x] Hyper-V socket RPC transport。
- [x] Hyper-V socket restricted egress transport 已在 Windows x64 真机验证 allow/deny。
- [x] Plan9 boot/workspace share 和 VHDX root/state attachment。
- [x] Guest HCS Plan9-vsock `trans=fd` mount helper、bootstrap-first identity 和 workspace RW/RO mount policy；Windows x64 真实 HCS 已验收。
- [x] Guest state gate 同时识别 Virtio `/dev/vdb` 与 HCS SCSI `/dev/sdb`，并验证 ext4 类型及 `zapvm-state` 卷标。
- [x] 可保留证据的 Windows 目标机验收脚本；GitHub `windows-2025` build 26100 管理员 Host 已完整执行并上传 artifact。
- [x] Virtual Machine Platform、ComputeCore、vmcompute/HNS/hypervisor doctor。
- [x] 普通 LCOW HCS schema 2.1/build 20348+ doctor gate，以及 direct-kernel `rootwait/init/pci=off/hv_sock` cmdline 契约单测。

验收：Windows Server 2025 build 26100 x64 已执行总体验收；Windows 11、更多最低支持 build 与 arm64 标记为独立覆盖门槛，必须真实设备验证。

上述条目中明确写有 Windows x64 真机证据的最新闭环来自 Actions run 31007213788；arm64 仍只有制品与交叉编译，不能据此推断运行通过。

## M6：安全与产品化

- [x] Host restricted egress CONNECT proxy、域名/端口策略、解析后 IP 校验和最小化审计事件。
- [x] state companion metadata、跨平台排他锁、guest flush、dirty recovery gate 和签名镜像回滚控制面。
- [x] Host workspace 实路径授权、Session ID/HOME/TMP/namespace/cgroup 策略，以及同一 VM 多命令顺序/并行 execution plan。
- [x] 显式启用的持久生命周期审计日志：脱敏固定字段、跨进程锁、fsync、SHA-256 链、篡改/partial/容量 fail-closed，并在 macOS 真机验证 state/协议最终事件顺序。
- [x] credential file broker 源码与 macOS VZ 开发镜像验收：Host 显式绑定、plan/stdio ID 引用、认证 RPC、guest 0400 只读私有 mount、并发隔离、退出前清理和 degraded fail-stop；仍不允许普通 env secret。
- [x] 用当前源码隔离重建 arm64+amd64 raw/VHDX 镜像；两架构 10-file manifest、SPDX、静态 Linux runtime、内嵌 Agent 和一次性本地验收根签名均已验证，arm64 signed active image 已在真实 macOS VZ 运行。
- [ ] Linux KVM、Windows HCS/Plan9 已用 CI 验收签名镜像复验 credential mount/清理；仍需正式密钥托管签发产品镜像，并接 keychain/OAuth 短 TTL capability broker。
- [x] fuzz framed codec、认证 envelope 和 Host 路径边界/规范化核心。
- [x] fuzz 认证后的完整 Agent RPC method 分派、ExecStart JSON/argv/env/timeout 校验和连接关闭清理。
- [x] fuzz 跨平台 VM 生命周期状态机与 VMM 事件竞态：三平台 backend 共用终态不可逆的转换核心，随机事件序列、并发终态竞争、race detector、Linux 原生 userspace 与四目标交叉门禁通过；真实 Linux/Windows VMM 竞态仍随平台总验收复核。
- [x] arm64/amd64 镜像 SPDX 2.3 SBOM、Alpine/自研组件 PURL、LicenseRef 定义、manifest 纳入及官方工具校验。
- [x] guest root/agent/proxy/workload 身份分离、运行目录和 VSOCK 最小权限审计，并在真实 macOS VM 验收。
- [ ] Linux systemd scope 已在真实 KVM 执行，Windows service 基础 ACL 与 HCS ACL 21 点崩溃恢复已在 Windows Server 2025 真机通过；SCM 升级事务中点、最低 build 20348 物理 Host 和更多平台权限审计仍待完成。
- [ ] 性能基线、磁盘回收、并发和长稳。
- [x] macOS 冷启动/state persistence 短 soak harness；3 轮门禁通过。
- [x] 1ms–24h Host/guest exec timeout 传递、乘法前上界校验和真实超时终止验收。
- [x] macOS duration-based 长稳 harness：逐轮 clean state、RSS/VSZ/FD/mount/disk telemetry 和 evidence 汇总；缩短版真机通过。
- [x] self-hosted Actions 入口：唯一 runner label、危险操作确认、只读 Host 预检、失败预检证据留存、Linux 同 Host 完整验收、Windows ACL 恢复、三平台整机睡眠/唤醒和 macOS 72 小时长稳分流；长稳证据由后续 fresh-token job 上传。预检不修改 KVM ACL、userns sysctl、linger/user manager 或电源策略，power target 只检查实际命令的窄 NOPASSWD 授权。
- [ ] macOS 72 小时完整长稳执行与趋势判定。
- [x] macOS state ENOSPC 故障注入与下一次启动恢复通过。
- [x] 双连接 heartbeat、agent supervise-daemon 重启、遗留 cgroup 清理与 crash fail-stop 真机验收。
- [x] state-backed Session HOME 跨 VM 持久化、Session 间隔离和请求私有 TMP 真机验收。
- [x] 同一 macOS VM 内两 Session 并行执行、JSONL 输出路由、HOME 隔离，以及顺序命令清理后同 Session HOME 复用真机验收。
- [x] 父 Host 进程持有的单 VM stdio 常驻 worker：严格请求协议、heartbeat、32 outstanding/8 并发、EOF/shutdown drain、idle stop、state clean 后最终事件；macOS 真机验收通过。
- [ ] 跨独立 CLI 进程的 daemon/IPC registry、workspace→VM 自动路由、多 VM 配额，以及 suspend/resume 与睡眠唤醒策略（daemon 主链路已完成；剩余项见子项）。
  - [x] 内部 VM pool 核心：完整授权路由键、workspace 文件身份复核、并发 start 去重、全局/单 workspace 配额、idle LRU、lease discard/close 和 stop-failure degraded fail-stop。
  - [x] 本地 transport 身份边界：Unix 0700/0600 endpoint + 双向 peer UID；Windows current-user/System protected pipe DACL + 双向 peer process-token SID。
  - [x] daemon RPC 基础 framing：schema 1、1 MiB 上限、strict outer/payload JSON、token 边界、并发写序列化和 fuzz。
  - [x] exec/status/pause/resume/shutdown 业务 schema、`zapvm daemon serve|exec|status|pause|resume|stop`、持久 stdio worker adapter、断连 discard、signed active image 逐请求复核与 credential ID 路由。
  - [x] macOS Apple Silicon 真机跨 CLI 复用：两个顺序 client、两个并发 client 共用单一 boot ID/worker，并发 status 为 2 leases；stop 后 state clean 且无残留进程。
  - [x] Unix daemon 异常恢复：owner-only endpoint flock + `ECONNREFUSED` stale 接管、worker 独立 session/SIGPIPE 处理；macOS 真机 SIGKILL daemon 后 orphan worker flush/clean，重启读回 Session。
  - [x] macOS 真实多 route：RW/off 与 RO/off 两台 VM 同时驻留、2 active lease 时第三 route quota 拒绝、idle 后 restricted LRU 换入、两 worker 并行 clean Close。
  - [x] 三平台显式 pause/resume 代码：共享状态机与失败回滚、VZ、Cloud Hypervisor v53 API、ComputeCore + Windows service、pool admission fail-closed、active drain、heartbeat gate、paused stop 先恢复再 flush；macOS VZ 真机通过。
  - [x] 三平台自动 Host power adapter 代码：macOS IOKit sleep acknowledgement、Linux logind PrepareForSleep delay inhibitor、Windows suspend/resume callback；短 deadline Suspend 不 drain active command，wake ownership 不解除显式 pause。macOS 注册/取消 smoke test通过。
  - [x] Linux/Windows 自包含目标机 daemon 验收 harness：同一 signed bundle、请求级 credential 清理、boot/Session 保持、active drain、paused admission、双 route/配额/LRU、paused stop、全 state clean 与残留进程检查；Windows x64 全量与 Linux 单 VM 变体已在目标机执行。
  - [x] Windows HCS/pipe 真机 daemon 多 route、quota/LRU 与 pause/resume；resume 后重连 command/heartbeat Hyper-V socket，并核对同一 Agent generation 后才恢复 admission。
  - [x] 三平台真实 Host 电源验收 harness：active lease 中挂起、定时唤醒、Host/guest boot identity、active command、state/Session、clean shutdown 与残留检查；daemon 成功回调输出固定审计事件。
  - [ ] Linux KVM 同 Host 多 route/配额/LRU 需 self-hosted runner；三平台真实 Host 睡眠/唤醒整机验收仍待执行。
- [x] Host workspace 实路径解析、敏感路径/根目录/symlink 目标硬拒绝。
- [x] 签名镜像安装/激活/回滚、Windows service 升级/回滚和默认脱敏诊断 JSON。
- [x] 离线签名 bundle 的有界安全导入、显式架构校验、冲突拒绝、幂等激活，以及 Linux/Windows 精确预签名制品验收入口。
- [x] TUF v2 一次性安全更新：固定 root、metadata freshness/rollback、consistent snapshot、流式 target hash、双层 manifest 校验、单调 release ledger、跨平台 activation lock 和本地签名仓库端到端测试。
- [ ] Host 应用后台更新调度、生产 root/targets 密钥托管、真实 CDN 发布与跨版本真机回滚集成。

验收：完成威胁模型逐项攻击测试；72 小时压力测试无失控进程、挂载泄漏或不可恢复状态。

## M7：Agent Computer 与远程产品化

- [x] 稳定 Computer ID、owner-only registry 和独立 state identity。
- [x] `computer create|list|inspect|exec|stop` 本地生命周期与实时状态。
- [x] route 变化先 clean retire、active command 阻止 stop、通用 exec 禁止伪造 Computer authority。
- [x] 持久 task/event journal、幂等提交、输出 cursor 和断线续传。
- [x] Task cancel、digest-locked retry、显式 retention/prune 和 opt-in daemon GC。
- [x] Work Computer 持久 rootless 包环境、16 GiB 稀疏状态盘、schema 3 迁移与 Agent 禁止 Host fallback 契约。
- [x] 单 Host mTLS 远程网关：精确 SPIFFE node/client 身份、tenant/project/computer/action/credential 授权、列表过滤、Host 路径与错误脱敏、hash-chain 本地审计，以及兼容现有 adapter 的 owner-only 本地 tunnel。
- [x] gateway owner-only schema 1 配置、离线证书/策略预检，以及 Linux systemd user 和 macOS launchd 后台模板；Windows 原生 SCM wrapper 与三平台安装器仍待完成。
- [ ] 控制面跨节点投递/ack、远程 retention 协议和 scheduler retry policy。
- [ ] 在线节点注册与自动证书轮换、集中授权/审计汇聚和短期 credential broker。
- [ ] 多 Host scheduler、drain/迁移、磁盘加密/快照/配额和远程接管通道。
- [x] 单 active 云控制面 Beta：SPIFFE mTLS 节点注册/心跳、scope 调度、generation/lease fencing、跨节点 Task ack/事件/完成、原子恢复和 hash-chain 集中审计；GA 的外部一致性数据库、KMS/CA 自动轮换、配额计费与取消下推仍待完成。
- [ ] Claude Code、Codex CLI 与 OpenCode adapter 端到端验收。

验收：foundation 先通过本地跨进程生命周期与全量单测；Task 层覆盖提交连接断开、cursor 重放、幂等冲突、取消竞态、digest-locked retry、终态-only GC 和重启恢复；远程能力只有在鉴权、跨节点持久事件、凭证和多租户隔离验收完成后才能标记 alpha。

## 当前实施顺序

1. 先完成 M1 的纯 Go 控制面和协议，使三平台共享逻辑稳定。
2. 并行准备 M2 镜像契约；没有可复现镜像不宣称 VM 后端完成。
3. 当前开发机优先打通 macOS，但接口和验收不得降格为 macOS-only。
4. Linux/Windows 必须在对应真实 Host 验收，交叉编译只作为早期门禁。

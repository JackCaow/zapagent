# Agent VM 跨平台技术调研

> 调研基线：2026-08-05。本文区分“官方能力”“本机或源码验证”和“设计选择”。依赖版本在实现时锁定，不能把此日期的 latest 当成永久事实。

## 1. 问题定义

Agent VM 与通用虚拟机产品的差别不是能否启动 Linux，而是能否安全地把以下能力组合为稳定协议：

1. 执行不完全可信的进程并流式传输 stdin/stdout/stderr。
2. 只暴露用户明确授权的 Host 目录。
3. 对 DNS、IP、端口和凭据实施出口策略。
4. 隔离不同工作区、Session 和进程树。
5. 在睡眠、崩溃、磁盘满、镜像升级后可恢复。
6. 在 macOS、Windows、Linux 上保持同一上层语义。

威胁主体包括恶意仓库脚本、依赖安装脚本、提示注入诱导执行的命令、被攻陷的工具链，以及试图读取其他工作区或 Host 凭据的 Agent 子进程。

非目标：防御已经拥有 Host 管理员/root 权限的攻击者；在首版实现 GPU、GUI 或完整桌面虚拟化；把 VM 当作秘密保险箱。

## 2. 隔离层次

| 边界 | 防御对象 | 采用技术 | 结论 |
|---|---|---|---|
| Host ↔ guest | Agent 代码、guest root | 平台 Hypervisor + 精简设备模型 | 必须 |
| 工作区 ↔ 工作区 | 横向读取和持久化污染 | 默认一工作区一 VM | 必须 |
| Session ↔ Session | 残留进程、临时文件、资源争用 | Linux user、mount/PID namespace、cgroup v2 | 必须 |
| 进程 ↔ guest agent | 获取挂载权和控制通道 | 独立 UID、Unix 权限、认证 RPC | 必须 |
| guest ↔ 网络 | SSRF、内网探测、数据外传 | guest nftables + Host egress proxy | 必须 |

单独使用容器不能提供目标中的 Host/guest 硬边界；单独启动 VM 也不能解决目录授权、网络和 Session 横向隔离。

## 3. macOS

### 3.1 平台能力

Apple [`Virtualization.framework`](https://developer.apple.com/documentation/virtualization) 提供 Linux boot loader、Virtio block、NAT、Virtio socket、VirtioFS、entropy、balloon 和 VM 生命周期 API。进程需要 `com.apple.security.virtualization` entitlement。

本机验证环境为 macOS 15.6.1 arm64，Swift 6.2 和 Go 1.26.2 可用。Claude 本机 bundle 也验证了 raw rootfs、session data、EFI state 和网络标识分离的磁盘布局。

Go 侧采用 [`github.com/Code-Hex/vz/v3`](https://github.com/Code-Hex/vz)。2026-08-05 通过 Go module proxy 验证的最新稳定标签是 `v3.7.1`；它直接绑定 Apple 框架，并公开 Virtio socket、共享目录、block、NAT 和状态事件。

### 3.2 结论

- 使用 direct kernel + initrd 启动，减少 UEFI/bootloader 变量。
- rootfs 使用只读 raw ext4 block；状态盘单独可写。
- RPC 使用 Virtio socket，不依赖 guest IP。
- 共享目录使用 VirtioFS；guest agent 再 bind mount 到 Session namespace。
- 配置 Virtio traditional memory balloon；后续由 Host 资源策略调整 target size。
- NAT 只作为受控网络数据面，不能把 NAT 本身当作安全策略。
- 自动睡眠通知使用 IOKit `IORegisterForSystemPower`；will-sleep 回调必须在 Host pause 尝试后调用 `IOAllowPowerChange`，powered-on 再恢复，不用轮询 `pmset` 日志推断状态。

## 4. Windows

### 4.1 平台能力

Microsoft [Host Compute System 概览](https://learn.microsoft.com/en-us/virtualization/api/hcs/overview)明确：HCS 能创建、启动、停止、暂停、恢复 VM/容器；compute system 是临时对象，调用方必须准备 VHD、网络和 Hyper-V socket，再通过 JSON 文档创建系统。

当前实现直接绑定微软公开的 `ComputeCore.dll` operation API：`HcsCreateOperation`、`HcsCreateComputeSystem`、`HcsStartComputeSystem`、`HcsPauseComputeSystem`、`HcsResumeComputeSystem`、`HcsGetComputeSystemProperties` 和 `HcsTerminateComputeSystem`。每个异步操作都调用 `HcsWaitForOperationResult` 并释放其 `LocalFree` result；函数参数顺序由微软 [Windows SDK computecore.h](https://github.com/microsoft/win32metadata/blob/main/generation/WinSDK/RecompiledIdlHeaders/um/computecore.h) 锁定。微软对 [`HcsGrantVmAccess`](https://learn.microsoft.com/en-us/virtualization/api/hcs/reference/hcsgrantvmaccess) 的公开契约是为 VM 内部 GUID 派生账户增加文件 ACE，对 [`HcsRevokeVmAccess`](https://learn.microsoft.com/en-us/virtualization/api/hcs/reference/hcsrevokevmaccess) 的契约是移除该 ACE；文档没有承诺重复 revoke 或未 grant 时的 HRESULT。真实 build 26100 故障注入进一步证明，对尚未 Grant 的非继承 state VHDX 调用 Revoke 即使返回成功也会改变 DACL。实现因此不能只在 Grant 返回后记账，也不能盲目补偿：每条路径先持久化 pending intent，恢复时从 VM GUID 派生精确 `S-1-5-83-1-*` SID，只有实际 ACE 存在才 Revoke，调用成功后再 commit。这里不使用旧的 `vmcompute.dll` 私有封装。

[`microsoft/hcsshim`](https://github.com/microsoft/hcsshim) 是微软维护的 Go HCS/HNS 接口和 Linux guest compute service 实现。源码验证的 `v0.14.1` 中：

- 公共 `ContainerConfig` 支持 Linux Utility VM 的 kernel、initrd、VHD boot source、MappedDirectories 和 MappedVirtualDisks。
- HCN 包是公共 API；底层通用 HCS、LCOW UVM 和 Hyper-V socket 辅助实现大量位于 `internal/`，不能直接作为稳定第三方 API 使用。
- 这意味着 zapVM 不能把 hcsshim internal 包当作产品 SDK；应使用公开接口可覆盖的部分，并为必要的 HCS v2 调用维护窄而可审计的 Windows adapter。

### 4.2 结论

- 使用 HCS/HCN 创建 Linux utility VM，不使用 `wsl.exe` 生命周期。
- Host 控制层运行普通进程；需要机器级注册和网络配置的操作放入最小权限 Windows service。
- RPC 使用 Hyper-V socket。
- Linux utility VM 的目录共享使用 `Devices.Plan9.Shares`。对 `hcsshim v0.14.1` 普通 LCOW 创建路径和 Windows Server 2025 实机 HCS Create 的交叉验证表明，direct-kernel/VHDX/Plan9 compute document 应声明 schema 2.1；2.5 属于 VMGS/SNP 等另一条路径，混用会在 Create 阶段返回无效 JSON。doctor 仍要求 Windows build 20348+。HCS Plan9 不是 Virtio 9P 设备：guest 必须先通过 AF_VSOCK 连接 share 的 port 564，复制 socket FD，再以 `trans=fd,rfdno=...,wfdno=...` 和 `aname=<AccessName>` 挂载。`MappedDirectories` 是 container schema，不作为裸 Linux VM 的配置字段。
- rootfs 发布为 VHDX，kernel/initrd 与 macOS/Linux 使用同一构建源和版本 manifest。

风险：Windows 后端不能在当前 macOS 主机上做运行验收；GitHub `windows-2025` 管理员 runner 已提供 build 26100 的 x64 HCS/HCN 证据，Windows arm64 与更多受支持 build 仍需要独立真实主机。

Windows 用户级 daemon 通过微软 [PowerRegisterSuspendResumeNotification](https://learn.microsoft.com/en-us/windows/win32/api/powerbase/nf-powerbase-powerregistersuspendresumenotification) 的 callback 形态接收事件。官方 [PBT_APMSUSPEND](https://learn.microsoft.com/en-us/windows/win32/power/pbt-apmsuspend) 说明应用通常只有约两秒保存状态，因此自动 suspend 不等待长命令 drain；显式用户 pause 才采用 drain-first 语义。

## 5. Linux

### 5.1 平台能力

Linux [KVM API](https://docs.kernel.org/virt/kvm/api.html)以 `/dev/kvm`、VM/vCPU file descriptor 和 ioctl 为核心，稳定 ABI 版本为 12。直接实现 VMM 意味着还要自行实现 Virtio 设备模型，不符合项目投入目标。

候选 VMM：

| 方案 | 优点 | 缺点 | 选择 |
|---|---|---|---|
| QEMU | 成熟、设备最全、KVM/WHPX/HVF | 攻击面和配置面大，三平台语义仍不同 | 故障回退/开发工具 |
| Firecracker | microVM 小、vsock、jailer、seccomp | 仅 Linux host；缺少原生目录共享，网络过滤需外置 | 不选主后端 |
| Cloud Hypervisor | KVM、现代 Virtio、vsock、virtio-fs、API、x86_64/aarch64 | 仅适合现代 guest；需管理独立二进制 | Linux 主后端 |
| crosvm | 沙箱和设备隔离成熟 | 分发、API 稳定性和集成复杂度较高 | 备选 |

[Firecracker 设计](https://github.com/firecracker-microvm/firecracker/blob/main/docs/design.md)明确每个进程只承载一台 microVM，生产使用 jailer，并指出它不做网络流量过滤，出口必须由 Host 控制。这一点同样适用于 zapVM。

[Cloud Hypervisor](https://github.com/cloud-hypervisor/cloud-hypervisor)运行于 KVM/MSHV，强调精简设备模型，支持 x86-64/AArch64、direct kernel boot 和现代 Virtio。其公开文档包含 VirtioFS 与 HTTP API，因此比 Firecracker 更符合本地 Agent 的实时工作区需求。

2026-08-05 复核的上游发布基线是 [Cloud Hypervisor v53.0](https://github.com/cloud-hypervisor/cloud-hypervisor/releases/tag/v53.0) 与 [virtiofsd v1.14.0](https://gitlab.com/virtio-fs/virtiofsd/-/releases/v1.14.0)。Cloud Hypervisor 官方 release 同时提供 amd64/arm64 static binary 及 GitHub API 的 SHA-256 digest；virtiofsd 只发布 source archive/commit，没有官方预编译 binary。因此产品不能继续信任任意 `PATH` 版本：Cloud Hypervisor 资产可按上游 digest 固定后再纳入 zapVM 签名，virtiofsd 必须从 commit `c2540f8d...` 与 lockfile 在固定 builder 中构建，再把最终 binary hash 纳入独立签名运行时包。仅检查 `--version` 可被恶意 binary 伪造，不作为安全门禁。

### 5.2 结论

- Linux 使用 Cloud Hypervisor 子进程，zapVM 通过 Unix socket HTTP API管理生命周期。
- 锁定的 [Cloud Hypervisor v53 OpenAPI](https://github.com/cloud-hypervisor/cloud-hypervisor/blob/v53.0/vmm/src/api/openapi/cloud-hypervisor.yaml) 明确以 PUT `vm.pause`/`vm.resume` 返回 204；Host adapter 只在该同步成功后提交共享 paused/running 状态。
- VMM 进程由 systemd transient unit 或独立 cgroup 限制；无特权运行，只把必要的 `/dev/kvm`、tap/vhost-user fd 授予它。
- RPC 使用 AF_VSOCK；文件共享由独立 `virtiofsd` 进程提供，并对共享根做最小化。
- 当前实现已固定 Cloud Hypervisor v53.0 的上游 per-arch SHA-256，并从 virtiofsd v1.14.0 的固定 source hash/commit、Cargo.lock 与 digest-pinned Rust builder 构建。最终 binary hash、builder/toolchain/package provenance 和两个 runtime 文件一并进入镜像 manifest；Host 启动只执行重新验证过的 active image 绝对路径，并将 provenance 版本与有界 `--version` 输出交叉检查。版本输出只作一致性/依赖可执行性检查，安全门禁仍是 manifest 签名与逐文件 hash。
- 上游 virtiofsd CI 已提供 musl + `libcap-ng-static` + `libseccomp-static` 的静态构建范式。zapVM 采用 digest-pinned Rust Alpine builder，并把显式 musl target、静态链接 flags、静态 C 库版本和最终 binary hash 写入 provenance；这样 Host runtime 不再依赖目标发行版的 glibc、libseccomp 或 libcap-ng 共享库。真实 Ubuntu/Fedora 验收仍须验证 seccomp/capability 与 virtio-fs 行为，但不再把安装这些动态库作为启动前提。
- Linux 自动睡眠使用 systemd-logind Manager 的 `PrepareForSleep` signal；daemon 持有 `Inhibit("sleep", ..., "delay")` 返回 fd，收到 true 后暂停并关闭 fd放行睡眠，收到 false 后恢复并重新取得 inhibitor。目标机必须验证本机 `InhibitDelayMaxSec` 是否覆盖 VMM freeze 时延。

## 6. Host/guest RPC

三平台的 socket 原语不同，但都可以抽象为可靠字节流：

| Host | 传输 |
|---|---|
| macOS | VZVirtioSocketDevice |
| Windows | Hyper-V socket |
| Linux | AF_VSOCK |

zapVM 协议选择：有界长度前缀 + versioned JSON envelope。原因是协议对象数量小、便于独立 guest 镜像调试、无需在早期引入代码生成。每帧最大尺寸固定；stdout/stderr 分块；所有请求有 request/session ID；未知字段向前兼容。

最小方法集：

- `hello`：协议版本、镜像版本、能力和 boot nonce。
- `session.open/close`：创建用户、cgroup、namespace 和挂载。
- `exec.start/stdin/signal/resize/wait`：结构化进程控制。
- `mount.apply/revoke`：只接受 Host 已授权的挂载描述。
- `health/stats/shutdown`：恢复与资源监控。

认证采用每次启动生成的 256-bit secret；通过仅 root 可读的启动元数据注入，双方用 challenge/HMAC 建立连接。Agent workload 用户不可读取 socket、secret 或 guest agent 二进制的可写副本。

## 7. 文件访问

统一语义不是统一底层协议。Host backend 只建立“授权根共享”；guest agent 执行：

1. 规范化 Host 路径并获取稳定文件句柄，拒绝 `..` 和越界符号链接。
2. 为每个授权创建不可预测 share ID，不把原始 Host 路径作为 guest mount 名。
3. share 首先挂载到 root-only staging namespace。
4. 通过 bind mount 暴露给 Session，默认只读并附加 `nosuid,nodev,noexec`；需要执行时显式放开 `noexec`。
5. Session 结束先杀进程树，再卸载；失败时把 VM 标记为 dirty，不复用。

跨平台一致性测试必须覆盖大小写、Unicode、符号链接、junction、文件锁、原子 rename 和删除中的打开文件。

## 8. 网络与凭据

默认 `network=off`。开启后，guest nftables 只允许连接 Host proxy/DNS stub；Host proxy 每次解析后再次检查目标 IP，阻断：

- loopback、RFC1918、link-local、multicast、unspecified；
- IPv6 ULA/link-local；
- cloud metadata 地址；
- DNS rebinding 后落入禁区的地址。

域名授权不是单次 DNS 白名单。TLS SNI 只能作为辅助信号，不能替代目标 IP 和 CONNECT authority 检查。OAuth token、SSH key 和云凭据不写入普通环境变量。当前第一阶段 broker 已实现“Host 显式授权静态文件→命令 ID 引用→guest 请求级 0400 只读文件”，并验证并发 namespace 隔离和命令结束清理；这解决了把长期 secret 复制进 argv/env 的问题。第二阶段仍需对接系统 keychain/OAuth provider，按请求签发短 TTL、限定 audience/域名的 capability，避免把长期静态 token 整体交给 workload。

## 9. 镜像和更新

逻辑镜像由同一 Linux kernel config、initrd 和 rootfs 构建，按 `os/arch/backend` 转换容器格式：

- macOS/Linux：raw ext4；Windows：VHDX。
- rootfs 只读；状态盘单独创建，Host metadata schema 与 guest state schema 分开版本化。
- manifest 记录 SHA-256、大小、架构、最低 Host 版本、协议版本、guest state schema 和签名，并把 SPDX 2.3 SBOM 作为受签名文件；SBOM 同时描述 Alpine 软件包和自研 guest 组件。
- 下载到临时路径，验证签名/hash 后原子激活；保留上一版回滚。
- guest agent 和 kernel 同 manifest 发布，防止不兼容组合。

生产下载信任链采用 [TUF 规范的客户端工作流](https://theupdateframework.github.io/specification/draft/#detailed-client-workflow)，而不是只依赖 HTTPS 或单个在线签名。客户端必须离线固定初始 root，并依序验证 root、timestamp、snapshot、targets 的版本、阈值签名和过期时间；仓库强制 consistent snapshots，目标文件使用 hash-prefixed 名称。实现使用官方 [go-tuf v2 updater](https://pkg.go.dev/github.com/theupdateframework/go-tuf/v2/metadata/updater)，不自建 TUF 状态机。

TUF target 的 signed custom metadata 额外绑定 `release_sequence`、image version、architecture 和内层 manifest SHA-256。schema 3 镜像使用 custom metadata schema 2，再绑定 Base/Runtime/Agent/Session 的精确版本向量；客户端要求它与内层签名 manifest 一致，旧 schema 1 metadata 只允许旧 manifest。本机受保护账本保存每个 channel/arch 已应用的最高 sequence 和已激活向量，弥补缓存被清空后仍可能回放“有效但较旧且未过期”仓库状态的应用层风险。同一 sequence 指向不同 manifest 或 target hash 视为分叉并 fail-closed。目标流式写入 0600 临时文件并校验所有声明的 SHA-256/SHA-512；严格 tar 解包只允许顶层普通文件、限制条目数/单文件/总大小，并再次验证既有 Ed25519 manifest 和逐文件 hash。

网络面生产只接受 HTTPS，禁用环境代理和自动压缩，redirect 限制为最多五次且同 origin；显式开发开关只允许 loopback HTTP。该设计不包含透明 TOFU，也不把 TUF root 放进从同一远端下载的未信任配置。后台周期调度、root/targets 离线密钥职责分离、生产 CDN 和跨版本真机制品仍是发布工程待办。

## 10. GitHub Actions 目标机编排

GitHub 官方 [Actions limits](https://docs.github.com/en/actions/reference/limits) 当前给 self-hosted job 最长 5 天执行时间、最长 24 小时排队时间；GitHub-hosted job 最长 6 小时。官方 [workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax) 同时说明 `timeout-minutes` 默认 360，超过 runner execution limit 时仍以 runner limit 为准；`GITHUB_TOKEN` 在 job 结束或最长 24 小时后过期。因此 72 小时 macOS soak 可以放入一个 self-hosted job，但不能依赖该 job 在结束后继续调用 artifact API。

编排采用以下边界：长稳进程只写 `RUNNER_WORKSPACE` 下按 run ID 唯一命名的持久 evidence 目录；完成后由第二个 job 在同一唯一 runner label 上取得新 token、打包并上传。这个 label 必须精确绑定一台物理主机，否则第二个 job 可能落到另一台机器而找不到证据。整机睡眠 target 只允许 `workflow_dispatch`，并要求精确确认短语；不自动响应 push/PR，也不使用共享 runner label。Linux/Windows 从 hosted build job 下载同一个已签名 amd64 bundle，从而把 target-host 运行结论与制品 identity 绑定。

workflow 与 harness 只能提供可审计执行入口。未注册符合 `/dev/kvm` + systemd 254+ 的 Linux Host、Hyper-V/HCS build 20348+ 管理员 Windows Host和 Apple Silicon macOS Host并取得成功 artifact 前，同 Host multi-route、整机 sleep/wake 和 72 小时长稳仍是未完成验收。

## 11. 方案结论

采用“三个原生后端 + 一个控制面 + 一个 guest agent”架构：

```text
                 zapvm CLI / daemon (Go)
        policy + sessions + image + recovery + audit
              platform backend interface
          /              |               \
  macOS VZ.framework   Windows HCS/HCN   Linux Cloud Hypervisor/KVM
          \              |               /
       common kernel + initrd + rootfs + zapvm-agent
             versioned authenticated RPC
```

不采用“一套 QEMU 参数跑三平台”，因为它没有消除平台服务、文件共享、网络权限和安装生命周期差异；也不采用“一台全局 VM 承载所有工作区”，因为 guest kernel 一旦被攻陷会跨越全部工作区信任域。

常驻复用已形成 parent-owned worker 与用户级 daemon 两层。stdio schema 1 支持 ping/exec/pause/resume/shutdown；daemon 在 peer-auth IPC 上按 workspace 权限、网络、镜像、state、credential scope 与资源参数自动路由和配额。显式 pause 会先 drain active command、停住 heartbeat，再调用各平台 VMM；paused 时新 lease/exec fail-closed，恢复成功后才重新开放。macOS VZ 已真机验证 boot/Session 连续性、多 route 和 paused-stop clean flush；Linux KVM 已验证单 VM daemon 生命周期；Windows HCS 已验证两台 route VM、quota/LRU、pause/resume 和三块 clean state。Windows HCS resume 会使既有 Hyper-V socket channel 不再可用，因此 Host 必须重建 command/heartbeat channel，并要求新健康响应的 Agent instance ID 与暂停前一致，完成后才恢复 heartbeat gate 与 pool admission。Linux 同 Host 多 route 和三平台自动 Host 睡眠/唤醒通知仍待验收。

生命周期审计采用显式文件而非把 stderr 当账本。记录模型刻意没有任意 message/detail：只允许固定 event/phase、随机 run ID、哈希 VM ID、序号和 SHA-256 链，append 时锁定并 fsync，重开时完整校验。这样可以检测保留下来的记录被改写、插入、重排或留下 partial record，同时避免命令、路径、Session 名和错误正文进入长期日志。它不是签名透明日志：拥有文件权限的主体仍能删除完整尾部，所以生产形态应把末尾 hash 定期锚定到独立存储，并在 Windows 上验证实际继承 ACL。

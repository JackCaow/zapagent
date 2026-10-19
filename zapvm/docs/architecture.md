# zapVM 架构决策

状态：Accepted，2026-08-05。

## ADR-001：隔离单元

默认一个工作区/信任域对应一台可复用 VM。同一 VM 内可顺序或并发运行多个 Session，但不同 Host 授权集合不得自动合并。

理由：长期 VM 能复用 SDK 和缓存；按工作区分 VM 避免单一 guest kernel 漏洞暴露所有项目。VM 空闲后休眠或停止，状态盘可保留；rootfs 始终可替换。

## ADR-002：控制面语言

Host 控制面和 guest agent 使用 Go。平台绑定限制在 `internal/platform/<os>`：

- Darwin：`Code-Hex/vz/v3` 绑定 Apple Virtualization.framework。
- Windows：LocalSystem SCM service 独占微软公开的 ComputeCore HCS operation API，普通 CLI 只经本机命名管道提交窄协议；普通 LCOW direct-kernel/VHDX/Plan9 路径使用 HCS schema 2.1，`hcsshim` 只作公开源码行为参考，不依赖其 `internal` 包。Windows build 20348+ 由 doctor 前置校验；网络使用 HCN。
- Linux：Cloud Hypervisor HTTP API、AF_VSOCK、virtiofsd。

业务层不得直接 import 平台 VMM SDK。

## ADR-003：启动和磁盘

使用 direct kernel + initrd。schema 3 的块设备顺序固定为只读 Base rootfs、可写 Session state、只读 Agent disk，随后才是显式 workspace shares。完整 manifest 同时签名 Base、Runtime、Agent、Session 的独立版本、`state_schema` 与每个文件的 size/hash；每个文件必须且只能属于一层。Host 创建 state clone 时显式记录 state schema，并在启动前重新验证当前平台所需的全部层。上层 Agent 只可通过 Host CLI 验签后读取能力契约，禁止直接把镜像目录中的未验证文本注入提示词。schema 1/2 仅作为兼容读取路径，不再用于新发布。

产品默认 kernel cmdline 必须与 Host 后端的启动设备一致，而不是依赖外部脚本补参数：Darwin/Linux 加载 `ext4,virtio_blk,virtiofs,virtio_balloon`，Windows 加载 ext4、SCSI/Hyper-V storage、Plan9 和 Hyper-V socket；HCS adapter 再把 root 设备从 Virtio 约定改为 `/dev/sda` 并补 `rootwait/init/pci` 约束。自定义 `--cmdline` 是显式覆盖，不属于正常镜像可启动性的前置条件。

状态盘不得覆盖 rootfs 内容。镜像升级只迁移显式版本化的 state schema。

每个 state disk 从签名镜像内的预格式化模板复制，Host companion metadata v2 分开记录 metadata schema 与 guest `state_schema`，并记录 clean flag、generation、最后 VM ID及 OS 级排他文件锁。raw Computer 盘复制后稀疏扩展到 16 GiB；Windows 使用已声明 16 GiB 虚拟容量的动态 VHDX。guest 在 Agent Ready 前探测 Virtio `/dev/vdb` 或 HCS SCSI `/dev/sdb`，只接受 ext4 且卷标为 `zapvm-state` 的设备，依次执行 fsck 与 `resize2fs`。当前迁移器按顺序支持 1→2→3：v2 建立 Session 布局，v3 建立 owner-private 的 `computer/nix`；每步先原子提交 root-only marker，再提交 `schema-version`。未知版本、symlink 或不完整 marker 都拒绝 Ready。Agent health 必须回报实际 schema 3；只有 workload 进程树已回收、guest flush RPC 成功且 Host 主动正常停机，Host 才把 companion `state_schema=3` 与 clean 原子提交。迁移后异常退出可从“盘已升级、metadata 仍是旧版本/dirty”的中间态重放。镜像 active/previous 指针独立于 state，回滚不得改写或降级 state schema；不支持 schema 3 的旧 guest 必须 fail-closed。

## ADR-004：RPC

使用可靠 socket 上的有界长度帧和 JSON envelope：

```text
uint32 big-endian payload length
UTF-8 JSON payload
```

帧上限 1 MiB；输出以不超过 64 KiB chunk 传输。连接必须先完成 `hello` challenge/HMAC。命令使用 argv 数组，禁止 Host 把字符串拼成 `/bin/sh -c`。

Host 可在一个 VM 生命周期内提交 schema 1 execution plan：最多 32 条命令，顺序或最多 8 路并行；每条命令绑定独立 request ID 与 Session ID，并经独立认证 transport 执行。Host 对并发输出编码带 command ID、stream、timestamp 的 JSONL event，二进制 payload 使用 base64；plan schema 不提供任意 Host 环境变量或 credential value，只允许 `credential_ids` 引用本次 VM 启动时明确授权的 broker binding。VM 复用不改变 Session HOME、TMP、namespace、cgroup 和清理边界。

父 Agent 编排器也可把一个 `zapvm run --serve-stdio` 子进程作为单 VM 常驻 worker。stdin/stdout 是严格 schema 1 JSONL 控制面，串口必须关闭且诊断只写 stderr；请求只有 `ping`、`exec`、`shutdown`，exec command 与 plan 共用同一校验和事件结构。worker 限制 32 个 outstanding、8 路实际并发并拒绝重复 active ID；每个 exec 重新建立 HMAC 认证 transport，独立 heartbeat transport 始终存活。协议错误可恢复，不能扩大文件、网络或 credential 权限。该接口是 parent-owned process contract，不是跨进程 daemon/registry。

## ADR-005：权限模型

- Host 授权是唯一权限来源；guest 不能自行请求扩大 Host 路径范围。
- 工作区默认读写；额外目录默认只读；敏感目录有硬拒绝清单。
- 默认工作区在 VM 内为 `rw,exec,nosuid,nodev`，使编译产物、venv 和项目脚本可运行；只读工作区与额外 Host share 保持 `ro,nosuid,nodev,noexec`。`.git`、`.zapcode` 等控制路径在每个请求的私有 mount namespace 内再次只读 bind，并固定 `nosuid,nodev,noexec`。`noexec` 不被视为 VM 边界，因为可读文件可复制到请求私有 `/tmp`；真正的边界仍是 Guest VM、低权限 workload、网络和 Host 路径授权。
- Session 用户无 sudo、无 guest agent socket 权限、无 block device 权限。
- guest 控制面目录 `/run/zapvm` 固定为 `root:root 0700`。restricted egress bridge 使用保留身份 `zapvm-proxy:zapvm-vsock`（998:998），只能访问独立的 `/run/zapvm-proxy` 和组可读写的 `/dev/vsock`；镜像 workload 身份不得使用保留 UID/GID 998。
- 每个 Session 使用 cgroup v2、PID/mount namespace、独立 HOME/TMPDIR。
- 有 state disk 时，同一 Session 的 HOME 可持久化，但物理目录必须由 root-owned 哈希父目录隔离；TMPDIR 始终按请求临时化。没有 state 时 HOME 也按请求临时化。
- Session 结束必须杀死完整进程树；清理失败则销毁 VM，不回池。
- Host credential binding 只接受显式 ID→绝对 regular-file 授权，禁止 symlink 和 POSIX group/other-readable source；最多 16 个、单值 64 KiB、总值 256 KiB。direct exec 使用全部绑定，plan/stdio exec 必须显式列 ID，未知/重复 ID 在启动前或该请求内 fail-closed。
- Agent 把 credential value 解码到 root-only `/run/zapvm/credentials/request-*`，文件在完整写入后改为 workload UID/GID 0400、目录 0555；launcher 只接受该固定 root 的直接子目录，并在请求私有 mount namespace 只读 bind 到 `/run/zapvm-credentials`。不带 credential 的并发请求没有该 mount 和环境变量。命令退出后必须先清 lease，再发 `exec.exit`；清理失败使 health fail，从而销毁 VM。supervised restart 在清完 stale cgroup 后再清 stale lease。
- Linux Host 控制面拒绝 root 运行。每台 VM 的 supervisor、Cloud Hypervisor 和全部 virtiofsd 必须处于同一个 systemd user transient scope；scope 对 CPU、memory、swap、tasks 和 IO 启用 accounting/硬限额，API 失效时以 unit 为目标 stop/kill，禁止只杀 wrapper PID。systemd 至少为 254，以使用 `--expand-environment=no` 保证路径/参数不被二次展开。
- Windows 服务管道只接受可识别本机 PID 的连接；取得 PID 后立即固定 `PROCESS_QUERY_LIMITED_INFORMATION|SYNCHRONIZE` handle，要求进程 token SID 与 pipe impersonation SID 一致，VM 只接管该 handle 的 duplicate，不再按 PID 二次打开。pipe DACL 给 SYSTEM/Administrators 完全控制，Authenticated Users 仅获去除 `FILE_CREATE_PIPE_INSTANCE` 的读写 mask。服务在固定 OS thread 上调用 `ImpersonateNamedPipeClient`，任何模拟或 `RevertToSelf` 失败都不得继续以服务身份处理请求。`start` 的每个文件/目录都在客户端 token 下按所需读写权限打开、解析最终本地卷路径，并以不共享 DELETE 的 handle 锁定到 HCS create/start 完成；VM 以调用者 SID 归属，固定调用者进程 handle 结束即 fail-stop。每个 HCS ACL grant 必须先把路径和原始 DACL 作为 schema 3 `pending_path`/`pending_dacl` 写穿恢复账本，再调用 HCS；API 成功后成对转入 `granted_paths`/`granted_dacls`。服务恢复从 VM GUID 派生精确虚拟账户 SID，只在 ACE 实际存在时逆序 revoke；同一签名镜像路径被多台 VM 并发引用时共用首个原始基线，只有最后一个引用退出才恢复包括 descriptor control bits 在内的精确 DACL。每条成功补偿立即清账并写穿，第三方 ACL 变化则 fail-closed，避免覆盖外部修改。服务 binary 与账本目录 DACL 只授予 SYSTEM/Administrators 完全控制。

## ADR-006：网络

网络模式为 `off`、`restricted`、`unrestricted`。默认 `off`；产品 UI/API 默认只提供 `restricted`。`unrestricted` 需要显式危险授权并记录审计事件。

`restricted` 模式首版不向 VM 添加 NIC 或默认路由，只启用 loopback 上的 guest bridge；bridge 经 VSOCK 连接 Host CONNECT proxy，所以普通 guest 进程没有可绕过代理的三层网络出口。OpenRC 把 bridge 置于 Agent 之前，并以 `/proc/net/tcp` 确认 `127.0.0.1:3128` 已 LISTEN 后才允许 Agent Ready，关闭首条命令与 bridge 启动之间的竞态。Host 策略同时检查域名、端口和解析后全部 IP，拒绝特殊用途地址与公私混合结果，并只拨号已校验的字面 IP。宿主代理若把一个域名的完整系统 DNS 答案改写为 `198.18.0.0/15` Fake-IP，Host 才会启用 DNS-over-HTTPS 回退；回退结果仍接受相同的全量公网地址校验，失败时 fail closed，Fake-IP 本身不会加入允许地址集合。未来若 restricted 模式加入 NIC，则必须再由 guest 防火墙强制只走 Host proxy。

Windows 只有显式 `unrestricted` 才由服务为 VM 创建 HCN 2.0 NAT network 和 endpoint，并把 endpoint ID、MAC 及 HCN 分配的静态 IPv4/prefix/gateway 放入 HCS/guest bootstrap；network/endpoint flags 都使用 HCN 2.0 的合法零值，不混用旧 HNS v1 的 DNS、DHCP 或 inter-compute bit。Guest 在 Agent Ready 前配置该静态地址，并把 DNS 写到 `/run/zapvm/resolv.conf` 后只读覆盖 rootfs 的 `/etc/resolv.conf`。NAT 不创建 inbound port mapping；服务关闭或 VM 回收时显式删除 endpoint/network，启动时以固定 owner GUID fail-closed 清理陈旧对象。为避免固定网段冲突，按三个保留候选 `/24` 依次尝试；所有候选失败则拒绝启动，不得回退到透明桥接。HCN ACL 对 stateful return flow 的具体行为仍需扩大 Windows build 覆盖，因此当前不宣称额外的“全入站 deny”规则已完成。

每次 bootstrap identity 必须包含 `network_mode`。guest Agent 在监听 VSOCK 前执行策略门：`off/restricted` 发现任何非 loopback NIC 都拒绝 Ready；`unrestricted` 必须观察到 Hyper-V/virtio NIC，并完成 Host 下发的静态配置；未提供静态配置的平台才允许 DHCP fallback。这样 Host 设备配置错误不会静默把 restricted workload 暴露到三层网络。

## ADR-007：生命周期状态机

```text
absent → preparing → stopped → starting → ready → busy
                    ↑          ↓         ↓       ↓
                    └──── stopping ← degraded ←─┘
                                  ↓
                                failed
```

只有 `ready` 能接收 Session。heartbeat 失败先标记 `degraded`，拒绝新任务；确认 guest 无响应后强停。异常停止后的可写状态盘必须经过 fsck 和 schema check 才能复用。

三平台 Host backend 共用一个加锁的 VMM 状态转换核心：`starting → running → pausing → paused → resuming → running`，`starting/running/paused --stop requested--> stopping`，只有 `stopping --exited--> stopped`；未先接受 Host stop 的 `exited` 一律进入 `failed`。pause/resume 失败分别回到 running/paused；stop 失败准确恢复请求前的 starting/running/paused，而不是把 paused VM 误报成 running。显式 failure 进入 `failed`，`stopped/failed` 都是不可逆终态。macOS 映射 VZ StateChanged/Pause/Resume，Linux 调用锁定 Cloud Hypervisor v53 API 的 `vm.pause`/`vm.resume`，Windows 普通客户端经 SCM service 调用 ComputeCore `HcsPauseComputeSystem`/`HcsResumeComputeSystem`；每个 instance 用同一 operation mutex 串行 Pause/Resume/Stop。

heartbeat 必须使用独立于命令流的已认证 transport，避免长时间 stdout 或 RPC 阻塞掩盖健康失败。agent 可并发接受少量连接，但命令并发上限是 Server 全局资源，不能按连接倍增。连接关闭只清理该连接拥有的命令；agent 进程退出或 VM 停止则清理全部命令和 cgroup。

Agent stdout/stderr 直接接入 `os/exec` 管理的 RPC writer；`Wait` 会等待两个复制 goroutine 完成，随后才发送 `exec.exit`。因此同一请求的所有 output frame 必须先于 exit，不能用 `StdoutPipe` 配合先 `Wait` 的方式冒险丢失尾部缓冲。

stdio worker 的 pause 控制先等待 active command 清空，并用 gate 等待正在执行的 heartbeat 完成后再暂停 VMM；paused 期间新 exec 返回失败 result。resume 顺序相反：底层 VMM 成功恢复后才重新打开 heartbeat gate。shutdown、EOF、idle timeout 或控制流异常退出若遇到 paused VM，会用独立 cleanup context 先恢复；只有随后 guest flush、VMM stop/reap 与 clean metadata 提交全部成功，才输出 `vm_stopped`。任一步失败都不得把 state 标为 clean。

Host 自动睡眠使用同一底层控制，但不能沿用显式 pause 的 drain 语义：Windows suspend callback 只有约两秒处理预算，logind delay inhibitor 也有系统上限。因此 `Suspend` 会立即关闭 pool admission、停 heartbeat 并冻结 VMM，允许 active guest command 在 wake 后继续；若部分 worker 超时，pool 仍保持 paused，wake 对全部 worker执行幂等 Resume 后才开放 lease。macOS 用 `IORegisterForSystemPower` 并在处理 will-sleep 后 `IOAllowPowerChange`，Linux 持有 logind `Inhibit(..., "delay")` fd 到 `PrepareForSleep(true)` 处理完成，Windows 用 `PowerRegisterSuspendResumeNotification` callback。自动 wake 只释放本次 power handler 自己取得的 pause ownership，不能解除用户此前的显式 pause。

用户级 daemon 已把池核心接到持久 stdio worker。路由键包含已解析 workspace、只读位、network mode、规范化受限出口策略摘要、签名/开发镜像内容摘要、state 身份摘要、credential 授权集合摘要、CPU 和内存；任一权限或资源字段变化都得到不同 VM。池在每次 acquire 前重新执行 Host workspace policy，并用 `os.SameFile` 比较启动时保存的目录身份，防止同一路径被替换后路由到旧 VM。相同键的并发启动合并为一个 reservation；全局/单 workspace 配额计入 starting/stopping，只有无 lease 的 LRU worker 可被换出。全池 Pause 在发起 worker 控制前先关闭新 lease admission，等待 starting reservation 退出，并发暂停所有 worker；任一失败会恢复已触达 worker，回滚失败则 degraded fail-closed。Resume 只有全部 worker 成功后才重新开放 acquire。Close 并行停止全部 worker，避免停止时延随池大小线性叠加。

后台 daemon 使用 owner-only schema 1 JSON 固定 endpoint、签名 image root/public key、state root、池配额、资源和 credential ID→文件路径。`daemon run --config ... --validate` 在不监听、不启动 VM 的情况下严格解析未知字段/边界，验签 active image 并实际读取 credential binding；service manager 直接执行同一配置入口，不允许 shell 或环境文件成为额外 authority。

本地 transport 使用双向同用户认证：macOS/Linux listener 只允许当前 UID 拥有的真实 0700 父目录、socket 固定 0600，并在 accept 与 dial 两端分别读取 `LOCAL_PEERCRED`/`SO_PEERCRED`；Windows pipe 限定 `\\.\pipe\zapvm-*`，使用只允许当前 user SID 与 LocalSystem 的 protected DACL，client/server 又通过 pipe peer PID 打开进程 token 并核对 SID。daemon 为每个连接只接受一个业务请求；exec 连接断开会取消命令并 discard 对应 worker，status/shutdown 使用短连接。普通 listener 仍绝不覆盖 endpoint；daemon 专用 listener 先通过同目录 0600 regular lock + nonblocking flock 取得唯一所有权，只在现有对象仍是同一个 socket且探测明确为 `ECONNREFUSED` 时删除 stale endpoint，普通文件、symlink、活 listener、timeout 或身份变化都 fail-closed。

daemon RPC 使用 schema 1 codec：4-byte big-endian 长度、单帧 1 MiB 上限、outer envelope 与 typed payload 均拒绝未知字段/trailing JSON，ID/type 只允许短 ASCII token，并发响应写入串行化。业务消息为 ping/status/exec/pause/resume/shutdown；status 显式返回 paused admission 状态。daemon 子进程运行 `zapvm run --serve-stdio`，control event 也按随机 ID 严格关联；guest 命令失败释放 lease，transport/VMM 失败 discard worker。Unix worker 处于独立 process session；只有内部 worker环境忽略 SIGPIPE，使父 daemon 消失后仍可清理。该 IPC 不替代 guest HMAC。

## ADR-008：可观测性

日志分为 Host 控制、VMM、guest agent、Session 四条流，统一包含 VM ID、Session ID 和 request ID。默认不记录命令环境值、stdin、凭据或完整文件内容。

核心指标：启动时间、ready 时间、RPC 延迟、内存、磁盘、heartbeat、清理失败、策略拒绝和异常停止原因。

显式 `--audit-log` 另写持久 schema 1 JSONL 生命周期账本。账本只保存随机 run ID、VM ID 的 SHA-256、run 内单调序号、固定 event/phase、前序 hash 和本条 hash；禁止自由文本 detail，因此 argv、Session/command 标识、路径、环境、输出和原始错误不能进入该文件。每条记录在跨进程锁内 append + fsync，打开时完整重放并验证链，单条 4 KiB、整文件 64 MiB 上限，partial/tampered 链拒绝继续。最终 `run_completed` defer 注册早于 state handle，执行顺序因此是 state clean/锁释放成功后再持久化完成事件；失败则写固定 `run_failed` phase，不复制可能含敏感数据的错误正文。SHA 链不防拥有文件权限的主体删除完整尾部，生产侧需要外部保存末尾 hash；Windows 继承目录 ACL 的实际部署权限仍需目标机确认。

credential value 同样不得进入生命周期审计、Host/VMM 默认日志或 result error。Host 和 Agent 在 RPC 写入/解析后、lease 清理后对自己持有的 byte slice 做 best-effort 清零；这只能缩短驻留时间，不能承诺 Go GC、socket buffer、core dump 或被调用工具内部副本已物理擦除。真正需要按域名短期签发的 OAuth/cloud token 后续仍应由在线 broker 生成短 TTL capability，而不是长期静态文件。

## ADR-009：镜像自动更新信任链

更新使用官方 go-tuf v2 客户端和显式固定的初始 root。仓库必须启用 consistent snapshots；客户端执行完整 root→timestamp→snapshot→targets 刷新，拒绝过期、版本回退、阈值不足或不一致的 metadata。生产 metadata/targets 只允许 HTTPS，禁用环境 proxy 与 HTTP 内容压缩，redirect 只能留在原 origin；loopback HTTP 仅供显式测试。企业私有 origin 可显式追加绝对路径、大小受限的 PEM CA bundle，但仍必须校验证书链与主机名，不提供 insecure 跳过开关。

稳定在线入口为 `channels/<channel>/<arch>.composition.tar.zst`，使用 TUF signed custom metadata schema 3，同时绑定单调 `release_sequence`、image version、architecture、内层 manifest SHA-256、profile-specific 精确版本向量以及独立 layer target 的路径。`host-runtime` 使用 Base/Runtime/Session 三层，`agent-computer` 使用 Base/Runtime/Agent/Session 四层。客户端优先获取 composition，再只下载内容寻址 Warm Cache 中缺失的 layer targets。`channels/<channel>/<arch>.bundle.tar.zst` 保留为完整 bundle 的兼容回退：旧镜像读取 custom metadata schema 1，schema 3 完整 bundle 使用 schema 2 并绑定 profile-specific 层版本向量。两条路径都要求外层 metadata 与内层签名 manifest 完全一致。受保护账本按 channel/arch 拒绝 sequence 回退及相同 sequence 的 manifest、target hash、层向量或 layer target 分叉；账本只在签名镜像重组、安装和原子激活完成后提交。TUF target hash 是外层供应链完整性，现有 Ed25519 manifest 与逐文件 hash 是独立的内层制品完整性，两层都必须通过。

bundle 默认是确定性 Zstd/tar，并继续只读兼容旧 gzip/tar；只允许 manifest 列出的顶层普通文件以及 `manifest.json`/`manifest.sig`。路径分隔符、NUL、重复项、symlink、额外文件和超限输入全部拒绝。下载和离线导入都采用有界流式处理，不把多 GiB rootfs bundle 整体载入内存；TUF target 通过内容 hash 命名进入持久 Warm Cache，每次复用前重新校验长度与全部 hash，最多保留四个对象。离线 `install-bundle` 必须在 owner-only/protected-DACL staging 内完成结构校验、Ed25519/逐文件 hash 验证和显式架构匹配后才安装；相同版本只能接受逐字节相同 manifest，重复导入不得增加 activation generation。联网更新和激活型离线导入在切换前必须使用 staged version 启动真实 VM smoke；`update`、`install-bundle`、手工 `activate` 和 `rollback` 共用非阻塞排他锁；版本目录只新增不覆盖，active pointer 和 update ledger 分别以 fsync + atomic replace 提交。

manifest schema 3 把完整制品划分为 Base、Runtime、Agent、Session 四个独立版本层。Base 与 Agent 盘均由 VMM 只读附加，Session 从稀疏模板为每个 Computer 建立独立可写盘，Workspace 始终是显式 Host share。在线发布进一步拆成一个仅含签名 manifest 的 composition target 和四个独立 TUF layer targets；客户端优先使用 schema 3 custom metadata，只下载 Warm Cache 中缺失的层，再按签名 manifest 重组并启动候选 VM。完整 bundle 继续用于离线安装、真机验收和灾备。详细构建、启动、更新与验收契约见 [`layered-image-delivery.md`](layered-image-delivery.md)。

## ADR-010：启动只消费签名 active image

产品模式的 `zapvm run` 不接受调用方直接指定 kernel/rootfs。Host 先读取原子 `active.json`，重新验证 Ed25519 manifest、Host 架构、所有文件 size/hash 与 state schema，再按平台选择 raw 或 VHDX；显式裸路径只允许带 `--allow-unsigned-image` 的开发/故障注入，且不能与签名模式混用。

镜像构建也必须保持架构隔离与失败原子性：arm64/amd64 使用独立 build context，输出先写同一输出根下的私有 staging；只有 guest binaries、rootfs/kernel、两种磁盘格式、锁定 Linux runtime、SBOM 和 manifest 全部成功后才能一次 rename 提交。默认拒绝覆盖现有架构目录；显式替换时先把旧目录移动到可恢复备份，不允许在原目录内半量更新。

Linux 的 Cloud Hypervisor、virtiofsd 和 runtime provenance 与 guest 镜像放在同一 per-arch manifest。Cloud Hypervisor 下载资产先验证锁定的上游 digest；virtiofsd 从锁定 source/Cargo.lock 在 digest-pinned Alpine/musl builder 中静态构建。最终二进制 hash 必须同时匹配签名 manifest 和签名 provenance，Host 还要验证两者是与 manifest 架构一致的 64-bit little-endian ELF executable，且均不含动态解释器。Host 只执行已验证版本目录下的绝对路径，并在创建 runtime 目录前以 5 秒/64 KiB 上限执行 `--version` 做版本与可执行性门禁。`PATH` 仅保留给显式未签名开发调用，不属于产品信任链。

## ADR-011：Agent Computer 与远程控制面边界

Agent Computer 是项目级持久身份，独立于一次命令、Session 和临时 VM route。owner-only daemon registry 固定其 workspace、网络授权和资源规格；运行状态只从实时 pool 推导，不持久化可能过期的 running 标志。Computer ID 单独派生 state disk 身份，因此镜像升级不会丢失 state；route authority 变化时，pool 必须先 clean retire 同 Computer 的旧 worker，再允许新 worker 挂载该盘。active command 存在时显式 stop 或 route replacement fail closed。

本地 `computer create|list|inspect|exec|stop` 复用现有同用户 IPC 和 daemon framing，但 `computer_id` 不能由通用 `daemon exec` 伪造；daemon 从受保护 registry 重新装配 workspace、policy 和 resource authority。Computer registry 在 POSIX 固定目录 0700/记录 0600，在 Windows 使用只允许当前用户与 LocalSystem 的 protected inheritable DACL；所有平台拒绝 symlink、未知字段、超限记录和非 token ID。`stop` 保留 record/state，破坏性 delete 暂不提供。

异步 Task 使用 owner-only、append-only 事件 journal：创建事件必须先于提交响应持久化，Task ID 与请求 digest 共同提供幂等提交，事件 cursor 支持历史重放和 follow。提交连接与 attach 连接都不拥有执行生命周期；断开只结束观察，daemon 持有 VM lease 直到终态写入。显式 cancel 先写请求事件，再通过 per-Task context、Host stdio cancel 和命令独占 Guest Agent 连接关闭来终止 Guest 进程树；只有收到终态才复用 worker，取消超时则 fail closed 丢弃 VM。retry 必须对源请求 digest 做等值验证并生成带 `retry_of` 的新 journal。重启恢复不自动重放未知副作用命令。journal 中的 stdout/stderr 和结果属于敏感数据，必须与本地 state root 同级保护。

Task retention 是显式策略，默认不删除。prune 与 opt-in daemon GC 只选择 cutoff 之前的终态 Task，按 oldest-first 和单批上限处理；先将完整目录原子移动出 live namespace，再删除并同步父目录。非终态 journal fail closed，不能因容量压力被回收。retention 内的 cursor 可恢复，过期后的 not-found 是公开协议语义而不是透明重建。

Work Computer 在 state schema 3 中把 `computer/nix` 绑定到请求 mount namespace 的 `/nix`，保持 `nosuid,nodev` 但允许执行；根挂载仍为签名只读。workload 以非 root 身份运行 Nix local store，`zap-pkg` 使用 Computer 级 profile 与内核文件锁。安全环境固定 Nix store/profile/cache 与 PATH，调用方不能用请求环境变量重定向到 Host 或控制目录。restricted 网络仍由 Host policy 逐任务取 Computer allowlist 的子集，不因安装能力自动变为 unrestricted。

未来远程控制面不属于该本地 IPC 信任域。它必须在 Host daemon 之前提供 mTLS 节点身份、tenant authorization、跨节点任务投递与确认、短期 credential broker 和审计；不得把本地 socket 或 Guest agent transport 直接暴露到公网。Agent adapter 只获得 Computer/Session 级能力，不获得 VMM、状态盘或 Host 文件系统的泛化权限。

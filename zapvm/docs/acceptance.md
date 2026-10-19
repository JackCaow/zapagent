# 当前验收记录

> 首次记录：2026-08-07；最后更新：2026-08-11。这里记录已实际执行的证据；没有在真实平台执行的项目明确标为未验收。

## 0. 当前精确 RC3 分层镜像候选验收（2026-08-11）

当前候选由 zapVM builder `16317a71b94cdf607fb1cc2873463a6ac56a0f7b` 与 ZapCode
`9124173f19139ac8dd6760bb1035675b1c2fd388` 构建。`arm64` schema 3
manifest 固定 Base `alpine-3.23.5-r1`、Runtime `0.3.0-rc.3`、Agent
`1.12.0`、Session `3`；Agent provenance 同时固定 Bun `1.3.0`、
`bun-linux-arm64-musl` 和 Resident Zap payload SHA-256
`2c4c754ec80af9cc964c818570d614354f3d5771edf2172ee90ebaca2d99e876`。

用 zapVM `e13f1b533fc38412e6d1398e77c495b60a65d895` 重建 RC3 Host archive，
其中 entitlement-signed `zapvm 0.3.0-rc.3` 在真实 macOS Apple Silicon
Virtualization.framework 启动同一签名候选。guest 确认 Base root
只读、Session schema 3 可写、Agent disk 以 `ro,nosuid,nodev` 挂载，实际输出
`zapcode v1.12.0` 与 `ZAPVM_IMAGE_SMOKE_OK`，随后 state flush acknowledged 并退出。
签名校验后 staged image 原子激活为 generation 1；候选专属 VM/VMM 进程无残留。

精确摘要：

```text
host archive  b2df96dbf93ae446db3ac42076c31a096cedc6e53b83936f8b78ccafcd44e5e3
image bundle  354dd10ec642f20217945256538e868d36da95f767849633b38fa165c1e70153
manifest      da810a9c45cd0ce3c9478fc078d0f5562dac7bbbd617a4d6af79896165a1373c
public key    178da5377ec3f3f632815e9c7c99dffb473560792a0019deb99feb1327f21dec
TUF custom    05abfdcdbe575a79099f72f1c819f9a6fdc950551f6485351c1b675953f9aff5
amd64 bundle  0a40cbe1e9d9c7eb16772ed84285483352d5a22a544fff9bf61b8216b7ab0505
amd64 manifest c2912e87ab2cd902656c7817a6d1e95b6d940a68d0f0d3e4e49035ba5a4444ab
arm64 composition 6b004366c1fa426e4b1fba55e68c5c03e854fc3d68f379c9fc47705de926d50f
amd64 composition 379ea3ef1889746b6a88e0efc7dc3b351d36202a308f15d46ce36cc961526f81
arm64 schema3 TUF custom 8f5158eb94a4302e11a9223c22dffea55c2eb266ed40f12590e2314a8dbb1096
amd64 schema3 TUF custom 37072b70d58e49f0dfacf6cd933f973ca1b90448e6b2a87bf7e541c95549e00c
```

本机交付证据保存在
`/Users/example/Desktop/zapVM-0.3.0-rc.3-layered`。该候选使用 owner-only 文件密钥，
仍是 RC 而不是 HSM/KMS 生产签名稳定版；Linux amd64 KVM 与 Windows amd64 HCS
仍须用同一 amd64 精确 bundle 复验。amd64 已完成 locked-runtime digest、schema 3
构建、签名、逐文件校验、TUF custom metadata 与 Zstd bundle；未把这些构建证据
冒充真实 KVM/HCS 启动证据。

zapVM `680a1d649447bdb3cfddd29197105512fbf769a6` 又把同一签名 manifest
拆成只含 manifest/signature 的 composition 和 Base/Runtime/Agent/Session 四个
独立、按架构命名的 TUF target。双架构 `layer-targets.json` 已逐项复验五个 target
的 size/SHA-256。端到端测试使用签名 TUF metadata 下载五个 target，重组后通过
受信 CA 的真实 TLS 服务完成下载，重组后通过 Ed25519 与全部文件 hash 校验并提交
schema 3 ledger；第二次执行对 target 的网络
请求数为 0，证明验证过的 Warm Cache 被实际复用。完整 bundle 保留为离线安装、
目标 Host 验收和灾备制品。这里仍只证明本地 TUF 链与精确制品身份，不代表生产
HTTPS/CDN 或 Linux/Windows 真机更新已验收。

为避免最终原生候选验收继续依赖会消耗 Actions 预算的 hosted authorization/build
job，新增 `native-candidate-acceptance.yml`。Linux 与 Windows 两条路径全部运行在
唯一 `zapvm-physical-<host-id>` self-hosted runner 上，先校验 operator-pinned bundle/
public-key SHA-256 与只读 Host preflight，再从选定 Git revision 原生构建并验证 Host
package，最后让既有完整验收脚本只使用该 package 内的 `zapvm`/`zapvm-image` 执行
精确 signed amd64 candidate；Windows 额外执行 21 点 HCS ACL 强杀恢复。证据与原生
Host archive 优先保留在 runner workspace，GitHub artifact upload 仅是 best-effort
副本。workflow 的 YAML/Actionlint/仓库静态门禁已通过；没有注册真实 runner 和成功
run 前仍只记“验收入口完成”。相同逻辑同时暴露为 Linux shell 与 Windows
PowerShell 原生入口，即使 workflow 尚未合并、未注册 runner 或 Actions budget 不可用，
目标机仍可直接完成最后验收并保留同格式 evidence。

## 0.1 历史 RC1 分层镜像候选验收（2026-08-11）

候选 `1.12.0-layered-rc1/arm64` 已在 macOS Apple Silicon 的真实
Virtualization.framework VM 完成以下黑盒链路：

- manifest schema 3 的 13 个签名文件全部且仅归属于 Base、Runtime、Agent、Session 四层；
- Base `alpine-3.23.5-r1` 以只读 root 挂载，Session schema 3 可写；
- 独立 Agent raw disk 以 `ro,nosuid,nodev` 挂载到 `/opt/zapvm-agent`，实际执行输出 `zapcode v1.12.0`，与 Agent layer `1.12.0` 一致；
- candidate smoke 在 `active.json` 切换前完成 mutual-auth RPC、能力检查、状态写删和 clean flush，并输出 `ZAPVM_IMAGE_SMOKE_OK`；
- RC2 写入 Session marker 后，签名回滚到 RC1，以同一 state disk 读回 marker 并输出 `ROLLBACK_STATE_OK`；最终 state 为 `clean_shutdown=true`、schema 3、generation 3；
- 失败 candidate smoke 的单测证明候选只保留在 staged version，不能生成或改写 `active.json`。

精确候选摘要：

```text
image bundle  8a865f998b3e3305e0c3de599f7d0e0766a6b9178fa23bd3d0cc815d486d552e
manifest      d802f8606d9ea08013fb800373bd5d32447498567100f3ada94894f14549521b
public key    b5ac03539bd243c8ba880292a6e2aec7080b02e9b263f6f08314cc1ee4bed22f
```

这组证据只关闭该摘要的 macOS arm64 分层镜像与真实 Resident Zap 门禁。公共
Linux/Windows CI 因不持有私有 Zap payload，会使用只允许 `--version` 的明确
`unavailable` Agent 层验证 schema 3 挂载和平台执行链；这不能替代真实 Zap payload
在 Linux amd64 KVM、Windows amd64 HCS 上的精确候选复验。生产签名/公证、生产
TUF/CDN 和 clean-machine 更新同样仍须保留成功证据；历史 schema 1/2 平台验收
不能替代 schema 3 候选验收。

## 1. 构建与单元测试

| 项目 | 结果 | 证据 |
|---|---|---|
| Go 单元测试 | 通过 | `go test ./...` |
| 全仓 race test | 通过 | `go test -race ./...` |
| Go vet | 通过 | `go vet ./...` |
| Framed codec fuzz | 通过 | 5 秒，266,051 execs，78 interesting inputs |
| RPC auth envelope fuzz | 通过 | 5 秒，224,437 execs，40 interesting inputs |
| Host path boundary fuzz | 通过 | 5 秒，192,271 execs，118 interesting inputs |
| Authenticated Agent RPC dispatch fuzz | 通过 | 5 秒，52,695 execs，119 interesting inputs |
| ExecStart validation fuzz | 通过 | 5 秒，153,287 execs，125 interesting inputs |
| Linux amd64/arm64 交叉编译 | 通过 | `GOOS=linux GOARCH=<arch> CGO_ENABLED=0 go build ./...` |
| Windows amd64/arm64 交叉编译 | 通过 | `GOOS=windows GOARCH=<arch> CGO_ENABLED=0 go build ./...` |
| macOS entitlement doctor | 通过 | 签名后 `bin/zapvm doctor` 两项均为 `pass` |

交叉编译不等于对应平台运行验收。

fuzz targets 位于 `internal/protocol/fuzz_test.go`、`internal/hostpolicy/fuzz_test.go` 与 `internal/agent/fuzz_test.go`。它们覆盖任意 framed bytes 的有界解码/重编码、认证 envelope、路径父子边界、认证后的全部 Agent RPC method 分派、连接关闭后 active-command 清零，以及 ExecStart 的 JSON/argv/env/timeout 校验。RPC fuzz 将 `state.flush` 替换为无副作用测试依赖，并保证不会执行 fuzzer 控制的程序。跨平台 VMM 事件/生命周期状态机 fuzz 仍未完成。

## 2. 镜像构建

执行：

```bash
./scripts/build-rootfs.sh arm64
./scripts/build-rootfs.sh amd64
```

arm64 与 amd64 均已生成 `kernel`、`initramfs`、`rootfs.raw`、`rootfs.vhdx`、`state.raw`、`state.vhdx`、`capabilities.json`、`sbom.spdx.json` 和 `manifest.json`。arm64 流水线会从 Alpine PE/gzip `vmlinuz` 解出 Apple VZ 可启动的原始 Linux `Image` 并校验 ARM64 Image header；amd64 保留 Linux x86 boot protocol `bzImage`。两种架构都从同一用户态配方产生 raw ext4 与动态 VHDX，并把所有交付文件的 size/SHA-256 写入各自 manifest。

本次 amd64 格式核验确认：`kernel` 是 Linux 6.18.42 x86 boot executable bzImage，`initramfs` 是 gzip，`rootfs.raw` 是 ext4，`rootfs.vhdx` 是动态 VHDX。这里证明的是制品可构建且格式匹配，不证明其已在真实 x86 KVM 或 Windows HCS Host 启动。

当前 rootfs 特征：

- Alpine 3.23.5 / Linux 6.18.41-0-virt。
- rootfs 以 Virtio block 只读挂载。
- 含静态 `zapvm-agent`、`zapvm-launcher`、`zapvm-proxy-bridge`、CA、Git、SSH client、curl、nftables、Python 3.12、pip/virtualenv、Node/npm、jq、ripgrep、zip/unzip 和 kernel modules。
- 运行时系统包变更被显式阻断；`apk add/del/fix/update/upgrade` 返回 `ZAPVM_ERROR[IMMUTABLE_ROOTFS]`，查询命令仍由镜像内原始 APK 实现处理。
- bootstrap secret 通过只读 `zapvm_boot` VirtioFS share 复制到 `/run`，随后卸载 bootstrap share。
- bootstrap 同时注入 Host UID/GID，guest agent 只在准备隔离挂载时保持 root，执行 argv 前永久降权。
- agent 启动前显式加载 `vsock`，支持 virtio 与 Hyper-V transport。
- guest service 在 macOS/Linux 优先挂 VirtioFS，在 Windows HCS 下 fallback 到 9P2000.L。
- HCS fallback 由静态 `zapvm-plan9-mount` 完成：连接 Host CID/port 564、复制 VSOCK FD、限制 share 名避免 mount-option injection；默认读写 workspace 使用 `trans=fd`/9P2000.L/`nosuid,nodev`，只读 workspace 与 bootstrap 保持 `noexec`。
- restricted egress bridge 使用独立的 `zapvm-proxy:zapvm-vsock`（998:998），不复用镜像 workload 的 1000:1000；Host 注入的 workload UID/GID 也会拒绝保留值 998。

Base 构建现将 Alpine 3.23.5 多架构镜像固定到 OCI index digest，并在导出 rootfs 前校验每个架构完整 `/lib/apk/db/installed` 的 SHA-256 与包数量；锁文件同时声明 `ROOTFS_BASE_VERSION`。该门禁是在重建候选时捕获到 Alpine 仓库已把内核和 CA 等包更新、而旧 Base 版本名仍不变后补入的：以后相同漂移会令构建失败，不能再以旧层版本静默产出不同字节。锁更新必须伴随新 Base 版本和评审。

镜像工具已实现 Ed25519 keygen/sign/verify、逐文件 size/SHA-256 校验、symlink/path traversal 拒绝和同文件系统 staged rename 安装；对应单测包含篡改拒绝与禁止覆盖已有版本。构建流水线会从同一 ext4 raw rootfs 生成动态 VHDX，并把预格式化 state raw/VHDX 模板纳入 manifest。新 manifest schema 2 签名声明 `state_schema=2`；验证器仍兼容旧 schema 1 并明确归一化为 state schema 1，拒绝未知 manifest/state schema。

镜像流水线还解析 Alpine `/lib/apk/db/installed`，生成确定性的 SPDX 2.3 JSON。Alpine 的非标准 `Public-Domain` token 被规范为文档内定义的 `LicenseRef-Alpine-Public-Domain`；最初遗漏 extracted license 定义时，官方验证器明确拒绝，补齐 `hasExtractedLicensingInfos` 后 arm64/amd64 均通过 `pyspdxtools --version SPDX-2.3` 零错误校验。`sbom.spdx.json` 已纳入 per-arch manifest，后续签名/篡改拒绝与其它制品一致。包数量随精确 Base/Runtime/Agent 版本变化，因此验收必须记录候选镜像自身的数量和摘要，不能沿用历史常量。

schema 3 进一步把 `source-offer.json` 纳入 Runtime 层和镜像签名。构建器从 Alpine installed DB 的 origin/aports commit、zapVM/ZapCode 精确提交和锁定的 Cloud Hypervisor/virtiofsd 源码归档生成逐包对应源码索引；激活前验证器要求它与 SPDX 的 package ID、名称、版本和 declared license 一一对应，并拒绝未知许可证、遗漏/重复覆盖、非 HTTPS URL、路径穿越、未知字段和 trailing JSON。实现级单测及实际 installed DB 生成测试已通过；这不等同于精确发布候选的源码镜像留存和法律复核，`roadmap-to-1.0.md` 对应门禁在完成这些外部步骤前仍保持未勾选。

为兼容三平台块设备，guest state gate 依次只接受 Virtio `/dev/vdb` 或 HCS SCSI `/dev/sdb`，并在 fsck/mount 前验证 `TYPE="ext4"` 与 `LABEL="zapvm-state"`。首次实现因误用 util-linux 风格的 `blkid -s/-o` 与 Alpine BusyBox `blkid` 不兼容，真实 macOS VM 串口门禁捕获并拒绝；改为解析 BusyBox 实际 identity 后重建 arm64/amd64 镜像。修复后的真实 VM 输出 `STATE_DEVICE_REGRESSION_OK`，收到 state flush ack，最终 metadata 为 clean、generation 1。

`activate/status/rollback` 使用原子 `active.json` 指针，记录 active、previous 和 generation。单测已验证两个签名版本的激活与回滚；篡改 previous 后回滚会被拒绝且指针不变，修复文件并重新验证后才允许回滚。

新增 `zapvm-image bundle/update`。本地端到端测试实际生成四个独立 Ed25519 角色的 TUF root/targets/snapshot/timestamp、consistent-snapshot hash-prefixed bundle 和独立镜像 manifest key，再经 loopback HTTP 完成 metadata 刷新、SHA-256/SHA-512 流式下载、严格 tar 解包、内层签名验证、版本安装、active generation 1 和 sequence 1 账本提交；随后把可信账本提高到 sequence 2，确认旧 sequence 1 在下载前以 `release sequence rollback` 拒绝。恶意归档测试覆盖 `../` traversal、symlink 和超限 manifest，独立下载测试确认同长度篡改被 SHA-256 拒绝；URL 测试覆盖 HTTPS、loopback-only HTTP、credentials/query/file scheme 拒绝，custom metadata/ledger 均拒绝未知字段和 trailing JSON。`update/activate/rollback` 现共享同一跨平台非阻塞锁，并有第二个并发持有者失败的回归测试；cache 在 Unix 为当前用户 0700，在 Windows 使用 SYSTEM/Administrators/current-user protected DACL。

schema 3 分层更新又增加 TUF custom metadata schema 2：外层签名 metadata 在下载前绑定 Base/Runtime/Agent/Session 精确版本向量，下载后必须与内层 Ed25519 manifest 完全一致；缺少向量、错层版本、旧 manifest 携带向量、同 sequence 向量分叉和 ledger 非法向量均 fail-closed。端到端测试实际生成 schema 3 签名 bundle、四角色 TUF 仓库，经 loopback HTTP 安装激活并确认四层向量写入受保护 ledger。`zapvm-image target-metadata` 只从已验签 manifest 自动生成发布 JSON，篡改 manifest 与覆盖已有输出均被拒绝。

这证明实现级 TUF 信任链和本地下载链路，不证明生产发布完成。尚未验收：生产 root/targets 密钥托管、真实 HTTPS/CDN、后台调度、生产制品跨版本回滚，以及 Windows DACL 在真实 NTFS 上的运行行为。state 1→2 已在真实 macOS VM 验收；Linux/Windows 仍须随各自真实平台复核，且这不等同于生产镜像升级验收。

## 3. macOS Apple Silicon 真实 VM

Host：macOS 15.6.1 arm64；后端：Apple Virtualization.framework。

### 3.1 启动与只读 rootfs

通过。串口证据包括：

```text
virtio_blk ... [vda] 3145728 512-byte logical blocks
EXT4-fs (vda): mounted filesystem ... ro
OpenRC 0.63 is starting up Linux 6.18.41-0-virt (aarch64)
```

### 3.2 bootstrap、vsock 与认证

通过。guest 识别 `zapvm_boot`，加载 PF_VSOCK，Host 输出：

```text
guest agent authenticated
```

错误 secret 的拒绝由本地 mutual-auth 单测覆盖；真实 VM 错误 secret 测试尚未执行。

### 3.3 低权限命令执行与身份映射

通过。早期固定身份测试返回 `uid=1000(zapvm)`；当前自动 bootstrap 会映射真实 Host 身份。本机 Host 结构化传递 `[/bin/sh, -c, ...]` 后返回：

```text
uid=501 gid=20(dialout)
```

该链路覆盖：VM 启动 → VirtioFS secret → Virtio socket → HMAC auth → exec.start → stdout → exit code。

### 3.4 授权工作区读取

通过。把当前仓库作为只读 `zapvm_workspace` share，guest 在 `/workspace` 执行：

```text
/usr/bin/wc -c README.md
1868 README.md
```

### 3.5 只读工作区写阻断

通过。guest 执行 `mkdir zapvm-write-probe`：

```text
mkdir: can't create directory 'zapvm-write-probe': Operation not permitted
```

Host 随后验证该路径不存在。

### 3.6 授权工作区读写

通过。Host 未手工准备 secret 或 identity，CLI 自动创建 per-boot bootstrap share；guest 创建 `rw-probe-2/result` 后，Host 验证：

```text
mode=-rw------- uid=501 gid=20 size=12
isolated-ok
```

### 3.7 请求隔离与资源边界

通过真实 VM 黑盒测试。命令位于请求级 PID、mount、UTS、IPC namespace 和 cgroup v2；cgroup 路径形如：

```text
0::/zapvm/85179a5d8c8fe7f4/907b140415f335dc
```

隔离 launcher 在降权前重挂 `/proc`，`ps` 只能看到当前请求：

```text
PID   PPID  USER  COMMAND
1     0     501   sh
7     1     501   ps
```

`/proc` 使用 `hidepid=2`；`/tmp` 和 `/home/zapvm` 是请求私有 tmpfs，均由 501:20 所有。请求 cgroup 当前限制为 1 GiB memory、256 PIDs 和 1 CPU quota；连接取消、timeout 和正常退出都会杀 cgroup 后代并由执行协程回收。

重建加入 Windows 9P fallback 和 VHDX 后，又执行一次完整 macOS 回归；mutual auth、501:20、私有 PID namespace 和默认读写工作区均保持通过，Host 侧 `final-result` 为 501:20、`0600`、内容 `final-ok`。

### 3.8 默认网络关闭

通过真实 VM 黑盒测试。以 `--network off` 启动时，guest 只有处于 DOWN 状态的 loopback，没有默认路由；对 `http://example.com` 的限时请求失败并输出 `NETWORK-BLOCKED`。

### 3.9 受限网络

通过真实 VM 黑盒测试。restricted 模式不附加 NIC，只启用 loopback；路由表为空。guest 的 `127.0.0.1:3128` 桥通过 VSOCK 19091 连接 Host CONNECT proxy，因此非代理流量没有旁路。启动状态为：

```text
restricted egress proxy ready
guest agent authenticated
zapvm-proxy-bridge: started
```

以唯一允许项 `example.com:443` 执行内容级验证，完整页面正文包含 `Example Domain`，Host 审计记录解析后的公共地址并输出 `ALLOWED_CONTENT_OK`。随后请求未授权的 `www.iana.org:443`，Host 在 DNS 前按域名拒绝，guest 输出 `DENIED_DOMAIN_BLOCKED`：

```json
{"host":"example.com","port":443,"addresses":["172.66.147.243","104.20.23.154"],"allowed":true}
{"allowed":false,"reason":"egress policy denied target: host is not allowed"}
```

策略单测还覆盖精确/通配域名、端口、IDNA、私网/loopback/link-local/metadata/CGNAT、DNS 公私混合结果、NAT64 内嵌私网、拒绝前不解析，以及只拨号经校验的字面 IP，避免 DNS TOCTOU。当前产品能力只支持 HTTPS CONNECT；普通 HTTP 转发尚未实施。

### 3.10 状态盘持久化与异常恢复

通过真实 VM 黑盒测试。用 `zapvm state create` 从 `state.raw` 创建逻辑大小 512 MiB 的 per-VM 磁盘；APFS clone 后 Host 实际占用约 1 MiB。初始元数据为 clean、generation 0。

早期基线第一次 VM 启动在 Agent Ready 前完成 `/dev/vdb` 的 `e2fsck -p`、ext4 mount 和 schema-version 1 校验；workload UID 501 写入 `/var/lib/zapvm/data/probe`。正常停止后元数据为 clean、generation 1，第二次 VM 启动成功读回 `persistent-state-v1`。

随后对第二次 VM 的 Host 控制进程执行受控强杀。内核文件锁自动释放，但 companion metadata 保持：

```json
{"clean_shutdown":false,"generation":2,"last_vm_id":"mac-state-read"}
```

第三次启动明确输出 dirty recovery 提示；guest fsck/schema gate 通过、agent 认证后仍能读回数据，并输出 `STATE_RECOVERY_OK`。最终实现又加入 root agent `state.flush` RPC；真机返回 `guest state flush acknowledged`，Host 主动正常停机后元数据为 clean、generation 4。仅 VMM stopped、启动失败、代理错误或 Host crash 都不会误标 clean。

公共状态库单测还覆盖模板不覆盖、symlink 拒绝、格式/schema 校验、并发 attach 文件锁、失败启动元数据回滚、dirty generation 和原子元数据替换。Linux/Windows 的 raw/VHDX attach 与 guest gate 尚待对应真实 Host 验收。

当前 state schema 已提升到 2，并完成真实 v1→v2 黑盒迁移。保留的旧 `state.raw` 先由 ext4 `debugfs` 直接确认 `schema-version=1`，新双架构模板确认值为 2；两份 manifest schema 2 各含 7 个逐项 size/SHA-256 匹配文件，签名字段 `state_schema=2`，SPDX 仍各为 78 packages/relationships 且验证零错误。Host 以 `--schema 1` 克隆旧盘，首次 macOS VM 在 init gate 中迁移，Agent health 回报 2 后写入普通 state 与 Session HOME并完成 flush；companion metadata 从 clean generation 0/state 1 提交为 clean generation 1/state 2。第二次 VM 以同 Session 成功读回两类数据，最终 generation 2。停机后再次用 `debugfs` 直接读到盘内 schema 2、migration marker 2 和 payload；精确进程名复查无 zapVM/VMM 残留。证据目录为 `.cache/acceptance/state-schema-migration-macos-MhfOj7`，模板/制品证据为 `.cache/acceptance/state-schema-artifacts-czRw1k`。

新增 `zapvm diagnose` 默认脱敏 JSON：输出必须是不存在的新文件，并以同目录临时文件 fsync + exclusive hard-link 提交为 0600；最多接收 32 个 state 和 32 个 manifest。state 路径只保留 SHA-256 短 ID，`last_vm_id` 默认清空；manifest 只保留自身 hash、版本/架构/protocol/state schema/文件数，不读取工作区、环境、secret 或文件正文。真实 macOS 快照同时解析 state schema 2 与 7-file arm64 manifest，doctor entitlement 为 pass，文件中不存在仓库绝对路径，证据为 `.cache/acceptance/diagnostics-macos-pass-3E0r96`。该验收还捕获并修复了旧校验器把 raw string 中 `\\x00` 误当字符集合、从而错误拒绝文件名 `rootfs.vhdx` 与版本 `0.1.0-*` 的问题；现在分隔符与 NUL 分开检查并有回归测试。

默认脱敏另有负向 canary 门禁：同一秘密值分别放入环境变量、Workspace 文件正文和敏感输入路径，生成结果仍保留 `path_id` 与 redacted error，但不得出现秘密值、变量名、Workspace 名、路径或文件名。Host 包内 `zapvm`、`zapvm-image`、`zapvm-node` 和 `zapvm-sbom` 使用共同的稳定错误分类；真实构建二进制负测确认 invalid request/image/configuration 分别退出 64/65/78 并输出 `ZAPVM_ERROR[code]`，权限、磁盘/配额和超时由共享分类器覆盖。

`--stop-after-exec` 自动化有序停机路径也已通过短 soak：`scripts/soak-macos.sh` 连续执行 3 次冷启动，每一代从 state 读取上一代计数、写入新计数、收到 guest flush ack 后停机。最终 metadata 为 clean、generation 3、last VM `mac-soak-3`，期间无人工信号。该结果只是功能性短门禁，不替代 72 小时长稳。

state v2、诊断与生命周期加固后又用最新签名 Host binary 重跑同一 3 轮短 soak；三轮分别输出 `SOAK_ITERATION_1_OK` 至 `SOAK_ITERATION_3_OK` 和 flush ack，最终 metadata 为 schema 2/state schema 2/clean/generation 3，并用 ext4 `debugfs` 直接读到盘内计数 3；退出后无 zapVM/VMM 精确进程名残留。证据目录 `.cache/acceptance/state-v2-short-soak-ds5tVv`。首次自动断言误用了长稳脚本才产生的 workspace 文件名而返回 1，随后只读检查日志、metadata 与盘内计数确认 VM 路径实际通过；该操作性误报不计作产品失败。

独立 state clone 上完成 ENOSPC 故障注入：非 root workload 写至 ext4 可用空间耗尽并观察到 `STATE_ENOSPC_OBSERVED`，agent 仍能完成 flush 和有序停机；下一次 VM 启动删除大文件、重新写入并输出 `STATE_ENOSPC_RECOVERY_OK`，最终 metadata clean、generation 2。测试盘一度实际占用 451 MiB，验收后仅删除该独立临时盘并回收空间。

最终还执行 state + restricted egress 组合回归：同一 VM 读回持久 state、允许 `example.com` 内容、拒绝 `www.iana.org`、收到 guest flush ack 后自动停机，输出 `COMBINED_STATE_EGRESS_OK`；主测试 state 最终 clean、generation 5，Host 无遗留 VM 进程。

### 3.11 Agent heartbeat、监管重启与崩溃

通过真实 VM 故障注入。agent 改为并发处理最多 8 个认证 transport 连接；命令与 heartbeat 使用不同 VSOCK 连接，命令 semaphore 仍是全局共享。3 秒 workload 执行期间以 1 秒周期探活并输出 `HEARTBEAT_DURING_EXEC_OK`。

OpenRC 通过 `supervise-daemon` 监管 agent。Host 先请求一次空闲 agent 有序重启，等待服务重新拉起并重新 HMAC 认证，随后健康检查和命令执行成功，输出：

```text
guest agent supervised restart recovered
guest agent health ready
SUPERVISED_AGENT_RESTART_OK
```

非协商崩溃使用双重门控 fault RPC：只有自动生成的 root-only identity 包含 `fault_injection=true` 且调用方通过 per-boot HMAC 时启用；默认请求由单测验证为拒绝。真实 VM 在 30 秒 workload 已启动后注入 agent 进程退出，250ms heartbeat deadline 检测到 broken pipe，CLI 返回非零并输出 `guest agent degraded after injected crash`；没有出现 workload 完成标记，VM 被控制面销毁。agent 每次启动还会扫描并 kill/remove `/sys/fs/cgroup/zapvm` 下遗留请求 cgroup。

同一崩溃测试又在主 state 上执行：异常退出后 companion metadata 保持 dirty、generation 6；下一次启动输出 fsck/schema recovery 提示，读回原持久数据并输出 `AGENT_CRASH_STATE_RECOVERY_OK`，guest flush 与有序停止后恢复 clean、generation 7。

### 3.12 Session HOME 与 Host 路径授权

通过三次真实 VM 黑盒测试。`--session-id agent-a` 首次把文件写入 `/home/zapvm/session-probe`，并确认 HOME 的 mount 来源是 state ext4；第二台 VM 使用同一 Session 输出 `SESSION_HOME_PERSISTENCE_OK`。第三台 VM 使用 `agent-b`，确认看不到 A 的文件、写入独立内容并输出 `SESSION_HOME_ISOLATION_OK`。三次均完成 heartbeat、state flush 和有序停机，主 state 最终 clean、generation 10。

Session HOME 实际路径是 state 内 root-owned `sessions/<session-hash>/home`：父目录不可由 workload 替换，HOME 本身归 workload UID/GID 所有、模式 0700；launcher 在请求私有 mount namespace 中 bind mount 并附加 `nosuid,nodev`。没有 state disk 时仍使用请求私有 tmpfs HOME；TMP 始终不持久化。

Host workspace policy 单测与 CLI 黑盒均通过：普通工程目录允许；`/`、整个 Host HOME、`.ssh/.aws/.gnupg/.kube/.docker`、系统凭据目录和 symlink 指向这些目标均拒绝。真实 CLI 尝试 `--workspace /` 返回 `refusing to share a filesystem root as workspace`，没有启动 VM。

同一 VM 多 Session execution plan 已在 macOS Apple Silicon 真机验收。schema 1 plan 使用两个独立认证连接并行提交 `plan-session-a`/`plan-session-b`：Host 先输出 `scheduled`，收到 guest Agent 的 `exec.started` 后才输出带真实 PID 的 `started`；两次真实启动分别为 PID 1080/1081，相差约 1.6ms。两条命令各自写入持久 HOME、明确确认看不到对方 marker、同时 sleep 2 秒，并几乎同时输出 `PLAN_A_OK`/`PLAN_B_OK` 和成功 result；JSONL 为每个 output 标记 command ID/stream/timestamp，payload base64 解码断言通过。当前代码又在同一 VM 内执行三条顺序命令：A 读回上轮 marker 并写 reuse marker，B 读回自己的 marker且看不到 reuse marker，A 的下一条命令在前一条 namespace/cgroup 已清理后重新读回 reuse marker，依次输出 `PLAN_A_WRITE_OK`、`PLAN_B_ISOLATED_OK`、`PLAN_A_REUSE_OK`；三次 `started` 带不同 guest PID，顺序/result 断言通过。所有轮次均完成 health/state flush/有序停机，最新 state clean generation 5，无残留 VM 进程；最终证据为 `events-v2.jsonl`、`events-sequential-v2.jsonl` 及对应 assertions，完整目录 `.cache/acceptance/exec-plan-macos-20260805`。本门禁自身只证明单 VM 生命周期内复用；跨 CLI daemon 的独立验收见 3.20。

`-race` 回归曾稳定暴露 execution plan 偶发缺少最后一段 stdout/stderr：Agent 使用 `StdoutPipe` 后先调用 `cmd.Wait`，慢调度时 pipe 会在 reader 排空尾部前关闭。实现现改为把两个 stream 直接接到 `os/exec` 管理的 RPC writer；`Wait` 只有在复制完成后才返回并发送 `exec.exit`。相关并行路由与 credential plan 测试在 race 下重复 20 轮通过，全量 race 也通过，协议现在保证同一请求 output 先于 exit。

父进程持有的 stdio 常驻 worker 随后在同一 macOS Apple Silicon 真机通过。第一轮非 TTY EOF 验证 `ready → eof → vm_stopped`；交互 v2 在 VM 不退出的情况下完成两次 ping、两条同时提交的 Session A/B 命令和一条延迟提交的 Session A 复用命令。并行命令取得 guest PID 1081/1082，started 相差约 0.3ms，分别输出 `STREAM_A_WRITE_OK`/`STREAM_B_ISOLATED_OK`；约 17 秒后第三条命令取得 PID 1093 并读回同 Session marker，输出 `STREAM_A_REUSE_OK`。三条 result 全部成功，shutdown 先输出 `drained`，随后 state flush、有序停止和最终事件；state clean generation 7，无残留 VM 进程。证据为 `.cache/acceptance/stdio-pool-macos-20260805/events-v2.jsonl`、`decoded-v2.log`、`assertions-v2.log`、`state-v2.json` 和 `vm-v2.log`。

最终事件时序修正后又执行 v6 复验：`ready`、ping/pong、PID 1080 的真实 exec（base64 解码为 `POST_FIX_EXEC_OK`）、成功 result、`drained` 和 `vm_stopped` 各一次。companion metadata 为 schema/state schema 2、clean、generation 11；其 `updated_at=2026-08-04T21:32:22.685737Z`，早于 `vm_stopped=2026-08-04T21:32:22.695875Z`，证明上层看到最终事件时 clean 事务已经提交。此前 v3-v5 手工复验遗漏正式验收使用的 `rootfstype=ext4 modules=...` cmdline；v3/v4 的 reset 日志已保留，v5 切到串口诊断后明确观察到 rootfs mount 失败并留下 dirty state。v6 恢复为正式 cmdline 后输出 dirty recovery gate passed，再完成 flush/clean，故这组三次失败是可解释的操作错误与恢复过程，不计为 stdio 实现失败。最终通过证据为同目录的 `events-v6.jsonl`、`vm-v6.log`、`state-v6.json` 和 `assertions-v6.json`。该证据自身仍是父进程/管道持有的一台 VM；跨 CLI daemon 的独立验收见 3.20，多 VM 与 suspend/resume 仍未验收。

上述手工失误同时证明原 CLI 默认 cmdline 本身不可启动当前 Alpine initramfs：它只有 `root=/dev/vda ro`，没有触发 ext4 模块加载，验收脚本的显式覆盖掩盖了这个产品缺陷。现已按 Host 后端提供默认模块集合并增加三平台 cmdline 单测。重新构建、entitlement 签名后，macOS 真机完全不传 `--cmdline` 启动成功，依次输出 `ready → eof → vm_stopped`，完成 guest flush，state clean generation 12；证据在 `.cache/acceptance/default-cmdline-macos-20260805/{events.jsonl,vm.log,state.json}`，退出后无残留 VM 进程。Windows 默认集合和 HCS root/options 组合仍只通过代码门禁，必须在真实 Windows 验收。

### 3.13 Virtio memory balloon

macOS 后端现为每台 VM 配置 `VZVirtioTraditionalMemoryBalloonDeviceConfiguration`。重建并重新签名 Host CLI 后，真实 VM 加载 `virtio_balloon`，在 guest 内发现 `/sys/bus/virtio/drivers/virtio_balloon/virtio5` 并输出 `MAC_BALLOON_OK`，随后有序停机。该证据确认设备已接线；按内存压力动态调整 target size 的策略与性能曲线尚未实施。

### 3.14 可配置 exec timeout 与长稳 telemetry

CLI 新增 `--exec-timeout`，允许 1ms–24h，并把毫秒值写入结构化 `ExecStart`；guest 在 `time.Duration` 乘法前比较无符号毫秒上界，`math.MaxUint64` 回归测试确认不会溢出后绕过 24 小时限制。真实 VM 执行 `sleep 3`、设置 500ms timeout，CLI 非零返回 `guest command exited with code -1`，没有输出完成标记，VM 随后清理。

`scripts/soak-macos-long.sh` 支持按总时长和轮次间隔运行；每轮同时验证 state/HOME/workspace 计数，执行可调 MiB 的 `/tmp` 与 state 写删压力、4 个并发 worker、flush 和有序停止。它保留 environment/doctor、逐轮日志、逐轮 clean state JSON、秒级 Host RSS/VSZ/FD/mount/state-size CSV、逐轮峰值和最终 summary，且拒绝覆盖已有 evidence。

重建最新 arm64 guest agent 后执行 1 秒缩短门禁（一次冷启动实际 15 秒）通过：1 轮、最终 clean generation 1、峰值 RSS 23,872 KiB、峰值 13 个打开文件、Host mount min/max 均为 14、state 物理占用 584 KiB。该结果只验证 harness 和单轮压力链路，不替代 259,200 秒长稳。

### 3.15 guest 权限边界与代理身份

审计发现旧版 restricted bridge 复用镜像 workload 的 1000:1000，并会取得 `/run/zapvm` 所有权；当 Linux Host 用户同为 1000 时，这会破坏控制面身份与工作负载身份的分离。现已为代理固定保留 998:998，独立使用 `/run/zapvm-proxy`，仅通过 `zapvm-vsock` 组获得 `/dev/vsock` 访问权；Agent 的 secret、identity 和 pid 继续留在 root-only `/run/zapvm`。Host bootstrap 与 guest agent 均拒绝把 workload 映射到保留 UID/GID 998。

重建 arm64/amd64 镜像后，真实 macOS VM 中的非特权 workload 同时确认：`/run/zapvm` 为 `0:0:700` 且不可写，`/run/zapvm-proxy` 为 `998:998:750`，`/dev/vsock` 为 `0:998:660`。同一黑盒测试通过 Host CONNECT proxy 读取 `example.com` 内容，并在 DNS 前拒绝未授权的 `www.iana.org`，输出 `PROXY_IDENTITY_ISOLATION_OK` 后有序停机。证据目录为 `.cache/acceptance/proxy-identity-20260804T190845Z-10503`；退出后无 zapVM/VMM 残留进程。

本轮重建后的两架构 manifest 各含 7 个受 hash 保护的交付文件，SBOM 仍各含 78 个 package/关系并通过 SPDX 2.3 官方验证器；`go test ./...`、`go test -race ./...`、`go vet ./...` 以及 Linux/Windows x64/arm64 四份 Host CLI 交叉构建再次通过。guest 内权限边界已审计，但 Linux 非特权 VMM/systemd unit 和 Windows service/ACL 仍必须在各自目标机审计。

加入 Agent RPC fuzz seam 与空 executable 边界校验后再次重建 arm64/amd64 guest。最新 arm64 rootfs 冷启动完成 mutual auth、独立 health、501:20 workload RPC 和有序停机，输出 `LATEST_AGENT_RPC_OK`；证据目录 `.cache/acceptance/latest-agent-smoke-20260804T191739Z-20080`。最终全仓 test/race/vet、四目标交叉构建、两份 SPDX 验证再次通过，且所有并行门禁退出后复查无 zapVM/VMM 残留进程。

### 3.16 持久生命周期审计

新增 `internal/auditlog` 与 `run --audit-log`。单元/竞态测试覆盖 0600 和 VM ID 哈希脱敏、同文件两个 logger 并发写入、重开续链、内容篡改、符号链接、partial/strict schema，以及 append 后重放验证；Windows amd64/arm64 和 Linux arm64 交叉门禁通过。显式启用后日志写入失败会令 VM run fail-closed。记录没有 argv、Session/command ID、路径、环境、输出或原始错误字段，单条限制 4 KiB、文件限制 64 MiB并要求外部轮转。

macOS Apple Silicon 真机以默认 cmdline、stdio EOF 路径运行一轮。0600 `lifecycle.jsonl` 依次包含 10 条：`run_requested → vm_started → agent_ready → exec_stream_started → exec_stream_drained → state_flushed → vm_stop_requested → vm_stopped → state_clean_committed → run_completed`；run sequence 1-10、九条 previous-hash link 和单一 VM hash 断言全部通过，原始 VM ID `mac-audit-secret-v1` 未出现在审计文件。state clean generation 13，metadata `updated_at=21:41:11.469188Z`，早于 audit clean event `21:41:11.474726Z`、协议最终事件 `21:41:11.479125Z` 和 audit completed `21:41:11.483982Z`；退出后无残留进程。证据目录 `.cache/acceptance/lifecycle-audit-macos-20260805`，包含原始 lifecycle/protocol/VM log、state snapshot 和 `assertions.json`。Windows 文件锁已交叉编译，但目录继承 ACL 与真实并发/崩溃行为仍待 Windows 主机验收；没有外部末尾 hash 锚点时也不能声称能检测授权主体删除完整尾部。

### 3.17 请求级 credential file broker

Host 新增 `--credential id=/absolute/path`，loader 拒绝非绝对路径、symlink、非 regular file、空值、POSIX group/other-readable 源、重复/非法 ID，以及 16 个/64 KiB 单值/256 KiB 总值上限。execution plan 与 stdio command 新增的只有 `credential_ids`，plan 在 VM 启动前核对全部引用，stdio 对动态未知 ID 返回失败 result；未引用 binding 不会进入 Exec RPC。Agent 对 ExecStart 使用 unknown/trailing-field strict decoder，解析后清零原始 payload；请求 lease 为 root-only 父目录下的 0555 direct child，文件归 workload UID/GID、0400。Linux launcher 再核对固定父路径、目录/文件 owner/mode/count/size，以只读 `nosuid,nodev,noexec` bind mount 暴露固定目录。command wait 后先覆写/删除 lease 再发 exit；失败置 degraded，health/state flush/新 exec 均 fail。

单元/race/fuzz 门禁覆盖 Host binding copy/zero、权限/symlink/大小/未知 ID，plan/stdio 只解析被请求 ID且输出不含值，Agent 真实子进程读取、固定环境不可覆盖、lease 在 exit 前删除、strict Exec schema，以及多个请求并发。Linux launcher 和 Agent、Windows Agent 均交叉编译通过。

真实 macOS Apple Silicon VZ 验收没有修改 `dist`：先以 APFS CoW 克隆当前 arm64 raw rootfs，再用离线 `debugfs` 只替换本次构建的 Agent/launcher；`e2fsck -fn` 全通过，rootfs/两个 binary hash 记录于 `.cache/acceptance/credential-macos-20260805/artifacts.sha256`。同一 VM 同时提交 PID 1081 `credential-present` 和 PID 1082 `credential-isolated`：前者只通过文件 SHA-256 验证 synthetic token，确认固定目录、0400、workload UID/GID、写入被只读 mount 拒绝并输出 `CREDENTIAL_FILE_OK`；后者在前者 sleep 期间确认没有 env、看不到其 credential mount，输出 `CREDENTIAL_ISOLATION_OK`。之后 PID 1102 的同 Session 无凭据命令再次确认文件不存在并输出 `CREDENTIAL_CLEANUP_OK`。三条 result 均成功，明文 synthetic value 未出现在 events/VM/lifecycle 文本，audit 10 条链完整，state clean generation 14，退出后无 VM 进程。机器断言在同目录 `assertions.json`。

该阶段证据证明真实 VZ guest 行为，但当时的克隆 rootfs 是显式 unsigned 开发制品，且 Linux/Windows 目标机尚未运行；后续 signed image 与两平台证据见 3.24。正式密钥托管仍未完成，因此 credential broker 仍不能标记为生产发布验收完成。

### 3.18 跨平台 VMM 生命周期状态机

新增的共享转换核心把三平台 backend 的异步回调归一为 ready、stop-requested、stop-rejected、exited、failed 五类事件。单测覆盖合法路径、stop 失败回退和终态不可逆；并发测试连续 100 轮同时竞争 stop/exit/failure/late-ready，最终只能是 stopped 或 failed，之后所有迟到事件均不得改变终态。`FuzzLifecycleEventSequences` 运行 5 秒完成约 75 万次随机序列，`FuzzLifecycleConcurrentEvents` 再完成约 73 万组最多 32 路同时起跑的随机事件；共享 platform 包 race detector 通过。Linux amd64 userspace 测试使用本地缓存 `golang:1.25-alpine3.23`、断网和 tmpfs build cache 原生通过；Linux arm64、Windows amd64/arm64 交叉门禁通过。

Linux supervisor、Windows direct HCS、Windows service client 和 macOS VZ notification 均已接入该核心。Linux/Windows 未经 Host stop 的 VMM 退出现在即使进程返回 0/远端仅报告 stopped 也判 failed；stop RPC 失败恢复 running 允许上层重试。macOS Apple Silicon 随后用当前 entitlement 签名 Host 和现有 unsigned 开发 rootfs 做真实回归，执行 `/bin/sh` 输出 `LIFECYCLE_STATE_OK`，Host `Stop`/`Wait` 以退出码 0 完成且无残留 zapvm 进程；证据在 `.cache/acceptance/lifecycle-state-machine-macos-20260805/{stdout.log,vm.log,host.sha256}`。该阶段回归只验证 macOS 状态适配；Linux KVM/Windows HCS 后续目标机事件与资源回收证据见 3.24。

### 3.19 VM pool 路由与配额核心

新增 `internal/vmpool`，路由键覆盖 workspace real path/RO、network 和 restricted-policy digest、image/state/credential-scope digest、CPU 与内存。测试确认相同 route 的 16 个并发 acquire 只启动一个 worker 并共享 lease；任何权限摘要变化均不复用。全局或单 workspace 达限时，active worker 明确返回 quota error，idle worker 才能按 LRU 先 stop 后换入。workspace 目录被 rename 并在同一路径重建后，`os.SameFile` 失败会先退休旧 worker再启动新实例。idle sweep、显式 discard、重复 release、close 与 start 并发均有回归。

stop 失败测试模拟 VMM 拒绝终止：entry 从可路由集合移除，但 stopping 配额不释放，pool 标记 degraded，之后 acquire 全部 fail-closed；“启动已返回 worker、调用方 context 随即取消”的 rejected worker 也执行同一规则。真实 macOS 首次 daemon 启动因未签 entitlement 正确失败，并额外暴露 Go interface typed-nil worker 被误当作非 nil 后送入 Stop 的 panic；pool 现在先检测 typed nil，回归连续 10 轮确认启动失败不进入 stopping/degraded 且不调用 Stop。普通测试、race 测试以及 Linux/Windows 双架构交叉门禁均通过。

随后新增 `internal/localipc`。macOS 实际 Unix socket 回归确认只有当前 UID 拥有的 0700 真实父目录才可监听，socket 为 0600，client/server 双方 peer UID 校验后完成 ping/pong；Linux 使用 `SO_PEERCRED` 并交叉通过；Windows 使用 current-user/System protected DACL，且 accept/dial 两端再以 named-pipe peer PID 的进程 token SID 核对当前用户，amd64/arm64 交叉通过。普通 listener 继续拒绝任何既有 endpoint；daemon listener 新增同目录 0600 regular lock 与 nonblocking flock，只有拿到唯一所有权且现有对象在二次身份检查期间保持为同一 socket、连接明确返回 `ECONNREFUSED` 时才接管。活 listener、普通文件、symlink lock 与非确定探测错误都拒绝；优雅 close 删除 socket并释放锁，相关本地/race/交叉门禁通过。

`internal/daemonrpc` 随后完成 4-byte framing 与 schema 1 envelope。回归覆盖 round-trip、typed payload unknown-field 拒绝、空帧/超限/outer unknown/trailing/bad ID，以及 32 路并发 writer 后逐帧完整读取；race 与四目标交叉门禁通过。3 秒 fuzz 执行约 136 万个任意 frame，没有出现越界或接受后再违反 Validate 的情况。最终业务 payload 只允许 ping/status/exec/shutdown；exec 限定结构化 argv、1ms–24h timeout、network policy、workspace 与 credential ID，不接受 credential value。

### 3.20 用户级 daemon 与跨 CLI VM 复用

`zapvm daemon serve|exec|status|pause|resume|stop` 已接入本地 peer-auth transport、严格 framing、VM pool 和 `zapvm run --serve-stdio` adapter。daemon 启动时加载 credential binding 并计算值相关 scope digest；签名模式在每次 route 前重新解析 active image，unsigned 开发模式则流式 hash 全部 artifact 内容而非依赖 size/mtime。restricted 域名使用 IDNA/尾点/大小写规范化后的去重规则生成 digest。每个 exec 连接断开会取消请求并 discard worker；guest command 自身失败只释放 lease；transport/VMM 错误才销毁 worker。status 只暴露 worker/lease/paused 计数和不可逆 route hash，不回传 workspace 或 credential。

本地端到端测试用受保护真实 IPC endpoint 和两个独立 client connection 连续执行两条命令，starter 计数严格为 1；status 为 1 worker/0 lease/1 route，shutdown 等待 worker drain 后退出。该测试连续 10 轮和 race 连续 5 轮通过。全量 `go test ./...`、`go test -race ./...`、`go vet ./...` 及 Linux amd64/arm64、Windows amd64/arm64 `CGO_ENABLED=0 go test -exec=true ./...` 均通过。

macOS Apple Silicon 随后使用 entitlement ad-hoc 签名的当前 Host、现有 unsigned credential 开发 rootfs 和 schema 2 state 模板执行真实 VZ 验收。冷 status 为 0 worker；第一个独立 CLI 启动 VM，输出 boot ID `a82e1d61-5ab9-4ca2-821f-d738931a34fd` 并在 Session HOME 写 marker。第二个独立 CLI 运行前 status 已是 1 worker/0 lease/1 route；其 boot ID 完全相同，且读回 marker 后输出 `SESSION_REUSE_OK`。随后两个并发 CLI 使用不同 Session 同时 sleep，运行中 status 为 1 worker/2 leases/1 route，两边仍输出同一 boot ID 与 `CONCURRENT_A_OK`/`CONCURRENT_B_OK`。daemon log 只有一次 `VM ... started`。

`daemon stop` 完成 guest state flush、VMM stop 和 listener 关闭；最终 state metadata 为 schema/state schema 2、clean、generation 1，精确 Host binary 路径无残留进程，socket 已删除。机器断言与完整日志位于 `.cache/acceptance/daemon-pool-macos-20260805/assertions.json`。

异常恢复又执行独立真实 VZ 门禁。最初的强杀试验先暴露 typed-nil worker panic并已修复；后续又确认父 daemon 同时关闭 stdin/stdout 时，Go 对标准输出 broken pipe 的 SIGPIPE 默认会让 worker 在 flush 前退出。最终实现只给内部 daemon worker 独立 process session 并忽略 SIGPIPE；单元/race 连续验证 broken stdout 后进程仍能继续清理。最终验收由 launchd wrapper 隔离测试执行器本身，对精确 daemon PID 发 SIGKILL：worker 读到 stdin EOF，在父进程已不存在且 stdout 已断开的条件下仍记录 `guest state flush acknowledged`，自行退出并把 state 提交为 clean generation 1；stale socket 保持、ownership flock 自动释放。

第二个 daemon 随即在同一个 endpoint 上安全接管 stale socket，冷 status 为 0 worker；同一路由启动的是新 boot ID，但同一 Session 成功读回强杀前 marker并输出 `CRASH_RECOVERY_SESSION_OK`。最终 stop 后 state clean generation 2，socket 删除、launchd fixture 移除、精确进程检查为零。机器断言位于 `.cache/acceptance/daemon-crash-sigpipe-macos-20260805/assertions.json`。两组 daemon 真机都使用 unsigned 开发镜像，因此不替代新 Agent 的签名产品镜像重建；Linux KVM、Windows HCS/named pipe 和 suspend/resume 仍未覆盖。

随后执行真实多 route 配额与 LRU。daemon 配置 `max-workers=2/max-per-workspace=2`，同一 workspace 的 RW/off 与 RO/off 分别启动 boot ID `33b5bdb7-b271-4436-b955-8dc0202a47e2`、`f9a1e378-bfa5-42be-a0aa-96481a9c675d`，status 为 2 workers。两条 4 秒命令同时活跃时 status 为 2 leases；第三条 restricted route 明确返回 `VM pool quota is exhausted`，没有越过 active worker。释放两条 lease 后再次请求 restricted route，pool 先 clean 停止一个 idle worker，再启动 boot ID `4f5eeddf-9b44-447a-8d92-4bc94f8cad0f`；换入前后的两个 route hash 仅保留 1 个交集，Host 上始终只有 2 个 worker。

首次两 worker stop 还暴露 pool 串行 Close 的总超时：两台 VM 实际都 clean，但两个约 10 秒停止串联后 client 达到 20 秒 deadline。Close 已改为并行 retire，并用两个 blocking worker 证明 Stop 必须同时进入；真实 VZ 复验重新启动保留的 RO/restricted 两 route，daemon stop 在 10 秒内成功返回。三块 route state 最终均 clean，generation 排序为 `[1,2,2]`，socket和精确进程残留为零。证据为 `.cache/acceptance/daemon-multiroute-macos-20260805/assertions.json`。至此 macOS 多 route 已验收；上段未完成范围收窄为签名产品镜像、Linux KVM、Windows HCS/named pipe 与 suspend/resume。

随后补齐显式 pause/resume。共享 lifecycle 新增 pausing/paused/resuming，stop rejection 会恢复请求前状态；macOS 对接 VZ，Linux 对接 Cloud Hypervisor v53 `vm.pause`/`vm.resume`，Windows 普通用户通过 SCM service 调用 ComputeCore pause/resume。stdio worker 在 pause 前 drain active command 并停住 heartbeat gate，paused 时拒绝 exec；shutdown/EOF/idle 回收从 paused 开始时先恢复再 flush。pool 在 Pause 开始即关闭新 lease admission，并发控制全部 worker，失败会回滚或 degraded fail-closed。普通、race、vet 和 Linux/Windows 双架构交叉门禁全部通过。

真实 macOS VZ 验收先启动 boot ID `56851037-333e-466a-8d96-017e8eed04a2` 并写入 Session marker；pause 后 status 为 1 worker/0 lease/paused，等待 3 秒期间新 exec 明确返回 `VM pool is paused`，resume 后同一 boot ID 和 marker 保持并输出 `AFTER_RESUME_OK`。第二轮在 1 active lease 的 4 秒命令执行中请求 pause：控制调用等待约 5 秒，先看到 `ACTIVE_DRAIN_OK`，随后 status 才进入 paused/0 lease。最后从 paused 直接执行 daemon stop，日志确认 guest state flush acknowledged。加入自动 power adapter 后又用最终签名 Host binary 重跑：pause 前后 boot ID 都是 `6726da4c-c1fe-4321-8444-9e2abb291a4d`，原 Session marker 可读，最终 state clean generation 2，socket删除且无精确 Host 进程残留。证据为 `.cache/acceptance/daemon-pause-resume-macos-20260805/assertions.json`。本阶段仍使用 unsigned 开发镜像；Linux/Windows 后续显式 pause/resume 证据见 3.24，三平台自动 Host 睡眠通知仍未验收。

自动 Host power adapter 随后接入：macOS IOKit will-sleep/has-powered-on、Linux logind `PrepareForSleep` + delay inhibitor、Windows `PowerRegisterSuspendResumeNotification`。因为 Windows 官方只给 suspend callback 约两秒，自动路径新增不等待 active command 的 `suspend` 控制；它先关闭 admission、停 heartbeat、冻结 VMM，wake 后恢复 active command。超时不会在 suspend callback 内做长 rollback，而是保持 pool paused，等待 wake 对全部 worker幂等恢复。单测确认自动 wake 只释放自动 pause ownership，不会解除用户显式 pause；macOS 本机完成 IOKit 注册/取消 smoke，Windows/Linux 双架构交叉通过。为避免未授权打断当前桌面会话，本轮没有主动执行整机 sleep，因此自动 will-sleep→wake 的真实闭环仍标为待验收。

### 3.21 当前源码双架构签名镜像与真实 VZ 验收

镜像脚本已改为 per-arch build context、可配置版本/输出根和同文件系统 staging；任何编译、Docker、runtime 或 manifest 步骤失败都会清理 staging，成功后才原子移入目标。覆盖已有架构目录必须显式设置 `ZAPVM_REPLACE_OUTPUT=1`，旧目录会保留为可恢复备份。以版本 `0.1.0-dev.20260805` 从当前源码完整重建 arm64/amd64 raw、VHDX、state template、SPDX 和锁定 Linux runtime；两个 manifest 各含 10 个文件。直接从两块 ext4 rootfs 抽出的 `zapvm-agent` 分别与独立当前构建上下文逐字节一致，SHA-256 为 arm64 `7b86f730...d84f75`、amd64 `e9caebf2...7c91e`。Cloud Hypervisor 与 virtiofsd 也分别确认为 aarch64 static 和 x86-64 static PIE。

本轮只生成一次性 Ed25519 本地验收根；源目录与安装目录均完成签名和逐文件 hash 验证，两架构 `active.json` 都指向 generation 1。签名完成后私钥已删除，仅保留只读公钥（SHA-256 `4d57ba41...869b`）和签名，因此这不是生产发布签名，也不替代正式 root/targets 密钥托管。

arm64 安装目录随后由当前 entitlement ad-hoc 签名 Host 以 signed active 模式启动真实 macOS Virtualization.framework，没有使用 `--allow-unsigned-image`。pause/resume 前后 boot ID 均为 `095a1d30-a27a-4645-bad3-5038e347b74a`，state 与 Session marker 保持；paused 时新 exec 返回 `VM pool is paused`。协调式 active-drain 验收先观察到 1 lease，再让 5 秒 guest 命令运行并请求 pause；pause 用时 4936 ms，命令先输出 `SIGNED_ACTIVE_DRAIN_OK`，随后池才进入 paused/0 lease。从 paused 直接 stop 后 guest flush acknowledged，state 为 clean schema 2/generation 2，endpoint 和精确进程残留均为零。镜像证据在 `.cache/acceptance/current-source-images-20260805/assertions.json`，真机证据在 `.cache/acceptance/signed-current-source-macos-20260805/assertions.json`。Linux KVM、Windows HCS 与真实整机 sleep/wake 仍必须在对应目标 Host 验收。

### 3.22 离线签名 bundle 与目标机 handoff

新增 `zapvm-image install-bundle`，把原先只供 TUF update 内部使用的安全解包链暴露为受控离线安装入口。命令要求绝对 image root 和显式 expected arch，在跨平台更新锁内把输入解到 owner-only/protected-DACL staging；tar 只接受顶层 regular file，并限制条目数、单文件和总展开大小。随后严格验证内容集合、Ed25519 manifest、全部文件 hash 与架构，最后使用已有 sparse-aware 原子安装和 active pointer。已有同版本必须重新验签且 manifest 逐字节一致；同版本重复导入不增加 generation。单元测试还确认相同输入生成字节一致的 bundle、错架构在安装前拒绝。macOS/APFS 对 8 MiB 小稀疏文件可能按一个完整 extent 计费，原测试因此被新代码触发后误报；样本扩大为 64 MiB，继续验证大零区间确实保留，不改变产品复制实现。

当前 arm64/amd64 10-file 镜像分别生成 170 MiB 与 174 MiB 的确定性 gzip bundle，SHA-256 为 arm64 `54304c75...8732c8`、amd64 `a896f895...b3e03`。两份真实 bundle 都重新完成解包、验签、安装和 generation 1 激活，再次导入保持 generation 1；用 arm64 bundle 指定 amd64 时明确返回 architecture mismatch，未创建版本目录。handoff 同时包含 Linux/Windows amd64/arm64 的 `zapvm`、`zapvm-image`，Windows 独立升级 fixture、验收脚本、公钥和全目录 `SHA256SUMS`。Linux 主脚本和 daemon helper 均通过 POSIX 语法检查；Windows 主脚本/daemon helper 由 PowerShell 7.5 parser 分别解析为 1710/2148 tokens、零错误。自包含执行说明与制品位于 `.cache/acceptance/current-source-images-20260805/handoff/README.md`；它们仍是本地验收根制品，不是生产发布包，也不替代目标机运行证据。

### 3.23 Linux/Windows daemon 目标机验收 harness

新增 `acceptance-daemon-linux.sh` 与 `acceptance-daemon-windows.ps1`，并由各平台总验收脚本在 direct-run 场景完成后自动调用。harness 以同一已验签 active image 启动 2-worker daemon，首先在请求中读取只读 credential，下一请求确认 credential mount 已清理；记录 boot ID 与 state/Session marker 后，让 5 秒命令发布 Host 可见 marker，再请求显式 pause，要求控制调用至少等待 4 秒、命令先完成、status 进入 paused/0 lease，且 paused 新 exec 被拒绝。resume 后要求同一 boot ID 与两类 marker 保持。

随后同时启动 RW/off 与 RO/off 两个 route，必须观察 2 workers/2 leases；第三个 restricted route 在两者 active 时必须被 quota 拒绝，释放后同一 restricted route必须通过 idle LRU 换入且 worker 总数仍为 2。最终从全池 paused 状态 stop，逐一 inspect 至少三块 route state 为 clean，检查 guest flush 日志、endpoint/进程残留并输出机器断言。Linux helper 还在任何失败路径终止并等待后台 client/daemon；Windows helper使用 .NET `ArgumentList` 避免路径/命令引号重解析，以异步 drain stdout/stderr 防止子进程管道死锁，并在 `finally` 停止残留进程。该 harness 已完成 POSIX/PowerShell parser 门禁；其 KVM/HCS 行为只有目标机实际跑通后才能计为验收。

handoff 主脚本又在原生 Linux/arm64 Alpine 容器以非 root 用户实际执行到 doctor：预构建 `zapvm`/`zapvm-image`、170 MiB bundle、公钥、离线安装、active version 与无私钥路径均通过。为隔离 handoff 本身，systemd 可执行文件/版本/user-manager探针使用只返回 systemd 255 的 fixture；最终 doctor 唯一失败项是容器确实不存在的 `/dev/kvm`，输出 `LINUX_HANDOFF_PREFLIGHT_REACHED_KVM_GATE`。证据在 `.cache/acceptance/current-source-images-20260805/handoff-verification/linux-native-preflight.log`。这证明 handoff 能在 Linux 原生执行到硬件边界，不证明真实 systemd scope 或 KVM 启动。

### 3.24 GitHub Actions Linux KVM / Windows HCS 真实主机验收

private repo 的 `platform-acceptance.yml` 在提交 `bf3cd164c470f6a86bc73f285772ff8c87c973ab` 上完成 [Actions run 30982994876](https://github.com/JackCaow/zapVM/actions/runs/30982994876)，总 workflow conclusion 为 `success`。build job 先执行 `go test ./...`、`go vet ./...`，构建锁定 amd64 guest/Cloud Hypervisor/virtiofsd，生成并签名 exact bundle；Linux 与 Windows job 下载同一份 artifact 并再次核对 identity，避免目标机各自重签或使用漂移制品。

Linux 使用 GitHub Ubuntu 24.04 非 root runner，前置断言 systemd 255、cgroup v2、user manager 与 KVM API 12。由于 hosted nested-KVM Host 在同一 runner 上只允许第一次 `KVM_CREATE_VM`，总链路按 state snapshot 串成 7 个 fresh-runner 阶段，全部通过：workspace write + Agent supervised restart、跨 boot state 与 Session 隔离、真实只读失败、restricted allow/deny、Agent crash 后 dirty、下一 boot recovery，以及单 VM daemon credential cleanup/pause/resume/clean stop。该证据确认真实 Cloud Hypervisor/KVM、virtiofsd、AF_VSOCK、restricted transport 与 systemd scope；同一 Linux Host 的双 route/配额/LRU 仍需带 `/dev/kvm` 的 self-hosted runner，Fedora 也未覆盖。

Windows 使用提升权限的 GitHub `windows-2025` x64 runner，实测 build 26100，hypervisor、`vmcompute`、`hns`、`computecore.dll` 与 `vmcompute.dll` 均通过门禁。目标机完成 LocalSystem service install→upgrade→doctor→rollback、普通 LCOW HCS schema 2.1 VM、Hyper-V socket、Plan9 workspace/state、Agent restart、write/persistence/Session isolation、真实只读失败、HCN static-IPAM unrestricted HTTPS、restricted allow/deny、crash fail-stop 和 dirty recovery；主 state 最终为 schema/state schema 2、clean、generation 8。

Windows daemon 证据输出 `WINDOWS_DAEMON_ACCEPTANCE_OK`：active pause 等待 4706 ms 完成 drain，paused admission 拒绝新 exec，resume 后 boot ID `78e29b2e-ac87-4d58-86c8-cbc590a56419` 和 state/Session marker 保持；HCS resume 后 Host 重建 command/heartbeat Hyper-V socket，并确认同一 Agent instance generation 才重新开放 admission。随后实际观察 2 workers/2 leases，第三 route quota 拒绝，idle LRU 换入成功；最终三块 VHDX state 均 clean、无残留进程。run artifact `windows-hcs-acceptance-evidence` 保留 14 天，artifact SHA-256 为 `bd81ac073cb69e9955113ebb1d7da7485c578caca6534079e837934d1aedc76b`。

提交 `581de66c45f047473ede2c5b8591826fd1b10724` 的最新 [Actions run 31029088877](https://github.com/JackCaow/zapVM/actions/runs/31029088877) 再次完成 signed amd64 image、Linux KVM 7/7、Windows native HCN gate 与完整 HCS 验收。下载后的原始 artifact 已逐项复核：Linux/Windows 均输出 `PROTECTED_WORKSPACE_PATHS_OK`，Guest 对 `.git` 与 `.zapcode/settings.json` 的写入返回 `Read-only file system`；restricted egress 对允许域放行并拒绝非 allowlist 目标；Linux daemon 无残留进程；Windows 21 个 ACL/HCS fault-injection case 全部恢复 journal 和原始 DACL baseline。主要 artifact digest 为 signed image `sha256:7a70599c19f4b877bc5b94545e02d4b13414034506db86f33f7fe468569f01ed`、Linux daemon `sha256:7799362d475d141456648e227433a5c4e2643020cfc264499111f6314c79f93a`、Linux restricted `sha256:bb438393fbb59348e83581987914a0b14bb962e5323864aa0410f27012f11239`、Windows HCS `sha256:05959724467f87a65ef1b55415c3525945f51e2aff43f7b81693fcefefb3811a`。该 hosted run 不替代 3.25 的专用物理 Host 验收。

### 3.25 self-hosted multi-route、Host power 与 72 小时入口

新增 `acceptance-host-power-unix.sh` 与 `acceptance-host-power-windows.ps1`。两者在 signed active image 上启动单 worker daemon，写入 state/Session marker 和 guest boot ID，再保持一条 active command/lease。Unix 分支分别用 Linux `rtcwake` + `systemctl suspend` 或 macOS `pmset relative wake` + `pmset sleepnow`；Windows 分支用 resumable waitable timer + `SetSuspendState`。唤醒后只有同时满足自动 Host suspend/resume 固定日志、Host 未重启、active command 继续、同一 guest boot ID、marker 保留、最终 state clean 以及 endpoint/进程残留为零，才写出 `assertions.json`。

daemon 自动 power handler 增加两条仅在成功后写出的固定事件：`Host suspend completed ownership=<bool>` 与 `Host resume completed`；单测同时确认自动 wake 只释放自动取得的 pause ownership。Unix harness 已通过 POSIX parser；Windows harness 已通过容器内 PowerShell AST parser，但本轮没有 Windows 目标机执行证据。

新增手动 `self-hosted-acceptance.yml`，包含 Linux 同 Host完整 multi-route、Windows HCS ACL 强杀恢复、Linux/macOS/Windows 整机睡眠唤醒及 macOS 72 小时长稳。sleep target 需要危险操作确认，runner label 必须以 `zapvm-physical-<host-id>` 唯一绑定单机，泛化 OS/架构 label 会在调度前拒绝；Linux/Windows 从受控 ZapCode release 按 tag 和 operator-pinned bundle/public-key SHA-256 下载同一真实 Resident Agent signed amd64 bundle，验收入口会拒绝 `unavailable` Agent provenance，不再为目标机另建或另签 stub。72 小时 evidence 先落到 runner 持久目录，再由同一唯一 label 的新 job 用 fresh token 上传。目标机步骤现先执行可独立运行的只读预检：不会修改 KVM ACL、userns sysctl、linger/user manager 或电源策略，power target 只核对实际 suspend/wake 命令的窄 NOPASSWD 授权；预检输出在失败时也随 artifact 保留。上述源码、本地 Go/race/vet/交叉构建和 workflow 静态门禁通过后，仍须注册对应物理 runner 并取得成功 run/artifact；在此之前本节只记“验收入口完成”，不记真实整机验收通过。

提交 `462589d` 的 hosted capability run `30992912761` 已在 Ubuntu 24.04 通过 Unix harness 语法/禁止自改 Host 的静态门禁，并在 Windows Server 2025 通过新预检的 PowerShell AST；两个 capability job 均成功。独立负向 run `30992918580` 使用通用 `runner_label=linux`，在 hosted authorize job 以 exit 2 和固定错误拒绝，后续 build/target job 均未调度。这证明 label/脚本门禁生效，不证明任何物理 self-hosted Host 已通过运行验收。

### 3.26 P0 开发运行时与能力契约

版本 `0.1.1-p0` 从同一源码完整构建 arm64/amd64 镜像；两份 manifest 均新增受签名 size/SHA-256 保护的 `capabilities.json`，两份 SBOM 各含 120 packages/relationships。Host `zapvm capabilities --json` 只验证 active pointer、manifest 签名与能力文件 hash，不为提示词读取而重复哈希多 GiB 磁盘；完整 VM 启动仍执行全部制品验证。能力文件篡改、未知字段、可写 rootfs 契约、错误 Host 架构和重复/非法 token 均有 fail-closed 校验。

arm64 制品使用一次性本地 Ed25519 验收根安装、激活，并由当前 entitlement ad-hoc 签名 Host 以产品 signed-active 路径启动真实 macOS Virtualization.framework。读写 route 在同一命令内输出 `Python 3.12.13`、`PYTHON_VENV_OK`、Node `v24.18.1`、`WORKSPACE_EXEC_OK` 和 `P0_VM_ACCEPTANCE_OK`；这证明 `.venv/bin/python` 与 workspace shell 文件可直接执行，不再依赖复制到 `/tmp`。同一命令确认 `/usr/local`、`.git`、`.zapcode` 写入均被拒绝，并要求 `/sbin/apk add` 精确返回 78 与 `ZAPVM_ERROR[IMMUTABLE_ROOTFS]`。

独立只读 route 继续拒绝直接执行 workspace 脚本及任何写入，同时允许签名 rootfs 的 Python 读取/解释项目内容，输出 `READONLY_INTERPRETER_OK` 与 `READONLY_WORKSPACE_ACCEPTANCE_OK`。daemon 两轮都完成 guest flush、有序停止，未遗留 endpoint 或精确 VM 进程。配套 Zap 集成读取了同一签名能力并生成 rootfs/workspace/命令提示；TypeScript typecheck、2539 项测试和 standalone build 均通过。这里新增的是 macOS arm64 运行证据及双架构制品证据；Linux/Windows 的新 workspace exec 行为仍由后续常规 hosted release gate 覆盖，不挪用已暂缓的 self-hosted/power/72 小时门禁。

### 3.27 Work Computer 持久工具环境与云链路

2026-08-07 在 macOS Apple Silicon 的真实 Virtualization.framework VM 中完成 Work Computer 黑盒验收。签名只读 rootfs 内提供 rootless Nix 与 `zap-pkg`，独立 Computer state 从 512 MiB 模板稀疏扩展为 16 GiB；Guest 首启把 ext4 扩展到 15.7 GiB 可用文件系统。实际安装 `hello`、`yt-dlp` 和 `ffmpeg-headless` 后，状态文件逻辑大小仍为 16 GiB，物理占用按内容增长；没有把工具复制到 `/tmp` 或 Host。

独立 Session 与登录 shell 均直接从持久 profile 找到工具，输出 `Hello, world!`、`yt-dlp 2026.07.04` 和 `ffmpeg 8.1.2`。`yt-dlp --simulate` 经 restricted allowlist 成功读取测试视频元数据；访问非 allowlist 的 `example.com` 被 proxy 以 403 拒绝。与此同时 `/etc` 保持只读，Guest 写 `.git` 与 `.zapcode` 都返回 `Read-only file system`。Computer 连续执行 stop→start→stop→start 后工具仍存在，state metadata 最终为 schema 3、clean，证明持久性不是驻留进程缓存；验收还捕获并修复了登录 shell PATH 被 `/etc/profile` 重置，以及已扩展文件系统第二次启动不应重复执行 `resize2fs` 两个真实回归。

最终制品以本机生产 Ed25519 根签名为 `v1.11.1`，经 `install-bundle` 原子安装并激活，`active.json` generation 3、previous 为 `v1.11.0`。专用 launchd daemon 与 `zapvm-node` 升级后重新连接 Railway 控制面；Zap cloud adapter 的真实 mTLS 测试两轮通过“提交命令→保护路径→安装 hello→下一 Task 登录 shell 使用”，中间显式停止 Computer 后第二轮仍成功。生产 Work Computer 使用 25 个域名、443 端口的固定最大 allowlist；模型声明的目标必须是其子集，当前复用 VM 的 proxy 边界按 Computer 而非逐命令动态缩小。

### 3.28 Remote Host 安装事务

macOS 用户级安装器在真实 launchd 上以两个签名版本完成 install、doctor、upgrade、rollback、uninstall。每次切换后，本地 TLS 1.3 mTLS Control 都观察到精确 Node version 和 `daemon_state=healthy`；最终 LaunchAgent、Control 和短 socket 目录无残留，release/config/state 保留。最新证据目录为 `.cache/acceptance/macos-host-install-live-20260808-002435`。

Linux 安装器先在原生 Ubuntu 24.04 amd64 用户态验证 release 供应链：篡改 `SHA256SUMS.sig` 在执行二进制前被拒绝；合法 Ed25519 包完成安装并只在容器真实缺失的 `/dev/kvm`/user manager 门禁停止。随后在 Linux arm64 systemd 255 容器中，以独立 user manager、linger、真实 daemon/node user unit 和 mTLS Control 完成 install、成功 upgrade、rollback、doctor、uninstall；Control 最终观察到 `0.1.0-installer-arm.1`，服务稳定状态要求 `ActiveState=active`、`SubState=running`、`NRestarts=0`。故障 release 令 Node 持续 exit 42，安装器拒绝 `activating (auto-restart)` 并自动恢复旧 release、配置、unit 和指针。证据位于 `.cache/acceptance/linux-host-installer-native-20260808-003723`。

该 Linux systemd 容器使用可打开的测试字符设备代替 `/dev/kvm`，没有创建 VM，因此只证明 release、service、Control 注册和升级事务，不计作真实 KVM 执行验收。真实 x64 KVM 主链路仍沿用 3.24 的 hosted 证据；新安装器在干净专用 KVM Host 上的 `acceptance-host-install-linux.sh --live` 尚待执行。

## 4. Windows/Linux 代码门禁

Windows 后端现已实现公开 ComputeCore HCS operation 生命周期、VM 文件 ACL grant/revoke、schema 2.1 direct-kernel/VHDX/Plan9 配置，以及 RPC/受限出口两个 Hyper-V socket service。HCS ownership 已从普通 CLI 迁入真实 LocalSystem SCM service：服务支持安装/升级/回滚/启动/状态/停止/卸载，binary 安装目录与每个 binary 都使用仅 SYSTEM/Administrators 完全控制的 protected DACL；doctor 必须通过服务 pipe ping。升级前严格核对注册命令行、LocalSystem、service/SID type、`vmcompute` dependency 与最终 binary 路径；不同 hash 先保存一份 rollback，停服替换后必须达到 SCM Running 且 pipe ping 成功，否则恢复旧 binary。该事务与手工 rollback 已进入目标机验收，但 SCM 启动失败/进程崩溃的中点注入仍待专项执行。1 MiB 有界、拒绝未知字段的 RPC 只允许 `ping/start/pause/resume/stop/query`。每个连接取得本机 client PID 后立即固定 process handle，比较 process token SID 与锁定 OS thread 上的 pipe impersonation SID；VM start 只 duplicate 该已验证 handle，从而避免授权后按 PID 重开造成的复用窗口。文件在客户端 token 下按实际读写权限打开、canonicalize 到本地卷，并保持 no-delete-share handle 到 HCS create/start 完成。VM 记录 owner SID、限制并发，固定调用者进程死亡即终止 VM；macOS、Linux 与 Windows client/service instance 的 Pause/Resume/Stop 都分别串行化。

Windows `unrestricted` 的 HCN 2.0 代码也已接入同一服务。只有该显式模式会创建 NAT network/per-VM endpoint；network/endpoint flags 使用 HCN 2.0 合法零值，IPAM 为 Static，并保留三个候选 `/24`。服务查询 endpoint `IpConfigurations`，把地址/prefix/gateway 连同 endpoint ID/MAC 传入 HCS/guest；guest 配置静态地址，并从可写 `/run` 只读 bind-mount DNS 配置覆盖 rootfs `/etc/resolv.conf`。VM/服务回收显式删除 endpoint/network，固定 owner GUID 用于下次启动 fail-closed 清理陈旧对象。Windows Server 2025 x64 目标机已验证 HCN create、真实 HTTPS 外网访问和回收。HCN Switch/VFP deny 作为 Host 网络层边界保留，但真实 NAT VM 验证证明 HCN Host/WFP ACL 即使被 API 接受并回读，也没有阻断 Host 到 Guest 的直连；签名 guest 因此在 unrestricted 启动时 fail-closed 安装 nftables input policy，拒绝所有非 loopback、非 established/related 的新入站连接。

最终签名镜像 `0.1.0-ci.30990980623.1` 已在 GitHub Actions run `30990980623` 的 Windows Server 2025 build 26100 管理员 Host 上通过完整 HCS 验收。Host 对 Guest `23456/tcp` 的主动连接在 3 秒窗口内未建立，guest listener 12 秒超时且 payload 为空；同一 VM 随后完成 HTTPS 出站并写出 `WINDOWS_HCN_INBOUND_DENY_OK`。独立 unrestricted VM 也写出 `WINDOWS_HCN_UNRESTRICTED_OK`。同一 job 还通过写入/Agent 监管重启、跨启动持久化、Session 隔离、只读 Plan9、restricted allow/deny、Agent crash/dirty recovery、daemon pause/resume/active drain、凭据清理、配额与 LRU；最终 VHDX 为 clean generation 9。原始证据 artifact 为 `windows-hcs-acceptance-evidence`（artifact ID `8924438402`）。这完成了 build 26100 x64 门禁；Windows Server 2022 build 20348 与 arm64 仍待扩展验证。

Windows 托管验收曾捕获一次独立的 HCS/Plan9 慢启动：根盘在约 22 秒才进入 init，30 秒固定 Agent 上线期限在工作区挂载前耗尽。CLI 现提供 1 秒–5 分钟的 `--agent-start-timeout`，Windows 默认 90 秒，macOS/Linux 保持 30 秒；这扩大单次真实启动观测窗口，不会自动重启 VM 或把失败转换为通过。

Windows 生命周期轮询补充了 fail-closed 响应契约。Direct HCS properties 现在限制为 1 MiB，并只接受 Created/Starting/Running/Paused/Pausing/Resuming/Stopping/Stopped；畸形、缺失或未知 state 连续出现会在 20 次后把实例置为 failed，不再无限忽略。普通客户端对 LocalSystem service 的 ping/start/stop/query 响应分别验证 VMID、逻辑 ID 和合法 state，`OK=true` 的空响应或错 VM 响应会立即拒绝。解析与协议回归测试在本机及 Windows amd64/arm64 交叉门禁通过；真实 HCS 异常响应仍待目标机故障注入。

HCS grant 现在使用 `%ProgramData%\\zapVM\\hcs-grants.json` schema 3 两阶段恢复账本：先以 `pending_path`/`pending_dacl` 写穿 intent 与原始 DACL，再调用 `HcsGrantVmAccess`，成功后成对转入 `granted_paths`/`granted_dacls`。正常 terminate 和启动恢复都确认精确 VM ACE 已消失，再逐路径清账；多台 VM 并发 grant 同一签名镜像路径时复用首个原始基线，最后一个引用退出才恢复完整 control bits。恢复只在精确 VM ACE 实际存在时调用 revoke，ACL raw bytes 与基线不一致会拒绝覆盖第三方变化。schema 1/2 仍可读取；已经被 CLI 删除的临时 bootstrap 路径按“对象不存在即无残留 ACE”跳过。微软公开 [`HcsGrantVmAccess`](https://learn.microsoft.com/en-us/virtualization/api/hcs/reference/hcsgrantvmaccess) / [`HcsRevokeVmAccess`](https://learn.microsoft.com/en-us/virtualization/api/hcs/reference/hcsrevokevmaccess) 文档只说明增加/移除 ACE，没有承诺未 grant 或重复 revoke 的 HRESULT，所以恢复错误继续 fail-closed。

新增的 acceptance-only service build 默认拒绝 install/upgrade，只有精确设置一次性确认环境变量才允许装入 SCM；生产构建完全不编译故障配置解释器。黑盒脚本包含 21 个启动中断点：journal prepare 之后；6 条路径各自在 intent 落盘后、HCS Grant 返回后、commit 后；HCS Create 与 Start 后。另在一次恢复首条 revoke 后再次强杀，要求下一次启动可重放同一 journal。每例显式创建 bootstrap share，使全部 6 条路径都能在 grant 前独立采集基线；随后保存 marker、schema 3 journal、崩溃 ACL、基线 SDDL 和最终断言，且必须恢复到精确基线、无 journal、doctor 通过。GitHub Actions run [`31007213788`](https://github.com/JackCaow/zapVM/actions/runs/31007213788) 的 Windows Server 2025 build 26100 管理员 Host 已输出 `WINDOWS_HCS_GRANT_RECOVERY_OK cases=21`；evidence 中 21/21 均为 `journal_recovered=true`、`acl_baseline_restored=true`，并包含一次恢复中再次强杀的成功重放。artifact `8931346502` 的 digest 为 `sha256:306601d7178bbe206bbbbaa0f7a3982c600184cd14d14e4884c9e5da474a08fd`。

首次真实故障 run `30995173676` 在前 10 例通过后，于 `after-grant-intent` 的 state VHDX（grant index 3）准确捕获基线变化：intent 时该文件没有 VM ACE，服务恢复直接调用 `HcsRevokeVmAccess` 虽未报错，却改变了原始非继承 DACL。artifact `8926179396` 保存了 schema 2 journal、崩溃前基线和 ACL，证明“Revoke 未发生的 Grant”不能当作无害幂等操作。后续源码搜索还发现正常 VM 退出仍绕过账本直接 revoke，并发 VM 会把另一台 VM 的共享镜像 ACE 错当原始基线；schema 3 因而统一正常/恢复清理、保存精确基线并做共享引用计数。Windows native 测试覆盖 control bits 恢复、外部 ACL 变化拒绝、共享基线复用和不一致账本拒绝，最终 run `31007213788` 已关闭该专项。

早期源码推断曾把普通 LCOW document 提升到 schema 2.5；Windows Server 2025 的真实 HCS Create 明确拒绝该组合。重新对照 `hcsshim v0.14.1` 普通 LCOW 路径后，direct-kernel/VHDX/Plan9 document 已锁定为 schema 2.1；2.5 保留给 VMGS/SNP 等不同路径。doctor 继续要求 Windows build 20348+。kernel cmdline 单测及目标机启动还确认 `/dev/sda rootwait`、`init`、`pci=off` 和 `virtio_vsock` blacklist，不覆盖调用方已有 init。

同一次审计发现原 guest fallback 错把 HCS Plan9 当成 `trans=virtio`。现已加入最小静态 helper，对齐微软 guest 的 VSOCK port 564 + duplicated FD + `trans=fd` 契约；bootstrap share 先挂载并复制 root-only identity，再根据 identity 为 workspace 显式追加只读 mount flag。重建后的 macOS VirtioFS 实机回归分别输出 `MAC_BOOTSTRAP_RW_OK` 和 `MAC_BOOTSTRAP_RO_OK`，只读写入实际返回 `Read-only file system`。该阶段只证明共享启动顺序和策略未回归；后续 3.24 已在 Windows x64 真机验证 HCS JSON、Plan9-vsock、Hyper-V socket、受限出口与基础 service/ACL。arm64 与 ACL 恢复账本中点强杀仍待 Windows 真机验证。

bootstrap identity 新增强制 `network_mode` 后重建 arm64/amd64 rootfs；该阶段的 manifest 各含 7 个逐项 size/SHA-256 匹配文件，SPDX 2.3 验证器仍为各 78 packages/relationships、零错误。真实 macOS 镜像分别以 `off` 和 `restricted` 启动：两者在 Agent Ready 前都确认 `/sys/class/net` 只有 loopback；restricted 仍允许读取 `example.com`、在 DNS 前拒绝 `www.iana.org`，输出 `MAC_NETWORK_POLICY_OFF_OK` 与 `MAC_NETWORK_POLICY_RESTRICTED_OK`。证据目录 `.cache/acceptance/network-policy-20260805-DbtyqX`，退出后无 zapVM/VMM 残留。这证明新 guest fail-closed 策略未破坏两种已有模式，不证明 Windows HCN unrestricted；当前 arm64 manifest 已在后续 Linux runtime 门禁中扩展为 10 个文件。

Linux 后端已实现 `/dev/kvm` doctor、Cloud Hypervisor direct boot、virtiofsd shares、host-to-guest RPC handshake 和 guest-to-host 受限出口 Unix socket listener。生命周期不再把 VMM 进程 `Start` 成功当作 VM Ready：Host 通过有界 Unix-socket HTTP client 先验证 `vmm.ping`，再等待 `vm.info` 明确为 `Running`；停止时依次调用 `vm.shutdown` 与 `vmm.shutdown`，API 不可用才回退到进程信号/强杀。HTTP 合约单测覆盖 endpoint/method、204、错误状态、缺失字段和 1 MiB 响应上限；virtiofsd 改为唯一 reaper/done channel，启动即退出会立刻失败且清理不再重复 `Wait`。Linux x64/arm64 测试包和 Host CLI 均交叉编译通过。当前可用的 OrbStack 环境没有 `/dev/kvm`，因此未将其记为运行验收。

Linux Host 权限模型进一步改为强制非 root，并要求 systemd 254+、cgroup v2 和可达的 user manager。Host 把私有 0600 supervisor config 交给内置隐藏入口；一个 systemd user transient scope 内先启动全部 virtiofsd，再启动 Cloud Hypervisor。scope 设置 `CPUAccounting`、`MemoryAccounting`、`TasksAccounting`、`IOAccounting`、`MemoryMax=guest+512MiB`、`MemorySwapMax=0`、`TasksMax=256+128*vCPU` 和 `CPUQuota=100%*vCPU`；任一 virtiofsd 提前退出会 fail-stop VMM。API 失效时使用 `systemctl --user stop`，最终强杀使用 `kill --kill-whom=all`，不再只杀 `systemd-run` wrapper。

强停完成语义进一步收紧：旧实现把 `systemctl --user kill` 命令返回 0 直接当作 VM 已清理；现在必须等待 supervisor `Wait`/reap 关闭 `done`，5 秒仍未退出才直接 SIGKILL wrapper，并再等待 5 秒，逾期明确报错。ARM64 Linux 容器原生测试用假 systemctl 杀死真实 sleep supervisor，断言 `killUnit` 返回前 reap 已完成，证据在 `.cache/acceptance/linux-lifecycle-arm64-20260805/test.log`。

Linux 运行时供应链也已从 Host `PATH` 移入签名 active image。`runtime-lock.env` 固定 Cloud Hypervisor v53.0 的官方 arm64/amd64 asset digest，以及 virtiofsd v1.14.0 的 commit/source digest和 Rust 1.88.0 builder digest；构建记录 rust/cargo 与系统包版本，最终两个 binary hash 和 provenance 连同 guest 制品进入 10-file manifest。第一版 arm64 验收得到 `cloud-hypervisor v53.0` 和 `virtiofsd 1.14.0`，provenance hash 与 manifest 一致，Ed25519 签名后全文件验证通过；同架构 Linux 容器原生执行 platform test binary，覆盖精确版本 token、不可执行文件、supervisor config、Cloud Hypervisor API 与共享 HCS/HCN 合约，全部通过。该阶段证据保留于 `.cache/acceptance/linux-runtime-arm64-signed-20260805`，但其中 virtiofsd 仍为 glibc 动态链接产物，已被后续静态构建替代。

后续完成 ELF 元数据门禁和全静态迁移：签名 active image 的两份 Linux runtime 必须是与 manifest 架构一致的 ELF64 little-endian executable，且都不得包含 `PT_INTERP`。回归测试构造“manifest/provenance/hash 全部自洽但二进制机器类型为 amd64、manifest 声明 arm64”的合法签名镜像，解析阶段明确拒绝，避免把错误架构拖到 `exec format error` 才暴露。virtiofsd 按其上游 CI 范式迁到 digest-pinned Rust 1.88.0 Alpine 3.22 builder，使用 musl、libcap-ng-static、libseccomp-static 和显式 `aarch64-unknown-linux-musl` target；builder 又从 multi-arch index 收紧为 arm64 platform manifest digest `eb5ce72a...`。实际 `file` 结果为两份静态 AArch64 ELF，不再依赖 Host glibc/共享库；10-file manifest 重新签名并全文件验证通过，私钥已删除，最终证据在 `.cache/acceptance/linux-runtime-static-arm64-perarch-signed-20260805`。

amd64 同样锁定到独立 builder manifest digest `64eba372...`；本机首次拉取 Rust toolchain 时因磁盘不足未进入 Cargo 编译，因此该阶段不得借 arm64 结果推断通过。后续 GitHub build job 已实际生成、校验并签名 amd64 runtime，目标机运行证据见 3.24。

静态迁移前的 10-file manifest 曾按产品路径安装并激活，在 macOS Apple Silicon 上真实冷启动一轮：CLI 明确输出 `using signed active image 0.1.0-dev`，完成 VZ VM start、Agent mutual auth/health、workload、guest state flush，最终 state metadata 为 schema 2、clean、generation 1；退出后重新校验已安装 manifest 签名和全部 10 个文件通过，验收私钥不存在，且无 zapVM/VMM 残留进程。日志、state、公钥、active pointer、manifest 和签名已归档到 `.cache/acceptance/signed-runtime-macos-20260805`。该阶段只证明通用签名包没有破坏 Darwin；后续 3.24 才提供 Linux KVM 运行证据。

该 userspace 合约在一次性 Ubuntu 24.04 ARM64 OrbStack machine、systemd 255 上实际执行。无 user bus 的非登录 shell 先被 doctor 明确拒绝；启用测试 user manager 后，真实 transient scope 显示 supervisor 与假 VMM 同处一个 cgroup，读取到 CPU 100%、MemoryMax 768 MiB、swap 0、TasksMax 384 以及四类 accounting。unit 级 SIGKILL 后完整进程树消失且 `--collect` 令 unit 变为 `not-found`；100ms 正常子进程路径返回 0、消费私有 config 并自动回收，分别输出 `SCOPE_TREE_KILLED` 与 `SCOPE_CLEAN_EXIT_OK`。同机原生执行 ARM64 platform test binary 全部通过。该阶段 machine 没有 `/dev/kvm`、Cloud Hypervisor 或 virtiofsd，只证明 systemd/supervisor 合约；后续 x64 真实 KVM 证据见 3.24。

已加入 `scripts/acceptance-linux.sh` 与 `scripts/acceptance-windows.ps1`。两者默认仍可从目标机当前源码构建 CLI，生成一次性镜像签名密钥、安装并激活签名镜像；也可显式接收预构建 Host/image tool、同一份已签名 bundle 和公钥，避免目标机重新构建或重签造成制品身份漂移。随后在唯一 evidence 目录执行/保留 doctor、workspace RW/RO、同 Session HOME 持久化、跨 Session 隔离、state 持久化、Agent supervised restart、restricted allow/deny、Agent crash fail-stop 与 dirty recovery 证据；state 创建绑定已验签 active version 内的 schema 2 模板，最后自动执行 3.23 的 daemon 验收。Windows 脚本还要求提升权限、拒绝碰触预先存在的服务，使用不同 hash 的升级 fixture，逐项验证 install→upgrade→doctor→rollback 的 installed binary hash，并在 `finally` 卸载本次服务。Linux 两份脚本均通过 POSIX shell 语法检查；Windows 主脚本与 daemon helper 用 PowerShell 7.5 parser 零错误，并已在 3.24 的目标机 Actions 中执行。Linux hosted 变体因单次 KVM create 限制拆成 7 个 fresh-runner 阶段；完整单 Host 多 route 仍由 self-hosted 脚本承担。

## 5. 未通过或尚未执行

| 平台/能力 | 当前状态 | 缺失证据 |
|---|---|---|
| macOS Session 生命周期 | 部分验收 | 请求级 namespace/cgroup、持久且隔离的 Session HOME、请求私有 TMP、parent-owned stdio，以及用户级 daemon 的跨 CLI 复用、真实多 route 配额/LRU、并行 stop、SIGKILL 后 clean orphan 回收与 stale endpoint 接管已通过；suspend/resume 尚未验收 |
| Credential broker | macOS VZ、Linux KVM、Windows HCS 通过 | 请求级只读注入、下一请求清理和无明文日志已在三条 Host 主链路验证；正式密钥托管与产品镜像发布仍缺失 |
| macOS 异常恢复 | 部分验收 | Host/VMM 同进程强杀后的 dirty recovery、state fsck/ENOSPC、agent supervised restart 和 crash fail-stop 已通过；睡眠唤醒仍待验收 |
| Linux KVM | Ubuntu 24.04 x64 真实 KVM 主链路通过 | hosted runner 的单次 `KVM_CREATE_VM` 限制使同 Host 多 route/配额/LRU 尚需 self-hosted KVM；Fedora/arm64 未运行 |
| Windows Hyper-V/HCS/HCN | Windows Server 2025 build 26100 x64 主链路、daemon 多 route、显式全入站 deny 与 HCS ACL 21 点强杀恢复通过 | SCM 升级事务中点、build 20348 等更多受支持版本、整机睡眠唤醒仍待验收 |
| x86_64/Windows arm64 | x86_64 Linux/Windows 已运行；arm64 制品/交叉编译完成 | Linux arm64 KVM、Windows arm64 与 macOS Intel 仍需对应真实设备，不接受构建或交叉编译替代 |
| 72 小时长稳 | 未执行 | 并发负载、内存/FD/挂载趋势、睡眠唤醒和磁盘压力 |
| 生产自动更新 | 本地 TUF 端到端通过，生产未验收 | 后台调度、离线 root/targets 密钥流程、真实 HTTPS/CDN、三平台跨版本回滚 |

### 5.1 Host 包可复现构建

Host 打包已消除文件枚举顺序、mtime、uid/gid、gzip header、macOS xattr 和
PowerShell `Compress-Archive` 元数据漂移。固定同一源码与
`SOURCE_DATE_EPOCH` 后，本地连续构建两次得到完全相同的归档：macOS
arm64 为 `d8bf83b084831ceb26c0ab7625be71d0cd22c879ee5505f7ada79eee0bec89d3`，
Linux amd64 为 `46b8845e936db9a3d1b346edda092ad55d8ed52cf236534e4b5f415df1da4b5b`，
Windows amd64 交叉构建为
`827cd9dbc816a8ef032ae0779a44b947fffbe7267a89e23dd3dca07f9887ae75`。
Linux 包已在真实 amd64 Alpine 3.23 clean extraction 中通过结构校验；
Windows 结果只证明 ZIP 字节可复现，不替代 HCS 真机验收。上述 hash 是本轮
实现证据，不是未来 tag 的固定发布 hash；源码提交发生变化后必须重新构建并
记录新的 hash。

因此项目当前可认定 macOS arm64、Linux x64 KVM 和 Windows x64 HCS 的核心 VM/Agent 主链路已打通，Windows HCS ACL 的 21 个 durable boundary 也已通过；同 Host Linux 多 route、最低支持 Windows build 物理机、缺失架构、三平台整机睡眠/唤醒、72 小时长稳和生产更新仍未完成，不能认定全部交付门槛已关闭。

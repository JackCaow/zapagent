# Linux Remote Host 安装与升级

`scripts/zapvm-host-linux.sh` 将经过 Ed25519 release 签名验证的 `zapvm`、`zapvm-node` 安装为专用非 root 用户的 systemd user service。Control 可以部署在 Railway 或其他 TLS 入口；Linux Host 只建立出站 mTLS 连接，daemon Unix socket 不监听公网。

## Host 前置条件

- x86_64 Linux，systemd 254+，统一 cgroup v2。
- 当前用户可读写 `/dev/kvm`，并允许 unprivileged user namespace。
- 当前用户的 systemd user manager 可达。
- 专用 Host 用户已启用 linger，使服务不依赖交互登录持续运行。
- 一个已安装并激活的签名 zapVM image，以及对应 image public key。
- Control 已 provision Node、tenant/project scope 和 Computer；Node client certificate 只包含该 Node 的 SPIFFE URI SAN。

管理员只需执行一次 Host 配置，不要让安装器以 root 运行：

```bash
sudo loginctl enable-linger zapvm-host
sudo usermod -aG kvm zapvm-host
```

重新登录后，以 `zapvm-host` 用户运行 `zapvm doctor`。安装器不会修改 `/dev/kvm` ACL、sysctl、user namespace 或 linger。

## Release 包

release 目录必须包含：

```text
zapvm
zapvm-node
SHA256SUMS
SHA256SUMS.sig
```

`SHA256SUMS` 只允许两个按 SHA-256 固定命名的条目，`SHA256SUMS.sig` 是对该文件的 raw Ed25519 签名。安装器使用单独交付的 PEM public key 先验签，再校验 binary hash，之后才会执行 `version` 或 `doctor`。同一版本不同内容会被拒绝。

示例发布侧签名流程；production private key 必须由 CI/KMS 托管，不能复制到 Host：

```bash
(cd release && sha256sum zapvm zapvm-node >SHA256SUMS)
openssl pkeyutl -sign -rawin \
  -inkey /secure/release-private.pem \
  -in release/SHA256SUMS \
  -out release/SHA256SUMS.sig
```

## 配置与安装

从 [daemon.json](../packaging/examples/daemon.json) 和 [cloud-node.json](../packaging/examples/cloud-node.json) 创建 owner-only 严格 JSON。两份配置中的 `endpoint` / `daemon_endpoint` 必须显式设置且完全一致，并位于 `HOME` 或 `/run/user/<uid>` 内；这避免两个 `PrivateTmp` service 因 `/tmp` 隔离而看到不同 socket。`workspace_root` 必须是专用于自助 Computer 的绝对目录，Node 只会在其下创建 tenant/project/computer 工作区。credential、mTLS private key 和配置不得向 group/other 开放。

```bash
./scripts/zapvm-host-linux.sh install \
  --source-dir /absolute/release \
  --release-public-key /absolute/release-public.pem \
  --daemon-config /absolute/config/daemon.json \
  --node-config /absolute/config/cloud-node.json

./scripts/zapvm-host-linux.sh doctor
```

默认安装根是 `~/.local/share/zapvm`，unit 位于 `~/.config/systemd/user`。安装器会：

1. 验证 Host release 签名、版本一致性、签名 active image、credential 和 Node mTLS authority。
2. 强制执行 systemd/KVM/cgroup/user-manager/linger preflight。
3. 安装 `releases/<version>` 并原子切换 `current`。
4. 生成不经过 shell、不使用 `Environment` authority 的 hardened user unit。
5. 先启动 daemon 并等待配置指定的 IPC health，再启动 Node。

成功输出固定标记 `ZAPVM_LINUX_HOST_OK`。Control 管理员仍需确认精确 Node/daemon version、image digest 与 `daemon_state=healthy` 后再开放 admission。

## 升级、回滚与卸载

先 drain Node 并等待 `in_flight=0`：

```bash
./scripts/zapvm-host-linux.sh upgrade \
  --source-dir /absolute/new-release \
  --release-public-key /absolute/release-public.pem \
  --daemon-config /absolute/config/daemon.json \
  --node-config /absolute/config/cloud-node.json

./scripts/zapvm-host-linux.sh rollback
./scripts/zapvm-host-linux.sh uninstall
```

升级会保留 `previous`。新 unit、daemon health 或 Node service 检查失败时，安装器恢复原 release、配置、unit 和指针。卸载只 disable/stop managed services，并删除 managed unit 和 active/previous 指针；release、配置、日志、VM/Computer state 与 credential 文件保留，数据清理需另行确认。

## 验收

```bash
./scripts/acceptance-host-install-linux.sh \
  /absolute/images /absolute/image-public.pem \
  "$HOME/zapvm-evidence/linux-host-install-$(date +%Y%m%d-%H%M%S)"

./scripts/acceptance-host-install-linux.sh \
  /absolute/images /absolute/image-public.pem \
  "$HOME/zapvm-evidence/linux-host-install-live-$(date +%Y%m%d-%H%M%S)" \
  --live
```

`--live` 只应在没有预先存在 `zapvm-daemon.service` / `zapvm-node.service` 的专用 KVM Host 上执行。它会创建短期 release signing key 和 mTLS CA，执行 install、doctor、upgrade、rollback、Node 崩溃循环的失败升级自动恢复、uninstall，并在每次版本切换后等待 Control 持久状态报告精确版本与 healthy daemon。成功条件是 `LINUX_HOST_INSTALL_ACCEPTANCE_OK`；容器内通过签名/语法/preflight 不等于真实 KVM/systemd service 验收。

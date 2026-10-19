# macOS Remote Host 安装与升级

`scripts/zapvm-host-macos.sh` 把已签名的 `zapvm`、`zapvm-node` 和两份 owner-only 配置安装为当前登录用户的 LaunchAgent。它不安装 Control；Control 可以部署在 Railway 或其他 TLS 入口，macOS Host 只建立出站 mTLS 连接。

## 前置条件

- Apple Silicon macOS，当前用户可使用 Virtualization.framework。
- 一个已安装并激活的签名 zapVM image，以及对应的 image public key。
- `zapvm` 和 `zapvm-node` 来自同一版本的 release 目录。
- release 内全部 Mach-O 已使用 Developer ID Application、Secure Timestamp 和
  Hardened Runtime 签名；`zapvm` 额外包含 `packaging/macos/zapvm.entitlements`。
  全部二进制都能通过 `codesign --verify --strict`，公开发行包还必须有 Apple
  Notary Service 的 `Accepted` 记录。
- Control 已 provision 该 Node、tenant/project scope 和 Computer。
- Node client certificate 只包含该 Node 的 SPIFFE URI SAN。

安装器必须由目标登录用户运行，拒绝 root。默认安装根是 `~/Library/Application Support/zapvm`，默认 LaunchAgent 目录是 `~/Library/LaunchAgents`。

## 配置

从以下严格 JSON 示例开始：

- [daemon.json](../packaging/examples/daemon.json)
- [cloud-node.json](../packaging/examples/cloud-node.json)

两份配置中的 `endpoint` / `daemon_endpoint` 必须是同一个当前用户可访问的绝对 Unix socket 路径。Node 的 `workspace_root` 必须是专用于自助 Computer 的绝对目录；Node 只会在该目录下按 tenant/project/computer 创建工作区，不接受 Control 下发任意 Host 路径。daemon 配置固定签名镜像、state root、资源配额和本地 credential ID 到文件的绑定；Node 配置固定 Control URL、Node identity、mTLS 文件和并发上限。配置和私钥必须是当前用户拥有的 regular file，并且不得向 group/other 开放。

先用 release 中的二进制离线检查：

```bash
/absolute/release/zapvm daemon run \
  --config /absolute/config/daemon.json --validate
/absolute/release/zapvm-node \
  --config /absolute/config/cloud-node.json --validate
```

## 安装

```bash
./scripts/zapvm-host-macos.sh install \
  --source-dir /absolute/release \
  --daemon-config /absolute/config/daemon.json \
  --node-config /absolute/config/cloud-node.json

./scripts/zapvm-host-macos.sh doctor
```

安装器按以下顺序完成 fail-closed 检查和切换：

1. 验证两个二进制的签名、版本一致性和 zapVM Virtualization entitlement。
2. 验证签名 active image、credential file、Node mTLS 配置和 daemon endpoint 一致性。
3. 将 release 安装到不可变的 `releases/<version>`，原子切换 `current` 指针。
4. 生成不经过 shell、无 `EnvironmentVariables` authority 的 daemon/node LaunchAgent。
5. 先启动 daemon 并等待 IPC health，再启动 Node。

成功输出固定标记 `ZAPVM_MACOS_HOST_OK`。Control 管理员还必须确认该 Node 的精确版本、image digest 和 `daemon_state=healthy` 后，才能开放 admission。

## 公证发行包

先从同一源码提交构建完整 Host tools release 目录，再使用个人 Developer ID
和保存在 Keychain 中的 `notarytool` profile 生成可供 Homebrew 发布的公证包：

```bash
./scripts/release-macos-host.sh \
  --source-dir /absolute/unsigned-release \
  --output-dir /absolute/release-output \
  --version 0.3.0-beta.1 \
  --source-commit "$(git rev-parse HEAD)" \
  --signing-identity 'Developer ID Application: Name (TEAMID)' \
  --keychain-profile zapvm-notary-personal
```

脚本会统一签名 `zapvm`、`zapvm-node`、`zapvm-sbom`、`zapvm-image`，提交 ZIP
公证，核对 Apple ticket 中每个 Mach-O 的 CDHash，最后生成 `.tar.gz`、
`SHA256SUMS`、`BUILD-IDENTITY.txt` 和公证 JSON。只有输出
`ZAPVM_MACOS_NOTARIZATION_OK` 才能更新 GitHub Release 与 Homebrew Formula。

standalone CLI 不能 staple，且 `spctl --type execute` 可能提示它“不是 App”；
发行门禁以 Notary Service `Accepted`、ticket CDHash 精确匹配、严格 codesign
验证和实际命令验收为准。不要把 `.p8`、Apple ID 密码或 Keychain 导出物放入仓库。

## 升级与回滚

先在 Control 将 Node drain，并等待 `in_flight=0`，再运行：

```bash
./scripts/zapvm-host-macos.sh upgrade \
  --source-dir /absolute/new-release \
  --daemon-config /absolute/config/daemon.json \
  --node-config /absolute/config/cloud-node.json

./scripts/zapvm-host-macos.sh doctor
```

升级会保留 `previous` 指针。如果新服务没有通过健康检查，安装器恢复旧二进制、配置、LaunchAgent 和指针；若需要人工回滚：

```bash
./scripts/zapvm-host-macos.sh rollback
```

确认新 generation 的 Node 健康后再解除 drain。旧 generation 的 lease 和 event 会由 Control fencing 拒绝。

## 卸载

```bash
./scripts/zapvm-host-macos.sh uninstall
```

卸载只停止服务并删除本工具管理的 LaunchAgent、`current` 和 `previous` 指针。`releases`、配置、日志、VM state、Computer state 和 credential 文件会保留，以便审计或恢复；数据清理必须由管理员单独确认范围后执行。

## 真实验收

离线安装生命周期门禁：

```bash
./scripts/acceptance-host-install-macos.sh \
  /absolute/images /absolute/image-public.pem \
  "$HOME/zapvm-evidence/macos-host-install-$(date +%Y%m%d-%H%M%S)"
```

真实 launchd + mTLS Control + Node/daemon 健康门禁：

```bash
./scripts/acceptance-host-install-macos.sh \
  /absolute/images /absolute/image-public.pem \
  "$HOME/zapvm-evidence/macos-host-install-live-$(date +%Y%m%d-%H%M%S)" \
  --live
```

`--live` 会构建两个测试版本，创建短期测试 CA，依次执行 install、doctor、upgrade、rollback、uninstall，并在每次版本切换后等待 Control 持久状态报告对应 Node 版本和 `daemon_state=healthy`。成功条件是最后输出 `MACOS_HOST_INSTALL_ACCEPTANCE_OK`；脚本存在或只通过 shell 语法检查不代表验收通过。

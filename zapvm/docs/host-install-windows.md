# Windows Remote Host 安装与升级

`scripts/zapvm-host-windows.ps1` 将 Authenticode 签名的 `zapvm.exe`、`zapvm-node.exe` 和两份受保护配置安装到 `ProgramData\zapVM\Host`。安装器注册三个原生 Windows 服务：最小权限边界的 `zapvm` HCS 服务、LocalSystem `zapvm-daemon` 和 `zapvm-node`。Control 可以位于 Railway 或其他 TLS 入口，Host 只建立出站 mTLS 连接，daemon 只监听本机命名管道。

## Host 前置条件

- Windows Server build 20348+ 或相应 Windows 客户端版本，x64。
- Hyper-V、Virtual Machine Platform、HCS/HCN 已启用，`vmcompute`、`hns` 可用且 hypervisor active。
- 使用提升权限的 Administrator PowerShell。
- 已安装并激活签名 zapVM image；Windows 使用 VHDX 资产。
- Control 已 provision Node、tenant/project scope 和 Computer；Node client certificate 只包含该 Node 的 SPIFFE URI SAN。

安装器不会自动启用 Windows Feature、修改固件虚拟化设置或降低执行策略。生产发布必须先在 CI/KMS 中完成 Authenticode 签名；Host 只接收预期 signer certificate thumbprint，不接收签名私钥。

## Release 与配置

release 目录必须包含由同一证书签名且版本完全一致的：

```text
zapvm.exe
zapvm-node.exe
```

从 [daemon.json](../packaging/examples/daemon.json) 和 [cloud-node.json](../packaging/examples/cloud-node.json) 创建严格 JSON。Windows 的 daemon endpoint 必须使用专用命名管道，例如 `\\.\pipe\zapvm-host-a`；Node 的 `daemon_endpoint` 必须完全相同。`workspace_root` 必须使用专用于自助 Computer 的绝对 Windows 目录。image、state、credential、CA、certificate 和 private key 都使用绝对 Windows 路径。

安装器把配置复制进仅 SYSTEM/Administrators 可访问、owner 为 Administrators 的版本目录；SCM 参数只包含配置路径，不包含 token、证书内容或 credential value。由于 daemon/Node 以 LocalSystem 运行，配置引用的 image public key、credential、CA、certificate、private key 及其直接父目录也必须由 SYSTEM 或 Administrators 持有，并且 allow ACE 只能授予这两个主体；安装器会在任何 service 变更前 fail closed 检查这一条件。

可用管理员 PowerShell 预置专用 authority 目录（不要对 workspace 或一般用户文件运行）：

```powershell
icacls.exe "C:\ProgramData\zapVM\Authority" /inheritance:r `
  /grant:r "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F"
icacls.exe "C:\ProgramData\zapVM\Authority" /setowner "*S-1-5-32-544" /T /C
```

## 安装

```powershell
$signer = "0123456789ABCDEF0123456789ABCDEF01234567"

.\scripts\zapvm-host-windows.ps1 install `
  -SourceDirectory "C:\staging\zapvm-0.1.0" `
  -DaemonConfig "C:\staging\config\daemon.json" `
  -NodeConfig "C:\staging\config\cloud-node.json" `
  -SignerThumbprint $signer

.\scripts\zapvm-host-windows.ps1 doctor
```

安装流程先验证 Authenticode status 和 signer thumbprint，再执行配置/mTLS/image校验。随后安装 HCS 服务，运行完整 `zapvm doctor`，注册有依赖关系的 daemon/Node 自动服务，并确认 PID 在健康窗口内稳定。固定成功标记是 `ZAPVM_WINDOWS_HOST_OK`。

## 升级、回滚与卸载

先从 Control drain Node，并等待 `in_flight=0`：

```powershell
.\scripts\zapvm-host-windows.ps1 upgrade `
  -SourceDirectory "C:\staging\zapvm-0.2.0" `
  -DaemonConfig "C:\staging\config\daemon.json" `
  -NodeConfig "C:\staging\config\cloud-node.json"

.\scripts\zapvm-host-windows.ps1 rollback
.\scripts\zapvm-host-windows.ps1 uninstall
```

升级不允许改变首次安装固定的 signer trust anchor。HCS service binary、daemon/Node SCM `ImagePath` 和 `host-state.json` 作为一个事务切换；新 daemon health 或 Node service 稳定性失败时恢复旧版本。回滚同样具备反向恢复。卸载删除三个 managed service 和 active state，但保留 release、配置、日志、VM/Computer state，数据清理需另行确认。

## 真机验收

在没有预先存在三个 zapVM service 的专用 Windows Hyper-V Host 上运行：

```powershell
.\scripts\acceptance-host-install-windows.ps1 `
  -ImageRoot "C:\ProgramData\zapVM\Images" `
  -ImagePublicKey "C:\ProgramData\zapVM\Keys\image-public.pem" `
  -EvidenceDirectory ("C:\ProgramData\zapVM\Acceptance\windows-host-" + (Get-Date -Format yyyyMMdd-HHmmss))
```

验收脚本创建一天有效的临时代码签名证书和 mTLS CA，构建两个版本，执行 install、doctor、upgrade、rollback、故障 Node 升级自动恢复、uninstall，并等待本地 Control 持久状态中的精确 Node version 和 `daemon_state=healthy`。证书在结束时从测试用户证书库删除，证据目录保留。成功条件是 `WINDOWS_HOST_INSTALL_ACCEPTANCE_OK`。

PowerShell AST、Go 交叉编译或既有 HCS 单测均不能替代这项真实 SCM/Hyper-V/NTFS DACL 验收；最低 build 20348 和 Windows Server 2025 应分别保留证据。

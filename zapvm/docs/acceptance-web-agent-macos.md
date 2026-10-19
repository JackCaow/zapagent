# macOS Web Agent 真实闭环验收

本文定义 P0 Remote Agent 的 macOS 黑盒验收。成功条件不是某个服务健康，而是用户从真实浏览器发起目标后，任务进入签名 VZ Guest 内的 Zap Agent 执行，并能把事件、文件和终态可靠返回浏览器。

## 1. 覆盖链路

```text
Google Chrome
  → zapvm-web BFF
  → zapvm-control
  → zapvm-node
  → owner-only daemon IPC
  → macOS Virtualization.framework VM
  → Guest Agent + Runtime adapter + independently signed Agent Layer
  → Task journal / Workspace operation
  → BFF / Chrome
```

验收场景包括：

- 登录、选择 Computer、创建 Session 和执行首个 Agent turn；
- 浏览器离线/在线切换后的 SSE cursor 恢复；
- 页面刷新后的 Task snapshot 和完整事件重放；
- 同一 Session 的 continuation turn；
- Workspace 列表、文本读取、Git diff 和文件下载；
- 运行中 Agent 的取消以及 Guest 进程树终止；
- 390×844 移动视口无横向溢出，Conversation 与 Outcome 抽屉可打开和关闭；
- 跨租户 Task 查询统一返回 `404 not_found`；
- Web、Control、Node、daemon 和 Guest Event Journal 五层关联；
- 已存在 `.git` 的写拒绝，以及缺失 `.zapcode` 的请求期保护和退出清理；
- 指标中的 Store ready、VM boot、成功 Task、取消 Task 和空告警集合。

## 2. 前置条件

- Apple Silicon Mac，Virtualization.framework 可用；
- 由当前源码构建、签名、安装并激活的 arm64 `host-runtime` 镜像；
- 使用独立 Agent 信任根安装的 arm64 ZapCode Agent Layer，以及精确 `id@version` 引用；
- Google Chrome 和全局 Playwright；
- owner-only 模型 credential 文件；
- provider 使用 HTTPS，Computer restricted allowlist 只放行 provider 域名的 443 端口。

旧的已签名镜像不能证明当前 Guest Agent 源码。修改 Guest Agent 或 launcher 后，必须先重新执行 `build-rootfs.sh arm64`，再用一次性验收根或生产发布根完成 `zapvm-image sign/install/activate`。

## 3. 执行

```bash
ZAPVM_E2E_MODEL_KEY_FILE=/absolute/private/model-key \
ZAPVM_E2E_PROVIDER_BASE_URL=https://provider.example/v1 \
ZAPVM_E2E_MODEL=model-name \
./scripts/acceptance-web-agent-macos.sh \
  /absolute/signed/images \
  /absolute/signed/image-public.pem \
  /absolute/signed/agents \
  /absolute/signed/agent-public.pem \
  zapcode@1.12.0 \
  /absolute/new/evidence-directory
```

除 Agent 引用外的位置参数都必须是绝对路径，evidence 目录必须位于当前用户 HOME 内且事先不存在。脚本不会覆盖全局 daemon、Node、镜像或配置；所有测试证书、访问令牌、Control state、daemon state、socket 和工作区都位于短路径临时目录，并由退出 trap 回收。

固定成功标记为：

```text
WEB_AGENT_MACOS_E2E_OK evidence=/absolute/evidence-directory
```

## 4. 证据与安全

成功 evidence 至少包含：

- `acceptance-result.json`：平台、源码 SHA、三个 Task ID、跨租户状态和保护路径清理结果；
- `browser-result.json`：首轮、continuation、cancel 三个浏览器 Task，以及移动视口门禁结果；
- `mobile-workspace.png`：390×844 自动化移动视口证据；
- `guest-event-summary.json`：不含正文的 Guest 事件摘要；
- `metrics.json`：低基数运行指标；
- `correlation.log`：同一 Task 的五层低敏关联；
- `control.log`、`node.log`、`daemon.log`、`web.log`：已替换临时路径和 credential 文件路径的日志；
- `downloaded-artifact.txt`：浏览器下载动作的内容校验样本。

证据不得保存模型密钥、Web access token、证书私钥、prompt 或完整 Agent 输出。脚本只把 credential ID 交给 Control；credential value 由 daemon 的请求级文件 broker 注入 Guest，并在任务结束时清理。

## 5. 签收边界

该脚本通过可签收 macOS P0 用户闭环，但不替代以下门禁：

- Linux `/dev/kvm` + systemd 254+ 物理 Host；
- Windows 20348+ 管理员 Hyper-V/HCS/HCN Host；
- 整机睡眠/唤醒与 72 小时长稳；
- 生产镜像签名根、正式发布仓库和密钥轮换。

这些门禁失败时不能回写为 macOS E2E 失败；应分别记录平台、镜像 digest、Host build、Task ID、日志关联和清理结果。

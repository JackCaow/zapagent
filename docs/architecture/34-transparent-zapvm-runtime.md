# Transparent zapVM runtime

Zap 的目标产品形态与 Claude Desktop/Cowork 的本地 Agent VM 类似：用户只运行
`zap`，Host 保留 UI、模型调用和权限判断，Agent 产生的 Shell/脚本/构建/测试在
一台长期运行的 Linux VM 中执行。VM、daemon、镜像、公钥和 IPC endpoint 都不是
日常用户配置项。同一执行边界也支持 owner 安装的 Cloud Computer binding，把命令经
mTLS control plane 调度到远端 node；Agent 和工具协议不感知传输差异。

## 当前接入边界

```text
Zap TUI / Loop / Policy (Host)
        |
        +-- file, MCP, HTTP, delegate orchestration --> existing Host adapters
        |
        `-- bash / background shell
                  |
                  v
          TransparentExecutionBroker
                  |
                  v
           zapVM daemon exec
                  |
                  v
        Linux Guest /workspace + Session HOME
```

Cloud binding 启用时，`TransparentExecutionBroker` 的下半段替换为：

```text
        mTLS Cloud Adapter
             |
             v
   POST /v1/tasks + event cursor
             |
             v
  zapvm-node -> dedicated daemon -> Linux Guest
```

`src/agent-factory.ts` 始终装配 `TransparentExecutionBroker`。它只在找到一套完整
Runtime 时启用 VM 路由；旧安装没有 Runtime 资产时继续使用原来的平台 OS
sandbox。完整 Runtime 的固定目录契约为：

```text
<runtime-root>/
├── bin/zapvm[.exe]
├── image-public.pem
└── images/
    ├── active.json
    └── <signed-version>/...
```

生产安装器把该目录放在 Zap binary 相邻的 `zapvm-runtime/`，或 Zap data directory
下的 `runtime/zapvm/`。发现逻辑拒绝 binary、公钥、image root 或 `active.json` 的
symlink，且缺少任一资产时不会把半安装状态当作可用 Runtime。源码调试可以用内部
环境变量 `ZAPCODE_ZAPVM_RUNTIME_DIR` 指向同一目录结构；这不是用户功能。

Cloud binding 位于 Zap data directory 的 `runtime/zapvm-cloud.json`，支持两种明确模式：

- `fixed`：安装器写入一个 Computer ID 和一个固定 workspace root，适合 Computer 运行在
  真正的远端 node；
- `local-auto`：适合全局安装的 Zap 经云控制面调度回本机专用 node。安装器只写入经过
  用户确认的项目根列表；Zap 对根内的当前工作目录生成稳定 Computer ID，再通过 owner
  控制且不可被组/其他用户写入的本地 `zapvm` binary，向专用 daemon 执行
  inspect/create/reuse。并发首次调用共享创建结果，已有 Computer 的 workspace 或安全策略
  不一致时 fail-closed。

`local-auto` 还显式声明 `computer_profile` 与 `computer_revision`。`sandbox` profile 只使用
镜像内既有命令；`work` profile 允许 Agent 通过签名能力契约中的
`zap-pkg install <package>...` 把工具安装到 Computer 的持久 rootless store。Work Computer
ID 同时摘要 workspace、revision、只读模式和规范化网络策略；升级 revision 或改变授权会
创建新 Computer/state，而不是让旧的小容量/旧能力状态盘与新策略混用。典型配置片段：

```json
{
  "binding_mode": "local-auto",
  "computer_profile": "work",
  "computer_revision": "work-v1",
  "network": "restricted",
  "allowed_domains": [
    "channels.nixos.org",
    "cache.nixos.org",
    "releases.nixos.org"
  ],
  "allowed_ports": [443]
}
```

两种模式都携带 control origin、operator mTLS 文件路径，以及与 Computer 完全一致的
网络/只读契约。配置文件、CA、client certificate 和 private key 必须是当前用户拥有的
owner-only 普通文件并拒绝 symlink；workspace 也必须解析为真实目录。`local-auto` 只匹配
显式项目根，不应把整个 Home 作为授权根。配置一旦存在但无效，启动 fail-closed，不会
悄悄切回 Host 或本地 VM。

## 懒启动和 fail-closed

Runtime 发现不会启动任何进程。第一次执行 `bash` 时：

1. `ZapVmRuntime` 用 `zapvm daemon status` 探测 Zap data directory 中的私有 endpoint；
   它不复用用户手工启动的全局 zapVM daemon。
2. 没有 daemon 时，以签名 image root/public key 和私有 state root 启动后台 daemon。
3. 并发的首次工具调用共享同一个启动 Promise；单次工具取消只停止等待，不会中断
   其他 Session 的 bootstrap。
4. daemon ready 后才执行工具。已安装 Runtime 若启动失败，`bash` fail-closed，绝不
   回落到 Host shell。

Cloud 模式同样 fail-closed：Task envelope 与 payload 使用同一个随机 Task ID 和
Computer ID；工作目录必须等于 fixed binding，或位于 `local-auto` 的显式项目根内；
`.git/.zapcode` 继续写保护；请求网络不得超过 Computer allowlist。Adapter 按单调 cursor
转发 stdout/stderr，终态前再取一次事件，Agent 取消会向 control plane 发送
`DELETE /v1/tasks/<id>`。云模式暂不向模型暴露后台任务字段，避免把远端 Task 伪装成
本机 PID。

Work profile 下只读 rootfs 仍是完整性边界，而不是禁止搭建环境。system prompt 与 Bash
tool prompt 都指示 Agent 使用 `zap-pkg`；安装 profile 自动进入后续命令 PATH，并跨 Session、
VM stop 和 Host restart 保留。缺工具时不得调用 Host 的 Homebrew/apt，也不得把运行时复制到
请求私有的 `/tmp`。Sandbox profile 或缺失签名能力时仍明确失败，不伪装成可安装环境。

daemon 日志和 route state 位于 Zap data directory 的 `runtime-state/zapvm/`。正常
用户界面不显示这些实现细节；支持诊断可以读取该目录。

## 命令与 Session 映射

VM process broker 不经过 Host shell 拼接命令，而是构造 argv：

```text
zapvm daemon exec
  --endpoint <zap-private-owner-only-endpoint>
  --workspace <authorized-host-workspace>
  --session-id <host-authored-zap-session-or-agent-run-id>
  --cwd <guest-relative-cwd>
  --exec-timeout <broker-limit>
  --protect-workspace-path .git
  --protect-workspace-path .zapcode
  --network restricted
  --allow-domain <declared-domain>
  --allow-port <declared-port>
  -- /bin/sh -c <model-command-as-one-argv>
```

Host workspace root 映射为 Guest `.`，子目录映射为 `./relative/path`；越出授权 root
的 cwd 在启动前拒绝。主 Agent 使用 conversation Session ID，子 Agent 使用
host-authored subagent ID，因此持久 HOME、cgroup 和进程清理边界不会全部落到旧的
`default` Session。后台 Shell 复用工具上下文中的同一个 VM process broker。

Host 只向 `zapvm` client 进程传递 endpoint 定位必需的最小环境变量。模型 provider
API key 和普通 credential-shaped 环境变量不会进入 client，更不会进入 Guest；只保留
平台后端启动所需的 `PATH`、systemd user bus、Windows system root 等非凭据环境。
Host 为 Windows 时，prompt 仍明确告知 Agent bash 的实际目标是 Linux，并把旧命令
适配器产生的 `NUL` 重定向恢复为 Guest 的 `/dev/null`。

## 已接通的发布门禁

- release workflow 将 zapVM 源码锁定到 reviewed commit，分别构建 amd64/arm64 Guest，
  用仓库 secret 中稳定的 Ed25519 私钥签名，再把平台 zapVM binary、可信公钥和已验证
  image bundle 组装进 Runtime archive；安装器校验 archive checksum 后原子替换 Runtime。
  同一 release 还发布按架构命名的原始 `.bundle.tar.zst`、公钥和各自 SHA-256，供
  zapVM 的 dedicated Linux KVM / Windows HCS workflow 下载并复验完全相同的候选，
  真机门禁不得重新构建或重签一个身份不同的 stub image。发布任务同时生成签名
  composition、按架构命名的 Base/Runtime/Agent/Session 独立层归档和 schema 3 TUF
  custom metadata；在线更新只下载可信 Warm Cache 中缺失的层，完整 bundle 继续作为
  离线安装、验收和灾备制品。
  当前锁定的 zapVM revision 同时提供 fail-closed RC/staging TUF repository publisher；
  每个独立服务的 architecture repository 必须使用独立 root/role-key domain。生产 stable
  仍必须在分离角色和 HSM/KMS 中完成签名，不能由 release job 的单进程 RC publisher 代替。
- 每次命令执行把 Guest `.git`（存在时）和 `.zapcode` 传为保护路径。Guest launcher
  在独立 mount namespace 内对它们 self-bind 并只读 remount；普通 workspace 仍可写。
  路径必须是存在的、非 symlink 的 workspace 相对文件或目录。
- VM 网络默认关闭。直连 daemon 的一次性 route 会从 capability grant 生成精确
  domain/port allowlist；通配所有目标和 method-scoped grant 会 fail-closed。
- Cloud Work Computer 在创建时固定最大 restricted allowlist，后续命令声明的
  `network_destinations` 必须是它的子集；Guest proxy 始终强制该 Computer 最大边界。
  当前版本不会在复用同一 VM 时为每条命令动态缩小 proxy allowlist，因此高敏租户应按
  项目/用途拆分 Computer policy。安装能力不会把 restricted 自动提升为 unrestricted。

Release 仓库必须配置 `ZAPVM_REPOSITORY_TOKEN`（只读私有 zapVM）和
`ZAPVM_IMAGE_SIGNING_PRIVATE_KEY`（PKCS#8 Ed25519 PEM）；没有这两个 secret，tag
release 会在构建资产前明确失败。发布入口还要求 tag 是 GitHub 验证通过的 annotated
signed tag、精确解析到 workflow commit，且该提交可从 `main` 到达；lightweight、
unsigned、无效或旁支 tag 均在访问镜像签名私钥前失败。私钥不会进入 artifact，
Runtime 只携带派生公钥。私有仓库若使用不支持 Environment reviewer/branch
protection 的 GitHub 套餐，仍须升级套餐或迁移到具备等价保护的发布系统后才能按
stable 标准签收。

发布者必须先把个人 GPG/SSH 公钥作为 signing key 注册到 GitHub，并在本地验证
签名后才推送 tag；workflow 不接受 lightweight tag：

```bash
git switch main
git pull --ff-only
git tag -s v1.12.1 -m "Zap v1.12.1"
git tag -v v1.12.1
git push origin refs/tags/v1.12.1
```

## 仍需满足的交付门禁

源码、协议和发布流水线完成不等于三平台真机交付。仍需：

- macOS VZ、Linux KVM、Windows HCS 分别执行安装、首次启动、Session 复用、取消、
  后台任务、休眠恢复和崩溃恢复黑盒验收；
- Linux 真实主机必须具备 `/dev/kvm`、cgroup v2、systemd 254+；Windows 真实主机
  必须为 20348+ 管理员环境并启用 Hyper-V/HCS。托管 runner 的分阶段结果不能替代
  dedicated physical runner 的同机多 VM、休眠/唤醒和长时间 soak 验收；
- macOS release binary 当前使用 VZ entitlement 做技术验收；正式外部分发还要完成
  Developer ID 签名/公证策略；
- 支持诊断必须保留底层错误和 diagnostic ID，但正常 UI 不暴露 VM 控制概念。

在真机 evidence 归档并人工确认前，不应仅因为 discovery、单测或托管 CI 通过就宣称
Claude 级本地 VM 隔离已经交付。

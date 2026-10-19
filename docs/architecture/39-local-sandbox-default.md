# 39. 本机沙箱默认执行与沙箱外重试

状态：已实现（zapAgent 1.14.3 起；1.14.5–1.14.7 增补自动放行、包缓存、网络白名单、GUI 拒绝启动和 `sandboxExcludedCommands`）。
与 Claude Code 的本地沙箱模型对齐。

## 问题

通用 `bash` 一旦发现 zapVM 安装就固定路由进 VM。用户启动的是本地 Agent，却拿到一个
Linux 环境：本机工具链（Xcode、Swift、npm 全局工具）、浏览器预览和桌面能力全部断开，
模型还会把普通失败误判成环境问题反复重试。

## 决策

| 项 | 行为 |
| --- | --- |
| 默认执行位置 | 本机，套 OS 沙箱（macOS Seatbelt / Linux bubblewrap / Windows AppContainer） |
| VM | 显式 opt-in：配置 `executionBackend: "vm"` 或环境变量 `ZAPCODE_EXECUTION=vm`（环境变量优先） |
| 沙箱内写入 | 工作区、每命令临时目录，以及已存在的包管理器缓存（见下文）；`.git`、`.zapcode` 只读；HOME 为每命令临时目录 |
| 沙箱内读取 | 系统目录、工作区，以及 `~/.bun/bin`、`~/.cargo/bin`、`~/.nvm/versions`、Xcode 等工具链只读根 |
| 网络 | macOS：只能连回环，经本地代理按域名白名单访问；Linux/Windows：目前仍全开（见下文） |
| 沙箱外重试 | bash 参数 `dangerouslyDisableSandbox: true`，每次调用都需要用户批准 |
| 关闭逃生口 | 配置 `allowUnsandboxedCommands: false`；该参数随即不再出现在工具 schema 中 |

沙箱与权限是两套机制：权限规则决定"要不要问"，沙箱决定"批准后实际能碰什么"。

## 层次与分工：沙箱与 VM

```
模型调用 bash
  → 权限层 PermissionManager（src/permissions.ts）：要不要问
  → 执行代理 ExecutionBroker（zapsdk/execution/broker.ts）：怎么跑
  → OS 沙箱 或 VM：能碰什么
  → 子进程
```

| | OS 沙箱（默认） | VM（opt-in） |
| --- | --- | --- |
| 命令跑在哪 | 本机，同一个系统和内核 | 内置 Linux 虚拟机（zapVM） |
| 隔离手段 | Seatbelt / bubblewrap / AppContainer | 独立内核和虚拟硬件 |
| 本机工具链 | 可用 | 不可用，只有镜像里的 Linux 工具 |
| 图形程序（浏览器、`open`） | 不能直接用，需批准后沙箱外运行或列入 `sandboxExcludedCommands` | 不可用 |
| 沙箱外逃生口 | 有，每次批准 | 没有；VM 失败不回退到宿主 shell |
| 适合 | 日常开发 | 不可信代码、需要强隔离、复现问题 |

两者都只约束 **命令执行**（bash 工具）。文件工具、MCP、网络抓取工具走权限层，不在沙箱或 VM 里；
Agent 本身（模型调用、界面、权限判定）始终在宿主上。所以这不是"整个 Agent 被隔离"。

权限层判定顺序：计划模式拦截 → 危险命令模式（TUI 强制确认，headless 拒绝）→ 沙箱外运行强制确认 →
用户的 allow/ask/deny 规则（deny 优先）→ 内置放行（命令确实在沙箱或 VM 里跑、工作目录没离开项目）→ 权限模式。
"命令是否被沙箱约束"是 `PermissionManager` 的实例属性（`sandboxConfined`），不是进程级开关；
没有可用沙箱时所有命令回到逐条询问。

## 沙箱内命令不再询问

1.14.3–1.14.4 每条非只读命令都要问，一次任务里会反复打断。现在（对齐 Claude Code 的 `autoAllowBashIfSandboxed`）：

- 命令确实在沙箱里跑，就直接执行，不弹审批。配置 `autoAllowSandboxedCommands`（默认 `true`）；
  设为 `false` 退回只放行严格解析的只读命令清单（`src/readonly-commands.ts`，清单制，逐级白名单）。
- 仍会询问：沙箱外运行（永远）、用户自己的 ask/deny 规则、危险命令模式、没有沙箱时的所有命令。
- 命令的工作目录离开项目（`cwd` 在工作区外）时不享受放行。

## 临时目录与命令结果

本机沙箱为每个 shell 命令创建独立、可写的临时目录，通过 `TMPDIR`、`TMP`、`TEMP`
传给子进程。POSIX shell 使用 `"$TMPDIR"`，Windows cmd 使用 `"%TEMP%"`；不要硬编码
`/tmp`。例如，同一次 Bash 调用内完成 `printf data > "$TMPDIR/input" && cat "$TMPDIR/input"`。
命令退出后目录自动删除，后续 Bash 调用和 `check_steps` 的下一步得到新的目录。需要跨调用
保留的产物应显式选择获准的持久位置；一次性计算无需污染项目目录。这些生命周期说明仅针对
本机沙箱，不适用于获准的沙箱外命令或 VM。标准提示词、自定义提示词的环境区以及主/子 Agent
的 Bash 工具说明均包含这些事实。

Shell 退出码通常只表示最后一条命令或管道末端的状态。前序写入失败后，末尾 `wc -l` 仍可能
返回 0。前台 Bash 回执因此额外记录 `stderrPresent`：退出 0 但有 stderr 时，将诊断置于 stdout
之前，给模型附加检查提示，TUI 显示 `⚠` 而非 `✓`。stderr 也可能是正常警告，所以仍保留真实
退出码和 shell 的成功状态，不根据文本伪造失败码。无 stderr 的前序失败仍可能被 shell 掩盖。
依赖前一步成功的操作应使用 `&&`；独立验证使用 `check_steps`，遇到非零退出即停止；管道内
各阶段需显式检查，或在支持的 shell 中启用 `pipefail`。不能仅凭最后退出 0 声称所有步骤成功，
也不能因为警告就自动重跑可能产生副作用的命令。

## 包管理器缓存

沙箱额外保留这些**已存在**目录可写：`~/.cache/{pip,uv,pnpm,yarn}`、`~/.npm`、`~/.bun/install`、
`~/.cargo/{registry,git}`、`~/go/pkg/mod`、`~/Library/{Caches/pip,Caches/Yarn,pnpm,Python}`、`~/.local/lib`。
不放开任何 `bin` 目录（在 `PATH` 上）。目的是 `pip install`、`npm install`、`cargo build` 不再需要沙箱外重试。

**风险**：沙箱里的命令可以往用户 site-packages 和包缓存里放代码，之后沙箱外的 python/node 可能导入。已记入 #59。

## 网络白名单（macOS）

- Seatbelt 只允许命令连回环；`HTTP(S)_PROXY`、`ALL_PROXY`、`NODE_USE_ENV_PROXY` 指向宿主进程里的本地 CONNECT/HTTP 代理
  （`zapsdk/execution/network-proxy.ts`）。忽略代理设置的工具直连外网会被内核拒绝，而不是绕过策略。
- 白名单：常见开发域名（包仓库、git 托管、工具链下载、常用 CDN）+ `sandboxNetwork.allowedDomains`；
  `deniedDomains` 优先；`*.example.com` 只匹配子域；`*` 放开全部。回环地址放行；链路本地地址（`169.254.*`，云元数据）永远不可达。
- 被拦的主机返回 `403` 并带提示（加入 `sandboxNetwork.allowedDomains`，或批准后沙箱外重试）。
- 关闭：`sandboxNetwork.mode: "open"` 或 `ZAPCODE_SANDBOX_NETWORK=open`。
- 局限：只按主机名过滤，不检查 TLS；对已放行域名不能防止数据外传。本机自己的局域网 IP 经回环投递，Seatbelt 视同回环。
  Linux/Windows 暂无网络过滤，需要独立网络命名空间加桥接，另做。

## GUI 程序与 `sandboxExcludedCommands`

浏览器、`qlmanage`、`open` 之类无法在沙箱里工作：读不到自己的框架文件，或需要写真实的用户配置目录。
在沙箱里启动 `.app` 会崩溃，macOS 还会弹出"意外退出"报告框。处理方式：

- **拒绝启动**：Seatbelt 对 `*.app/Contents/MacOS/*` 的 `process-exec` 一律拒绝（系统、`/Applications`、`~/Applications`）。
  启动立即失败，报 `Operation not permitted`（退出码 126），不再崩溃弹窗；Xcode 的命令行工具在 `Contents/Developer` 下，不受影响。
  失败提示告诉模型：这类程序直接申请沙箱外运行，不要在沙箱里试。
- **评估过并放弃的方案：让 Chrome 在沙箱里直接跑。** 放开 `/Applications` 只读还不够，它还要写真实的 Chrome 配置目录（crashpad）
  和系统临时目录里的 socket 目录，放开等于让沙箱里的命令能改用户的浏览器配置。
- **`sandboxExcludedCommands`**（对应 Claude Code 的 `excludedCommands`）：配置命令模式（bash 规则语法），例如
  `["*Google Chrome.app*", "docker:*"]`。命中的命令从第一次就在沙箱外运行，不再先失败一次。
  模式同时匹配整条命令和每个子命令，所以 `CH="/Applications/X.app/..." && "$CH" --flag` 这种间接调用也能命中。
  命中的命令**不**享受沙箱内自动放行：仍走正常权限流程（弹一次审批，可保存"不再询问"规则），
  "能在沙箱外运行"和"免审批"是两个独立授权。`allowUnsandboxedCommands: false` 或 VM 后端下该配置不生效。
  默认列表为空，每条都是用户自己的风险决定。复合命令里只要一段命中，整条命令都在沙箱外运行。

## git 在沙箱内

- **真实 git，不经 xcrun 垫片。** mac 自带的 `/usr/bin/git` 是 `xcrun` 垫片：它自己和它起的辅助程序
  （`git-remote-https`、`blame`、`show` 用到的部分）都要在每用户临时目录创建 `xcrun_db` 缓存，沙箱里写不了就报
  `couldn't create cache file`。但该缓存记录"每个开发工具在哪"，**不能**对沙箱开放写入：被污染的条目会让之后
  沙箱外的 `git`/`clang` 指向攻击者的程序。做法是在宿主上用 `xcrun --find git` 解析真实 git，把它所在目录放到沙箱
  `PATH` 最前面（只接受 root 所有、其他人不可写的目录）。于是 `status`、`diff`、`log`、`show`、`blame`、
  公共仓库的 `clone` 和 `ls-remote` 都能在沙箱内工作。
- **`.git` 仍然整体只读。** `commit`、`checkout`、`merge`、`stash`、`fetch`、`push` 走审批后的沙箱外重试。

**评估过并放弃的方案：让沙箱内的 `git commit` 直接可用。** 这需要放开 `.git` 的一部分写权限，而独立审查三轮，
每次都找到可演示的问题，最后一轮的结论是不能合并：

1. 黑名单（只保护 `hooks`、`config`）：把 `.git` 改名、改里面的 `config` 再改回，之后沙箱外的 git 会执行任意命令；
   `rebase-merge/git-rebase-todo` 的 `exec` 行、`info/attributes`、`objects/info/alternates`、`worktrees`、
   `config.worktree` 同类。
2. 放开 `xcrun_db*`：沙箱真的写进了用户的真实缓存目录。
3. 改成白名单后，`COMMIT_EDITMSG`、`FETCH_HEAD`、`logs/HEAD` 这些文件之后会被**沙箱外**的 git **原地写**，沙箱能
   把它们换成符号链接，于是你自己终端里的一次正常 `git commit` 就会覆盖或追加到链接指向的任意文件。
   事后扫描并删除新增链接补不全：后台进程在命令返回之后仍可种链接，而且你自己终端里的 git 不受 Zap 控制。

根本矛盾是 `git commit` 必须写一个会被原地覆盖的文件。**只要放开它，就会有一个沙箱外的写穿原语。** 若要支持，
应当由宿主侧的受信代理在沙箱外执行一小组严格解析的 git 子命令，而不是放开 `.git`。

## 沙箱外重试的约束

1. 退出 sandbox 使用独立的 `SandboxEscape(*)` 能力，支持本次、当前会话、当前项目；普通工具 allow、`--allowed-tools` 和 acceptEdits 不能代替它。显式 deny/ask 优先于能力授权与 bypass。
2. TUI 审批条显示红色警告及四档选择。危险命令和显式 ask 只允许本次/拒绝。项目授权保存在用户数据目录；会话授权随 session UUID 切换清除，可在 `/permissions` 撤销。
   完整语义见 [工具批量与宽泛授权](57-tool-authorization.md)。
3. ACP 的权限标题标注 "outside the OS sandbox"。
4. 隔离 worktree 的子代理（isolated-write）拒绝 `unsandboxed` 效果；只读 bash 不提供该参数。
5. VM、resident 后端不提供该参数：VM 失败不会回退到任意宿主 shell。
6. 逃生调用不做 `cd X && cmd` 的 cwd 提取，保证执行目录就是审批时解析的目录。
7. 执行回执如实记录该次没有使用沙箱（`sandboxedProcesses = 0`）。

沙箱拦截的失败会在输出末尾追加提示，让模型知道可以申请重试，而不是误判项目问题。

## 刻意不做

- 不放行 Seatbelt 的 `lsopen`：`open index.html` 在沙箱内返回 Launch Services -54。
  允许沙箱内进程启动任意应用会削弱沙箱，这类动作走已审批的沙箱外重试。
- 不引入通用 `host_exec` 工具和环境选择器。一个带审批的参数即可覆盖，和 Claude Code 一致。

## 已知局限（追踪于 #59）

- 沙箱内命令可写 Python 用户目录和包缓存（持久化植入途径）。
- 网络白名单只在 macOS，且只按主机名过滤。
- 只读命令解析器无法证明完备，但自动放行之后它不再是唯一一道门。
- `.git` 写入始终不在沙箱内完成。

## 验证

- 单元：broker、policy、headless/TUI 审批、环境选择与 schema 预算测试。
- 真实 CLI（tmux）：沙箱内 `bun --version`、`curl`、`npm install` 成功；写工作区外被
  `Operation not permitted` 拦截且模型归因正确；批准逃生口后成功；`open index.html`
  经批准后打开本机浏览器。

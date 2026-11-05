# 权限打断治理：风险分级与能力授权

本设计在 57（工具能力与可复用授权）的裁决框架上继续演进，目标是让打断次数与风险成正比，而不是与语法或工具名的多样性成正比。57 的安全不变量全部保留。

## 背景：实测的打断来源

在隔离 `ZAPCODE_DATA_DIR` 下，用 `evaluateApprovalPolicy` 对典型调用逐一裁决（default 模式）：

| 调用 | 沙箱可用 | 沙箱不可用 |
| --- | --- | --- |
| 读文件 / 搜索（含项目外） | allow | allow |
| `edit_file` / `write_file` | ask | ask |
| `git status`、`bun test`、循环、heredoc | allow | **ask** |
| `rm -rf node_modules` | allow | ask |
| `rm -rf /tmp/build` | **ask（危险，不可记住）** | 同左 |
| `dangerouslyDisableSandbox` | ask | ask |
| `task_stop`、`memory_save`、`http_request`、MCP 工具 | ask | ask |

“会话允许”之后的覆盖范围过窄：

```
edit_file src/a.ts → 会话允许 → 保存 Edit(src/**)
  edit_file  tests/a.test.ts   ask   换目录
  multi_edit src/b.ts          ask   换工具
  write_file src/new.ts        ask   换工具
Bash(bun test:*) 已允许
  bun test 2>&1 | tail -20     ask   tail 无规则
  cd src && bun test           ask   拆分后 `cd src` 独立判定
  bun run typecheck            ask   两词前缀
```

拒绝不会中止 agent（executor 返回 `POLICY_DENIED` 工具错误），打断来自阻塞式审批本身；审批队列全局串行，并行调用逐个弹出。

## 根因

1. 授权单位是“工具名 + 参数模式”，与用户意图（“可以改这个项目的代码”）不一致；同一意图被工具名和目录切碎。
2. Shell 规则依赖前缀语法，无害的管道过滤和 `cd` 让已授权命令失配。
3. 已有 `ToolEffects`（filesystem/network/process/external）和 checkpoint 回滚，但裁决只消费 `readOnly`/`editOnly` 两个布尔量，没有区分可逆与不可逆。
4. 沙箱失败统一升级为整体逃逸审批，而不是申请更窄的缺失能力（域名、目录）。

## 目标模型

### 风险分级（Host 从 effects 计算，模型不可声明）

| 级别 | 定义 | 例子 | 默认行为 |
| --- | --- | --- | --- |
| R0 无影响 | 只读，或仅作用于 agent 自有资源 | 读文件、todo、停止本会话 task | 自动允许 |
| R1 工作区内可回滚 | 工作区内修改且 checkpoint 可回滚；沙箱内执行 | 编辑代码、沙箱内 `bun test` | 问一次，按工作区记住 |
| R2 越界但可界定 | 工作区外写、新网络域名、MCP、沙箱外执行 | 写 `~/.config/x` | 问一次，按 能力×范围 记住 |
| R3 不可逆 / 大范围 | 危险模式命中、外部破坏性操作 | force push main、`sudo`、`curl \| sh` | 每次问，不可记住 |

取所有 effect 的最高级；`confidence: "unknown"` 至少 R2；R1 的“可回滚”要求 checkpoint 启用且路径在快照范围内，否则升 R2。

### 能力授权

授权单位从工具名改为 能力 × 范围 × 有效期；工具经 effects 映射到能力：

| 能力 | 范围 | 来源 |
| --- | --- | --- |
| `fs.write` | 目录（默认工作区根） | filesystem create/modify |
| `fs.delete` | 目录 | filesystem delete，与 write 分离 |
| `exec.sandboxed` | 工作区 | 沙箱内 shell |
| `exec.host` | 命令族或整个 shell | 无沙箱 shell |
| `net` | 域名 | network destinations |
| `sandbox.escape` | 会话 / 项目 | 保持独立能力 |
| `mcp` | server（可细到 tool） | `mcp__<server>__*` |
| `agent.delegate` | provider@cwd | 保持现状 |

存储沿用 `{ pattern, type }`，新增 `Capability(<name>:<scope>)` 形式；旧规则继续匹配，`deny > ask > allow` 与来源顺序不变。

### 目标裁决顺序

1. 取消 / plan / disallowed-tools → deny
2. 任一来源 deny → deny
3. R3 → 仅本次 ask（Headless deny）
4. 显式 ask 规则 → 仅本次 ask
5. 计算所需能力集合 C
6. C 全部被能力授权或旧规则覆盖 → allow
7. 模式默认：R0 allow；R1 按模式；R2 仅 bypass allow
8. ask 时只展示未覆盖的能力，默认选项直接授予它们

## 对策

### Shell 匹配
- 中性子命令：`cd <工作区内目录>`（经 `effectiveCommandCwd` 校验，拒绝 `~`、`$`、`..`）。
- 标准输入过滤：`head`/`tail` 无操作数，`grep` 非递归且只有模式操作数；且必须通过 `isReadOnlyCommand` 的严格白名单。
- 中性子命令只在复合命令中有非中性兄弟时跳过，且显式 deny/ask 规则仍先匹配。理由：兄弟命令已获用户授权，其能力严格大于一个只读本工作区的过滤器；单独出现的中性命令维持原裁决。规则推断与覆盖校验对称跳过中性子命令，不再保存 `Bash(cd src:*)`、`Bash(tail:*)`。

### 编辑授权
- 工作区内的编辑审批选择会话/项目允许时，授予编辑工具组（`write_file`、`create_file`、`edit_file`、`multi_edit`）对整个工作区 `**` 的规则；删除与移动不在组内。
- 工作区外目标保持精确路径规则。
- 审批条展示 “file edits anywhere in this project”，不再列出四条 pattern。

### 危险判定
- `rm -r` 目标为临时目录（`os.tmpdir()`、`/tmp` 的真实路径）的严格子路径时不视为系统路径；临时根本身、家目录、系统目录仍为 R3。不透明字符串的保守扫描不变。

### 自有资源工具
- `task_stop` 的 handler 已限定本会话任务，改为 `permission: "auto"`。
- `memory_*` 暂保持 confirm，待 P2 分级后决定（写入会影响后续提示词，存在持久化注入面）。

### 沙箱失败分流（P3）
- 网络拦截 → 声明 `network_destinations`，经 `net.read(主机)` 授权后只为该命令扩展代理 allowlist；工作区外读写 → 沿用已有的 `read_paths`/`write_paths` 声明与文件授权；只有确需宿主环境才申请 `sandbox.escape`。

### 交互（P4）
- 同一轮并行调用合并审批，展示能力并集；
- 审批等待期间不阻塞无需审批的调用；
- 拒绝返回结构化能力，本轮内同一能力不再重复弹窗；
- `request_capabilities` 工具：开工前一次申请，Host 裁决；
- 同一能力手动批准 ≥3 次时提示更宽授权，仅提示不自动授予；
- 预设档位 `strict` / `balanced` / `autonomous`，映射现有 default / acceptEdits / bypassPermissions。

## 安全不变量

- 授权结论只来自 Host：能力由 adapter effects 计算，不读取模型同名参数。
- `deny > ask > allow` 跨来源成立；显式 ask 不被任何档位或能力授权覆盖。
- R3 永不可记住；Headless 无审批通道时拒绝 ask。
- `sandbox.escape` 独立，任何批量授权或档位不隐含它。
- effects `unknown` 不进入 R0/R1 自动允许。
- 撤销即时生效；会话授权随根 session UUID 轮换清除。
- TUI 与 Headless 共用同一 evaluator。

## 决定记录

| 问题 | 当前决定 | 状态 |
| --- | --- | --- |
| 新默认档位是否为 balanced（R1 编辑自动允许） | 默认仍为 strict（default）；balanced 需用户选择。工作区编辑一次授权已覆盖整个项目，默认 balanced 等于未经同意自动允许所有项目内编辑 | 已定 |
| 无沙箱时单独的只读命令是否免审批 | 维持 57 的取舍：不免；仅复合命令中的中性子命令跳过 | 已定，可复议 |
| memory 写入分级 | `project`/`reference` 为 R1，default 下免审批；`user`/`feedback` 写入全局、影响所有项目，仍询问；`memory_merge` 会删除来源，仍询问 | 已定 |

## 任务规划

### P0 度量
- [x] 裁决结果增加 `category`（read / edit / shell / sandbox-escape / dangerous / mcp / tool）。
- [x] TUI 的 `permission_decision` 日志改为结构化字段：`tool`、`mode`、`decision`、`category`、`tier`、`source`、`reason`；Headless 的 stream-json `permission` 事件附带 `category` 与 `tier`。
- 统计方式：`jq -r 'select(.event=="permission_decision" and .decision=="ask") | .category' <dataDir>/logs/*.log | sort | uniq -c`。

### P1 低风险收益
- [x] Shell 中性子命令（`cd`、标准输入过滤），裁决、规则推断、覆盖校验三处对称。
- [x] 编辑授权按工作区记住（P2 起保存为 `Capability(fs.write:**)`）；审批条友好描述。
- [x] 危险判定排除临时目录子路径。
- [x] `task_stop` 改为 auto。
- [x] 回归测试与文档。

### P2 能力模型
- [x] `zapsdk/tools/approval.ts` 由 effects 推出 `capabilities`；Host 裁决给出 `tier`（R0–R3），写入日志与 Headless 遥测。
- [x] `Capability(...)` 规则的解析、匹配、覆盖校验，`/permissions` 显示可读说明，撤销沿用按 pattern 删除。
- [x] 非 Shell 调用按能力覆盖裁决；“不再询问”保存能力规则；审批条显示能力说明。
- [x] 兼容：旧工具规则继续生效；跨来源 deny/ask；TUI/Headless 一致；自定义授权（`g`）预填沿用工具级推断。

P2 实现要点：

| 能力 | 来源 | “不再询问”保存的范围 |
| --- | --- | --- |
| `fs.write` | 内建文件工具参数；其他工具的 filesystem create/modify | 工作区内 `**`；工作区外精确 canonical 路径 |
| `fs.delete` | `delete_file`、`move_file` 源；filesystem delete | 工作区内父目录 `dir/**`；工作区外精确路径 |
| `net.read` / `net.write` | network connect / mutate 的 destination 主机名 | 该主机 |
| `external.read` / `external.write` | external read / mutate 的 system（MCP 为 `mcp:<server>`） | 该 system |

- 能力集合只在每个 effect 都可表达时存在；含进程、`*` 目标、破坏性外部操作或 unknown effects 的调用没有能力集合，继续使用工具级规则。Shell 与 `delegate_agent` 不参与能力裁决。
- 内建文件工具的能力从参数推出（与其工具规则一致），Shell 的 `write_paths` 检查不会借用 Shell 自身的事实。
- allow 只覆盖同一种能力且需覆盖全部能力（文件需覆盖真实目标与目录条目）；deny/ask 作用于整个族：`fs.*`、`net.*`、`external.*`，命中任一能力即生效，bypass 下同样生效。
- 移动文件需要源路径的 `fs.delete`，因此批准一次 src 内的移动后，后续从 src 移出的操作被覆盖，但从其他目录移动仍询问。
- 风险分级只用于度量，不改变 default 模式的自动允许行为（见决定记录）。

### P3 沙箱失败分流
- [x] 网络：主机沙箱代理执行 allowlist 时（macOS、非 open 模式），bash 提供 `network_destinations`；代理 403 与结构化失败（`missingCapabilities: network:<host>`）的建议改为声明主机，不再建议退出沙箱。
- [x] Host 裁决：allowlist 内主机无需审批；`deniedDomains` 直接拒绝（bypass 同样）；其余需要 `Capability(net.read:<host>)`，询问一次后可记住；显式 deny/ask 能力规则优先；沙箱外执行（escape、`sandboxExcludedCommands`）与未过滤出口时不检查。
- [x] SDK 传递：bash effects 为 `["*", ...声明]`；broker 只把 shell 的已批准声明（规范化为主机模式）交给沙箱上下文；沙箱仅对该命令的代理实例调用 `allowDomains`，不影响共享代理与并发命令。
- [x] 目录：沿用已有的 `read_paths`/`write_paths` 声明与 Host 文件授权（P2 起写入可由 `fs.write` 能力覆盖），本阶段未新增机制。

P3 实现要点：

- 主机模式由 `destinationHostPattern` 统一解析：接受 URL、主机或 `*.主机`，拒绝 `*`、无点主机名、非法标签；SDK 与 Host 共用。
- 声明只扩展代理，不扩展文件系统或进程能力；`deniedDomains` 与 link-local 地址在代理侧仍然拒绝，与声明无关。
- 嵌入方若自行批准 bash 调用，即同时批准了 effects 中声明的目标；Host 以外的审批实现需自行检查 `network_destinations`。
- `tests/permissions.shell-network.test.ts` 覆盖 Host 裁决；`zapsdk/tests/execution/declared-network.test.ts` 覆盖解析、schema/effects、broker 传递，并在 macOS Seatbelt 中验证声明前 403、声明后放行、不泄漏到后续命令。

### P4 交互
- [x] 非阻塞：`ApprovalCallback.precheck` 让策略可直接裁决的调用（allow/deny）不进 `approvalQueue`，审批弹窗打开期间无需审批的调用照常执行；无 precheck 的嵌入方保持原有串行顺序。
- [x] 排队调用轮到时重新裁决：前一个弹窗选择“不再询问”后，同批其余被覆盖的调用不再弹窗。真正的多调用合并对话框暂缓（见下）。
- [x] 拒绝记忆：用户拒绝后记录该请求所需的授权（推断规则；整工具规则附加参数指纹），本轮内所需授权是其子集的请求直接拒绝并提示先询问用户；新用户消息、接受 steering、切换会话时清除。
- [x] 授权建议：会话内对同一授权“仅此一次”批准 ≥2 次后，第 3 次弹窗提示选择 2 记住本会话；仅提示，不自动授予；沙箱逃逸不计数。
- [x] `request_capabilities` 工具：开工前一次申请所需能力，Host 裁决，批准即保存为会话或项目能力规则。
- [x] 预设档位 `strict` / `balanced` / `autonomous`：`/mode` 与 `--permission-mode` 接受档位名，映射 default / acceptEdits / bypassPermissions；默认仍为 strict。
- [x] memory 分级：项目级记忆写入 R1 免审批。

P4 实现要点：

- precheck 只在策略结论无需人工时返回结果；ask 仍走队列，轮到时再次裁决并记录日志，因此每个调用只记录一条 `permission_decision`。
- 拒绝记忆在 `evaluateApprovalPolicy` 的显式 deny 之后检查，只会把 ask 变成 deny，不会影响本就允许的调用（如读取）。
- 多调用合并对话框暂缓：重新裁决已消除“同一授权连续弹窗”，合并只在多个互不覆盖的授权同时等待时有收益，且会增加对话框高度（见 `dialog-approval.tsx` 关于滚动残留的说明）。
- `request_capabilities` 的所需能力就是它申请的能力：已被覆盖时直接放行；族级 deny/ask 照常生效；审批只提供“本会话 / 本项目 / 否”，保存时按原样保存，文件范围不会扩大为 `**`。文件范围只接受项目相对路径/glob，网络范围只接受主机或 `*.主机`，外部范围只接受单个 system；不能申请 Shell 命令或沙箱逃逸。plan 模式拒绝；Headless 仅在有 `onAsk` 时注册，宿主批准即为本次运行保存会话规则。工具结果如实说明是否已保存。
- 档位只是现有模式的名字，不引入新语义；`/mode bypass` 之前未校验就写入配置，现在与档位共用 `parsePermissionMode`，未知名称报错。
- 测试：`tests/permissions.capability-requests.test.ts`（档位解析、memory 分级、申请校验、精确保存与覆盖、限制优先、Headless 授予、结果说明、审批选项）、`zapsdk/tests/tools/approval-precheck.test.ts`（弹窗期间放行/拒绝、无 precheck 保持顺序）、`tests/permissions.turn-denials.test.ts`（子集匹配、整工具参数指纹、轮次/会话清除、不影响允许的调用）、`tests/hooks/permission-approval.test.ts` 的 repeats 场景。

## 验收

- 每阶段在隔离 `ZAPCODE_DATA_DIR` 下：`bun run typecheck`、`bun test`。
- P1 用例：`cd src && bun test`、`bun test 2>&1 | tail -20` 在已允许 `Bash(bun test:*)` 后放行；单独 `tail -20` 与带 deny 规则的过滤器仍按原裁决；工作区编辑一次会话允许后覆盖其他目录与编辑工具，工作区外仍询问；`rm -rf $TMPDIR/x` 不再命中危险，`rm -rf /tmp`、`rm -rf ~` 仍命中。
- P2 用例：`tests/permissions.capability-rules.test.ts`（SDK 推导、按主机记住网络写、MCP 按 server 授予只读工具、族级限制含 bypass、跨类不覆盖、Shell 不受影响、旧规则兼容、Headless 一致）；`tests/ui/tool-grants.pty.test.ts` 断言审批条的能力说明。
- P4 起以 P0 日志对比基线：典型编码任务（沙箱可用、default 模式）除 R3 外每任务 ≤1 次审批。

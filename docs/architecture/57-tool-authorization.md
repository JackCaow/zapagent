# 工具能力与可复用授权

本设计取代 21 中的 first-match、bypass 先行描述，以及 39 中仅允许逐次 sandbox 提权的描述。

## 本次重设计：能力决定范围，语法只影响匹配证据

旧实现把“解析器无法展开”直接等同于“必须每次审批”，并放在整工具授权和 sandbox 自动授权之前。结果是用户已经授权 Bash，循环、命令替换、脚本输入仍反复被拦截。随后为 cat heredoc 增加消费者白名单，又把同一种输入按程序名字分成不同待遇。

新实现删除该白名单与全局复杂语法否决。授权保持确定性：模型提供调用参数，用户选择范围，Host 根据注册工具的能力与规则裁决；模型不能声明自己的授权结论。

### 可信运行时契约

- 工具 adapter 声明 `resolveEffects`，shell adapter 另提供 `resolveShellCommands(args)`，返回实际交给 shell 的每段原始输入。参数名称可以不同，不需要加入工具名列表。
- executor 只解析一次 effects，并从同一份 effects 构造 `ApprovalContext.authorization`：`readOnly`、`editOnly`、`sandboxEscape`、`workspaceShell`、`shellCommands`。该快照与命令数组被冻结，不从模型的同名参数读取；原始执行参数保持不变。
- plan 和 acceptEdits 使用能力；shell 风险检查使用 adapter 投影的实际命令；退出 sandbox 使用 process effect 的 `unsandboxed`，覆盖显式退出及 adapter 判定的排除命令。Host integration 或包含额外 external effects 的调用不能继承 workspace sandbox 的自动授权。
- shell adapter 缺少或无法提供 payload 时只允许本次审查；整工具授权和 bypass 不能替代缺失的 adapter 证据。
- 旧的无 effects SDK adapter、直接调用 onApproval 的嵌入者，通过 `src/approval-facts.ts` 集中兼容。新工具必须声明能力，不扩充该历史名字列表。文件别名、glob 和持久规则格式保留兼容，当前没有宣称删除所有字符串匹配。

### 两种可复用范围

| 已有授权/约束 | 简单直接命令 | 不透明输入：循环、替换、heredoc、脚本等 |
| --- | --- | --- |
| 命令前缀 allow | 所有直接命令均匹配才允许 | 前缀不足以证明覆盖；询问并可选择整个工具 |
| 整工具 allow / allowed-tools / bypass | 允许 | 允许，不因语法重复询问 |
| workspace sandbox 自动授权 | 在实际配置的沙箱范围内允许 | 同样允许，不按消费者名字分类 |
| 直接命中的 deny / ask | 拒绝 / 本次审批 | 拒绝 / 本次审批 |
| 存在未能验证的同工具 deny / ask | 按直接命令判断 | 本次审批，说明无法验证哪条限制；无审批通道则拒绝 |
| 已识别危险操作 | 保留危险操作检查 | 同样保留 |
| 退出 sandbox | 另查独立能力 | 另查独立能力 |

不透明输入的默认会话/项目候选是明确的整工具规则，例如 `bash`。审批条显示 `Bash (entire tool)`，不再保存一个看似窄小、实际无法覆盖调用的 `Bash(cat:*)`。仅批准“本次”仍不存规则；自定义前缀若不能覆盖当前调用会被拒绝。

旧 `bash` / `Bash(*)` 全工具 allow 在新版本中兑现全工具语义；旧前缀授权不会自动升级。若已有细粒度限制，系统不会用宽泛授权掩盖解析不确定性。可以在 `/permissions` 查看并撤销或调整规则。

## 授权模型

授权由三部分组成：工具集合、资源范围、有效期。

- 工具集合来自当前运行时 registry 中需要审批的工具（`permission: "confirm"`），用户可多选，读文件组、编辑文件组和全选均展开成具体工具名快照。新注册的 MCP 工具不自动加入旧授权。内部自动执行的控制工具不显示为待授权选项。
- 资源范围可选整个工具，或文件路径 glob / Bash 命令模式。目录范围例如 `src/**`，命令族例如 `git log:*`。混合文件与命令工具不能共用一条资源过滤器。其他工具只能按工具名授权，不能把任意第一个字符串当成资源契约。
- 有效期为当前会话或当前项目；本次调用仍由审批条的“本次”处理，不存规则。
- `delegate_agent` 必须保留 provider/cwd 约束，不能通过批量授权全开。sandbox escape 是独立能力，不包含在普通工具全选中。

产品使用现有 `{ pattern, type }` 作为兼容的执行规则。批量授权在预览后一次写入一组规则，单次原子保存，保存失败不安装任何项目授权。现有仓库、个人、全局规则继续可读。

## 裁决顺序

TUI 与 Headless 使用同一个 App 层 policy evaluator：

1. 取消、plan 模式、显式 disallowed 工具。
2. 所有来源匹配的 deny。
3. 危险执行：TUI 仅本次审批，Headless 拒绝。
4. 所有来源匹配的显式 ask：只能单次审批，不被模式、工具批量允许或 sandbox grant 覆盖。
5. 不透明 Shell 且存在无法验证的同工具 deny/ask：本次审批；adapter 未提供 payload：本次审查。
6. sandbox escape 的独立能力检查。
7. 普通 allow、Headless allowed-tools、项目内读取、sandbox 内自动允许、permission mode 默认行为。
8. 未匹配：TUI 询问；Headless 无审批通道则拒绝。

普通规则统一 `deny > ask > allow`；同类规则的来源顺序仅用于选择解释证据。Shell 的每个直接子命令、未引用换行和 check_steps 的每一步分别判断，任一步 deny 则整体 deny。无法可靠展开的命令替换、子 shell、控制结构、eval/source、heredoc 等不使用前缀 allow 作为覆盖证据，整工具能力可以覆盖；Shell adapter 使用同一检查。命令模式不是任意脚本/程序行为的操作级隔离，文件/网络强制边界仍由 executor/broker/OS 承担。

heredoc 的正文保持不透明，不把正文逐行当命令，也不为 cat、Python、shell 等消费者分别开白名单。此前的 cat 特例已移除。解析器不承诺枚举不透明输入中的所有命令；若设置了命令级限制，无法证明满足时要求本次审批，不能伪造“安全解析”的结论。

文件授权以可信 ApprovalContext 的当前 workspaceRoot 归一化，隔离子 agent 的绝对、相对路径映射到同一项目资源坐标。allow 必须覆盖 canonical 目标；文件修改还必须覆盖真实目录条目（例如被替换/删除的叶节点 symlink）。deny/ask 命中词法路径、真实目标或目录条目任一即生效。项目相对 glob 不能匹配项目外绝对路径；glob 的 regex 元字符按文件名字面量处理。移动文件必须覆盖源与目标的所有实际资源。

目录搜索、glob 和列树在执行前保守检查子树：同工具的 deny/ask 可能覆盖任一后代时，整次扫描拒绝或询问，不能通过从父目录扫描绕过限制。无法证明 glob 与子树无交集时同样保守处理；缩小 glob 不会消除该审批。read_tool_output 保持会话输出能力语义，由所属 session 校验访问，不授予任意宿主文件读取。

Shell 风险识别保留既有的保守正文扫描：即使 heredoc 被命令规则视为不透明输入，正文出现破坏性命令仍可能命中危险提示。危险检查先于普通复杂 Shell 审批，Headless 继续拒绝该风险。

read_file 的 basename/glob 非精确匹配仅返回候选精确路径，不读取正文；模型需要使用精确路径重新调用，让真实目标经过普通授权。

所有 host 审批入口（包括 MCP sampling）共享 FIFO 队列，每项保留独立请求 id、取消信号与入队时的 session。排队取消及时结算，开工时重新裁决，取消或结束只清理自己的审批界面；组件按 id 隔离状态。审批等待期间，实际执行前再次检查取消、session、模式和当前规则；过期或重复回调不能保存授权。自定义授权必须覆盖当前调用，不能批准一组无关工具却顺带放行当前命令。

## 存储与生命周期

- 会话规则只在 PermissionManager 内存中，绑定根 session UUID。`/new`、恢复及 fork 旋转 UUID，清除全部普通规则与 sandbox 会话授权；`/clear` 不更换 session。
- 产品新增项目授权统一写入 `<dataDir>/permissions/projects/<canonical-cwd-sha256>/settings.json`，文件权限 0600。工作目录的真实路径决定身份，其他 clone 不继承。
- 规则每次决策读取当前状态，撤销对后续调用立即生效。已运行进程不因撤销自动终止，停止进程由 task/service 控制完成。
- `/permissions` 按来源展示，允许逐条撤销和清空持久规则。普通规则与 sandbox 能力分开解释，撤销只作用于选中的来源。

## 交互

`/permissions` 按 `a` 新建授权：选择工具 → 资源范围 → 会话/项目 → 逐条预览 → 确认保存。

普通调用审批条保留本次、明确范围的会话允许、项目允许、拒绝；按 `g` 打开同一个自定义授权界面，预填当前工具和匹配模式。危险命令及显式 ask 不提供扩展授权入口。sandbox escape 继续使用独立四项菜单。

界面展示实际模式，避免把 `Bash(git log:*)` 描述成“整个 Bash 已允许”。批量工具组是 UI 便利入口，不是隐含的永久工具通配符。

## 子 agent 与执行边界

同一根 session 内的 SDK 子 agent 通过现有 onApproval 回调复用授权，范围按父 PermissionManager 的项目坐标判断。隔离工作区不会获得新的宿主路径权限；只读/isolated-write 和 VM/resident 的禁止由现有 executor/broker 继续执行。外部 CLI delegate 不复制这些规则，仅对带 provider/cwd 的启动调用应用规则。

App 层授权不改变 SDK/VM 的执行策略，不注入 VM 提示词，不将普通工具允许转换为 sandbox 退出权限。

## 验收

- 跨 session/local/project/global 来源的 deny/ask/allow 矩阵；复合命令、结构化步骤、源/目标路径。
- 批量规则原子保存、会话清除、项目隔离、撤销、来源精确删除、旧设置兼容。
- TUI/Headless 对同一规则采用相同裁决；无交互通道不会自动批准 ask。
- 自定义审批覆盖校验、取消、模式切换、过期与重复回调。
- 真实终端验证多选、范围预览、会话/项目保存、重启复用与撤销，源码与编译版均验证。


## 实现与验证入口

- SDK 事实解析：`zapsdk/tools/approval.ts`；executor 传播：`zapsdk/tools/executor.ts`。能力来自 effect 快照与可信 adapter，SDK/VM policy、broker 和 OS 的强制边界仍独立生效。
- Host 裁决：`src/permission-policy.ts`；规则匹配与覆盖证明：`src/permissions.ts`；旧调用兼容：`src/approval-facts.ts`。
- `tests/permissions.capabilities.test.ts` 通过真实 executor 的 authorize 路径验证工具重命名、自定义参数、模型伪造字段、effects 单次求值、plan/acceptEdits、退出 sandbox、缺失 adapter、持久撤销。不会执行危险测试命令。
- `tests/permissions.literal-heredoc.test.ts` / `tests/permissions.shell-review.test.ts` 验证多种消费者和语法的统一范围矩阵、窄规则限制、Headless 一致性。保留既有路径/子 agent/FIFO 回归。
- `tests/ui/heredoc-approval.pty.test.ts` 在真实 App 中批准一次 heredoc，再运行另一种循环写文件，验证会话复用和重启后的项目复用。`docs/recordings/heredoc-authorization.cast` 记录真实终端的明确整工具提示。
- 验收命令：隔离 `ZAPCODE_DATA_DIR` 下运行 `bun run typecheck`、`bun test --timeout 60000`、`bun run build`；启用 `RUN_TUI_PTY_TESTS=1` 并指定 `ZAP_TEST_COMPILED_BINARY` 验证编译产物。

## 明确边界

命令前缀匹配与危险识别仍是兼容规则和风险启发，不是对任意脚本的完整静态证明。旧危险识别仍可能对文档中的破坏性示例产生保守提示，本次没有通过删除危险检查换取静默执行。真实文件/网络隔离只由 broker/OS 提供；批准整个 Bash 意味着允许其执行程序，不意味着这些程序的所有行为可被前缀过滤器识别。剩余误报应在独立的风险证据契约中处理，不能继续增加消费者豁免。

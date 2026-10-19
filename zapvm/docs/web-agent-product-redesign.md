# zapVM Web Agent 产品重设计

## 1. 结论

当前 Web 已具备登录、Computer 目录、Session continuation、实时事件、Workspace、Artifact 和 Git delivery 的技术闭环，但页面把这些后端对象原样暴露给用户，形成了一个三栏运维控制台。下一版应把产品重心改为“交给 Agent 一个目标，并持续看到进展和结果”的 Chat 工作台：Conversation 是主对象，Computer、Project、Credential、cursor 和 Task ID 都退到设置或诊断层。

目标不是重做一个通用 IDE，而是交付一个可以理解、可以信任、可以恢复、可以拿走成果的远端 Agent 产品。

## 2. 当前问题

### 2.1 心智模型错误

- 首屏要求用户理解 `Project access token`，登录后继续暴露 Project、Computer、Session、Task、Credential ID 和 Provider URL。
- Session 使用 UUID 作为标题，用户无法根据任务内容寻找历史会话。
- `运行 Agent` 更像执行批处理任务，没有形成“发消息—观察—继续”的对话预期。
- `idle`、`leased`、`cursor`、`stream-json` 等实现概念出现在用户可见层。

### 2.2 信息架构失焦

- Conversation、事件日志、文件树、Artifact、Git delivery 和运行设置长期同屏，主任务没有视觉焦点。
- 文件面板无论是否有结果都占据固定宽度，挤压 Chat；在窄视口出现裁切和纵向堆叠过长。
- 每个底层事件都渲染为同等权重的卡片，用户难以判断 Agent 正在做什么、是否需要介入、最终交付了什么。

### 2.3 配置暴露过度

- Provider URL、模型名和 Credential ID 应属于管理员配置的 Runtime Profile，不应要求普通用户每次创建 Conversation 时填写。
- Computer ID 应映射为可读的运行环境名称，例如“我的 Mac · 在线”或“Linux 构建机”，只在切换环境时出现。
- 登录 Token 是当前 Beta bootstrap 手段，不应成为最终产品登录语言；正式形态应使用邀请链接、SSO 或 Magic Link。

### 2.4 状态反馈不完整

- “正在运行”没有分解为排队、准备环境、分析、执行工具、验证、整理结果。
- 错误直接来自基础设施或 API 分类，没有面向用户的恢复动作。
- 最终回答、代码变更、产物、预览和 PR 分散在不同区域，没有统一的 Outcome。

## 3. 新产品模型

用户只需要理解四个概念：

```text
Workspace  工作空间和权限范围
Conversation  与 Agent 的持续对话
Environment  Agent 使用的远端执行环境
Outcome  代码变更、文件、预览、下载或 PR
```

系统内部对象保持不变，但 UI 采用以下映射：

| 系统对象 | 用户名称 | 默认可见性 |
| --- | --- | --- |
| Project provision | Workspace | 顶栏，只有多 Workspace 时可切换 |
| Computer | Environment | Composer 上方状态；只有多个可用环境时可切换 |
| Agent Session | Conversation | 左侧历史列表 |
| Task / turn | 一条用户消息及其 Agent 响应 | Chat 主区 |
| Task Event | Activity | 折叠展示关键步骤，详细日志按需展开 |
| Credential ID | Runtime Profile 内的 Credential | 普通用户不可见 |
| Artifact / Git delivery | Outcome | 回答底部统一结果区 |

## 4. 页面结构

### 4.1 应用外壳

- 顶栏：zapVM、Workspace 名称、Environment 在线状态、帮助和用户菜单。
- 左栏：新建对话、最近 Conversation；标题由首条目标自动生成，副标题显示相对时间和状态。
- 主区：标准 Chat 时间线，用户消息、Agent 说明、Activity 和 Outcome 在同一叙事流中。
- 右侧：默认关闭的“本次结果”抽屉；仅当出现代码变更、Artifact、预览或 PR 时显示入口和未读标识。

### 4.2 Conversation 空状态

- 主标题：“今天想让 Agent 完成什么？”
- 三个能力提示：修复代码、搭建环境、生成并交付成果。
- Composer 默认聚焦；Environment 只显示一行可读状态。
- 不展示模型和 Credential 输入框。

### 4.3 运行中的回答

一次 turn 按以下顺序呈现：

1. 用户目标。
2. Agent 简短确认和当前计划。
3. 单个 Activity 容器，显示当前阶段和已完成步骤数量。
4. 只有需要用户选择、授权或补充信息时才中断对话。
5. 完成后输出自然语言总结和 Outcome。

Activity 默认只显示可读步骤：

- 正在准备远端环境
- 正在检查项目
- 已安装 4 个依赖
- 已修改 3 个文件
- 正在运行测试
- 18 项检查通过

点击“查看详细活动”后才显示命令、stdout/stderr、Task ID、request ID 和重试信息。

### 4.4 Outcome

每个成功 turn 最多显示一个结果容器，内部按实际存在的内容排列：

- 变更：文件数量、diff 摘要、打开变更。
- 验证：测试数量和最终状态。
- 产物：下载文件、大小、过期时间。
- 预览：安全的 HTTPS 预览入口。
- 交付：创建 PR 或打开已有 PR。

没有结果的类别不渲染，不创建空面板。

## 5. 设置分层

### 普通用户

- Environment 选择。
- 是否允许网络、是否允许创建 PR 等任务级意图。
- Conversation 的重命名、归档和删除。

### Workspace 管理员

- Runtime Profile：Provider、模型、最大轮次、超时、网络策略。
- Credential：创建、轮换和撤销，只显示 ID、版本和状态。
- Environment：Node/Computer 绑定和健康状态。
- Git Provider 和仓库范围。

### 诊断模式

- Task/Event 原始时间线。
- Node、daemon、镜像版本和 request ID。
- 重试、取消和导出诊断包。

普通 Chat 页面不出现管理员与诊断字段。

## 6. 状态语言

| 内部状态 | 用户文案 | 主要动作 |
| --- | --- | --- |
| pending / leased | 正在连接运行环境 | 取消 |
| running + preparing | 正在准备环境 | 查看活动、取消 |
| running + tool | 正在执行任务 | 查看活动、停止 |
| needs_input | 需要你的确认 | 回复或选择 |
| succeeded | 已完成 | 继续对话、查看结果 |
| failed + retryable | 暂时未完成 | 自动重试、手动重试 |
| failed + user_action | 需要你处理 | 展示一个明确修复动作 |
| canceled | 已停止 | 重新运行 |

页面不得把 `control_request_failed`、`artifact_collection_failed` 等内部 code 作为主文案；它们只出现在“技术详情”。

## 7. 必要的产品与 API 改造

### P0：让 Chat 可理解

- 前端改为 Conversation-first 双栏布局，结果面板按需出现。
- Session 标题由 Web 生成独立的有界元数据并由 Control 持久化，不从私密 prompt 或 argv 回显。
- Runtime Profile 由 BFF/Control provision 返回；Composer 移除 Provider URL、Model 和 Credential ID。
- Event renderer 把底层事件聚合为 Activity 阶段；原始流进入可折叠详情。
- Outcome 统一聚合 Artifact、Workspace diff 和 Git delivery。
- 修复 320px、768px、1024px 和 1440px 布局，不允许横向裁切。

### P1：达到产品级体验

- 限时签名邀请、可选 OIDC/SSO 和静态密钥应急入口。
- 跨设备持久化 Conversation 标题，以及 iOS Safari / Android Chrome 真机验收。
- 增加 Conversation rename/archive/delete、分页和搜索。
- 增加 `needs_input`/approval 事件，Agent 可在同一对话请求用户确认。
- 支持流式 Markdown、代码块、引用、复制和长输出虚拟化。
- 增加通知、断线恢复提示、自动重试倒计时和明确错误恢复动作。
- Outcome 支持 diff review、Artifact 下载、Preview 和 PR 状态回写。

### P2：多租户商业化

- Workspace 切换、成员角色和邀请生命周期管理。
- 管理员控制台独立路由，不与 Chat 共用页面。
- Runtime Profile、预算、配额、审计和保留策略可配置。
- Environment 池、排队位置、使用量与成本可观测。

## 8. 实施拆分

### 阶段 A：前端重构，不改后端契约

1. 抽离 `ConversationList`、`ChatTimeline`、`ActivityGroup`、`Composer`、`OutcomeDrawer` 的状态模型。
2. 在现有 API 上完成事件聚合、可读状态和响应式布局。
3. localStorage 只保存恢复所需的非敏感 ID；标题以 Control 的 Session 元数据为准。
4. 保留现有 Workspace、Artifact、Git delivery 能力，但移动到按需结果抽屉。

### 阶段 B：补齐产品契约

1. Control 增加 Conversation metadata 与 rename/archive API。
2. Project provision 增加默认 Runtime Profile，Web 只提交 profile ID。
3. Agent Session 增加 `needs_input`、approval 和结构化 progress/outcome 事件。
4. 增加 Conversation 分页、搜索和 retention UI。

### 阶段 C：正式身份与管理面

1. OIDC/邀请登录替换静态 access token。
2. Workspace 成员、角色、Credential 和 Environment 管理页。
3. 配额、账单、审计和数据保留配置。

## 9. P0 验收标准

- 新用户在不理解 Project、Computer、Session、Credential 的情况下，可以在 60 秒内提交第一个目标。
- 默认首屏只有 Conversation、Chat 和 Composer；模型配置与原始事件不可见。
- 运行中用户能回答三个问题：Agent 在做什么、是否需要我、完成后得到什么。
- 成功 turn 在同一回答中展示总结、验证和 Outcome。
- 断网刷新后按 cursor 恢复，不重复消息、不丢最终结果。
- 320px 到 1440px 无横向裁切；移动端结果区使用抽屉，不在 Chat 下方堆叠完整文件管理器。
- 键盘可完成新建对话、输入、发送、停止、展开活动和打开结果。
- 安全边界保持不变：浏览器不持有模型 API Key、mTLS 私钥或 tenant/project 覆盖能力。

## 10. 非目标

- P0 不实现完整浏览器 IDE、终端模拟器或多人实时协作。
- P0 不把所有 Node/VM 运维指标放进 Chat。
- P0 不允许用户通过 Web 提交任意 Guest argv。
- P0 不改变现有 mTLS、Credential Broker、签名镜像和 restricted egress 边界。

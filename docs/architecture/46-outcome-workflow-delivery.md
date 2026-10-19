# 46. Outcome 与工作流接线交付记录

日期：2026-10-13。本文定义本次可交付范围，完整目标架构仍见第 41 篇。

## 1. 交付范围

本次交付解决 Agent 结束被宿主验收反向阻塞的问题，并提供显式宿主验收和工作流控制 API。普通 CLI/TUI/ACP 继续 observe：执行正常结束不等于验收通过，缺少宿主验收不触发模型续跑。M1 outcome/state/events/兼容协议、M2 固定版本验收、M3a 控制、M3b 动作执行与恢复的契约分别见第 42–45 篇。

本批补齐：持久化 inline 报告导入、外部验收投递恢复、HostProtocol v2 控制接线、独立 CLI 控制命令。原入口自动修复仍关闭，不接受 repair 配置。后续新增的根 Agent 显式修复入口、进程内累计预算和公开反馈边界见[第 47 篇](47-bounded-public-repair.md)，不代表 deferred 工作流自动恢复已实现。

## 2. Inline 报告进入工作流

`DeferredAcceptanceCoordinator.registerInline({ workflowId, deadlineAt, recordId, store, blockers?, allowLimitedDelivery? })` 从可信 `InlineAcceptanceStore` 加载已持久化报告，校验报告身份、规范摘要及全部快照回执，复制原始 outcome/spec/snapshot/report 后原子建立 workflow revision 1。

inline-only 宿主可以用空外部 owner 列表构建 coordinator。内部 owner 标识 `host:inline` 保留，不可注册为外部签名 owner。导入不会调用模型或 verifier，不生成动作授权，也不覆盖原 M2 报告；只有宿主权限系统之后建立 grant 才能执行动作。

没有记录、损坏记录、重复 workflow ID 或过期 deadline 均拒绝。宿主从未持久化的内存 JSON 不能通过这个接口直接声称通过。可信 store 本身仍须由宿主提供，不能由远程调用者或模型指定。

## 3. 外部验收投递恢复

当前工作流的持久化 pending 记录就是投递意图，不依赖进程内队列；`InMemoryWorkflowControlStore.list(afterId?, limit?)` 和 SQLite 同名方法按 workflow ID 分页查询最新记录，limit 为 1–1000。内存实现不承诺重启恢复。

宿主选择 `acceptance.status === pending`、未取消、未过 deadline、没有 `delivery.receiptId` 的记录，通过 `WorkflowDeliveryRunner.deliver()` 投递。开始投递前以 CAS 增加 `delivery.attempts`；`beginDelivery` 在存储事务内再次检查取消与 deadline。投递请求包含 request/owner/attempt/spec/snapshot 身份和原 deadline，不包含密钥或模型对话。

adapter 的 `publish(request, signal)` 必须按 requestId 持久去重，并对重复请求返回相同 receiptId。投递成功后 ACK 与控制状态通过 CAS 合并；验收回调可以先于 ACK 到达，不会被 ACK 覆盖。旧 attempt 的 ACK 不能写入新 attempt。

外部已入队、ACK 丢失、超时或进程崩溃时，同一 request ID 可再次投递；这提供 at-least-once，不宣称本地数据库与外部队列的分布式 exactly-once。并发宿主也可能重复 publish，外部去重是必要契约。整个恢复过程不重新调用 Agent。没有扫描 daemon 或默认外部队列，宿主显式决定扫描周期和目标适配器。

单次 publish 受显式 timeoutMs 和 workflow deadline 共同约束，取消、旧 request 或控制不可读会停止等待并发送 signal；迟到 ACK 不会自动发布。投递失败保留 pending 记录及原 request ID。已经 ACK 的请求由 owner 完成验收，宿主不因 pending 尚未结束而重复入队。

## 4. HostProtocol v2

宿主构造 `new HostProtocolService(resolver, new HostWorkflowController(coordinator, options))` 显式安装能力；未配置 controller 或协议 v1 返回 `UNSUPPORTED_CAPABILITY`。这些操作不要求加载模型 Runtime，适合进程重启后的工作流协调。请求 threadId 必须匹配 workflow 内原 outcome 的 threadId。

| 方法 | 参数 | 行为 |
| --- | --- | --- |
| workflow.read | workflowId | 返回最新 record 与 decision |
| workflow.wait | workflowId, timeoutMs? | 独立等待，不启动模型或 verifier |
| workflow.cancel | workflowId, revision | 持久化取消，拒绝旧 revision |
| workflow.dispatch | workflowId, revision, actionId, timeoutMs? | 经宿主授权回调取得 grant，重新检查版本后领取并执行 |
| workflow.reconcile | workflowId, timeoutMs? | 对已领取 operation 做只读查询 |

options.actions 为显式注册的 `WorkflowActionRunner`，options.authorize 必须接入原有宿主权限系统，返回当前合法的 `{ actionId, grantId }`。请求中的 grantId 不被接受。授权异步等待期间若发生取消或版本改变，旧请求不能执行。API 只安装读写控制能力，未自动安装生产动作适配器；没有 authorize 时不能远程 dispatch。

这些 RPC 复用 AppServer 的 bearer 验证，服务 token/访问控制仍由宿主负责；SDK 没有把 owner HMAC 验收回调直接暴露为不鉴权 HTTP endpoint。当前没有 workflow SSE 增量订阅，调用者通过 read/wait 与 revision 协调。

## 5. CLI 控制命令

```sh
zap workflow list --db /absolute/path/workflow.sqlite --limit 100
zap workflow read --db /absolute/path/workflow.sqlite --id workflow-id
zap workflow wait --db /absolute/path/workflow.sqlite --id workflow-id --timeout-ms 30000
zap workflow cancel --db /absolute/path/workflow.sqlite --id workflow-id --revision 3
```

数据库必须已存在；不会因拼错路径新建一个空数据库。list 支持 `--after` ID 分页；cancel 必须提供确切 revision。参数不接受重复或未知字段。命令在 piped-stdin/headless/provider 初始化之前分流，不读取 stdin，不加载个人模型配置，不调用模型，也没有从任意路径加载可执行 adapter 的功能。

输出为独立 `zap.workflow-control` / `zap.workflow-list` / `zap.workflow-error` schema 1 JSON，不冒充原 Agent outcome。

read/list/cancel 成功退出 0；wait 在验收通过且执行具备交付条件时退出 0，明确验收失败为 5，验收错误为 6，未验证或仍有必要阻碍为 7，等待/工作流截止为 124，取消为 130；参数或控制读取失败为 2。passed 不覆盖执行取消、未解决动作或 blockers。CLI 不提供隐式授权、dispatch 或自动修复开关。

## 6. 验证与交付边界

新增集成测试覆盖 M2 报告导入、损坏报告拒绝、持久 pending 枚举、丢失 ACK 后同 request 重投、取消/存储失败零投递、迟到 ACK 丢弃、旧 attempt ACK 拒绝、回调先于 ACK、协议线程隔离、伪造 grant 拒绝、异步授权取消竞态、CLI 真实子进程路由及退出码。

2026-10-13 本机验证：新增 13 项接线测试通过；隔离 `ZAPCODE_DATA_DIR` 下全量 **3340 通过、8 跳过、0 失败**（3348 项，275 文件，69.68 秒）；类型检查、原生构建通过；固定 Harbor 0.24.0 的适配器测试 **9/9 通过**。系统 Python 缺少 Harbor，已改用仓库契约规定的隔离 uv 环境重跑，未将依赖缺失当作模型失败。M1 五题 Terminal-Bench 历史结果为执行链路 5/5 正常返回、官方 reward 3/5，并非本批新增宿主接口的真实模型评测。禁止用单测通过推断模型任务正确率提升。

2026-10-13 最新 Linux x64 baseline 二进制复测 `break-filter-js-from-html`：Agent 正常返回（execution finished、acceptance unverified、退出码 0），官方 verifier reward **1.0**，无 adapter/环境异常。耗时约 1 分 50 秒，6 个模型回合。这是一题运行链路 smoke，不替代五题完整评测，也不推断整体准确率提升。

远端 CI 暴露 Alpine 镜像仓库已移除 `linux-virt=6.18.55-r0`。仅将两架构的 kernel pin 更新为 `6.18.56-r0`，同步 Base revision r7；在固定 Alpine 镜像上实际安装 arm64/amd64 全部锁定依赖后重算输入锁与 installed 数据库摘要，包数保持 140/141。没有解除精确版本锁或关闭包签名校验。

完整目标架构尚有未交付项：deferred/CAS 工作流自动修复及累计预算恢复、执行前总预算持久化、模型前 deferred 一体化预检、workflow 增量订阅，以及按具体宿主实现的生产部署/合并适配器。当前 `runWithOutcome()` 仍拒绝直接传 required/deferred/repair；新能力均通过本系列文档中的显式宿主 API 调用。不能将本次交付描述为第 41 篇所有目标均完成。

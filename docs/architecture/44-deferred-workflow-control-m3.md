# 44. M3a 延后验收与持久化工作流控制

状态：SDK 控制层已实现；M3 尚未全部完成。日期：2026-10-12。

2026-10-13 接线更新：已补齐 inline 报告导入、持久投递恢复及 CLI/HostProtocol 控制，见 [46. 接线交付记录](46-outcome-workflow-delivery.md)。本篇其余内容保留所属阶段的历史边界。

后续进展：动作执行、取消传播、回执保存与崩溃查询框架已在 [45. M3b 动作执行与崩溃对账](45-workflow-action-execution-m3.md) 实现；下文保留 M3a 原始边界，完整剩余事项见第 45 篇。

## 1. 本批范围

M1 的 Agent 终态与 M2 的 inline 报告不变。本批新增独立 `zap.workflow` schema 1，用于宿主已经拿到执行终态之后的延后验收、回调认证、取消、版本替换、独立等待以及动作领取。

公共入口为 `DeferredAcceptanceCoordinator`、`InMemoryWorkflowControlStore`、`SqliteWorkflowControlStore`、`signDeferredAcceptanceResult`、`decideWorkflow` 及相关类型。`WorkflowControlDecision` 与 M1 outcome 内的 `WorkflowDecision` 是不同协议，不能直接替换。

本批不是 `runWithOutcome({ acceptance: required })` 的开放：该旧保留配置仍提前拒绝。CLI/TUI/ACP/Terminal-Bench 默认 observe，不等待工作流，不新增提示词、隐藏测试反馈、完成 guard 或模型续跑。Coordinator 自身不调用模型、verifier、外部队列或部署服务。

## 2. 注册与外部所有者

宿主先初始化控制存储和外部 owner 的密钥，按自身运行预算取得 M1 outcome，并通过可信 snapshot provider 固定验收版本，再调用 `register()`。注册原子保存以下字段：

- workflow ID、随机 request ID、owner ID；原始 outcome、完整 spec 与 specDigest、不可变 snapshot 元数据。
- 从 revision 1 开始的控制版本、创建/更新时间和共享绝对 deadline。
- 持久化取消标记、当前 blockers、`allowLimitedDelivery`，默认没有动作授权。
- acceptance 为 pending；无法提供稳定快照则 unverified；存在/删除要求不符则 failed。

注册需先成功，宿主才可把 pending 请求交给外部 owner。记录存在时不能重复 register 覆盖；重启读取既有 request ID。发布队列必须以 request ID 去重；本批没有事务性队列 outbox，不能宣称注册与外部投递 exactly-once。注册后、投递前崩溃时，宿主可读取同一记录并协调重新投递，不能重新跑 Agent 来重建请求。

snapshot 元数据是可信宿主提供的稳定性证明，签名并不能把可变目录变成稳定快照。外部 owner 必须能解析相同 provider/version 并保留该版本直到协调结束；丢失版本应回报 error。不可将模型生成的 JSON 或任意 HTTP 请求直接传给 register。Git provider 的 `readFile` 函数不进入记录；外部环境自行按完整 commit/blob ID 读取对象。

这是执行后 API，不提供模型前一体化预检，也不自动限制之前 Agent 的执行预算。宿主需在运行前校验 owner/provider/存储和总预算；注册 deadline 必须覆盖该宿主预先确定的剩余总预算，不能在每次修复后重置。本批只强制注册之后的截止时间与替换继承，不声称已经实现跨模型、工具、验收的总预算控制器。

## 3. 回调协议

可信外部 owner 使用至少 32 字节密钥及 `signDeferredAcceptanceResult()` 签名，宿主调用 `accept(payload, signature)`。密钥仅在进程配置中保存，不写 SQLite、不进入 Agent prompt。外部传输/密钥发放由宿主负责，本批不提供 HTTP endpoint。

签名算法为 HMAC-SHA256，域分隔符 `zap.deferred-acceptance.v1\n`，载荷为按对象键排序的确定性 JSON，数组顺序保留。签名十六进制输出，用恒定时间比较验证。一个 owner 是该请求所有 verifier 的可信结果汇总者，不代表逐 verifier 的独立密码学签名。

载荷绑定 `workflowId / requestId / ownerId / attemptId / specDigest / snapshotId`。结果有两种：

- `completed`：包含规范要求的全部 checks；每项仍遵守 M2 的 check ID、规范版本、快照、依赖对象版本、status/code/evidenceRefs 校验。聚合顺序为 error、failed、passed。
- `error`：外部基础设施或验收器没有形成完整判定，记录具体 code 和空 checks；不伪造任务失败。

缺失、重复或旧版本回执拒绝，不改变记录。最终结果为一次性封存，规范化载荷摘要相同的重试幂等；不同终态回调返回 `ACCEPTANCE_CONFLICT`。旧 request/attempt/spec/snapshot 返回 `STALE_ACCEPTANCE_RESULT`。回调与取消等并发写入冲突时返回 `WORKFLOW_CONFLICT`；发送者可以重发同一签名载荷，重新读取后的身份、deadline 和终态检查仍生效。

本批不做每项检查的增量回调；全部 checks 一次发布，记录 revision 单调递增。迟到且仍在 deadline 内的有效报告可记录在已取消工作流中，但取消标记不被清除，不能恢复 ready。已超时或旧 attempt 的结果直接拒绝，尚不另建过期回调审计表。

## 4. 控制与放行

`read()` 返回最新记录及纯计算 decision。`decideWorkflow()` 不能执行动作，ready 只是候选。下列操作均要求调用者提供当前 expected revision：

| 操作 | 实际行为 |
| --- | --- |
| `authorizeAction()` | 设置或撤销 `{ actionId, grantId }`；必须由宿主权限适配器确认原始用户授权；验收回调不会生成授权 |
| `setBlockers()` | 更新当前必要阻碍，使旧候选失效 |
| `cancel()` | 永久设置取消；新回调不能恢复；重新执行需显式创建新的 workflow |
| `replaceAttempt()` | 同 thread/turn 的新 attempt，生成新 request ID，继承原 deadline，清除旧授权与验收；拒绝同 attempt、取消后替换及领取动作后替换 |
| `expire()` | deadline 到达且仍 pending 时，持久化 `error / ACCEPTANCE_TIMEOUT` |
| `claimAction()` | 复核 ready、授权身份、所有版本和 deadline，以一次 CAS 保存永久 operation ID 与固定交付版本 |

finished 或宿主显式允许的 limited，必须同时满足没有执行错误、未解决动作、pending 后台工具、blockers，以及当前验收 passed，才可能 ready。无动作授权显示 not_requested；取消始终阻止领取；deadline 超过后即使曾经 passed 也不能领取。`allowLimitedDelivery` 仅能作为注册/新 attempt 的显式策略提供。

授权撤销必须通过同一个控制层（或宿主具有更强事务语义的权限适配器）完成，才能参与本次 CAS。`grantId` 不是 SDK 自发授予的权限，也不替代已有权限系统。调用者不能把用户文本中的任意 grant 字符串直接当授权。

## 5. 动作与崩溃边界

`claimAction()` 是逻辑动作开始的线性化点。SQLite 事务内再次检查最新版本和真实当前时间，因此锁等待不能把已超时的旧候选放行。取消先提交时，旧候选不能领取；领取先提交时，后续取消保留 claim，宿主执行器须另行停止可取消的动作。

只成功返回 claim 的领取者才有资格调用执行器，而且必须使用 claim 指定的不可变 snapshot 和 operation ID；不能交付随时可变的当前工作区。重复领取（包括同一个旧候选）拒绝。读取到已有 claim 并不授权重放。

本批不内置执行器、执行器 AbortSignal、完成回报或外部副作用的 exactly-once 机制。领取提交后、实际副作用前或后都可能崩溃；恢复时一律保留 claim，动作结果为需协调，不能推测成功，也不自动重试。后续适配器必须以 operation ID 查询目标系统，按其幂等协议协调。取消在逻辑开始之后不能承诺撤销已经发生的副作用。

## 6. 存储与等待

SQLite 是权威存储，不是可重建索引。使用 `journal_mode=DELETE`、`synchronous=FULL`、5 秒 busy timeout；`BEGIN IMMEDIATE` 串行化跨进程写入，在同一事务中加载当前 revision、检查状态转换、插入下一版。每个 revision 是不可变行，取消、回执和 claim 同库提交。文件权限 0600，新建父目录 0700。支持本地 SQLite 文件，不声明网络共享文件系统的并发保证。

读取校验完整记录、outcome、spec 摘要、快照、回执和 claim 身份；损坏记录报错，不能恢复为 passed。取消不可逆、已封存验收不可覆盖、已领取 operation 不可删除或替换，存储层也校验这些规则。内存实现仅用于测试/无恢复场景。

`wait(workflowId, { timeoutMs, pollMs, signal })` 独立等待验收完成、持久化取消或 workflow deadline，不阻塞 Agent 返回或外部 verifier 启动。wait 的 AbortSignal 只结束本次观察，持久取消需调用 cancel。等待自身超时抛 `WORKFLOW_WAIT_TIMEOUT`；workflow deadline 到达时返回当前记录及 blocked decision，是否保存验收超时由 expire 明确完成。

## 7. 最小宿主接线

以下是调用顺序示意。`outcome` 来自已返回的 `runWithOutcome()`；`spec` 和 `snapshotMetadata` 由可信宿主建立，snapshot 不含函数；密钥从宿主秘密配置读取。数据库须位于仓库之外。

```ts
import { DeferredAcceptanceCoordinator, SqliteWorkflowControlStore } from "zapagent";

const store = new SqliteWorkflowControlStore(workflowDatabasePath);
const coordinator = new DeferredAcceptanceCoordinator(store, [
  { id: "official-runner", signingKey: ownerSecretBytes },
]);
const pending = coordinator.register({
  workflowId, ownerId: "official-runner", outcome, spec,
  snapshot: snapshotMetadata, deadlineAt: workflowDeadlineAt,
});
// Only pending records can be sent to the external owner. The host queue deduplicates requestId.
// Agent execution has already returned; this does not wait for external acceptance.

// On an authenticated external result:
const updated = coordinator.accept(callbackPayload, callbackSignature);
// Separately, after the host permission adapter has resolved a current user grant:
const authorized = coordinator.authorizeAction(updated.id, updated.revision, currentGrant);
const candidate = coordinator.read(authorized.id).decision;
if (candidate.status === "ready") {
  const claimed = coordinator.claimAction(candidate, currentGrant);
  // An adapter may now consume claimed.action using that immutable snapshot and operationId.
  // Do not automatically replay this operation on process restart.
}
store.close();
```

## 8. 剩余实施项与验收边界

M3 后续仍需：自动修复的显式策略/反馈过滤/模型工具累计预算；持久化的执行前总预算与取消接线；external owner 投递 outbox；CLI/HostProtocol 配置及订阅；M2 inline 报告接入同一控制层；动作执行器、取消传播、operation ID 对账与结果持久化。本批 `replaceAttempt` 只是控制状态替换，绝不是自动修复实现。

针对性测试覆盖 Runtime 先返回且唯一终态、身份签名与密钥固定、检查及依赖版本、精确重试、迟到结果与取消、limited/阻碍、授权撤销、attempt 替换、deadline、独立 wait、持久化失败、损坏数据拒绝、SQLite 重开，以及两个真实 Bun 进程的取消/领取竞争。2026-10-12 macOS 验证：新增 25 项 M3a 测试通过；隔离 `ZAPCODE_DATA_DIR` 的全量 Bun 测试 **3309 通过、8 跳过、0 失败**（3317 项、273 文件，63.33 秒）。`bun run typecheck`、`bun run build`、SDK 根入口导出检查、`git diff --check` 均通过。没有运行真实模型、外部部署或 Windows/Linux 实机验收。

日志与当前未提交源码、构建哈希保存在仓库外 `zap-benchmark-results/agent-outcome-m3a-20261012-evidence/`。当前跨进程证据证明本机 SQLite 的控制竞争与恢复，不证明外部副作用 exactly-once。

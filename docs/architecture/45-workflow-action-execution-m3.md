# 45. M3b 动作执行与崩溃对账

状态：SDK 执行框架已实现；M3 尚未全部完成。日期：2026-10-12。

2026-10-13 接线更新：已补齐 inline 报告导入、持久投递恢复及 CLI/HostProtocol 控制，见 [46. 接线交付记录](46-outcome-workflow-delivery.md)。本篇其余内容保留所属阶段的历史边界。

## 1. 范围

M3a 提供版本化控制及原子领取。本批增加 `WorkflowActionRunner`，把已授权 ready 候选接到可信宿主 adapter，完成「领取 → 执行 → 保存结果」，并为崩溃、取消或超时留下只读对账路径。普通 Agent 的执行结果、提示词、默认 observe 以及 CLI/ACP 退出方式不变。

入口从 SDK 根及 `zapsdk/runtime/index.ts` 导出：

- `WorkflowActionRunner.dispatch(candidate, authorization, { timeoutMs, signal? })`：先解析适配器、检查配置和 signal，再调用 M3a claim，成功保存 claim 后最多调用一次 execute。
- `WorkflowActionRunner.reconcile(workflowId, { timeoutMs, signal? })`：只查询已经领取的 operation；不调用 execute。
- `DeferredAcceptanceCoordinator.recordActionResult()`：保存可信执行器/查询器的回执，使用 expected revision，保留同期取消与控制更新。
- `WorkflowActionAdapter`、`WorkflowActionContext`、`WorkflowActionReceipt`、`WorkflowActionResult`：宿主接线协议。

本批提供可运行的调度框架，尚未内置 Git merge、部署、邮件等具体生产适配器。SDK 不从模型输出加载 adapter，也不因验收 passed 自动调用 dispatch。原有权限适配器仍须验证当前用户授权并建立 grant；第三方 API 权限不由本框架授予。

## 2. 适配器契约

每个 adapter 具有唯一且版本化的 `actionId`，与已授权的 actionId 一致，并同时实现两个方法：

```ts
interface WorkflowActionAdapter {
  actionId: string;
  execute(context: WorkflowActionContext): Promise<WorkflowActionReceipt>;
  reconcile(context: WorkflowActionContext): Promise<WorkflowActionReceipt>;
}
```

构造 runner 时固定 adapter 方法引用；修改行为须使用新的 actionId，重启宿主也须维持该版本对应的语义。缺少 adapter 或 reconcile 能力、重复 ID、无效预算会在领取前拒绝。

context 包含 workflowId、不可变 claim/spec/snapshot 的深冻结副本、signal 和 deadlineAt。claim 包含 operationId、grantId、request/attempt/spec/snapshot 身份。execute 只能消费该不可变 snapshot，operationId 应用作目标服务的幂等标识；不能读取当前工作区后冒充已验收版本。

reconcile 是按 operationId 查询外部状态的只读方法，不能在找不到记录时调用 execute、重试发布或创建新操作。目标服务未发现该 ID、仍在处理或无法确认是否提交时，应返回 unknown。仅当外部系统提供可靠终态时，才能回报 succeeded/failed。

适配器是可信宿主代码，需遵守原有权限与运行隔离；这些只读/版本消费要求不是针对任意恶意 JS 的强制沙箱。框架不提供绕过审批或工具 Broker 的执行能力。

## 3. 动作结果与版本

`zap.workflow` schema 1 新增可选 `actionResult`，不改变旧字段语义；旧 M3a 记录仍可读取。原 action claim 保持永久不可变，decision 对已领取动作仍为 claimed（取消优先返回 blocked）；消费者通过 actionResult 判断外部结果。

回执必须匹配当前 claim 的 operationId 和 snapshotId，包含 status、非空 code 和 evidenceRefs。发布时仅复制这些协议字段，并由宿主添加 observedAt 与 source，adapter 不能覆盖发布时间或来源。

| status | 含义 |
| --- | --- |
| succeeded | 目标系统明确完成了该 operation |
| failed | 目标系统明确终止该 operation，并给出了失败回执 |
| unknown | 可能已发生副作用，当前证据不足；需查询协调 |

source 为 execute 或 reconcile。无 actionResult 也视为需要协调，不能视为失败或未执行。unknown 可由后续查询更新；succeeded/failed 封存后不能删除或改写。相同协议回执重复保存幂等。并发查询产生 unknown 时，不能覆盖已保存的确定结果；两个互相矛盾的确定结果返回 `ACTION_RESULT_CONFLICT`。

所有结果仍用同一控制存储 CAS 插入新 revision。遇到并发取消/控制写入时，runner 最多重读并重试 8 次，绝不回滚取消。结果存储失败抛 `ACTION_RESULT_PERSISTENCE_FAILED`，已领取 operation 保留，调用者必须查询对账，不能重跑 dispatch。原 Agent outcome 和验收报告始终保留。

## 4. 取消、预算与迟到值

execute 的 deadline 是 `min(workflow.deadlineAt, 调用时间 + timeoutMs)`。query 使用单独、显式的正整数 timeoutMs，因此允许在原工作流截止或取消后查明外部结果；这不延长执行预算。

dispatch 在调用适配器前、收到回执后以及执行期间（默认每 50 毫秒，可配置 1–60000 毫秒）读取控制状态。持久化取消、新增 blocker、控制读取失败或 deadline 到达会中止 adapter signal，结果记录 unknown。控制读取可能等待 SQLite 锁，读取后再次检查 deadline，避免锁等待后启动过期工作。

调用者 signal 在领取前中止会直接拒绝，未产生 claim。execute 期间 signal 中止会先尝试持久化 workflow 取消，再通知 adapter；若控制存储不可用，仍中止 adapter，且不会推断副作用已撤销。其他进程的取消通过读取同一 SQLite 控制记录传播。

Promise deadline 可以停止等待不配合的异步 adapter，随后返回值不会改写已发布结果。无法抢占在同一 JS 线程无限执行的同步代码；需要强制终止时，adapter 应使用受控子进程/容器。中止并不保证外部操作已停止，因此 timeout、abort、异常以及身份错误的回执均保存 unknown，而不是猜测 failed。

收到有效回执并结束 adapter 调用后进入持久化阶段，适配器计时器和 signal 监听被清理；存储等待不占 adapter 预算。同期持久化取消仍会保留，也允许记录真实的外部 succeeded 事实。已发生的副作用不会被取消标记抹除。

reconcile 的 signal 只停止这次查询，不撤销原 workflow；其取消或超时也不能授予重试执行的权限。

## 5. 崩溃与恢复

claim 提交仍是逻辑开始的线性化点，runner 并未承诺本地事务与外部副作用的分布式 exactly-once。

| 崩溃点 | 恢复处理 |
| --- | --- |
| claim 保存之前 | 没有 execute 调用；宿主可以重新读取当前候选 |
| claim 已保存，外部效果之前 | 保留 operation，先 query；不能仅凭缺少结果就重新执行 |
| 外部已提交，回执丢失或尚未保存 | 按同一个 operationId 查询，保存真实结果 |
| 成功/失败结果已保存 | 直接返回记录，不再调用 execute/query |

只允许领取成功的当次调用进入 execute；读取到既有 claim 仅能进入 reconcile。一次 dispatch 不包含任何自动执行重试。有些目标系统无法按 operationId 查询或保证幂等，此时 unknown 可能长期保留，需要宿主人工协调。本批不自动创建新 operation 来绕过未知结果。

## 6. 宿主组合示例

`coordinator` 是 M3a 控制层，`currentGrant` 已通过现有权限系统确认，`target` 是宿主固定的受控服务适配器。以下示意没有配置任何默认自动部署。

```ts
import { WorkflowActionRunner, type WorkflowActionAdapter } from "zapagent";

const adapter: WorkflowActionAdapter = {
  actionId: "publish-artifact-v1",
  async execute({ claim, snapshot, signal, deadlineAt }) {
    // target must consume this immutable version and preserve the operation identity.
    return target.publish({ operationId: claim.operationId, snapshot, signal, deadlineAt });
  },
  async reconcile({ claim, signal, deadlineAt }) {
    // Query only. Not found / still running must be represented as unknown.
    return target.query({ operationId: claim.operationId, signal, deadlineAt });
  },
};
const actions = new WorkflowActionRunner(coordinator, [adapter]);
const candidate = coordinator.read(workflowId).decision;
if (candidate.status === "ready") {
  const record = await actions.dispatch(candidate, currentGrant, { timeoutMs: 30_000, signal });
  // Inspect record.actionResult; unknown requires reconciliation, never another dispatch.
}
// After restart, only for an existing claim with a missing/unknown result:
const recovered = await actions.reconcile(workflowId, { timeoutMs: 10_000 });
```

## 7. 验证与剩余工作

新增测试覆盖持久 claim 先于 execute、固定版本与方法引用、授权失效、确定失败/未知、取消传播、不协作超时、迟到回执忽略、结果 CAS 竞争、落盘失败以及结果封存。

恢复集成测试使用真实临时 SQLite 与目标文件：子进程写入外部结果后被 SIGKILL，尚无 actionResult；宿主重开控制存储，以原 operationId 只读查询并保存 succeeded，全程没有第二次 execute。该证据覆盖本机进程崩溃，不代表真实部署服务、断电场景或 Windows/Linux 实机验收。

2026-10-12 macOS 验证：新增 **18 项** M3b 测试通过；隔离 `ZAPCODE_DATA_DIR` 的全量 Bun 测试 **3327 通过、8 跳过、0 失败**（3335 项、274 文件，64.16 秒）。类型检查、CLI 构建、SDK 根入口导出检查和 `git diff --check` 均通过。日志与当前未提交源码/构建哈希保存在仓库外 `zap-benchmark-results/agent-outcome-m3b-20261012-evidence/`；本轮没有运行真实模型评测或生产外部动作。

M3 仍待实现自动修复策略与累计模型/工具预算、执行前总预算持久化、外部验收投递 outbox、CLI/HostProtocol 接线，以及 M2 inline 报告进入统一控制层。生产动作适配器和各自的外部幂等/对账协议也仍需按具体宿主接入。

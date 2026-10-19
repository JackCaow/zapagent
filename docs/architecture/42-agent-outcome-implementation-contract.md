# 42. Agent Outcome 首批实施契约

状态：M1 主路径已实现；复审发现的终态生命周期缺口已修复并通过追加回归；GPT-2 外层超时仍为独立未解决项。日期：2026-10-11。基线：`dc396839`；工作分支：`codex/agent-outcome-m1`，尚未提交。

本文将 [第 41 篇](41-agent-outcome-and-acceptance.md) 的架构目标收敛为一个可独立交付的版本。第 41 篇描述最终架构；本文规定 M1 必须实现、明确不支持的能力、接口和验收。M1 的实现选择以本文为准，不要求同时完成未来 workflow 引擎。

2026-10-12 更新：后续 M2 SDK inline 验收已通过独立宿主组合 API 实现，见 [第 43 篇](43-inline-acceptance-m2.md)。本篇保留 M1 入口的限制和历史验证记录；`runWithOutcome()` 的 observe-only 行为未改，不能把 M2 新报告覆盖到原执行终态中。

## 1. 交付边界

M1 的目标是：普通 Agent 能正常结束，未验证修改如实报告；外部 runner 可以继续判分；既有消费者有显式兼容路径。

| M1 必须交付 | M1 明确不交付 |
| --- | --- |
| execution / acceptance / workflow 独立结果及稳定映射 | 新式 required 验收器、自动修复循环 |
| CLI、TUI、ACP 采用新执行语义 | SDK 内的 deferred 验收、workflow wait 服务 |
| legacy SDK/协议结果兼容，移除验收驱动 guard | 自动部署/合并放行、跨进程 WorkflowGate 调度 |
| 版本化结果、事件、最小终态持久化和恢复 | 不可变工作区快照引擎、外部资源验收 |
| Terminal-Bench 分类退出并继续官方 verifier | 隐藏测试反馈驱动重试、修改模型提示以适配题目 |

M1 新入口仅支持 `observe + none`，不注册验收器，`workflow.status` 恒为 `not_requested`。Agent 仍可自主运行检查；检查回执照常保留，不能自动提升为正式验收通过。外部 Harbor verifier 独立工作，不需要 SDK 的 deferred API。

旧入口显式提供的 `CompletionContract/completionEvidence` 保留原判定能力，由兼容路径处理。新入口收到这些显式配置或任何新式 required/deferred/repair 配置，在模型调用和工具副作用前返回 `UNSUPPORTED_ACCEPTANCE_MODE`，不能忽略配置继续执行，也不能静默降级到 observe。

M2 才开放新式 inline required 和稳定快照；M3 才开放 deferred、repair 与 workflow 动作调度。它们不阻塞 M1 交付，也不能通过 M1 的隐藏选项提前启用。

## 2. 版本与入口选择

以下版本号及选择方式在 M1 固定，不再留给实现自行决定：

| 接口 | 现状 / legacy | M1 新接口 |
| --- | --- | --- |
| Headless JSON / NDJSON result | 原有无版本 result | `schema: "zap.outcome"`、`schemaVersion: 1` |
| CLI 选择 | `--result-schema legacy` | `--result-schema outcome-v1`，新版 CLI 默认值 |
| Runtime 事件 envelope | 读取 schema 1/2，旧订阅投影为 2 | 内部新写入 schema 3；新增 `attempt_ended` |
| Runtime state | 读取 schema 1/2 | 写入 schema 3，增加 `attemptOutcomes` 与终态 outbox |
| HostProtocol | request/response `version: 1` | 同时支持 `version: 2`；响应回显请求版本 |
| SDK 运行方法 | `runtime.run()` 保留旧结果形状/判定 | `runtime.runWithOutcome()` 返回 loop result 与 outcome |

`--output-format text/json/stream-json` 仍只选择渲染格式，`--result-schema` 同时选择该 CLI 调用的执行/退出投影。text 模式不打印 schema 包装，但采用选定档位的退出语义。未知取值或重复且冲突的 `--result-schema` 返回参数错误 2。

SDK 不使用推测客户端版本的逻辑。旧 `run()` 不因包升级偷偷改变 completion 字段含义；应用内 CLI/TUI/ACP 调用点在本次迁移中显式改用 `runWithOutcome()`。两种方法共用同一个 active-turn 锁，禁止在同一 Runtime 上并发运行。

新方法签名固定为 `runWithOutcome(input: string, options?: RunOptions & { acceptance?: AcceptanceConfiguration }): Promise<{ loopResult: LoopAgentResult; outcome: AgentOutcomeV1 }>`。`RunOptions` 和 `LoopAgentResult` 复用 `zapsdk/agent/loop.ts` 的现有类型。acceptance 仅由新方法的调用选项传入，不再增加一套 factory 默认覆盖规则；省略时使用 observe/none。

`loopResult` 保留 SDK 既有工具回执和 usage；新调用者只用 `outcome.execution` 判断执行终态。`run()` 与 `lastCompletionAssessment()` 继续提供 legacy 判定，不用于驱动新入口的终态或强制续跑。旧 `run()` 收到 JavaScript 调用者夹带的新 acceptance 字段时返回参数错误，不能静默忽略。

## 3. 结果类型

以下 TypeScript 块为完整、自包含的 M1 公共结果契约。建议放入 `zapsdk/runtime/outcome.ts`，从 SDK 主入口导出。

```ts
export type ExecutionStatus = "finished" | "limited" | "blocked" | "cancelled" | "failed";
export type ExecutionStopReason =
  | "end_turn" | "max_steps" | "max_tokens" | "budget" | "timeout" | "max_repeat"
  | "permission_denied" | "input_required" | "capability_unavailable" | "aborted" | "error";

export interface OutcomeError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface ActionReference {
  actionId: string;
  owner: "host" | "runtime";
  kind: "approval" | "input" | "capability" | "running_tool";
  state: "pending";
  toolCallId?: string;
  reason: string;
}

export interface ExecutionOutcome {
  attemptId: string;
  status: ExecutionStatus;
  stopReason: ExecutionStopReason;
  finalResponse: string;
  error?: OutcomeError;
  unresolvedActions: ActionReference[];
  backgroundTasks?: Array<{ taskId: string; disposition: "stopped" | "host_owned" | "pending" }>;
}

export interface AcceptanceCheckResult {
  checkId: string;
  source: "agent_check" | "host_verifier";
  observedOutcome: "passed" | "failed" | "error";
  evidenceRefs: string[];
  observedAt: number;
  snapshotId?: string;
}

export interface AcceptanceReport {
  attemptId: string;
  status: "not_requested" | "pending" | "unverified" | "passed" | "failed" | "error";
  code: string;
  specId?: string;
  specRevision?: number;
  snapshotId?: string;
  checks: AcceptanceCheckResult[];
}

export interface WorkflowDecision {
  status: "not_requested" | "ready" | "awaiting_acceptance" | "blocked";
  attemptId: string;
  controlRevision: number;
  code: string;
  snapshotId?: string;
}

export interface AgentOutcomeV1 {
  schema: "zap.outcome";
  schemaVersion: 1;
  threadId: string;
  turnId: string;
  runId: string;
  attemptId: string;
  startedAt: number;
  endedAt: number;
  execution: ExecutionOutcome;
  acceptance: AcceptanceReport;
  workflow: WorkflowDecision;
}
```

M1 固定 `attemptId = runId`；没有 repair attempt，因此不创建额外随机身份。时间均为 UTC Unix 毫秒。所有嵌套 attemptId 必须相同；不匹配属于 `OUTCOME_IDENTITY_MISMATCH`。

M1 acceptance 只输出 `not_requested / unverified`；workflow 只输出 `not_requested`、`controlRevision: 0`、`code: "WORKFLOW_NOT_CONFIGURED"`。其他枚举为协议已定义但本版本不产生的状态，不代表对应功能已开放。

`checks` 仅收录工具显式输出的检查回执：`checkId` 使用 toolCallId 加步骤编号，`source: agent_check`，`evidenceRefs` 指向对应调用记录。普通 shell exit 0 不生成 passed 检查；不存在明确检查时返回空数组。新结果不要求把全部原始工具输出复制一份。

### 3.1 执行分类优先级

分类函数 `classifyExecution()` 只读取结构化执行事实，按下表顺序匹配，不能读取模型自然语言猜测“成功”或“必要操作”：

| 优先级 | 输入事实 | status / stopReason |
| --- | --- | --- |
| 1 | 用户/宿主取消信号已被接受 | cancelled / aborted |
| 2 | 未处理 Runtime/provider/协议故障或 required 存储失败 | failed / error，携带 error |
| 3 | 宿主/Runtime 明确登记且未撤销的阻碍 | blocked / permission_denied、input_required 或 capability_unavailable |
| 4 | Loop 返回 budget stop | limited / 原 max_steps、max_tokens、budget、timeout、max_repeat |
| 5 | Loop 正常返回 | finished / end_turn |

取消与故障同时出现时，取消决定终态，故障仍记入审计。Runtime 预算耗尽映射 limited；provider 网络超时超过其重试策略后属于 failed，不能混用 timeout stopReason。

ActionReference 只能由宿主/Runtime 产生。pending 审批在当前动作放弃时终结活动引用，审批历史仍保留。已拒绝的旧调用不进入 `unresolvedActions`；它在工具结果中仍是拒绝，不能执行。不得把 `approval.anyDenied()` 当作新入口的整个 attempt 失败条件。

没有明确阻碍记录时，模型自然结束、包括回答“无法完成”，均归类 finished；目标是否达成不由执行分类器判定。`--continue-on-tool-denial` 在 legacy 档位维持旧行为，在 outcome-v1 档位保留为兼容参数，不改变上述分类。

### 3.2 M1 验收分类

`classifyObservedAcceptance()` 不访问 verifier、不强制逐文件 lstat、不比较历史 hash，只聚合已有的结构化 effects 与检查回执：

- 有 write/delete/process mutation、unknown effects、外部 mutation 或显式写入证据：`unverified / NO_ACCEPTANCE_SPEC`。
- 有明确的 agent 自检回执但没有上述 mutation：`unverified / AGENT_CHECK_ONLY`，避免把自检当作宿主验收。
- 都没有：`not_requested / ACCEPTANCE_NOT_CONFIGURED`。

没有工具调用或只读问答可以为 not_requested；这不构成任何任务正确性承诺。证据读取失败若仅影响可选观察，输出 `unverified / OBSERVATION_UNAVAILABLE` 并记录错误；required 存储失败按执行故障处理。

## 4. 验收接口与能力拒绝

第 41 篇中未展开的输入接口在此固定，供配置校验和后续阶段使用。M1 只执行 observe 分支；其他分支在 preflight 返回明确错误，不启动半套验收引擎。

```ts
export interface AcceptanceSpec {
  id: string;
  revision: number;
  subjects: Array<{
    id: string;
    path: string;
    expected: "exists" | "absent";
  }>;
  checks: Array<{
    id: string;
    verifierId: string;
    subjectIds: string[];
  }>;
}

export interface StableSnapshot {
  id: string;
  root: string;
  proof: "immutable_snapshot" | "all_writers_excluded";
  subjects: Array<{ subjectId: string; exists: boolean; sha256?: string }>;
}

export interface HostVerifier {
  id: string;
  verify(context: {
    attemptId: string;
    spec: AcceptanceSpec;
    snapshot: StableSnapshot;
    signal: AbortSignal;
    deadlineAt: number;
  }): Promise<{
    checkId: string;
    snapshotId: string;
    status: "passed" | "failed" | "error";
    evidenceRefs: string[];
  }[]>;
}

export type AcceptanceConfiguration =
  | { mode: "observe"; timing: "none" }
  | {
      mode: "required";
      timing: "inline";
      spec: AcceptanceSpec;
      verifiers: HostVerifier[];
      timeoutMs: number;
      repair?: { maxAttempts: number; timeoutMs: number };
    }
  | {
      mode: "required";
      timing: "deferred";
      spec: AcceptanceSpec;
      externalOwnerId: string;
      correlationId: string;
      timeoutMs: number;
    };
```

这些类型只覆盖文件存在/不存在及显式 verifier 扩展；其他条件不能通过任意 JSON 字段夹带，未来扩展要版本化。verifier 对象只能由宿主代码注册，不能从模型输出反序列化执行。`StableSnapshot.proof` 必须由可信执行环境提供，不能由模型填写字符串获得可信资格。

M1 新入口 preflight 顺序：解析参数 → 确定档位 → 检查显式配置来源 → 拒绝不支持能力 → 验证 provider → 获取 thread lease → 启动 attempt。检查原始输入中显式声明的 requirements/callback，不能靠 `contract.id` 判断是否默认注入。

| 输入 | M1 处理 |
| --- | --- |
| 新入口省略 acceptance | 使用 `{ mode: observe, timing: none }` |
| 新入口 required / deferred / repair / 显式 legacy requirements 或 callback | `UNSUPPORTED_ACCEPTANCE_MODE`；CLI exit 2，HostProtocol 参数错误，SDK 在运行前 reject |
| 非法规范引用、重复 ID、非法时间预算 | `INVALID_ACCEPTANCE_CONFIG`；运行前拒绝 |
| legacy 入口明确传入旧契约和 completionEvidence | 按旧接口在 Agent 返回后评估；不注入 guard、不创建新 attempt |
| 调用尚未实现的 workflow wait/dispatch | `UNSUPPORTED_CAPABILITY`；不默默等待或返回成功 |

新式 required/repair 的类型即使结构有效，也必须经过 M1 能力校验而被拒绝。不要为尚未开放的能力提供 CLI 成功路径。

## 5. CLI、JSON 与退出码

### 5.1 outcome-v1 输出

JSON 模式的最终对象和 stream-json 最后一行都包含 `type: "result"`、schema 标识及 `AgentOutcomeV1` 字段，同时保留 `text/sessionId/turns/usage/toolCalls`。`text = execution.finalResponse`，顶层 `stopReason = execution.stopReason`，`ok = execution.status === "finished"`。顶层 `completion` 不再输出；有执行错误时输出 `error`，unverified 不产生 error。

执行中途抛错时，Runtime 从根 agent 的 `run_ended` 保存已完成轮数和累计用量快照，
用于返回值、持久化终态及 legacy 投影，不能重置成 0。子代理事件不覆盖该快照，
后续 attempt 不继承前一次统计；正常返回仍以实际 LoopAgentResult 为准。
这些数字只覆盖已经报告的用量，不估算故障请求尚未返回的 usage，也不触发模型或工具重试。
错误分类和退出码保持原语义。

stream-json 的 init 事件带同一 schema 标识；中间 tool/assistant 消息保持形状，新增字段只能是可选字段。除存储/发布失败导致无法确认终态外，每个已启动的 attempt 恰好输出一次最终 result；这类失败输出专门的 error 记录并非零退出，不伪造执行终态。preflight 失败只输出 stderr 诊断并退出，不虚构已运行的 result。

例：编辑文件后正常结束，最终结构中的关键字段如下（usage 等公共字段略）：

```json
{
  "type": "result",
  "schema": "zap.outcome",
  "schemaVersion": 1,
  "ok": true,
  "stopReason": "end_turn",
  "execution": {
    "attemptId": "run-1",
    "status": "finished",
    "stopReason": "end_turn",
    "finalResponse": "文件已修改，尚未运行验收。",
    "unresolvedActions": []
  },
  "acceptance": {
    "attemptId": "run-1",
    "status": "unverified",
    "code": "NO_ACCEPTANCE_SPEC",
    "checks": []
  },
  "workflow": {
    "attemptId": "run-1",
    "status": "not_requested",
    "controlRevision": 0,
    "code": "WORKFLOW_NOT_CONFIGURED"
  }
}
```

### 5.2 退出映射

| 条件 | exit |
| --- | --- |
| finished，acceptance 为 not_requested/unverified | 0 |
| limited，包括 budget/timeout/max_repeat | 0，`ok:false`，保留停止原因 |
| failed | 1 |
| 参数、配置、不支持能力 | 2 |
| 没有可用 provider | 3 |
| blocked / permission_denied | 4 |
| blocked / input_required、capability_unavailable | 7 |
| cancelled | 130 |

状态码 5 固定保留给未来显式验收不通过，6 保留给验收基础设施错误；M1 不产生这两个退出码。新增退出码通过同一个纯函数映射，禁止 formatter 和调用点各自判断。

legacy CLI 保留现有 `end_turn=0 / incomplete=1 / permission_denied=4 / aborted=130` 及软停止 exit 0，原 `ok/error/completion` 语义不变。不能只选择旧字段而采用新退出码。

## 6. legacy 投影与应用入口

### 6.1 兼容原则

保留 `assessCompletion()` 的旧判定算法用于 legacy 投影，保留默认 legacy 合约和显式合约意图。它只能在 Agent 自然/预算结束后评估，不再安装验收驱动的 `turnEndGuard`。

每个 attempt 仅允许调用宿主提供的旧 completionEvidence 一次。legacy 调用或明确 opt-in 的旧宿主才执行该回调；新 observe 入口无回调、无隐藏文件扫描。新入口为旧订阅者生成的 completion 投影仅使用已记录的事实，不运行额外 verifier。证据不足时 legacy 可保持 incomplete，不改变 outcome 的 finished。

当新入口向 legacy 消费者投影时，缺失证据保持未知/不满足，不得用新 `finished` 构造旧 `completion.success: true`。legacy 的具体 ledger 来自纯函数评估；旧默认 delivery、显式合约和 V1 natural-response 必须分开保留其来源。

### 6.2 各入口修改

- CLI：新增参数和 profile parser；outcome-v1 调用 `runWithOutcome()`，legacy 调用 `run()`。
- TUI：用 outcome.execution 更新运行中/结束/错误 UI；未验证提示不触发新一轮执行。历史会话仍展示旧 completion。
- ACP：worker 显式选择 outcome-v1；只由 execution stopReason 映射正常结束、限制、取消或拒绝。acceptance 放入摘要/扩展元数据，不制造 refusal。
- SDK：旧方法签名保持，新增方法和导出类型；两条路径共用执行、权限、预算实现。
- 子 Agent/coordinator：父入口选择的执行档位显式继承；新路径的调用结果不因缺少验收而失败。隔离产物仍需按现有 merge 协议合并后才能启动依赖任务，不能把 finished 直接替换为 dependency succeeded。

## 7. 事件、存储与并发的具体落点

M1 没有 workflow action 或外部验收回调，因此不新增 WorkflowControl 事务调度器。现有执行取消仍通过 ActiveTurn AbortController；不能因为为未来模型保留了 workflow 字段就实现部分放行逻辑。

`runWithOutcome()` 对宿主提供的 stateStore/eventStore 使用 required 失败语义；未提供持久化实现时使用现有内存 store，并明确没有重启恢复保证。旧 `run()` 的 best-effort/required 选项保持原约定。新方法不能沿用 best-effort 后丢失终态却宣称已持久化。

### 7.1 state schema 3

在现有 `RuntimeStateSnapshot` 增加：

```ts
// 位于 zapsdk/runtime/outcome-state.ts；AgentOutcomeV1 使用第 3 节定义。
import type { RuntimeEventPayload } from "./types.js";
import type { AgentOutcomeV1 } from "./outcome.js";

type LegacyTerminalPayload = Extract<
  RuntimeEventPayload,
  { type: "turn_completed" | "turn_incomplete" | "turn_failed" }
>;

type PersistedAttemptOutcome = {
  outcome: AgentOutcomeV1;
  legacyTerminal: LegacyTerminalPayload;
  terminalEventId: string;
  terminalEventSequence: number;
  terminalEvent: import("./types.js").RuntimeEventV3; // 保存完整 envelope，恢复时原样重发
  publication: "pending" | "published";
};

type OutcomeStateExtension = {
  attemptOutcomes: Record<string, PersistedAttemptOutcome>;
};
```

存储校验必须校验 legacy 终态结构，不能接受任意 JSON。终态以 attemptId 为键，不允许写入不同的第二个终态。

读取 schema 1/2 时只增加空 `attemptOutcomes` 并升级到 3，不推断历史 execution。写入升级在现有 thread lease 下进行，使用原子临时文件替换；升级前保留一份 owner-only 原始 state 备份。旧二进制不支持 schema 3，回滚不能直接覆盖有新活动的线程，只能使用旧备份的独立恢复副本。

### 7.2 终态写入与事件发布

复用 `RuntimeStateStore.update(threadId, updater, { expectedRevision })` 和 `acquireThreadLease()`，不另建并发锁。`RuntimeStateTracker.flush()` 后再读取 revision；发生 CAS 冲突须重读状态并重新验证 attempt，不能盲目重复副作用。

持续服务交付的候选扩展见 [第 55 篇](55-managed-services-lifecycle.md)。现有 `stop/host` 是当前实现，只管理普通后台任务；`host_owned` 不代表 CLI 退出后有独立 supervisor 接管。

顺序固定为：

1. 停止/登记残留工具，收集最终回执，计算 execution 与 observe acceptance。配置后台工具的宿主同时传入 `backgroundTasks: { store, disposition }`：CLI/ACP 使用 `stop`，先发送 SIGTERM、等待 close/输出刷盘，超时升级 SIGKILL；仍未退出的任务记为 pending blocker。TUI 使用 `host`，将继续存活的任务显式记录为 `execution.backgroundTasks[].disposition = host_owned`，由会话继续管理；这不触发模型续跑，也不把后台服务一律视为执行失败。停止成功记录 stopped。
2. 在单次 state update 中保存不可变 outcome、legacy 终态投影、预分配的 event ID/sequence 及 pending publication。
3. 将同一 `attempt_ended` 事件追加至 event store；按 event ID 幂等发布。
4. 将 publication 改为 published，再向 CLI/SDK 返回最终结果。

Runtime 为 ActiveTurn 增加 `running / sealing / ended` 内部阶段。在进入步骤 1 前，同步取得终态 latch、将阶段改为 sealing 并固定已经接受的取消信号；此后 `cancelTurn()` 返回 false，不再修改该 attempt。进入 sealing 前已接受的取消必须进入最终分类。ACP worker 在 latch 关闭后发送 sealing 通知；父进程撤销取消强杀计时器，最终以 worker outcome 为准，不能用迟到的父控制器信号覆盖已封存结果。取消与异常竞态时，原始异常（包括 aborted wrapper 的 cause）保留在 execution.error 与终态审计中；普通取消不伪造执行故障。latch 仅控制该 Runtime 的收尾顺序，不承担工作区稳定性或未来 workflow 的取消语义。

event store 必须支持通过 event ID 检测已存在的发布；如果现有 append 不具备该行为，M1 在 event-store 层补齐。不能以“重试可能重复一条”作为终态协议。

`AgentRuntime.initialize()` 提供不执行模型/工具的独立恢复入口，使用与 run 相同的 thread lease；HostProtocol snapshot/events/subscribe 在空闲时先调用它，TUI 冷启动会话使用不配置 provider 的恢复适配器。恢复会读取 lastOutcome，完成待发布 outbox，不要求用户再发 prompt。

进程在步骤 2 后崩溃：恢复只重发 outbox，不重跑模型/工具、不调用 verifier。没有持久化终态但 owner 已死亡：生成 execution failed、错误码 `RUN_INTERRUPTED` 的恢复结果，不推测任务已完成。恢复事件采用原 attempt 关联，保留历史工具回执。

required state/outbox 写失败时，CLI exit 1，SDK reject `OUTCOME_PERSISTENCE_FAILED`，不打印持久化成功的终态。若步骤 2 已成功而后续 event-store 发布失败，保持原不可变 outcome 和 pending outbox；CLI 输出 `type: error`、code 为 `TERMINAL_PUBLICATION_FAILED` 的记录并 exit 1，SDK reject 同码错误，不另发矛盾的 failed result。后续恢复仅完成发布，不重写 execution。内存模式仍采用相同顺序，但明确不提供进程重启恢复保证。

### 7.3 HostProtocol 版本

服务接受 request version 1/2，其他版本返回 `UNSUPPORTED_VERSION`。version 1 保留旧 `thread.run` 返回形状和 schema 2 事件投影；version 2 的 `thread.run` 使用 runWithOutcome，事件返回 schema 3。订阅连接在建立时固定版本，不能在同一 cursor 上混用投影。

schema 3 的终态 `attempt_ended` 包含 outcome 和保存的 legacyTerminal。对旧订阅者转换成原 `turn_completed / turn_incomplete / turn_failed`，保持 eventId、sequence、timestamp 不变；其他消息/工具事件沿用字段并降为 schema 2 envelope。只存一份 canonical 事件，不为了投影再增加 sequence。

`thread.snapshot` 仍表达运行/空闲；version 2 新增返回 `lastOutcome`，version 1 保持原形状。`thread.cancel` 只取消当前活动执行；M1 对已结束 attempt 返回 `{ cancelled: false }`，没有延后 workflow 可取消。version 2 的 workflow 方法请求返回 `UNSUPPORTED_CAPABILITY`。

## 8. Terminal-Bench 适配器判定表

适配器默认显式传 `--result-schema outcome-v1`。评测旧二进制时必须通过 adapter kwarg `result_schema=legacy` 指定，禁止通过失败后自动降级并重跑模型。

| 最终 result 与进程退出 | 处理 |
| --- | --- |
| outcome-v1 合法，execution finished/limited，exit 0 | 保存 metadata，正常返回给 Harbor，继续官方 verifier |
| outcome-v1 blocked/failed/cancelled | 保存实际执行错误，adapter 抛错；M1 不验收故障后的部分产物 |
| outcome-v1 finished/limited，但 exit 非 0 | 协议/进程冲突，adapter 抛错，不吞掉额外崩溃 |
| legacy 合法 end_turn 或已知软停止，exit 0 | 继续 verifier |
| legacy stopReason=incomplete、completion.status=incomplete，exit 1 | 记录 legacy incomplete 并继续 verifier |
| 缺最终 result、非法 schema、身份冲突、未知退出组合 | adapter 抛错 |

`合法`要求 schema、必需字段、枚举、关联 ID 和 result 数量符合契约。重复相同最终记录或相互矛盾的多个 result 均视为协议错误，不能取最后一行隐藏早先失败。legacy 允许历史记录没有 schema，但不允许将未知 schema 当 legacy。

沿用模型、80 turns、任务预算和任务版本；启动命令继续断开 stdin。metadata 增加 result schema、execution status/reason、acceptance status、进程退出码；保留现有 usage 和错误信息。Python 测试验证 adapter 分类，真实评测验证 Harbor 实际进入 verifier；两者证据不能互相替代。

## 9. 实施拆分与依赖

这些是实施顺序，不意味着未经授权创建 PR 或发布。M1 全部条目完成后才能切换应用默认入口；中间提交保留旧默认，避免协议和消费者半迁移。

| 工作包 | 具体文件/接口 | 依赖与完成条件 |
| --- | --- | --- |
| M1-1：结果纯函数与类型 | 新 `zapsdk/runtime/outcome.ts`，`zapsdk/index.ts` | 第 3 节类型、执行/observe 分类、身份校验有独立测试；不改变默认入口 |
| M1-2：Runtime 与终态落盘 | `runtime/agent-runtime.ts`、`factory.ts`、`types.ts`、`state-types.ts`、`state-store.ts`、`state-tracker.ts`、`event-store.ts` | 依赖 1；runWithOutcome、移除 acceptance guard、outbox 幂等与 schema 迁移完成 |
| M1-3：宿主及兼容投影 | `src/headless/{args,formatter,runHeadless}.ts`、`src/agent/buildAgentRuntime.ts`、TUI dispatcher、`src/acp/`、`zapsdk/host-protocol/` | 依赖 2；参数、版本、全部退出映射和双协议回放通过 |
| M1-4：子 Agent 状态传递 | `agent/subagent-assembly.ts`、`builtin-tools/subagent.ts`、`coordinator/coordinator.ts` | 依赖 2；根/子执行档位一致，保留 merge 后启动依赖约束 |
| M1-5：评测适配器 | `evals/terminal_bench/zap_agent.py`、`test_zap_agent.py`、README | 依赖 3；第 8 节分类与新参数通过，未判分和 reward 分开 |
| M1-6：应用默认切换与证据 | CLI/TUI/ACP 调用点、架构文档状态 | 依赖 1–5；全量回归、构建及同五题真实评测完成 |

不能只合入 default contract 删除而省略 M1-3/4；那会留下旧 UI、子 Agent 或协议消费者继续按完成验收解释新执行结果。各工作包提交应保留独立、可运行的测试，不改 VM 的权限边界。

## 10. 直接可写的验收用例

| 测试落点 | 输入 / 操作 | 必须断言 |
| --- | --- | --- |
| 新 `zapsdk/tests/runtime/outcome.test.ts` | 自然结束；write 后结束；budget；provider 错误；取消与错误同时出现 | 分别为 finished/not_requested、finished/unverified、limited、failed、cancelled；无任务正确率推断 |
| `runtime/agent-runtime.test.ts` | scripted provider 正常结束，显式旧 artifact 条件缺失 | completion 不满足但模型调用数不增加；verifier 至多在结束后调用一次 |
| `runtime/factory.test.ts` | 新方法 + 显式 callback、required、deferred、repair | preflight 拒绝，provider 和 tool 调用数均 0 |
| `headless/args.test.ts` | schema 缺省、legacy、非法值、重复冲突 | 新默认 outcome-v1；旧显式可用；错误 exit 2 |
| `headless/runHeadless.test.ts` | 同一文件编辑分别使用新/旧档位 | 新 finished/unverified exit 0；旧保留原 completion/退出映射 |
| `headless/approval.test.ts` | 工具被拒绝，后续合法方案正常完成 | 新入口不因历史 anyDenied 失败；拒绝的工具从未执行 |
| `headless/formatter.test.ts` | json/stream-json 正常及 limited | schema、ok、stopReason 正确；恰好一个 result；limited 为 exit 0 但 ok false |
| `runtime/state-store.test.ts` | schema 1/2 升级；竞争 expectedRevision | 旧事实保留、outcome 为空；冲突不覆盖已存终态 |
| `runtime/recovery.test.ts`、`event-store.test.ts` | 在 outbox 保存、事件追加后分别模拟崩溃 | 同一 eventId 只发布一次，不重跑模型/工具；旧 attempt 不变 |
| `runtime/agent-runtime.test.ts` | 在 sealing 前后分别取消；模拟终态发布失败 | sealing 前接受取消且结果 cancelled，之后返回 false；发布失败不生成第二个矛盾终态 |
| `host-protocol/host-protocol.test.ts` | v1/v2 对同一日志回放 | 字段与终态各自正确，eventId/sequence 相同，cursor 不重复不丢失 |
| `tests/acp/events.test.ts`、`agent.test.ts` | 新 result finished + unverified | 正常回合结束，不映射 refusal；真实取消仍保留 |
| `builtin-tools/subagent.test.ts`、coordinator 与 workspace 测试 | 子 Agent 编辑后自然结束；隔离产物待合并 | 缺验收不制造工具失败；依赖仍等到 merge 成功 |
| Python adapter 测试 | 第 8 节每一组合，含重复 result 和未知 schema | 可判分状态正常返回，其余分类明确；不靠错误文本猜测 |
| 实际 CLI 临时目录 | 创建文件后结束、删除临时脚本、shell 修改已写文件 | 新默认均可正常结束并报告 unverified；没有额外强制模型调用 |

M1 自动化命令：`bun run typecheck`、隔离 `ZAPCODE_DATA_DIR` 下的 `bun test`、`bun run build`、`PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=. uvx --from harbor python -m unittest evals.terminal_bench.test_zap_agent`。临时目录不要指向个人配置目录；真实模型评测按原 adapter 的最小 provider 配置隔离执行。

最终运行同一五题，记录 commit、binary/adapter hash、Harbor/任务版本、模型、每题执行终态与 verifier 结果。五题必须实际进入官方判分，或有逐项可解释且独立记录的环境阻碍；出现与本轮相同的 completion-incomplete 跳过判分说明 M1 未完成。不能靠分数提高判定协议修复成功。

## 11. 后续能力的启用条件

M2/M3 需要单独的实施规格和测试证据后才能启用，不能仅将 M1 的 `UNSUPPORTED_*` 检查删除：

- M2 必须实现规范校验、可信 snapshot provider、依赖版本绑定、verifier deadline/cancellation 和聚合验收；普通工作区 hash 前后一致不能产生稳定快照证明。
- M3 必须定义 WorkflowControl 的持久化结构、取消 revision、外部回调认证/幂等、动作 dispatch CAS 及崩溃后的 exactly-once/at-least-once 边界。现有 thread CAS 不能自动保证外部部署只执行一次。
- M3 的 repair 默认仍关闭，启用后每次新 attempt 必须使用剩余总预算；用户取消后迟到的 passed 不恢复工作流。

M1 完成不宣称第 41 篇所有架构能力落地。它有明确终点：默认 Agent 完成语义恢复，协议与旧消费者可区分，外部评测判分链路恢复，全部首批回归成立。


## 12. M1 实施记录（2026-10-11）

已实现的路径：

- `zapsdk/runtime/outcome.ts`：执行优先级、observe 分类、结果身份校验、退出码及 required/deferred/repair preflight 拒绝。
- `agent-runtime.ts`：`runWithOutcome()`、共享运行锁、sealing 取消边界；legacy evidence 只在返回后调用一次；删除验收驱动续跑。
- `outcome-state.ts`、state/event stores：state/event schema 3、不可变终态、完整事件 outbox、CAS 保存、事件 ID 幂等、旧 state 私有备份、进程中断恢复。
- CLI/TUI/ACP：新入口为默认；CLI 可显式选择 legacy；ACP 在 `_meta["zap.outcome"]` 携带结果，未验收不再触发 refusal。
- HostProtocol：v1/v2 双入口及回放，v1 事件投影保持 eventId/sequence；v2 快照提供 lastOutcome。
- 子 Agent：执行档位随父运行传递；自然结束不以验收证据缺失判错；隔离产物的 merge 和依赖调度约束保留。
- Terminal-Bench adapter：显式 schema、严格结果/退出组合、重复与身份冲突拒绝、独立记录执行与官方判分。

最终验证证据：停止评测并行负载后，全量 Bun 测试 **3252 通过、8 跳过、0 失败**（271 个测试文件）；typecheck、原生构建与 Linux x64 baseline 构建通过。Python adapter **8 项测试通过**，覆盖所有退出类别、协议冲突和旧二进制只读探测。CLI 拒绝工具、JSON/NDJSON limited 输出、schema 3 轨迹、会话启动锁与陈旧 outcome 拒绝均纳入回归。跳过项包含需专门环境的 TUI PTY、MCP、VM 和真实沙箱测试，不能把它们算作本轮已验证。

真实 CLI 使用本地 scripted provider 完成写文件、shell 修改、删除临时脚本：outcome-v1 为 `finished/unverified`、exit 0；legacy 为 `incomplete`、exit 1；均恰好 4 次 provider 请求。权限拒绝用例确认所有拒绝操作未执行，模型正常返回后新入口不因历史拒绝失败。这是实际 CLI/文件系统验证，不是外部模型题目正确性证明。

同五题 Terminal-Bench 2.0 的运行名称为 `terminal-bench-20261011-outcome-m1-sample4` 与 `terminal-bench-20261011-outcome-m1-reshard`。模型为 deepseek-flash，80 turns，900 秒预算（重分片 3600 秒），任务版本沿用 `69671fbaac6d67a7ef0dfec016cc38a64ef7a77c`。源码、binary、adapter 哈希及测试日志保存在仓库外的 `zap-benchmark-results/terminal-bench-20261011-outcome-m1-*`。五题均已进入官方 verifier，4/5 通过；这只是五题样本，不代表完整 Terminal-Bench 的准确率。

| 任务 | Agent 执行终态 | 验收报告 | 官方 reward | 说明 |
| --- | --- | --- | --- | --- |
| reshard-c4-data | finished / end_turn，exit 0 | unverified | 1 | verifier 校验 9898 个文件的原始哈希 |
| llm-inference-batching-scheduler | finished / end_turn，exit 0 | unverified | 1 | 官方测试通过 |
| break-filter-js-from-html | finished / end_turn，exit 0 | unverified | 1 | 官方测试通过 |
| write-compressor | finished / end_turn，exit 0 | unverified | 1 | 文件存在、解压一致性、压缩大小 3 项检查通过 |
| gpt2-codegolf | 无最终 result；AgentTimeoutError | 无报告 | 0 | Harbor 900 秒外层终止后执行 verifier；不算新终态协议正常返回 |

基线 `dc396839` 的五题均被 completion-incomplete 阻止判分；本轮四题通过新 outcome 正常进入 verifier，GPT-2 在外层超时后由 Harbor 进入判分。GPT-2 未在内部时限前产出终态的问题仍需单独诊断，不能据此声称所有长任务都能可靠收尾，也不能把其 reward 0 解释为内部验收失败。

复现与覆盖边界：实测使用启动时固定的 binary/adapter，哈希见 manifest。随后收尾修正的文本错误显示、TUI/HostProtocol v2 失败投影与会话身份保护、SDK 轨迹兼容、旧二进制帮助探测由回归测试验证，不冒充这些分支已在五题实测中运行。部分 Bun 回归与前两题重叠，出现过一次 ACP 两秒 worker 启动等待超时，单独复跑及评测结束后的最终全量回归均通过；因此本轮不作严格受控的时延或模型能力提升比较。

M2/M3 的 required/deferred/repair 和 workflow 放行能力仍未实现。


### 12.1 复审修复

复审确认并修复四项缺口：后台任务未纳入终态、ACP 迟到取消覆盖已封存结果、恢复只能由下一次 run 触发、取消丢失并发异常审计。新增真实进程收尾/会话接管测试、真实 CLI 后台任务测试、ACP 取消竞态测试，以及无模型调用的恢复/HostProtocol 快照测试。此修复不启用 M2/M3，不增加验收驱动续跑。

追加验证：隔离数据目录的全量 Bun 测试 **3259 通过、8 跳过、0 失败**（3267 项、271 文件）；typecheck、原生与 Linux x64 baseline 构建通过，Python adapter **9 项通过**。定向测试 **56 项通过**；之后补充的跨 owner 游标测试也纳入最终全量回归。首次全量发现旧事件线程创建时间被新建内存状态覆盖，修复后再跑全量通过。日志、源码和二进制哈希保存在仓库外 `zap-benchmark-results/terminal-bench-20261011-outcome-m1-fixes-evidence/`。

上一节 3252 项测试与五题评测仍属于修复前版本，不作为复审修复后源码的实测证明。复审修复当时未重跑五题真实评测。GPT-2 旧日志只有流式内容和步骤预算，缺少请求阶段与收尾阶段时间线；当时证据不足以确定其超时根因。

### 12.2 长流式运行诊断与存储修复

CLI 的 stream-json 增加 provider 请求阶段与 checkpoint、sealing、runtime 返回、Host 清理的时间线 observation。它们只用于观测，不改变模型提示、运行预算或终态判定。

诊断运行 `terminal-bench-20261011-outcome-gpt2-diagnostic` 使用同一 GPT-2 任务和预算，约 725 秒后正常返回一次 `finished/end_turn + unverified`，无 Harbor 执行异常；官方 reward 为 0，模型报告前向计算错误。原先的 900 秒超时没有复现，不能据此给出确定的旧超时根因。该次 checkpoint 耗时 1 毫秒，sealing 到 runtime 返回耗时 14332 毫秒；运行中的落盘采样曾落后实时流约 19 秒。

代码检查发现 JSONL 事件存储每次 flush 都复制完整历史 eventId Map，长 thinking 流累计开销呈平方增长。改为只暂存当前批新增 ID，持久化后合入历史索引；跨批去重、批内去重与同 ID 冲突仍保持原语义。回归覆盖多批追加后历史 ID 不丢失、重复不追加及冲突拒绝。

本机微基准关闭 SQLite 索引，分别预置 1000/30000 条历史，再逐条 await 追加 1000 条。修复前耗时 63/521 毫秒，修复后 49/51 毫秒。此结果隔离了历史 Map 复制成本，不代表容器端到端提速，也不能单独证明旧超时由此引起。脚本、旧版对照源码、采样日志及结果保存在 `zap-benchmark-results/terminal-bench-20261011-outcome-final-evidence/`。诊断容器结束后已不存在，保留的是运行中复制的部分事件日志和实时采样，不能当作完整最终持久化状态证明。

修复后全量回归为 **3261 通过、8 跳过、0 失败**（3269 项、271 文件）；typecheck、原生构建、Linux x64 baseline 构建与 Python adapter **9 项测试**均通过。真实评测与全量测试分时执行，二进制和源码哈希在启动评测前固定。

最终版 GPT-2 复测约 590 秒后正常返回一次 `finished/end_turn + unverified`，官方 reward 为 0，模型报告产物大小和计算结果不合格。sealing 到 runtime 返回为 44 毫秒。其完整事件日志有 47014 条，恰好一个 `attempt_ended`，与 state 的 outcome 一致，publication 为 `published`。持续流式输出时抽样落盘延迟为 11/49 毫秒；等待 shell 时没有新事件，旧时间戳不计为存储积压。诊断版与最终版的模型轨迹、事件量不同，因此 14332/44 毫秒仅作实测收尾记录，不作为严格端到端性能对照。此次正常收尾也不证明原始超时已被完整复现或解释。

### 12.3 最终代码同五题复测

运行 `terminal-bench-20261011-outcome-final-sample4` 与 `terminal-bench-20261011-outcome-final-reshard` 已完成。固定 Harbor 0.24.0、deepseek-flash、80 turns、任务提交 `69671fbaac6d67a7ef0dfec016cc38a64ef7a77c`；外层/内部预算分别为 900/840 秒，重分片为 3600/3540 秒。两组依次执行，每组并发为 1，全量回归在评测前完成。构建来自基线 `dc39683960a01fc9ba883e00550be0cf49148b1f` 加本地 M1 改动，具体 binary/adapter/源码 SHA-256 见 `zap-benchmark-results/terminal-bench-20261011-outcome-final-evidence/manifest.json`。启动评测后只修改了本文和评测 README，运行实现与二进制哈希保持一致。

五题均恰好返回一个 outcome-v1 result，执行为 `finished/end_turn`、验收为 `unverified`、进程 exit 0，且全部进入官方 verifier。没有 adapter 异常、外层超时或环境异常。

| 任务 | Agent 执行秒数 | sealing 到返回（毫秒） | 官方 reward | 官方验收说明 |
| --- | ---: | ---: | ---: | --- |
| gpt2-codegolf | 589.302 | 44 | 0 | `gpt2.c` 超过 5000 字节；官方测试在大小断言处失败，未继续证明推理正确性 |
| llm-inference-batching-scheduler | 222.193 | 59 | 0 | 两个计划共 14 种 shape，超过联合上限 8；其余 5 项测试通过 |
| break-filter-js-from-html | 186.675 | 47 | 1 | 官方测试通过 |
| write-compressor | 207.139 | 66 | 1 | 官方测试通过 |
| reshard-c4-data | 194.482 | 60 | 1 | 压缩/解压流程通过，9898 个文件与原始哈希一致 |

本轮 **5/5 正常返回并进入判分，官方验收 3/5 通过**。协议返回覆盖从上一轮的 4/5 增至 5/5，但官方得分从 4/5 降至 3/5，不能宣称模型能力或准确率提升。五题单次样本只证明这些轨迹上的运行/验收分离成立，不证明任意长任务可靠收尾；原 GPT-2 超时仍未完整归因。

逐题 JSON 汇总为同目录 `five-task-summary.json`，包含任务 checksum、运行时间、退出码、schema、result 数量、执行/验收分类和 verifier reward；原始流、verifier 日志和任务配置保留在两个运行目录。此轮完成 M1 最终代码的同五题验收记录，M2/M3 仍按第 11 节单独规划。

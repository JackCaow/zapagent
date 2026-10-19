# 40. Harness 运行约束与完成证据

> 2026-10-11：M1 新默认入口已按 [第 42 篇](42-agent-outcome-implementation-contract.md) 实施。本文的 completion 门禁描述保留用于迁移前/legacy 行为，不能用于解释 outcome-v1 的执行终态。

> 本文保留基线 `dc396839` 的实现记录。2026-10-11 五题评测暴露了默认交付门禁与外部验收的循环依赖；目标架构见 [第 41 篇](41-agent-outcome-and-acceptance.md)，已实施的 M1 范围及验证结果见第 42 篇。M2/M3 仍未实现。

生产入口仍然是 `createAgentRuntime → AgentRuntime → LoopAgent`。本次调整把原本只存在于配置中的执行约束接入真实授权路径，并使“模型自然结束”与“任务经过验收”有不同终态。

## 执行循环的职责

`LoopAgent` 保留模型循环、会话提交、上下文压缩及失败恢复。以下组件独立维护，公开的 LoopAgent API 保持兼容：

- `agent/tool-execution-guards.ts`：单次运行的重复查询缓存、失败构建防护、计划 gate、重复步骤签名和进度轮询判定。
- `agent/call-budget.ts`：消息与工具 schema 的输入估算、context/input ceiling 和输出预算计算。
- `agent/nonstreaming-tool-executor.ts`：非流式工具批次的授权、资源冲突调度及结果配对。
- `agent/subagent-assembly.ts`：每个 loop 的 registry 克隆和子 Agent 装配；继承 policy、broker、审批队列、checkpoint 约束和 lifecycle observers。

## 策略如何生效

`HarnessToolPolicyEngine` 包裹宿主已有的 policy engine。它只能限制权限，不能把宿主 deny 改为 allow。

宿主共享的 POSIX shell 风险识别将 `rm` / `unlink` 删除 `/dev` 名称空间条目视为
`device_removal`，无需递归标志。无交互宿主在工具分发前拒绝并返回原因；交互宿主沿用已有确认流程。
普通 `/dev/null` 输入输出重定向不属于删除。识别本地路径时只解析待删除条目的父目录，
避免把删除项目内设备符号链接误判为删除设备本身；远端路径仅作词法识别。
这是可识别命令的风险提示，不是操作系统隔离：任意程序、动态路径和原生命令语法仍可能绕过识别。
运行环境被 Agent 改坏后导致 verifier 启动失败，须保留原始失败并单独记录归因，不能改记通过或
当作与 Agent 无关的基础设施故障排除。运行时不得通过自动修复环境来隐藏这种破坏。

| 字段 | 运行行为 |
| --- | --- |
| `autonomy: interactive` | 保留宿主审批策略。 |
| `autonomy: supervised` | 对 mutation/unknown effects 要求审批；不能使用 legacy `allowConfirmWithoutApproval` 绕过。 |
| `autonomy: bounded` | 可以在宿主已允许的权限内执行；需要 ask 的调用直接 deny，不申请提升权限。 |
| `allowedCapabilities` | effects 映射到 `read/write/delete/network/process/external/unknown`；缺少任一所需能力时在 handler 前拒绝。删除同时需要 write 和 delete。未知能力名称在装配时拒绝。 |
| `workspaceMode: isolated-write` | 拒绝 root workspace 的直接变更；允许 Agent tool 委派隔离写入，子工具仍受真实 workspace policy 和 Broker 约束。 |
| `checkpoint: before-write` | 声明写入路径的工具必须成功获得 checkpoint coverage 才能执行。 |
| `checkpoint: before-destructive` | 对删除要求 coverage；工具自身的 required 要求一直生效。 |
| `checkpoint: never` | 跳过可选备份，工具自身 required 要求仍生效。 |
| `observability: minimal` | Runtime 协议中的 run_step 不保留 context diagnostics；生命周期、usage、工具结果与执行凭据仍保留。standard/debug 保留现有 diagnostics。宿主独立 logger 的策略由宿主管理。 |
| `budgets.costUsd` | 当前没有可信计费表和成本 meter，因此 factory 在任何模型/工具副作用前明确拒绝该约束。不会把 token 数或缓存命中率当美元计费，也不会静默忽略成本上限。 |

要求 coverage 时，`CheckpointManager.trackEdits(paths, { required: true })` 会检查实际 pending backups；大文件、目录或禁用 checkpoint 的跳过不能被误报为备份成功。旧的 best-effort 调用保持兼容。

工具执行器使用 `trackEditsWithCoverage` 获取声明路径的实际备份结果；best-effort
调用没有抛异常，也可能因为目录、大文件或工作区外路径而报告 `covered: false`。
未覆盖不会阻止可选备份模式下已授权的操作；强制备份模式仍在 handler 前拒绝。
主 Agent 和隔离子 Agent 使用同一报告契约。`trackEdits` 的旧 void API 保持不变；
外部宿主的旧 void hook 仍以成功返回表示覆盖承诺，可能跳过路径的 hook 应迁移到
显式报告。覆盖只针对声明路径，不代表已发现或备份任意 shell 子进程的所有写入，
也不构成 OS 隔离保证。


执行策略不会替代 OS Sandbox、Broker 或 VM 的强制边界。未知 shell 副作用不能凭提示词变成安全读操作。金额预算的真实计费支持仍需要独立的 meter；此处修复的是“接受了配置却没有执行”的行为。

## 自然结束前的有限证据复核

应用的自然结束复核使用同一个 `makeTurnEndGuard` 接入 Headless 和 TUI：已有工具
结果或仍在进行的 Todo 时，最多提醒一次，将原始需求与本轮真实观察重新对照。
Todo 完成、列表清空或命令 exit 0 都不能代替功能证据。复核不判定答案正确与否，
不强制追加工具调用，允许明确报告未完成或未验证；第二次自然结束直接退出。
无工具结果、无进行中 Todo 的直接对话不增加复核请求。只读工具工作可能增加一次
模型请求，其耗时和成本必须纳入评估。共享预算、本轮 token/step 上限和收尾时间
预留均优先于复核；已到上限的完整回答仍能正常结束。

复核只使用模型已有的需求、用户后续指示和工具观察，不引入外部 verifier、隐藏
测试或参考答案。执行结果、外部验收和工作流状态保持独立；复核不能授予权限、
重放副作用或启动另一轮外部验收。合成测试只能证明接线与终止边界，真实模型
收益仍须通过独立完整 Bench 批次验证。

## 输出长度截断后的恢复

共享 `AgentBudget` 按已报告用量判断是否允许下一轮。当前回答恰好用完 token
仍可正常完成；下一轮、截断恢复以及强制收尾不能绕过已经耗尽的共享预算。
LoopAgent 在维护上下文前检查预算，并在实际占用 step 时重新检查，避免已耗尽
的运行先启动维护或模型调用。已结算的工具结果保留，不因停止而重放。

允许执行的强制收尾占用共享 step，返回的输入（含缓存）与输出 token 也计入共享
用量。没有余额时使用本地未验证说明结束，不另发摘要请求或复用旧进度作为完成声明。
这只控制基于已报告用量的后续准入：已启动请求的最终用量可能超过余额，缺失用量
仍须标记 incomplete，不能把它解释为零成本或严格的计费上限。provider 内部重试和
压缩调用的独立计量仍需另行审计。

当 provider 以 `length` / `max_tokens` 结束且没有完成的工具调用时，LoopAgent
沿用已有的有界恢复路径，并根据实际正文选择提示：

- 已有非空白正文：保留原始正文，让模型接续被截断的回答。
- 没有正文或仅有空白：不插入空 assistant 消息，明确说明尚未产生可用回答，
  让模型根据现有任务与观察选择简洁的下一步或回答。此时不要求从不存在的断句处续写。

`max_tokens_recovery` 观察保留 `attempt`，增加 `mode: partial_text | no_visible_output`，
用于区分两类恢复。重试次数、权限、共享预算、取消和期限处理沿用已有路径；
恢复不会自动重放已完成工具，也不会把缺少答案解释成任务通过。
该行为适用于流式与非流式 provider，不包含任务名称、参考答案或外部验收器反馈。

## 默认完成契约

V2 factory 的默认契约是 `delivery-response-v2`，要求 final response 与 delivery evidence。V1 输入以及直接使用低层 `AgentRuntime` 的默认自然回答契约保持兼容；宿主可以显式提供其他 completion requirements。

Runtime 收集当前 turn 的工具 effects、写入指纹、foreground command exit receipts、审批和 merge 状态。验收 callback 完成后重新检查产物，历史 turn 的批准或合并不能满足新任务。后续路径观察覆盖旧指纹，包括删除；读不到证据时不能使用旧工具指纹冒充当前状态。

- 无变更的问答可以自然完成。
- 涉及变更或 unknown effects 的运行必须有宿主提供的 `verification`，且 `satisfied: true`，才能判为 completed。
- 验证器成功不能抹掉实际产物变化、缺失产物或未解决的审批/合并/执行边界失败。
- 无 hash 的大文件、目录或 opaque process/external effects 需要宿主验收；已观察到的指纹不匹配会阻止完成。
- 工具执行成功、命令 exit 0、模型说 done，都不会自动被解释为任务验收或测试通过。
- 验证器异常保留为 infrastructure failure，并且缺少 delivery requirement 的运行保持 incomplete。

`HeadlessHost.completionEvidence` 与 TUI 的 `BuildAgentRuntimeDeps.completionEvidence` 都会透传到统一 factory，宿主无需自行重装配 LoopAgent。

宿主应根据用户目标提供真实验收条件，例如检查指定产物并运行指定测试，而不是从模型回答或任意 shell 文本猜测验收成功：

```ts
completionEvidence: async ({ threadId, turnId }) => {
  const acceptance = await hostVerifier.verify({ threadId, turnId });
  return {
    verification: {
      satisfied: acceptance.passed,
      detail: acceptance.description,
      source: "verifier",
    },
  };
}
```

`AgentRuntime.lastCompletionAssessment()` 返回独立的完成判定，保留 `run()` 的旧结果形状。Runtime 终态事件包含 evidence ledger。Headless 输出包含 completion；自然结束但证据不足时 `ok:false`、`stopReason: incomplete`、退出码 1。TUI 使用同一 factory 和 Runtime 终态；ACP 沿用已有的 incomplete → refusal 映射。缺少宿主验收 callback 的编辑任务会明确保持 incomplete；不会自动挑选并执行仓库测试。

## 测试设施

`zapsdk/testing` 导出 `ScriptedAgentHarness`，明确表示 scripted provider 的回归测试 fixture。旧名称 `AgentHarness` 和旧文件路径保留兼容。生产代码仍通过 runtime factory 装配。

回归重点包括 call/stream 路径、审批绕过、能力限制、checkpoint 成功/失败、隔离写入、产物变更、验收器失败、历史证据隔离、命令原始 exit code 和 Headless/ACP 的完成语义。

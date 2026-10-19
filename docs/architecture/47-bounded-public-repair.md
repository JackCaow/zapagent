# 47. 显式公开检查与有限修复

日期：2026-10-13。承接第 41 篇的修复边界，新增 SDK `runWithBoundedRepair(input, options)`。默认 `runWithOutcome()`、未启用公开检查的 CLI/TUI 和 Terminal-Bench 适配器仍只观察执行结果；Headless 可显式启用 `--public-checks`。M2 验收本身仍不续跑模型，由外层有限修复工作流决策。

## 1. 接入契约

宿主一次性提供 `runtime`（`CreateAgentRuntimeOptions`，必须 `subagent: false`）、现有 `acceptance` 配置、`repair: { maxAttempts, publicChecks }` 和 `budget: { modelCalls, toolCalls, timeoutMs }`。`maxAttempts` 是额外修复次数，0 表示仅做首次执行和验收。所有预算必须显式、有限；不支持的配置在模型执行前拒绝。

`publicChecks` 每项包含已声明的 `checkId`、用户可见的 `instruction`、允许驱动修复的公开失败码 `repairableCodes`。要求在首次执行前写入模型输入，修复时再次附带。宿主负责确认这些规则确实可以公开。不得把隐藏测试、私有答案或非公开断言登记成公开规则。

只有执行 finished、没有未解决动作/错误/仍运行的后台任务，且验收明确 failed 时，才考虑修复。每个失败检查都必须匹配公开规则和允许的失败码。缺文件/不稳定快照、检查器错误、未知失败码、权限或能力阻塞都停止；不会笼统地“再试一次”。已经通过则直接返回。反馈包含公开检查 ID、状态、失败码、依赖文件版本、attempt/spec/snapshot 标识及同码连续失败次数，通过项也标明仅对已记录版本有效。`includeDiagnostics: true` 允许附带 verifier 明确声明的 `publicDiagnostic: { expected, actual }`（各不超过 4096 字符）；默认不回送诊断值，始终不自动回送 evidenceRefs 或原始 verifier 输出。诊断值按数据处理，不提升为指令。

入口使用真实 `createAgentRuntime → LoopAgent → ToolExecutor`。`runRepairWithOutcome()` 在 Runtime ownership 内重新验证上一 attempt 仍是最新且可修复，然后沿用 turnId，创建新 runId/attemptId。首次 outcome 和验收回执先保存，新 attempt 才能执行；历史 outcome 不会改写为 passed。底层修复方法是显式宿主原语，不单独提供预算/验收策略，通常应调用上层入口。

## 2. 固定产物与确定性检查

`FileBytesSnapshotProvider(root, maxTotalBytes?)` 将声明的普通文件复制到只读内存快照，SHA-256 绑定每个文件版本。读接口每次返回副本，因此随后修改工作区或返回数组不影响已验收版本。默认总字节上限 16 MiB，超限、符号链接、目录等不提供稳定快照。缺失路径有明确 absence 版本。

宿主须先停止相关写入者。实现检查读取前后的大小/mtime/ctime，并拒绝符号链接；它不是抵抗恶意并发文件系统替换的 OS 安全边界，也不承诺多个文件的原子时间点。内存字节不提供跨进程恢复；需跨进程验证的宿主仍使用 Git 固定提交或自己的不可变对象存储。

`FileSizeVerifier([{ checkId, subjectId, maxBytes }])` 检查文件实际字节数；上限包含边界。例如“小于 5000 字节”应配置 `maxBytes: 4999`。`FILE_TOO_LARGE` 表示明确失败，实际字节数和上限保存在回执 evidenceRefs 和 publicDiagnostic 中。其他语义检查由宿主提供 `InlineHostVerifier`，同样绑定 attempt/spec/snapshot 和完整依赖。新增可选 `verifier.preflight({ spec, signal })` 在模型前检查配置/能力，方法身份固定且受预检 deadline 约束；内置大小检查用它拒绝错配的 check/subject。

## 3. 预算与中止

一个绝对 deadline 覆盖预检、首次执行、验收及全部修复。主 provider、fallback、summarizer 共用调用计数，包含流式调用、最终回答和压缩调用；统计的是 SDK provider 调用，不是 provider 内部 HTTP 重试、token 或金额。工具计数在授权后、handler 前共用一次准入，失败执行也计数；达到上限先取消再拒绝，不增加配额。

取消/超时关闭所有后续准入，模型或验收的迟到结果不能把本次返回值恢复为 passed。工具沿用原权限、checkpoint、broker 和取消机制。自定义 provider/tool 必须配合 signal 才能停止底层外部活动；不承诺强杀任意宿主回调。共享预算也约束等待 `runWithOutcome()` / `runRepairWithOutcome()` 返回，包含封存等待；预算到期可先返回 stopped，Runtime 继续持有线程锁直到在途写入与 ownership 释放结束。自定义存储迟到完成可能留下终态或回执，但不得据此自动触发验收、修复或工作流动作。

返回 `{ status, code, attempts, lastOutcome, usage }`。`attempts` 只含已经取得验收回执的 attempt；验收途中取消时 `lastOutcome` 仍保留最后已封存执行结果。`status: passed` 是本次预算内的执行和验收结论，不是部署/合并授权。保存失败会抛出协议错误，绝不继续修复。

当前入口只覆盖根 Agent，拒绝自定义 conversation/resultCompressor、subagentFactory、多 Agent 和转交宿主持有的后台任务。自定义工具内部自行调用的模型/API 不属于根 provider/handler 次数统计。修复预算在进程内共享，没有持久化修复调度或自动恢复；重启后必须由宿主读取既有终态、重新决策，不能将再次调用本入口解释为恢复原预算。deferred/CAS 工作流自动修复、累计预算恢复及多 Agent 全局预算仍未交付。SDK 宿主需要在运行前接入事件监听时可使用 `createBoundedRepairSession(options)`，再调用一次 `session.run(input, contextOptions)`；会话持有独立 conversation，禁止覆写预算 signal 或完成守卫，不能复用或重置预算。未执行的会话也必须 `dispose()`。

### 封存等待与恢复

Outcome Runtime 提供 `sealingTimeoutMs`（默认 30 秒，正整数）及 `onSealingProgress`。`createAgentRuntime` 透传两个选项，Headless Host 可覆盖等待上限；普通 CLI 使用默认值。此上限从模型执行结束、进入 sealing 开始，覆盖后台任务处置、state flush/load、终态保存、event flush、终态 append、发布确认及 ownership 释放，独立于模型执行预算。它不是完整 CLI 启动/恢复/退出的总限时，外层宿主仍须给这些阶段留出时间。

诊断回调直接发送，不能经被测存储排队；包含 threadId/turnId/attemptId、stage、started/completed/failed/timeout、阶段耗时与总耗时，不含提示词、产物或工具输出。Headless stream-json 将其输出为 `observation(kind=runtime_sealing)`。`terminal_append` 包含事件存储自身的 durable append 和索引操作；本次未再拆分存储内部耗时。

超过上限抛出 `OUTCOME_SEALING_TIMEOUT`，Headless 输出协议错误并返回非零退出码，不输出成功 result。超时仅结束调用方的等待，不取消在途持久化，也不提前释放线程锁；旧操作未结束时，禁止启动同一 Runtime 的新 turn。若异步写入之后完成，终态仍按原 attempt/event ID 保存和发布。恢复需先等旧 owner 释放锁或确认其进程已退出，再调用 `initialize()`：已保存的终态通过 outbox 幂等补发；保存前进程退出则按既有 `RUN_INTERRUPTED` 路径恢复，绝不自动重跑模型。

事件 JSONL 存储在前一批写入尚未完成时继续收集后续事件，到真正开始写入时才取得下一批，避免把每个网络流式增量冻结成一个独立磁盘/索引事务。完整事件及顺序不变，append 只在所属批次保存后确认；终态仍触发同步落盘，写入失败会拒绝在途与排队调用。该合批不向模型注入额外约束，也不丢弃 thinking/text 事件。

后台任务等待使用会话持有的 TaskStore。`task_status` 查询指定任务时默认等待至多 30 秒，退出事件会提前结束等待，返回时重新读取状态及已排空的输出；`wait_ms: 0` 是立即快照，不指定 task_id 的列表查询也立即返回。等待到期仍返回 running，不推断任务失败，也不启动替代任务。signal 取消只结束本次等待并清理监听器；整轮取消后 Runtime 原有的后台任务处置仍照常执行。

工具附带独立的 `runtime.taskObservation` 状态。重复守卫仅对成功查询、ID 匹配、当前仍 running 的受管任务免除 `max_repeat`；普通输出中的“running”、未知/已退出任务、失败查询均不享有该豁免。有效等待仍消耗原有模型轮次、工具次数与时间预算，不能无限续跑。该边界修复了连续查询活跃任务导致整轮提前结束的问题，不把等待或任务退出等同于验收通过。

`close()` 在执行或持久化仍在进行时明确拒绝，防止超时调用方提前关闭存储。等待旧操作结束后可以正常关闭；无法结束的存储调用需要外层宿主管理进程生命周期。

JavaScript 定时器不能打断同步存储或内核阻塞。实现会在异步阶段返回时复核单调时钟，避免事件循环阻塞后误报按时成功；严格的进程级硬截止仍由外层宿主负责。该机制不能据此宣称原 Bench 的 189 秒延迟已经定位或消失。

## 4. Headless 公开检查入口

创建 `checks.json`，只登记允许模型看到的公开要求：

```json
{
  "version": 1,
  "id": "public-result",
  "revision": 1,
  "maxRepairAttempts": 2,
  "budget": { "modelCalls": 16, "toolCalls": 12, "timeoutMs": 180000 },
  "checks": [
    { "id": "content", "path": "result.json", "kind": "json-equals", "pointer": "/ok", "expected": true },
    { "id": "size", "path": "result.json", "kind": "file-size", "maxBytes": 64 },
    { "id": "encoding", "path": "result.json", "kind": "utf8" }
  ]
}
```

```sh
bun src/index.tsx -p 'Write result.json with ok true.' \
  --public-checks checks.json --result-schema outcome-v1 --output-format stream-json
```

命令沿用正常权限审批与执行后端；无人值守宿主需要按其权限策略预先授权写入。配置路径相对 `--cwd`；文件至多 128 KiB、1–64 项检查、0–10 次额外修复，拒绝未知字段或可执行命令。产物必须是工作区内相对路径的普通文件；缺文件、符号链接、不稳定快照、总文件超过 16 MiB 等情况停止，当前不会自动修复这些前置条件。

`file-size` 检查包含上界的字节数；`utf8` 严格拒绝非法编码；`json-equals` 先验证 UTF-8 和 JSON，再通过 JSON Pointer 选择值，与公开的 string/number/boolean/null 做精确比较。空 pointer 选择根值，`~1`/`~0` 转义 `/`/`~`。CLI 公开检查自动允许回送选定值及检查诊断；不要登记私有文件或隐藏答案。配置在模型执行前读取并固定，运行中修改配置文件不会改变本次标准。变更标准时宿主应增加 revision。

该入口要求全新 outcome-v1 会话，拒绝 `--continue`、`--session-id`、legacy 结果或旧完成契约。关闭 `agent`、`delegate_agent` 和 `cron_create` 等无法计入根预算的入口。其余工具保持正常权限、checkpoint 和 broker；SDK/自定义工具内部调用外部 API 的费用不计入根 provider 次数。`--timeout-ms` 与配置预算同时存在时取较小值。总预算从修复会话建立开始，包含验收预检、执行、封存和修复；不覆盖 CLI 先前的模型/工具配置加载或之后的宿主清理。

最终 JSON 的 `publicChecks` 独立包含工作流 status/code、累计调用数和逐次验收回执摘要。历史 outcome 不改写；顶层 execution 仍描述最后已封存执行，`ok` 还要求公开检查工作流 passed。尚未封存的尝试不能伪造 outcome，输出 error；如超时发生在后续尝试期间，返回的 lastOutcome 可能仍是上一已封存版本，应以 `publicChecks.code` 判定工作流已停止。回执保存于项目数据目录 `acceptance/`，不可变回执包含完整版本依赖与公开诊断；跨进程自动恢复修复尚未支持。

退出码：0 为公开工作流通过，5 为检查/修复次数/调用预算等停止，124 为共享 deadline 超时，130 为取消，2 为配置/组合参数错误，其他协议或基础设施错误为非零。`turns` 沿用既有工具轮次数语义；模型调用总数使用 `publicChecks.usage.modelCalls`，包括最终回答和压缩。

时间提示不再仅因剩余比例低于 45% 就要求收敛。接近实际 finalization reserve 时仍要求结束；显式轮次/工具/输入预算及停滞提示继续有效。

时间上下文另附本次 run 最近至多 5 轮的实际耗时，按旧到新排列，包含模型响应、轮内恢复与前台工具执行；原生和 XML 工具使用相同边界。中断或超时的轮次不作为已完成样本，新的 run 清空历史。该观测帮助模型安排诊断、实现与验证，不预测剩余可用轮数，不修改 admission、finalization reserve 或既有预算，也不将后台任务总存活时间算作前台执行耗时。

## 5. 可执行验证

定向测试：

```sh
ZAPCODE_DATA_DIR=$(mktemp -d) bun test zapsdk/tests/runtime/bounded-repair.test.ts tests/headless/public-checks.test.ts
```

真实模型集成示例：`scripts/validate-bounded-repair.ts`。通过环境变量传入受信模型配置，脚本仅在新临时目录中读写固定 `result.json`，持久化 Runtime 和验收证据，输出证据目录。不要把密钥写入命令历史或提交文件。

```sh
# 先在进程环境中配置 ZAP_REPAIR_API_KEY、ZAP_REPAIR_BASE_URL、ZAP_REPAIR_MODEL
bun scripts/validate-bounded-repair.ts --inject-size-fault
```

`--inject-size-fault` 显式在首次执行结束时追加 256 个空格，保持 JSON 语义但违反公开的 64 字节上限，用于验证失败 → 新 attempt → 修复。省略参数即可做普通单次通过路径。这是公开任务的故障注入集成验证，不是 Terminal-Bench，不用于声称其官方分数上升；官方 verifier 仍只在 Agent 退出后评分。

2026-10-13 本机真实 `deepseek-flash` 故障注入验证通过：第一轮产物 284 字节，JSON 内容通过但大小失败；第二轮新 attempt 将产物修复为 28 字节，两项均通过。两个 attempt 沿用同一 turnId，累计 6 次模型调用、4 次工具调用。原失败记录仍保留；未读取或使用任何官方隐藏 verifier 输出。

同日 Headless 新入口真实模型验证通过：使用实际 CLI 组装的 provider、工具、权限、checkpoint、事件与持久化链路，宿主在首次 sealing 显式追加 256 个空格。首次 269 字节的文件仅大小检查失败，新 attempt 修复为 13 字节，JSON Pointer、大小和严格 UTF-8 三项通过；累计 9 次模型调用、7 次工具调用，退出码 0。隔离数据目录中的原失败回执保持不变。该结果证明公开检查闭环接入 Headless，不代表官方 Bench 的语义正确率提高。

# 55. 托管后台任务与服务交付生命周期

状态：M1 生命周期事实已实现；候选 M2 已包含协议绑定、客户端、持久派发日志，以及 SDK 的可选服务工具、执行授权接线和 Outcome 投影。已提供显式本地 owner 与 Headless 接入，并有 macOS 真实进程证据；崩溃后持续租约回收、Linux/VM/Windows 验收及完整 M3 模型对照尚未完成。架构 56 已完成 SDK Host 预置服务的有限模型对照，不替代这些验收。默认 CLI/TUI 不创建服务所有者；当前 `TaskStore`、Runtime 的 `stop/host` 收尾行为保持现状。

## 问题与现行边界

普通任务可能要求一个 HTTP 服务在 Agent 返回后继续可用。执行期间请求成功，只能证明当时可用。`monitor` 当前描述包含 dev servers，`bash.run_in_background` 也允许后台进程，但工具定义没有声明所在 Host 的收尾生命周期。

`src/headless/runHeadless.ts` 给 Runtime 配置 `backgroundTasks.disposition = stop`；`AgentRuntime.runOutcome()` 在发布终态前停止这些任务。`src/singletons.ts` 在进程退出时再次清理。TUI 配置 `host`，只保证仍在运行的宿主会话继续管理任务。两者都不能证明服务在 CLI 退出后可用。当前终态可能同时含有“服务仍在运行”的模型文字和 `backgroundTasks[].disposition = stopped` 的事实。

这些行为暴露两个独立缺口：模型缺少实际生命周期事实；Host 缺少能交付持续服务的显式所有者。只改变提示词不能补齐第二项。把所有后台进程保留下来也不能提供所有权、退出清理和恢复语义。

## 必须保持的边界

1. 默认后台命令仍归当前 run 管理；原有取消、超时、权限、沙箱与清理行为继续生效。
2. 持续服务必须由可信 Host 提供所有者。模型、工具参数、进程自行 daemonize 都不能创建该能力或转移所有权。
3. SDK 不读取 Go 内部实现，不向 VM 注入提示词，不覆盖 VM/远程执行权限。只有所选执行后端声明支持时才暴露服务工具；不以本机进程替代不支持的后端。
4. 生命周期事实不触发完成门禁、额外模型轮次、自动修复或验证器重跑。自然结束仍是 execution；服务可达性和用户验收分别记录。
5. 同一事实来源驱动 Runtime 收尾和模型可见说明，避免 CLI/TUI/SDK 各自写死不同承诺。

## M1：描述真实生命周期

M1 使用 TaskStore 的临时实例身份匹配 Runtime 实际管理的注册表；该身份不进入模型上下文，也不是权限令牌。Runtime 覆盖调用参数中的所有者描述，子执行不自动继承。由 Host 的 `backgroundTasks` 配置派生只读描述：`run`（终态发布前停止）、`host-session`（由当前宿主会话管理）、`unknown`。SDK 未提供所有者信息、工具与 Runtime 使用不同 TaskStore、或调用不执行 outcome 收尾的 legacy `run()` 时使用 unknown。它不是执行配置，不能由模型覆盖。

普通/自定义/concise 提示路径都收到相同的有界动态事实；工具结果对新后台任务返回同源的 lifecycle 字段和说明。`monitor` 与后台 `bash` 共同遵循这一来源。子 Agent 只接收自己实际可用工具的事实，不继承父进程可以提供持续服务的推断。

模型可见说明应直述具体行为：run 任务会在本次执行收尾时停止；host-session 任务只由仍活跃的宿主会话管理；unknown 不承诺返回后存活。服务交付能力不可用时如实报告，不建议 nohup、脱离进程组或绕过清理。

M1 的验收只能证明事实一致与报告边界，不能宣称已解决持续服务交付。候选测试覆盖 native stream、nonstreaming、XML、自定义提示和 concise 路径；真实短命 HTTP 进程验证 monitor/bash 在 run 收尾后停止、在仍活跃的 host 会话内继续可用。新增 21 项测试覆盖上述路径；完整 Bun 回归为 3847 通过、8 跳过、0 失败，类型检查通过。Windows 的真实进程检查仍需单独验收。

## M2：独立 Host 服务所有者

增加可选 `ServiceBroker`，与 `TaskStore` 的临时任务分开。Host 先提供 broker，再注册 `service_start`、`service_status`、`service_stop`。未提供时不注册这组工具。工具入口仍经过现有 Effect/Grant/ExecutionBroker 授权。

候选接口：

```ts
interface ServiceCapabilities {
  version: 1;
  backendId: string;
  ownerScope: "host-session" | "environment";
  ownerId: string;
  ownerGeneration: string;
  workspaceId: string;
  defaultLeaseMs: number;
  ownerExpiresAt: number;
  maxLeaseMs: number;
}
interface ServiceReceipt {
  version: 1;
  operationId: string;
  serviceId: string;
  backendId: string;
  ownerId: string;
  ownerGeneration: string;
  workspaceId: string;
  requestDigest: string;
  ownerScope: "host-session" | "environment";
  state: "starting" | "running" | "stopped" | "expired" | "unknown";
  observedAt: number;
  expiresAt: number;
  // running 表示进程所有者观察到进程存活，不等于业务端点通过验收。
}
interface ServiceBroker {
  capabilities(): ServiceCapabilities;
  start(request: AuthorizedServiceRequest, signal?: AbortSignal): Promise<ServiceReceipt>;
  lookup(operationId: string): Promise<ServiceReceipt | null>;
  status(serviceId: string): Promise<ServiceReceipt>;
  stop(serviceId: string, signal?: AbortSignal): Promise<ServiceReceipt>;
}
```

`AuthorizedServiceRequest` 只能由已授权的执行入口构造，绑定 operationId、完整 shell/argv、cwd、backend/workspace identity、原始 grant 摘要、资源/网络限制、输出上限和租约截止时间。命令与 cwd 的审批语义沿用普通执行；不能把模型提交的 ID 当成授权凭据。serviceId 的访问按当前 Host 所有者校验，不能接受任意 PID 或其他会话的服务。

进程从启动时即由服务所有者管理。M2 不提供把既有 TaskStore 任务“解除管理”的操作，避免取消、封存和转移竞态。run 的取消/失败在收到可靠服务回执前撤销本次创建；已提交的 environment 服务根据 Host 明确配置的取消策略处理，并记录结果，不能静默遗留或静默停止。

服务所有者必须能在 CLI 退出后独立存活：例如执行环境自身的进程管理器。`disposition = host` 只表示当前进程内对象继续管理，不能当成独立 supervisor。没有这种后端时 CLI 的服务能力保持不可用。

## 已实施的 M2 协议基础

`zapsdk/services/` 现提供 `ServiceCapabilitiesSchema`、`ServiceStartIntentSchema`、`ServiceReceiptSchema`、`BoundServiceClient` 和 `FileServiceDispatchJournal`。上述 `ServiceBroker` 是目标接口；底层去重接口为 `ServiceTransport.lookup/start`，其上新增 `AuthorizedServiceBackend` 的授权 lookup/start/status/stop 接线。另有显式启动的 `startLocalServiceOwner`；它不自动成为默认 backend。

这些 API 是 Host 侧的关联与去重机制。构造 intent、匹配 digest 或写入 journal 都不授予权限。`authorizationDigest` 只是原授权证据的摘要，不能独立验证该授权，也不能替代 ExecutionBroker/后端对真实 grant、资源、网络和隔离的验证。工具接线必须取得所选执行后端提供的受信服务通道；缺失时不注册工具，也不退回本机进程。

当前协议绑定 backend、owner、owner generation、owner scope、workspace、operation、请求摘要与原始租约。owner 的能力或策略变化须使用新 generation，不能借用旧 owner 的回执。所有时间字段均为请求约定的 Unix epoch 毫秒；不同时钟域必须由可信适配层转换，不能把不可比较的时钟直接用于准入。

Host 授权后创建一次 immutable intent，并在重连时复用同一个 intent。日志仅保存绑定摘要和 serviceId，不保存命令正文或授权值。文件日志使用私有目录、同目录完整写入/fsync、原子 hard-link 发布和目录 fsync；派发标记在调用 backend.start 前提交。并发或重新打开日志只能有一个派发者。已知派发但回执缺失时只查询，后端返回 absent 仍不能触发第二次 start；对真实未派发的查询失败允许再次查询。

客户端等待受原 lease 绝对截止时间和取消信号约束；后端忽略信号时，客户端仍能结束等待。后台行为不明时保留 unknown，不能声称取消已停止服务。start 的后续恢复只在原 lease 内进行；历史数据解析和时间新鲜度观察不提供进程停止证明或业务健康证明。新回执须匹配已绑定的 immutable serviceId，不能静默替换同一 operation 的服务。

新增 31 项协议与日志测试已通过，覆盖真实多进程争用同一派发文件、客户端重开、回执丢失、取消竞态、迟到响应、过期、不明状态、日志损坏和符号链接。类型检查通过；完整回归为 3878 通过、8 跳过、0 失败。文件日志目前只开放具备本地目录 fsync 语义的 Unix 路径，Windows 明确拒绝；这些测试不等于断电测试或远程文件系统的持久性验收。Host 必须把日志根目录放在 Agent 无写权限的控制面位置，不能把目录权限位当成同 UID 沙箱边界。

M2a 的 SDK 授权接线与投影见下一节；本地 owner 的准入与正常生命周期见后文；M2b 的故障回收与跨平台验收、M3 仍待实施。原冻结 Bench 不加载这部分代码，不从协议单测推断模型能力或评分收益。

## 已实施的 M2a SDK 授权接线

Host 可向 `DefaultExecutionBroker` 显式提供 `AuthorizedServiceBackend`，并对同一 broker/workspace 调用 `serviceTools()` 注册 start/status/stop。没有 owner、workspace ID/root 不匹配、只读或隔离写子工作区时不注册工具。工具 handler 不启动进程；broker 验证标准 grant、资源限额和与参数一致的 Effect 后，才进入所有者通道。启动要求 process、工作区读写及 service-owner mutate 权限；停止要求同一目标的 read/destructive 权限，先检查所有者回执再派发 stop。查询缺失不触发新 start。

每份批准带 Host 生成的稳定 nonce。服务 operationId 仅由该 nonce 与选定 owner 的 capabilities 派生，重放时不能因临时 executionId 或有效 deadline 改变而生成新的派发键。会话身份、完整参数、grant、Effect、工作区、有效资源上限和截止时间仍由 intent 的完整 authorizationDigest 绑定；同一派发键出现不同授权快照时返回 unknown/冲突，不能再次 start。完全一致的授权可查询并复用原 intent；没有显式固定 deadline 的重放不承诺成功恢复，应通过原 operationId 查询。新的批准与跨会话重复的模型 tool-call ID 不共享身份。权限摘要不成为凭证。发往 backend 的完整授权快照深度冻结，命令正文和授权值不写入模型可见回执。lookup 期间 grant 到期后不再启动。

`TransparentExecutionBroker` 对服务能力和调用始终选中 workspace backend；选中 VM 而 VM 不提供 owner 时不会使用本机 owner。`DefaultExecutionBroker` 不允许把本机服务接线与自定义 processBrokerFactory 组合；远程后端必须实现自己的可信服务通道。Go VM 模块、权限和协议不变。

`AuthorizedServiceBackend` 是可信执行后端的接口，不是已实现的隔离机制。它必须在自身进程域检查和执行原授权、沙箱模式、网络、资源、取消策略与租约，并持久绑定 operation/service identity。broker 不把返回一个 receipt 等同于这些约束已由内核执行；现有 execution receipt 不伪造本机进程启动或 sandbox 次数。当前验证使用受控 backend 夹具，不能代替真实 owner 的约束验收。

broker 通过 Host 内部观察回调在派发等待前保留未知操作事实。因此外层 executor 先超时或取消时，终态仍可携带 unknown 和原 operationId，不伪造 stopped，也不补发 start。完整回执在后处理替换或异常时仍保留；普通工具的伪造 service 字段被清除。实际服务 ID、状态、scope、期限及未知操作引用使用有界模型/历史投影，模型可以查询原操作，不从缺失正文推断服务不存在。

`execution.services` 保存每个服务最新的已验证回执，`execution.serviceOperations` 保存 observed/absent/unknown 操作记录。Runtime 终态事件、持久 outcome 校验、Headless 父子工具记录及 ACP `_meta` 保留这些字段；旧记录缺少它们仍有效。running/observed 不把 acceptance 改成 passed，不添加模型轮次或完成门禁。回执可能已过期或变旧，仍是历史观察。

当前 CLI/TUI 没有自动启用服务能力，SDK Host 也必须先提供真实 backend。本地 owner 已覆盖正常生命周期；故障恢复及其他后端的验收仍不能由这些结果推断。

## 显式本地 owner：已验证的正常路径与未完成边界

`startLocalServiceOwner()` 必须运行在独立的可信 Host 进程中。它持有 `TaskStore` 的真实 ChildProcess 句柄、原 lease 的计时器、私有持久回执及 Unix socket；不会从模型参数或旧文件接管 PID。启动先实际执行一次 required OS sandbox 预检，不支持时拒绝提供能力。`connectLocalServiceOwner()` 读取私有、无符号链接的 descriptor，并通过带时间戳、nonce 和完整正文 HMAC 的通道认证；重复 nonce 被拒绝。descriptor、日志、dispatch journal 和签名材料都必须在 Agent 工作区及服务授权的读取/写入范围之外。

owner 独立复核完整 grant、命令/lease/工作区/operation 摘要、过期时间、资源上限及作用域，不只相信来自客户端的 authorizationDigest。查询目标和停止目标绑定原授权；容量在并发派发前预留。命令通过现有 broker 的真实 OS sandbox 启动，后台输出继续受有界捕获限制。没有 CPU、内存、磁盘总量或恶意 daemon 逃逸的内核级保证；不能把这些现有 Broker 限额扩写成不存在的强隔离。

网络策略也属于后端能力：macOS owner 复用相同域名过滤代理；`network=false` 时内核拒绝网络，`network=true` 不绕过原 Host allowlist。`networkPolicyDigest` 必须与所选 Host 的规范化策略一致。当前 Linux owner 不能声称执行这个代理策略；不支持的 profile 拒绝启动，不自动改成开放网络。

Headless 的 `--service-owner <descriptor>` 仅连接已经启动的 owner，不自动 daemonize，不修改个人配置，也不改变默认后台任务收尾。它要求选择本地 required sandbox、配置 `allowUnsandboxedCommands=false`、workspace 匹配以及网络策略匹配；不满足时在模型执行前退出。服务启动和停止继续经过原有审批、计划模式、显式禁用及危险命令检查；只读查询也受显式禁用约束。子工作区不继承根 owner 的工具。

正常停止和 owner 正常关闭对本 owner 的真实进程句柄批量发送 TERM、等待、必要时 KILL，并观察 close 后发布状态。lease 到期的 expired 来自已观察到的退出，不能只改时间字段。macOS 的自有中性 HTTP 夹具已证明真实 `src/index.tsx` CLI 退出后服务仍可访问，显式 stop、lease 到期及 owner 正常关闭后端点关闭；还覆盖签名重放、控制文件读取拒绝、无网络 grant、allowlist、并发容量和新 generation。

客户端取消显式结束本次 RPC 等待并关闭传输，另用相同 HMAC/时间窗/重放校验发送原请求 nonce 的取消通知，不依赖运行时是否触发 Unix HTTP 断连事件。owner 只取消该活跃请求；先到的取消保留最多 4096 项、60 秒 TTL 的记录，覆盖原签名的可受理窗口，不影响已完成请求的服务。回执持久化后、返回前再次检查取消、关闭、lease、grant 和执行 deadline；未提交确认时失效只收尾本次可靠识别的进程。通知发送失败仍保留 unknown，客户端取消本身不提供服务已经停止的证明。owner 正常关闭也等待仍在启动中的操作收尾，
包括客户端已断连、仍等待持久日志的启动，随后再完成进程和记录收尾。不能仅依赖 HTTP
连接保持关闭等待；此修复不增加 owner 崩溃后的回收保证。

突然强杀 owner 的边界不同：旧客户端看到 unavailable/unknown，未决记录阻止自动重启和按 PID 接管。当前服务可能存活，lease 回收也未知，必须由 Host 对账和回收；`ownerFailure=unknown-until-host-reconciliation` 将这个事实暴露给模型。故障测试使用具有自身短命期限的自有应用清理，不据此声称 owner 崩溃后能强制回收任意服务。因此 M2b 仍未全部完成；Linux、VM、Windows 的真实生命周期与 M3 模型行为也仍待独立验收。原冻结 Bench 不启用此 owner 或新参数。

Host 的最小启动顺序是：在独立进程中调用 `startLocalServiceOwner({controlDirectory, workspace: {id, root}, ownerExpiresAt, defaultLeaseMs, maxLeaseMs, networkPolicy})`，将返回的 descriptor 路径交给 CLI，明确授予需要的服务操作。Host 捕获正常退出信号时调用 `close()`。控制目录要使用真实的私有规范路径；descriptor 内含签名材料，不进入 prompt、工具参数、子进程环境或仓库。配置、scope 或网络策略改变时使用新 generation。

## 持久化、失败与资源清理

- 启动前写入 operation intent，再创建进程，最后写入完整回执。operationId 幂等键绑定请求摘要；同 ID 不同请求拒绝。
- 启动响应丢失时先 lookup，不再次 start。lookup 无法确认时返回 unknown，不能宣称服务不存在、成功或自动重复启动。
- supervisor 持有真实进程句柄/平台进程身份、原始执行限制与租约。仅记录 PID 不满足 PID 复用、重启恢复或 owner-death 要求。
- 启动取消、截止时间、服务提前退出、租约过期均持久记录。启动过程中已产生进程但回执写入失败时，只清理本次可靠识别的进程；无法确认则保留 unknown 供 Host 对账。
- stop 和租约到期采用有界 TERM、等待、必要时 KILL，并等待输出刷盘；失败不能伪造 stopped。TTL 回收只作用于对应 owner 的租约。
- 日志由所有者分页读取并限制总量；不能暴露可读宿主任意路径。身份/运行状态不携带凭据值。用户结束环境、显式 stop 或 Host 关闭对应 owner 时回收服务；普通 turn 结束不停止 environment 服务。

## Outcome 与观察

保留现有 `execution.backgroundTasks` 对临时任务的 stopped/host_owned/pending 语义。持续服务另用经版本校验的 `execution.services?: ServiceReceipt[]`，不能把进程仍在运行升级成 acceptance passed。新增字段须在 outcome parser、持久化、SDK、headless 和 ACP 投影中往返保留；旧记录缺少字段表示没有这份观察。

Host 展示按结构化回执说明当前状态和期限；模型早先的总结不能覆盖收尾后的事实。回执是带时间的观察，不能承诺到期前绝不退出。未知/停止/过期的服务不能作为当前可用性的证据。

## 实施顺序与验收

| 阶段 | 代码范围 | 可证明的完成标准 |
|---|---|---|
| M1 | Runtime factory、模型上下文、monitor/bash 结果与各 Host 装配 | lifecycle 来源唯一；run/host-session/unknown 的描述与真实清理一致；无服务能力时不制造承诺 |
| M2a | SDK 可选 ServiceBroker、工具 Effect/Grant、回执验证与 Outcome | 未配置无工具；权限拒绝不启动；远程/VM 不回落本机；幂等、未知和取消语义可测 |
| M2b | 独立环境服务所有者及 Host 适配 | CLI 真正退出后服务仍由可信 owner 管理；状态、显式 stop、租约、owner 关闭和恢复对账有真实进程证据 |
| M3 | 中性集成任务与独立模型对照 | 同一通用短命 HTTP 服务任务，跨 run/CLI 退出进行外部请求，最终所有进程被可靠回收；分别报告工具行为、模型选择和外部验收 |

必须覆盖：普通 run 任务继续被停止；TUI 会话继续持有任务但关闭后停止；服务启动未就绪、启动失败、权限拒绝、资源不足、取消竞态、响应丢失、重复 operationId、跨 owner 访问、PID 复用、supervisor 消失和 TTL 到期。远程、VM 与 Windows 后端没有真实证据时明确记为未验收，不用本机 mock 代替。

中性集成任务使用临时目录、动态端口和仓库自有测试服务，不读取题库、隐藏断言或已有提交产物。原冻结 cohort 的模型、资源与评分不变；候选机制用新的明确版本评估，不合并重试赢家。只有 M2b 和 M3 的真实生命周期检查通过后才能声称支持执行结束后的持续服务交付。

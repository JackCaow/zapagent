# Harness 权限、预算与维护计量边界

关联：GitHub #89、#90、#91、#92；#93 为汇总路线。核实基线为
`a55fcd37e434641e7607ccc5f98d0282ffe6009a` 加当前工作区已有的图片计量改动。
所有复现使用合成数据和本地 mock provider，没有向外部模型发送用户会话。

## 核实结论

| Issue | 复现证据 | 修正原则 |
| --- | --- | --- |
| #89 | `read_file` 被拒、handler 未运行，压缩恢复仍读取磁盘标记并放入后续请求 | 恢复只能复用已成功返回的历史内容；重新读取必须通过工具授权 |
| #90 | 工具额度 0 仍执行工具；fresh input 额度 1 仍发送请求；model turns 1 仍可继续请求 | 所有 provider 调用和工具执行共用准入边界，不能只依赖循环结束时的建议 |
| #91 | 摘要和主请求实际消耗 113 tokens，旧账本只记录主请求的 3 tokens | 摘要、摘要修复、恢复重试、fallback、最终总结均逐次计量 |
| #92 | 冻结源码全量测试再次复现 delegate 进程清理失败；服务超时断言混淆派发前与派发后 | 按执行阶段验证，保留失败证据，不能靠放大超时或单次绿色归因 |

## 恢复历史内容

`restoreRecentFiles` 不再访问文件系统。它只匹配 assistant 调用之后紧邻的
`tool_result` 组，要求 `toolResultSuccess === true`，并明确标记为历史快照。
同一路径较新的拒绝/失败会阻止恢复更旧内容。没有成功标记的旧记录不自动恢复。
相对路径、远端路径、符号链接与磁盘上的后续改动都不会触发隐式重读。

session 日志恢复与 fork 保留显式成功/失败状态，缺失状态不提升为成功。重复读取的抑制
结果使用结构化 `suppression: "duplicate"` 标记；压缩恢复跳过该提示并继续寻找之前的
真实观察。标记贯通工具结果、turn/message、UI 日志及 session，不能通过解析提示字符串推断。

恢复附件最多 5 份，完整附件（路径、围栏、提示、正文）一起计入预算，默认最多
2048 tokens，并受压缩后剩余空间约束。需要当前内容时，agent 正常调用 read_file。

## 统一准入与计量

`RequestMeter` 包装实际的 SDK provider 边界，`AgentBudget` 是父子 agent 共享账本。

- `modelTurns` 约束实际 SDK 请求次数，包含维护调用、备用模型与恢复调用；不是仅数主循环轮次。
- `toolCalls` 在 handler 执行前逐个准入，流式、非流式、XML 和同一批次均复用该边界。
  已被前置去重钩子抑制的调用不计；进入准入后即使权限拒绝或执行失败也消耗调用额度。
- `freshInputTokens` 在请求前按整份输入估算预留，即假设本次缓存完全未命中；图像和工具
  schema 使用与上下文规划一致的估算器。返回后按 fresh input + cache creation 实际用量
  结算并释放预留；并发子 agent 不能重复使用同一份预留额度。历史 cache read 不能保证
  下一次仍命中，不用于提前减免预留。因此剩余额度小于完整 prompt 估算时，即使预计会命中
  缓存也会拒绝请求；这是保守准入带来的可用性限制，不是缓存感知的精确费用预测。
- 子 agent 可以收紧共享上限，不能通过创建新 meter 重置额度。达到上限后不再额外发起
  “免费”的最终总结请求；结果标记为 `limited / budget`，不伪造任务完成。
- 子 agent 已结束但没有文字报告时，适配器仅返回限长的原始观察；不再绕过子 agent 的
  预算、取消和完成事件生命周期，另外调用 provider 做一次隐藏总结。
- 失败或缺少 usage 的请求标记 `usageIncomplete`。有限 token 预算在计量不完整后停止新准入。
  失败请求消耗请求次数，不把未知费用记成已确认的零费用。
- 工具额度耗尽不会覆盖随后发生的取消或 provider 异常；已执行的流式工具批次仍提交配对
  历史。只有实际预算异常且未取消时才报告预算终止。

边界：provider 内部 HTTP 重试仍属于一次 SDK 请求，当前没有逐个 HTTP 请求的权威费用计量。
provider 返回的实际 token 数可能超过本地估算，已在途请求也无法撤销；预算会阻止后续准入，
不是服务端账单的绝对上限。旧 `maxTokens` 保留按已报告累计用量停止的语义，不能将其宣传为
精确的预付费用限制。需要货币硬上限时应由 provider/账户侧配额配合。

## 维护调用和主上下文显示

维护请求产生 `run_usage { purpose: "maintenance" }`，纳入本轮 totalUsage 和共享预算。
CLI 的回合前压缩、手动 /compact 也记录 usage journal；回合前 usage 只合并一次。
摘要格式不合格的重试仍收费、仍计请求次数。

维护 usage 不更新主对话的 context occupancy、吞吐率或 prompt-overhead 校准。
会话恢复和 fork 的最近主请求样本会过滤维护项，但完整 usage journal 保留维护记录。
这避免将小摘要请求的上下文占用误显示成整个主对话的占用。

回合前计量状态在创建回调前初始化，避免摘要成功返回后触发暂时性死区异常。
维护事件也不写入 hook 的主请求缓存历史。回合前压缩与手动 `/compact` 的日志写入
失败会报告独立的持久化错误，不能把已成功生成的摘要当作压缩失败丢弃。

## 验证入口

- `zapsdk/tests/context/restore-files.test.ts`：拒绝、失败、缺失结果、复用 call id、
  历史内容与磁盘变化、Unicode 和完整附件预算。
- `zapsdk/tests/agent/harness-boundaries.test.ts`：三种调用路径的零额度；批量工具精确准入；
  并发输入预留；摘要/格式修复/fallback；缺失 usage；同步 abort + throw。
- `tests/maintenance-usage.test.ts`：维护记录持久化且不污染主上下文样本。
- `tests/agent/preturn-maintenance.test.ts`：通过隔离子进程执行实际 hook、事件处理器和
  手动命令；验证回合前/手动压缩、日志写入失败隔离以及主请求缓存历史不被维护样本污染。
- `tests/session-read-provenance.test.ts`：实际保存、恢复、fork 后的读取成功状态与重复抑制标记。
- `zapsdk/tests/agent/loop.budget-interruption.test.ts`：流式工具批次额度耗尽后的取消、异常及正常结束。
- `zapsdk/tests/builtin-tools/subagent-salvage-boundary.test.ts`：空报告仅返回限长观察，不追加 provider 请求。
- `zapsdk/tests/runtime/bounded-repair.test.ts`：修复额度耗尽与取消传播。
- `zapsdk/tests/services/service-execution.test.ts`：派发前截止没有虚构服务事实；派发后取消保留
  unknown operation；实际计时器测试依据已观察的派发阶段断言。
- `zapsdk/tests/execution/process.test.ts`：真实 POSIX 进程、继承输出和脱离进程组的后代回收。

执行测试须使用独立 `ZAPCODE_DATA_DIR`。全量测试开始后冻结代码；不能用并发改源码造成的
混合模块结果作为回归结论。本文件不代表 GitHub issue 已关闭或改动已提交。

## 本次验证结果（2026-10-19）

- Claude Code 守门审查修复后冻结代码全量：`4443 pass / 17 skip / 0 fail`，4460 项、378 文件，113.51 秒。
- `bunx tsc --noEmit`、`bun run build`、`git diff --check` 均通过。
- 两名独立 agent 分别检查预算准入及恢复/维护计量。修复其发现的回合前回调暂时性死区、
  维护样本污染主缓存历史，以及手动压缩日志错误传播问题；新增动态回归覆盖这些实际入口。
- 原始合成复现脚本重跑：拒绝文件标记不再进入请求；工具额度 0 时 handler 执行 0 次；
  fresh input 额度 1 时 provider 请求 0 次；model turns 1 时 provider 请求 1 次，均返回 limited/budget。
- 共享请求额度 1 时只发起摘要请求，实际返回 110 tokens，账本和 totalUsage 均记录 110，
  不再额外发起主请求。这也展示了前述“本地估算不是服务端账单硬上限”的边界。
- #92 进程清理：本次早期冻结全量和一次单文件运行均观察到 6 秒兜底清理触发；之后带/不带
  临时诊断的多轮单文件以及两轮全量通过，GC 探针也未复现。尚未在失败时获得进程身份诊断，
  因此**没有确认根因、没有修改生产进程清理逻辑、不能宣称该项已修复**。临时诊断已移除，
  原有回归和清理保障保留；该子项应继续开放。服务测试的派发前/后阶段断言已经修正。

上述结果仅覆盖已执行的测试；17 项环境依赖的 skip 不视为通过。没有关闭 issue、推送分支或
替换工作区原有的图片 token / models.dev 改动。

## Claude Code 最终守门审查（2026-10-19）

使用 Claude Code 2.1.296、`claude-opus-5-5`。用户明确授权后，将不含凭据、个人配置与
session 数据的源码快照交给外部模型；仅开放 Read/Glob/Grep。初审 FAIL，指出五项 P2：

1. 子 agent 结束后存在未计量的备用总结调用：删除额外 provider 调用，仅保留限长原始观察。
2. meter 的 blocked 状态掩盖取消/provider 异常：仅明确预算异常进入预算终止，保留工具历史。
3. session 恢复丢失读取成功状态：贯通成功、失败及未知状态，并验证真实保存、恢复与 fork。
4. 缓存预算文档与实现不符：保留完整输入的最坏情况预留，明确缓存命中不可提前保证及可用性代价。
5. 重复读取提示覆盖真实快照：用结构化 suppression 标记贯通运行时和持久化，恢复时跳过该提示。

修复后的增量复审为 **PASS**，没有新增可执行 P1/P2；复审结束后逐文件校验源码与快照一致。
该结论只覆盖本次修复，不代表全产品验收，也没有解决 #92。Claude 只进行了静态调用链审查；
动态回归、全量测试、类型检查和构建由宿主另行执行。

验证边界：取消与预算叠加的新回归覆盖原生流式路径，XML/非流式在此次复审中为静态核对；
备用输出测试隔离模拟空报告，并非真实模型产生空报告的端到端验收。共享预算跨复用 runtime
持续累计、未知 usage 关闭有限 token 准入属于现有边界；MCP sampling 不在本次 LoopAgent
请求计量范围内，不能据此宣称所有宿主模型调用均已统一计量。

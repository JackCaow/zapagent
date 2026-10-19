# 43. M2 宿主 inline 验收实施契约

状态：SDK 实现；验证记录见文末。日期：2026-10-12。

2026-10-13 接线更新：已补齐 inline 报告导入、持久投递恢复及 CLI/HostProtocol 控制，见 [46. 接线交付记录](46-outcome-workflow-delivery.md)。本篇其余内容保留所属阶段的历史边界。

后续进展：M3a 已新增独立 deferred 控制层，见 [44. 延后验收与持久化工作流控制](44-deferred-workflow-control-m3.md)。下文保留 M2 本身的接口边界；M2 inline 报告尚未自动接入新控制层。

## 1. 范围与入口

M1 已建立不可变的执行终态。M2 增加宿主显式调用的 inline 验收：规范预检、稳定版本、依赖绑定、deadline/cancellation、结果聚合及独立持久化。CLI/TUI/ACP/Terminal-Bench 继续使用 M1 默认执行方式，普通编辑不要求提交 Git，也不注入验收驱动续跑。

公共 API 从 `zapsdk/runtime/index.ts` 和 SDK 根入口导出：

- `runWithInlineAcceptance(runtime, input, options)`：在模型/工具执行前预检，调用一次 `runtime.runWithOutcome()`，等执行终态已发布后验收并保存报告。
- `InlineAcceptanceCoordinator`：可对宿主已有的 outcome 调用 `evaluate()`，不会调用模型。首次 evaluate 自动完成预检。
- `GitCommitSnapshotProvider`：为已提交且干净的 Git 工作树提供固定 HEAD 的对象读取能力。
- `InMemoryAcceptanceStore` / `JsonAcceptanceStore`：独立的不可变报告存储。

这收敛了第 42 篇保留的 required/inline 入口方案：`runWithOutcome()` 仍只接受 observe/none；M2 使用显式组合函数，而非扩展原结果语义。第 42 篇保留的 `HostVerifier` / `StableSnapshot` 类型没有直接启用。新的 `InlineHostVerifier` / `AcceptanceSnapshot` 强制绑定版本并以只读 API 访问内容。

返回 `{ loopResult, outcome, acceptance }`：`outcome` 是 M1 原始执行终态；`acceptance` 是独立 `zap.acceptance` schema 1 报告，含 workflow 判断。旧 `outcome.acceptance` / `outcome.workflow` 不被覆盖。新报告也不伪装成 Runtime 的第二条 `attempt_ended`。

## 2. 预检契约

`InlineAcceptanceConfiguration` 必须显式提供 `mode: required`、`timing: inline`、spec、snapshotProvider、verifiers、store 和正整数 timeoutMs。未知顶层字段（含 repair）提前拒绝。

规范必须有非空 subject/check、唯一 ID 和路径、正整数 revision；路径相对快照根，拒绝绝对路径、反斜杠、空段、`.`、`..`、`.git` 和 NUL。check 的 verifier 必须存在，依赖不能重复或引用未知 subject。存在与删除分别写为 `expected: exists/absent`。没有隐式“所有写过的文件都必须保留”约束。

调用开始时复制并冻结 spec，固定 provider/verifier/store 的方法引用。模型运行期间修改调用者的原配置不能撤销检查。规范或 verifier 的语义变化必须提升 spec revision。

预检预算为 `min(timeoutMs, 10000)` 毫秒，检查存储可写及原子插入能力、Git 根路径和 provider 能力；预检失败、超时或取消时，模型/工具调用数为 0。它不保证之后设备/文件系统永远可用。

## 3. 稳定快照与可信边界

snapshot provider 是宿主代码能力，不接受模型参数自行声称稳定性。自定义 provider 必须提供真正不可变的源及版本；只有 `proof: immutable_snapshot` 受本轮支持。SDK 不把普通目录、逐文件复制、前后 hash 相同或 Runtime writer lease 当作稳定性证明。`all_writers_excluded` provider 尚未开放。

内置 Git provider：

1. 预检 root 必须是真实仓库根，解析 macOS 等平台的路径别名。
2. 执行后固定完整 HEAD commit ID，检查工作树/index/untracked/submodule 状态，以及 HEAD 是否变化。脏工作树、有 assume-unchanged/skip-worktree 标记的 index 均返回无稳定快照，报告为 `unverified`。读取时禁用 fsmonitor 和 untracked cache。
3. subject 绑定 commit 内的 blob/tree ID；删除绑定同 commit 下的缺失路径。被 ignore 的 subject、符号链接和 submodule subject 返回无稳定快照。目录仅提供 tree 版本/存在性，`readFile` 不遍历目录。
4. verifier 通过 `snapshot.readFile(subjectId, signal)` 读取指定 Git blob，不得到可变工作区路径。关闭 replacement refs；读取后重新计算 Git 对象哈希，字节不匹配时返回错误。
5. 后续工作区修改不改变已捕获的版本。报告只证明该 commit，不证明此时磁盘上的工作区；后续交付必须消费报告里的相同 snapshotId。

Git provider 不替 Agent 执行 add/commit，不触发 Git hook，不创建临时提交。普通未提交编辑继续使用 observe。需要验收未提交内容的宿主应自行提供有真实不可变保证的 provider；本轮不提供伪稳定目录回退。Git blob 没有原来 1 MiB 证据上限，当前读取 API 使用内存承载完整文件，宿主应为大文件选择合适的 verifier 资源预算。

## 4. 回执与聚合

每条 verifier 回执必须有 `checkId / attemptId / specId / specRevision / snapshotId / dependencies / status / code / evidenceRefs`。dependencies 逐项等于规范声明依赖在本次快照中的 `{ subjectId, exists, version }`，按 subjectIds 顺序记录。

每个 verifier 必须恰好返回它负责的全部检查；遗漏、重复、未知 check、旧 attempt、旧 spec、旧 snapshot 或依赖版本不匹配统一产生 `error / INVALID_VERIFIER_RESULT`，不得放行。快照 API 仅提供该 verifier 所有检查声明的依赖集合，读取其他 subject 返回 `UNDECLARED_CHECK_DEPENDENCY`；同一 verifier 内每项检查的依赖完整性由宿主实现负责。Agent 自主检查或自然语言自报不作为这些回执。

先验证所有 subject 的存在/缺失要求，不匹配为 `failed / SUBJECT_EXPECTATION_FAILED`，不继续调用 verifier。其余 verifier 顺序执行，聚合优先级为 error、failed、passed；已完成的检查保留。缺少稳定版本为 `unverified / STABLE_SNAPSHOT_UNAVAILABLE`。provider/verifier 异常作为验收 error，不能重写执行状态。

## 5. 超时、取消与发布

timeoutMs 是执行结束后快照采集及全部 verifier 共享的预算，绝不是每个 verifier 一份完整预算。预检预算独立。超时或调用者 AbortSignal 中止会发送 verifier signal，忽略随后返回的 passed，保存 `ACCEPTANCE_TIMEOUT` / `ACCEPTANCE_CANCELLED`。

Promise deadline 能约束异步等待，无法抢占在同一 JS 线程上无限运行的同步宿主代码。verifier 是可信宿主扩展，必须协作取消、只读访问交付版本、把日志写到独立位置；需要强制终止任意程序时，宿主应在隔离进程/容器内实现 verifier。SDK 不提供验收专用的权限绕过。

`finished + passed` 且没有未解决动作、pending 后台进程或执行错误才产生 `workflow.ready`，其余均 blocked。limited 可验收已产物，但不会 ready；blocked/cancelled/failed 执行不调用 verifier。ready 仅是与 snapshotId 绑定的报告，不授权部署/合并，也不触发动作。

报告在检查结束后封存，然后等待 store.save 成功才返回。存储失败 reject `ACCEPTANCE_PERSISTENCE_FAILED`，执行终态仍可从 Runtime 读取。文件系统持久化等待不算 verifier 预算；封存后取消不重写该报告。本轮没有持续有效的 workflow 取消控制，M3 才提供 control revision 和动作提交边界。

## 6. 持久化与恢复边界

`zap.acceptance` schema 1 / revision 1 是独立记录，保存完整原 outcome、spec及摘要、快照版本、检查回执和 workflow 判断。记录 ID 由 threadId + attemptId 确定；一个 attempt 只有一个已发布报告。

Json store 以私有权限写临时文件并 fsync，通过同目录 hard link 原子地“不覆盖插入”，POSIX 额外同步目录。相同记录重复保存幂等，不同内容拒绝；重开读取时校验完整身份和 passed/ready 一致性。Windows 不声明 POSIX 目录 fsync 保证。内存 store 无重启恢复承诺。

已保存报告可直接 load/evaluate 复用，不重跑 verifier；换规范不能覆盖旧 attempt。无报告表示尚无放行证据。进程在验收中退出时，已发布 execution 保留；不会自动补出 passed，也不会在 Runtime 恢复时自动重跑验收。显式重试已有 outcome 可能再次运行只读 verifier；并发 evaluate 不承诺只执行一次，存储只允许一个最终记录胜出，冲突的一方失败。宿主须避免并发发起同一 attempt 的验收。本轮没有外部副作用 dispatch。

验收 ledger 不写入 Runtime state/event schema 3，HostProtocol 没有新增异步验收订阅。外部回调认证、revision 更新、pending 恢复、deferred、repair、workflow wait 和动作 dispatch 均属于 M3。

## 7. 使用示例

用于宿主已明确要求提交后验收的工作流；store 放在仓库之外，避免记录文件使工作树变脏。

```ts
import {
  GitCommitSnapshotProvider,
  JsonAcceptanceStore,
  runWithInlineAcceptance,
  type InlineHostVerifier,
} from "zapagent";

const verifier: InlineHostVerifier = {
  id: "readme-v1",
  async verify({ outcome, spec, snapshot, signal }) {
    const text = new TextDecoder().decode(await snapshot.readFile("readme", signal));
    return [{
      checkId: "title", attemptId: outcome.attemptId,
      specId: spec.id, specRevision: spec.revision, snapshotId: snapshot.id,
      dependencies: [snapshot.subjects.find(s => s.subjectId === "readme")!],
      status: text.startsWith("# ") ? "passed" : "failed",
      code: "README_TITLE", evidenceRefs: [],
    }];
  },
};
const result = await runWithInlineAcceptance(runtime, userPrompt, {
  signal,
  acceptance: {
    mode: "required", timing: "inline", timeoutMs: 30_000,
    spec: {
      id: "readme-delivery", revision: 1,
      subjects: [{ id: "readme", path: "README.md", expected: "exists" }],
      checks: [{ id: "title", verifierId: verifier.id, subjectIds: ["readme"] }],
    },
    snapshotProvider: new GitCommitSnapshotProvider(repositoryRoot),
    store: new JsonAcceptanceStore(acceptanceDataDirectory),
    verifiers: [verifier],
  },
});
// result.outcome remains the original execution record.
// result.acceptance.workflow refers only to its pinned snapshot.
```

## 8. 验证记录

针对性测试覆盖预检零副作用、执行终态先发布、验收不重跑模型、存储失败不改 execution、超时/取消/迟到结果、回执与依赖身份、聚合优先级、limited 不放行、不可变报告重开/冲突，以及真实 Git 提交、后续工作区变更、删除、大于 1 MiB 的文件、忽略文件和符号链接。

2026-10-12 在 macOS 本机验证：新增 **23 项** M2 测试均通过；隔离 `ZAPCODE_DATA_DIR` 的最终全量 Bun 测试 **3284 通过、8 跳过、0 失败**（3292 项、272 文件）；`bun run typecheck`、`bun run build` 和 `git diff --check` 均通过。Git 集成实际执行了临时仓库的提交/读取/删除/后续修改，未调用真实模型。

日志及当前源码/构建哈希保存在仓库外 `zap-benchmark-results/agent-outcome-m2-20261012-evidence/`。M1 的五题结果属于默认 observe 路径，不作为 M2 新入口的真实模型评测证据；本轮没有重复运行模型评测，也未声明 Windows/Linux 文件系统的实机验收完成。

# 非 Git 工作区隔离

## 问题与边界

真实执行轨迹中，general 子 Agent 在模型开始运行前因 `git` 不存在而失败。
`WorkspaceMode` 虽声明 `isolated-copy`，原 acquire/finalize/hydrate/merge 链路仍只支持 Git。
本次补齐普通目录的写入能力；不向 Agent 提供任何 Bench 解题信息，不改变模型、预算或完成规则。

Git 仓库且 Git 可用时继续走原后端。仅 Git 可执行文件缺失或目录不属于 Git 仓库时选择 copy；
权限、损坏、clone 失败不触发静默降级。恢复使用租约记录的后端，避免环境变化使旧产物失去身份。

## 数据与生命周期

- 初始快照只建立一次，同批写 Agent 各自获得独立文件副本，不使用硬链接，不修改主目录 `.git`。
- 普通文件按固定大小缓冲读写与 SHA-256 校验，保留可执行位、二进制内容、目录及安全相对链接。
- `.git` 和原 untracked-secret 名称策略覆盖的文件不进入初始副本；子 Agent 新增这些路径时明确报错。
- 外部、悬空、循环链接和非普通文件明确拒绝；链接不作为共享写入口。此版本尚不支持这些输入的复制。
- `baseOid` / `resultOid` 在 copy 后端表示内容及元数据清单的 SHA-256；Git 后端保持 Git commit OID。
- copy artifact 显式带 `mode: isolated-copy`；旧 artifact 缺少 mode 时按 Git 读取，保持历史恢复兼容。
- finalize 将产物复制到独立的内容寻址目录；之后修改子 Agent workspace 不会改变已冻结产物。
- acquire、artifact、hydrate、cleanup 使用现有生命周期事件和 StateTracker。
- hydrate 校验 owner marker、线程、目录边界、租约身份、基线和结果哈希及 changedPaths。

默认 copy 临时根位于系统临时目录中，按用户与工作区路径哈希分组；显式 tempRoot 必须在源目录外。
系统清理临时目录会使恢复证据不可用，恢复必须明确失败，不能重建一个假定等价的旧基线。

## 合并与故障恢复

1. 校验所有冻结产物，与共同基线比较并组成最终目录树。
2. 不同文件的改动可组合；同路径竞争修改或结构性重叠拒绝。copy 后端暂不自动进行同文件文本三方合并。
3. 检查主目录变动、被删除目录中的新增文件和被排除的私密文件，保留无关主目录修改。
4. 在私有 batch 内构建并校验合并树，再调用统一 onTrackEdit。
5. 在主目录所在文件系统准备临时结果与原件备份，写入持久化 intent 后逐项 rename。需要修改只读目录内的文件时，记录并临时补齐目录 owner 权限，安装后恢复目标模式；回滚恢复原模式。
6. 普通异常尝试回滚；原件缺失或用户并发修改导致证据冲突时保留目录和 journal，并报告恢复未完成。
7. 显式重试 merge 会先校验并恢复本 batch 的中断事务；已持久化 committed 的事务只完成清理。
8. cleanup 和 retention 不删除仍有 pending journal 的 batch，避免丢失原件位置和恢复依据。删除自有副本和备份前恢复目录 owner 访问权，不跟随其中的符号链接。

这是有恢复记录的多文件事务，不是文件系统提供的多文件原子可见性；外部读者可能看到安装中的中间状态。
路径检查和文件副本也不替代 OS sandbox。已有 permission、allowedPaths、ExecutionBroker 策略继续生效。
copy diffStat 的 files 计入变动路径（含目录），additions/deletions 为 0，未计算文本行差异。

## 验证与收益判定

通用 fixtures 覆盖：缺 Git、普通目录、子 Agent 工具实际写入、兄弟隔离、冻结后再修改、二进制和权限、
空目录、增删、特殊文件名（含 `__proto__`）、只读目录权限恢复与清理、同目录兄弟新增、主目录漂移、冲突无应用、链接边界、私密文件保留、marker/hydrate、
Host recovery controller、合并中断窗口、恢复冲突及 retention 保护。Git 后端原有回归同时执行。

真实 Bench 必须使用同一模型、相同任务校验和及原时间/轮数预算，全新运行并保存所有失败。
单元测试通过只证明所覆盖的执行边界；不能据此宣称题目通过或正确率提升。

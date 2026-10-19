# `zapsdk/checkpoint` — Checkpoint / Rewind

当前产品契约：每个 Agent 回合开始前创建逻辑恢复点；原生文件工具执行前备份其确切目标。
`/rewind` 可以恢复代码、对话，或者两者；空输入时连按两次 Esc 打开选择器。
实现对齐 [Claude Code 公开的 checkpointing 行为](https://code.claude.com/docs/en/checkpointing)，不依赖闭源内部实现。

## 能力与权限边界

- 原生 `write_file`、`edit_file`、`multi_edit`、`delete_file`、`move_file` 通过
  `checkpointTracking: "files"` 和 `writesPath` 声明确切备份路径。
- Bash、外部进程使用 `checkpointTracking: "unsupported"`，它们的文件 effects
  仍用于权限和执行策略；cwd 或目录写入范围不能当成文件备份清单。
- 产品 Host 默认显式选择 `best-effort` checkpoint 模式；普通恢复是 best effort。关闭文件备份或文件不可备份时，已经授权的操作可继续，
  工具结果与恢复预览说明实际覆盖范围。关闭文件备份仍保留对话恢复点。
- SDK 显式 `checkpointRequirement: "required"`、`before-write`、
  `before-destructive` 保持 fail closed。严格策略始终检查 `writesPath` 与 effects 声明的完整并集；要求的文件无覆盖时，handler 不执行。
- 权限审批、sandbox、路径控制独立于 rewind。申请退出 OS sandbox 需要独立授权，可选本次、当前会话或当前项目；
  普通 Bash 允许规则不能授予退出权限，危险命令与显式 ask 仍逐次审批，拒绝与后端限制仍优先；
  单独的 DNS、网络错误不能作为要求退出 sandbox 的依据。
- 恢复不覆盖 Bash、外部进程、未追踪修改、项目目录外文件、符号链接、硬链接及超限文件。
  项目根本身的系统别名（如 macOS `/var`）可识别；根下链接跳过并说明原因。

## 生命周期与持久化

```text
LoopAgent.onRunStart
  beginTurn(preTurnMessageIndex, { journalLogIndex, uiLogIndex }, input)
  → 创建 kind:turn 恢复点（允许 trackedFiles 为空）
  → 原子保存私有 index + durable session JSONL

ToolExecutor（现有审批/策略通过后）
  native writesPath → trackEdits
  → 首次修改前读取文件 / 记录 absent
  → 原子保存 blob，再更新 index 和 durable JSONL
  → handler 执行

LoopAgent.onRunEnd
  makeSnapshot → 封存同一恢复点，清除 pending
```

因此 metadata 不依赖回合收尾才落盘；进程在工具执行后被终止，也能从私有索引恢复。
同一点逐次发布使用稳定 snapshot id，重放和 fork 按 id 更新，不把每次备份更新显示为新回合。

恢复点包含 `prompt`、稳定 id、回合位置、独立的 journal/UI 边界、`trackedFiles`、
`skippedFiles` 和 blob 所属 session。文件备份分为 `present(blob, mode)` 与 `absent`。
同回合同路径仅保留首次备份。从目标回合向后遍历，每路径取第一份备份，重建边界状态。

`turnStartIndex` 仅兼容旧数据；compact 会改变消息数量。恢复 marker 以稳定 snapshot id
和 journal 边界定位；App 从 marker-aware journal 重建 conversation、todo 和 usage 上下文，
不直接用旧消息下标截断经过 compact 的模型历史。UI 使用独立的 `uiLogIndex` 或 journal 映射。

## 三种恢复方式

| 模式 | 文件 | 对话 / todo 分支 | 恢复点 | 输入框 |
|---|---|---|---|---|
| `both` | 恢复已追踪文件 | 回到所选回合之前 | 丢弃目标及后续点 | 回填原提示 |
| `conversation` | 保持当前文件 | 回到所选回合之前 | 丢弃目标及后续点 | 回填原提示 |
| `code` | 恢复已追踪文件 | 保留当前对话 | 保留 | 保留当前草稿 |

纯聊天、未追踪写入或代码已经相同时仍可恢复对话。预览失败（如 blob 丢失）也允许仅恢复对话。
对话恢复优先回填原始 `restoreText`，并从用户日志恢复图片引用；没有日志时使用持久化 prompt。
有草稿时双 Esc 将草稿保存到输入历史并清空，随后可用上箭头找回；空输入双 Esc 打开菜单。
队列、附件、审批和运行中中断保留原有键盘优先级。菜单打开时暂停自动队列续跑，运行中禁止应用恢复。

文件恢复先读取和校验全部目标/blob，再开始原子写入和 chmod；路径在发布前再次校验。
文件或 durable marker 写入失败时补偿回滚已经应用的文件。仅恢复对话不读取 blob。
文件恢复遇到当前符号/硬链接会跳过并返回原因，不覆盖链接目标或拆开链接关系。
这些是应用内补偿事务；不承诺多个文件在断电时具备文件系统级原子性。

## 存储与保留

产品 Host 使用 `managedStorage: true`：

```text
<project-snapshot-base>/sessions/<sha256(sessionId)>/
  index.json                 # 原子写入、fsync；0600
  blobs/<hash[0:2]>/<rest>    # SHA-256 内容寻址；0600，目录0700
```

- 默认每会话保留100个恢复点、512 MiB唯一 blob，单文件10 MiB。
- 活跃回合达到预算后跳过新增大备份，明确记录部分覆盖；严格调用仍拒绝执行。
- 默认30天到期，在下次访问该会话时淘汰；不后台遍历所有历史会话。
- index 的保留范围具有权威性，旧 append-only JSONL 不得重新引入已淘汰 blob。
- GC 只删除当前会话私有 namespace 内不再引用的常规 hash 文件，不遍历其他会话，
  不跟随目录链接，不删除 legacy 共享存储或未知文件。
- fork/resume 在发布自己的 index 前将仍可用的引用复制到自己的 namespace。
  后续父会话淘汰不影响已导入 fork。源已到期的恢复点不会重新出现。
- 历史共享存储作为只读 fallback 保留。JSONL 会话记录、未访问的历史 namespace 和
  legacy 数据不计入本会话 blob 预算；这是保留范围，不能宣称整个数据目录有全局硬上限。

SDK 默认保持旧 `trackEdits → makeSnapshot` 接口及存储布局；仅文件修改会生成旧式 snapshot。
SDK Host 若需要新的持久化和 GC 契约，应显式开启 `managedStorage`，接入 `beginTurn`，
并在恢复会话时调用 `hydrateFromJsonl`。TUI 和 headless 已接入。

## 模块与验证

| 文件 | 职责 |
|---|---|
| `index.ts` | 生命周期、覆盖报告、导入、保留策略 |
| `archive.ts` | 会话私有 durable index、引用 GC |
| `blob-store.ts` | hash 校验、原子存储、fork 实体化 |
| `snapshot-store.ts` | id 索引、首写备份、向后遍历、截断 |
| `paths.ts` / `track-edit.ts` | 项目边界、链接排除、首写备份 |
| `rewind.ts` | 差异预览、三种恢复、补偿回滚 |
| `src/ui/dialog-rewind.tsx` | 选择、模式、原提示回填 |
| `src/session.ts` | durable snapshot/marker、marker-aware replay/fork |

关键回归：`zapsdk/tests/checkpoint/contracts.test.ts`、`tests/checkpoint-resume.test.ts`、
`tests/session.test.ts`、`tests/ui/dialog-rewind.test.ts`。
真实终端验收：`RUN_TUI_PTY_TESTS=1 bun test tests/ui/rewind.pty.test.ts`，
使用独立 tmux、本地模型 fixture、隔离数据目录，包含文件审批、三模式、双 Esc。

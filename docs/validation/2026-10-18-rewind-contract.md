# Rewind 契约修复验收（2026-10-18）

对应架构：[Checkpoint / Rewind](../architecture/14-sdk-checkpoint.md)。
测试环境：macOS ARM64、Bun 1.3.14。本地模型 fixture，不使用真实 provider 或用户凭据。

## 修复范围

| Review 问题 | 实现与验证 |
|---|---|
| 备份能力变成普通执行门槛 | 产品默认 `best-effort`；原生文件工具不再硬编码 required；普通超限删除成功，显式 before-write / before-destructive 仍拒绝无覆盖写入 |
| 只有编辑结束后才能恢复 | 回合开始生成逻辑点；纯聊天、禁用文件备份也能恢复对话；三种恢复、原提示回填、双 Esc 均验收 |
| 工具完成后、回合结束前崩溃丢备份 | handler 前保存 blob、私有索引和 durable JSONL；真实 LoopAgent 子进程在写入后被 SIGKILL，再进程恢复成功 |
| Bash cwd 当作备份文件 / 别名误报 | process effects 保留权限用途，Bash 不参与文件备份；`/var` 与 `/private/var` 两向匹配，同时拒绝项目外文件链接 |
| FIFO 索引无法回收 blob | 私有 namespace，默认100点、512 MiB 唯一 blob、10 MiB 单文件、30天按访问到期；回收未引用 blob；旧 JSONL 不能复活已淘汰点 |
| Fork 依赖父会话共享 blob | 导入前实体化本地副本；父会话 GC 后 fork 仍可恢复；旧共享存储不删除 |
| 链接恢复改变语义 | 符号链接和硬链接跳过并显示原因；不覆盖目标或拆开链接关系 |
| 重复/误导显示与恢复并发 | 备份覆盖说明保留在实际工具结果及预览，移除重复 transcript 通知；菜单暂停队列；恢复对话重新绘制屏幕 |
| 沙箱提示诱导逃逸 | DNS 等泛化错误不产生逃逸建议；显式退出 sandbox 仍逐次审批，显示真实批准/拒绝结果 |
| 严格策略完整性 | delete/move 源声明 delete effects；严格检查 writesPath 与 effects 的完整并集，原生精确文件提示也不能缩小它 |

## 验证命令

所有 Bun 测试设置临时 `ZAPCODE_DATA_DIR`；PTY 另创建独立临时工作区、tmux server 和本地 HTTP provider。

```sh
bunx tsc --noEmit
bun run build
bun test --timeout 60000
RUN_TUI_PTY_TESTS=1 bun test tests/ui/rewind.pty.test.ts
RUN_TUI_PTY_TESTS=1 ZAP_TEST_COMPILED_BINARY=/absolute/path/to/dist/zap bun test tests/ui/rewind.pty.test.ts
```

真实终端 fixture 同时检查代码/对话/两者恢复、原提示回填、双 Esc 清稿后历史找回、
空输入双 Esc 打开菜单、纯聊天点、文件写入审批，以及超限文件在普通模式批准后仍可删除。
编译产物在仓库外目录运行。

## 结果

| 检查 | 结果 |
|---|---|
| TypeScript | `bunx tsc --noEmit` 通过 |
| 可执行文件 | `bun run build` 通过（2034 modules） |
| 全仓 Bun 测试 | 4014 pass / 10 skip / 0 fail；4024 tests，341 files |
| 源码真实终端 | 1 pass / 0 fail，11 项断言 |
| 编译产物真实终端 | 1 pass / 0 fail，11 项断言；仓库外工作区 |

全仓默认跳过的 opt-in Rewind PTY 用上述两次显式运行单独验收；其他跳过项仍按各自环境条件保留。

## 边界

本地测试不代表真实 provider、Windows/Linux 的独立平台验收或 npm 已发布。
文件恢复是补偿事务，不提供多文件断电原子性；Bash/外部进程不受文件 undo 覆盖。
保留预算针对会话私有 blob，历史 JSONL、legacy 数据及未访问会话不属于全局磁盘硬上限。

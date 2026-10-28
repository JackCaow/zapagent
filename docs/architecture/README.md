# Zapcode 架构文档

按模块整理的实现详解。代码分两层：`zapsdk/`（可复用 agent SDK，零 React
依赖）和 `src/`（Ink/React TUI 宿主）。

| # | 文档 | 范围 |
|---|---|---|
| 00 | [Overview](00-overview.md) | 两层架构 / 一个 turn 的请求流 / 数据持久化位置 |
| **SDK 层** | | |
| 10 | [SDK core](10-sdk-core.md) | `zapsdk/core` — LLM 抽象、providers、Turn[]、retry、stream-idle |
| 11 | [SDK agent](11-sdk-agent.md) | `zapsdk/agent` — LoopAgent / 流式工具执行 / events / budget |
| 12 | [SDK tools](12-sdk-tools.md) | `zapsdk/tools` 框架 + `zapsdk/builtin-tools` 全套内置工具 |
| 13 | [SDK context](13-sdk-context.md) | `zapsdk/context` — autocompact / microcompact / token 估算 |
| 14 | [SDK checkpoint](14-sdk-checkpoint.md) | `zapsdk/checkpoint` — 回合恢复点、代码/对话恢复及保留策略 |
| 15 | [SDK memory + MCP + skills + tasks](15-sdk-memory-mcp-skills-tasks.md) | 四个独立子系统 |
| 16 | [SDK devtools/debug/utils](16-sdk-devtools-debug-utils.md) | 浏览器 devtools / 日志 / 平台 / 工具结果落盘 |
| **App 层** | | |
| 20 | [App shell](20-app-shell.md) | `src/index.tsx`、`App.tsx`、`session.ts`、`singletons.ts`、`config.ts` |
| 21 | [App agent + permissions](21-app-agent-permissions.md) | `src/agent/`、`agent-factory.ts`、`permissions.ts` |
| 22 | [App commands + queue + headless](22-app-commands-queue-headless.md) | slash 命令分发、输入/系统事件队列、非交互模式 |
| 23 | [App UI + hooks](23-app-ui-hooks.md) | `src/ui/` 组件 + `src/hooks/` 状态机 |
| 24 | [App prompts + memory + skills](24-app-prompts-memory-skills.md) | system prompt 装配、md 记忆、内置 skill、图片清理 |
| 25 | [Memory layer design](25-memory-layer-design.md) | 长期记忆、召回、压缩持久化、prompt/cache 不变量 |
| 26 | [Multi-agent orchestration](26-multi-agent-orchestration.md) | AgentRun 生命周期、并发调度、隔离工作区、批量合并与 UI 状态 |
| 27 | [Tool Runtime redesign](27-tool-runtime-redesign.md) | Tool Effect、Policy Engine、Sandbox、统一调度与事务边界 |
| 28 | [Agent Harness](28-agent-harness.md) | 可复现场景、脚本化 provider、事件与工具轨迹、测试边界 |
| 29 | [Production Agent Harness benchmark](29-production-agent-harness-benchmark.md) | Codex / Claude Code / OpenHands / Aider 对标，Runtime 目标架构与迁移路线 |
| 30 | [AgentRuntime and EventStore](30-agent-runtime.md) | Phase 0 统一装配、Thread/Turn/Item/Run 协议、版本化事件与持久化边界 |
| 31 | [RuntimeStateStore and crash recovery](31-runtime-state-recovery.md) | Phase 1A/1B 原子状态、writer lease、workspace hydrate、恢复 merge 与安全 cleanup |
| 32 | [ExecutionBroker, OS Sandbox and Recovery Center](32-execution-sandbox-recovery-center.md) | Phase 2A capability broker、跨平台 fail-closed sandbox、workspace TTL/配额与 TUI 恢复中心 |
| 33 | [Agent Platform Control Plane](33-agent-platform-control-plane.md) | 一级 AgentCoordinator、RepoIndex/RepoMap、HostProtocol/App Server 与真实仓库 trajectory benchmark |
| 34 | [Transparent zapVM runtime](34-transparent-zapvm-runtime.md) | 无感知 VM 发现/启动、ExecutionBroker 路由、Session/cwd 边界与打包门禁 |
| 37 | [ACP Agent adapter](37-acp-agent-adapter.md) | ACP v1 stdio、会话与权限、隔离 Worker、MCP 和验证边界 |
| 39 | [本机沙箱默认执行](39-local-sandbox-default.md) | 本机沙箱为默认、VM opt-in、`dangerouslyDisableSandbox` 审批重试；沙箱内自动放行、网络白名单、`sandboxExcludedCommands`、沙箱与 VM 分工 |
| 40 | [Harness 运行约束与完成证据](40-harness-runtime-contracts.md) | 迁移前及 legacy 的策略约束与交付门禁；新入口见第 42 篇 |
| 41 | [Agent 运行结果与任务验收架构重设计](41-agent-outcome-and-acceptance.md) | 目标架构：执行、验收和工作流分离，证据新鲜度、宿主投影与迁移验证 |
| 42 | [Agent Outcome 首批实施契约](42-agent-outcome-implementation-contract.md) | M1 实施契约及验证记录：结果接口、协议/退出码、legacy 映射、终态持久化与验收测试 |
| 43 | [M2 宿主 inline 验收实施契约](43-inline-acceptance-m2.md) | 显式 SDK 验收入口、Git 固定快照、回执版本绑定、超时取消与不可变报告 |
| 44 | [M3a 延后验收与持久化工作流控制](44-deferred-workflow-control-m3.md) | 外部回调认证、SQLite 控制版本、取消/恢复、独立等待与动作领取边界 |
| 45 | [M3b 动作执行与崩溃对账](45-workflow-action-execution-m3.md) | 可信动作适配器、取消/超时、持久结果、operation ID 查询与崩溃恢复 |
| 46 | [Outcome 与工作流接线交付](46-outcome-workflow-delivery.md) | Inline 导入、持久投递恢复、HostProtocol v2 控制及独立 CLI |
| 48 | [非 Git 工作区隔离](48-non-git-workspace-isolation.md) | Copy 快照、冻结产物、冲突检查及中断合并恢复 |
| 49 | [上下文附加字段的预算计量](49-context-payload-accounting.md) | 回传字段尺寸估算、压缩尾部与协议保真边界 |
| 50 | [提示词职责分层与对照验证](50-prompt-responsibility-boundaries.md) | 候选实施契约：用途与缓存分离、显式 profile、真实运行核验及生产验收 |
| 51 | [思考阶段断流恢复](51-reasoning-stream-recovery.md) | 显式废弃响应、禁止工具重放、取消与用量缺失边界 |
| 52 | [Shell 目录执行语义](52-shell-directory-semantics.md) | 初始 cwd、shell cd、真实退出状态与权限分类边界 |
| 53 | [Shell 审批目录事实](53-shell-approval-context.md) | 候选：可信审批上下文、隔离子 Agent 与跨平台验收边界 |
| 55 | [后台任务与服务交付生命周期](55-managed-services-lifecycle.md) | M1、SDK 接线与显式本地 owner 已实现；macOS 正常跨 CLI 路径有证据，故障回收与跨平台待验收 |
| 56 | [工具结果来源策略](56-tool-result-source-policy.md) | 显式 Host 来源范围、父子继承、结果扣留与评测回执绑定 |
| 57 | [Watch 运行时观测与动态状态图](57-watch-runtime-observability.md) | 已接入运行时：`zap --watch`、只读事件投影、工具/子 Agent 动态图、SSE 重连；含验收记录与剩余边界 |
| 58 | [能力执行、依赖恢复与完成证据](58-capability-resumption-evidence.md) | 调用级文件授权、后台事件去重和恢复、阻塞状态与验收证据 |

## 怎么读

- **刚上手**：先读 `00-overview.md`，了解两层划分和 turn 流。
- **想理解某个具体功能**：通常涉及 SDK 一篇 + App 一篇。比如「rewind 怎么实现的」=
  `14-sdk-checkpoint.md` + `20-app-shell.md` 里 session.ts 的 snapshot/marker 写入段落。
- **修 LLM 协议相关 bug**：`10-sdk-core.md`。
- **加新工具**：`12-sdk-tools.md` 末尾的「工具实现一致的约定」。
- **改 UI 表现**：`23-app-ui-hooks.md`。

## 文档维护

这些文档由 conversation 一次性生成，可能与代码偏离。引用具体行号 / 函数
名时**以代码为准**，文档侧重描述「为什么这么做」和「模块怎么协作」。

- 第 40 篇保留迁移前/legacy 行为；第 41 篇描述目标架构，第 42 篇记录 M1，第 43 篇记录已实施的 M2 显式宿主入口。第 44 篇记录 M3a 控制层，第 45 篇记录 M3b 执行与对账框架；第 46 篇记录验收、投递及宿主控制接线。自动修复和具体生产动作适配器仍未开放。当前运行行为以代码为准。

## Goal 调度

见 [Goal 持久目标与续跑调度](61-goal-continuation.md)：目标状态、单步执行、独立验收、前台输入优先、无进展检测和安全恢复。

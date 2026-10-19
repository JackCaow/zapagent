# `src/agent/`、`src/agent-factory.ts`、`src/permissions.ts` —— Agent 装配 & 权限

App 层把 `zapsdk` 组件粘成一个能跑的 agent 实例的代码全在这里。每次
config 变化或新 turn 都可能重建一次。

```
src/
├── agent-factory.ts                 # provider + registry + executor（一次性产物）
├── agent/
│   ├── buildAgentRuntime.ts          # TUI Runtime adapter + devtools/logger/checkpoint
│   ├── runtimeEventStore.ts          # 项目级持久 Runtime EventStore
│   ├── contextAttachments.ts        # 每 turn 的 memory/working-pack/todo 注入
│   ├── streamingPreview.ts          # text/thinking delta → React state + Static commit
│   └── wireRunHandlers.ts           # 把 agent events 翻成 addLog/replaceLog
└── permissions.ts                   # 规则评估、模式匹配、settings 持久化
```

---

## `agent-factory.ts` —— `buildAgentObjects(config, ...)`

每次 config 变化都会被 `useAgentObjects` 调用一次，返回
`{ provider, registry, executor }` —— AgentRuntime 在每个 user turn 通过统一工厂
构造内部 LoopAgent。

### Provider 选择

```
isAnthropic = active.protocol === "anthropic"
              || (undefined && baseURL.includes("api.anthropic.com"))
```

- `isAnthropic` → `AnthropicProvider`（构造 `new Anthropic({apiKey, baseURL})`，
  baseURL 去 `/v1` 后缀，因为官方 SDK 自带）
- 否则 → `OpenAICompatibleProvider`（携带 `extraRequestParams`、
  `defaultHeaders`、`supportsVision`）

两边都包一层 `RetryProvider`（`maxRetries:2`、`initialDelayMs:1000`）。

### Sentinel API key

First-run 状态 providers[] 为空，apiKey 是 ""，但 OpenAI / Anthropic SDK
构造里都对空 key throw —— App 渲染就崩了。所以这里 `apiKey ||
"unconfigured"`，让构造通过；真正发送时 401，user 看到 `/connect`。

### Kimi For Coding UA 伪装

Moonshot 的 "Kimi For Coding" 端点（`api.kimi.com`、`api.moonshot.{cn,ai}`）
按 UA 鉴权，拒绝 OpenAI SDK 默认 UA。host 匹配命中时塞 `defaultHeaders`：

```ts
{
  "User-Agent": "claude-cli/1.0.0 (external, cli)",
  "x-stainless-arch": null,  // OpenAI SDK 自带的指纹 header 清空
  ...
}
```

### Registry 装配

`createBuiltinRegistry({...})` 拿到主 agent 全套工具：
- `executeCommand: { defaultCwd, store: taskStore }` —— bash 拿全局 TaskStore，
  能用 `run_in_background:true`
- `webSearch: { searchFn: createSerperSearch(key) }` 仅当 `serperKey` 填了
- `todoWrite: { store: todoStore }` —— 主 agent 独有；subagent registry 没有这条
- `planMode: { callbacks: planCallbacks }` —— 主 agent 独有
- `skill: { getSkill, listNames }` —— 主 agent 独有
- `cronHandle / monitorHandle` —— 来自 `singletons.ts`
- `delegateAgent: { providers: delegateProviders, onEvent: bridge }` —— 仅
  当 PATH 上检测到 `claude` 或 `codex`

最后手工 `register(memorySaveTool({store: mdStore}))`。

### Executor 装配

```ts
new ToolExecutor(registry, {
  timeoutMs: 120000,
  onApproval,                            // 来自 usePermissionApproval
  onTrackEdit: checkpoint?.trackEdits,   // 来自 App 持有的 CheckpointManager
  postProcess: async (toolName, args, result) => {
    if (toolName==="read_file" && autoMemory.isMemoryPath(args.path)):
       挂 stalenessNote 提示
    return result
  }
})
```

postProcess 这里很轻，主要是 memory 文件读取时挂个 N-day-old 提示；大输出
落盘 / diff meta 由 zapsdk/utils/tool-result-storage 里 LoopAgent 自己干。

---

## `agent/buildAgentRuntime.ts` —— TUI Runtime adapter

每个 user turn 都通过 SDK `createAgentRuntime` 构造一个 Runtime facade。生产路径中的
`LoopAgent`、`WorkspaceManager` 和 `MergeCoordinator` 由 RuntimeFactory 统一装配，
这个 App adapter 只传入：

| 参数 | 来自 |
|---|---|
| provider/registry/executor | `agent-factory.ts` 的产物（缓存在 `agentRef`） |
| conversation | 全局 `singletons.conversation` |
| systemPrompt | `buildSystemPrompt(config, cwd, toolPrompts, enabledTools, skills)` |
| maxSteps / maxToolRetries | `config` |
| autoCompactThreshold / autoCompactTokenThreshold | `deriveCompaction` |
| contextWindow | `getActiveContextWindow(config)` |
| storageSessionId / sessionId | `getCurrentSessionId()` |
| onRunEnd | `(ctx) => checkpoint.makeSnapshot(turnStartIndex, logIndex)`；workspace cleanup 由工厂 finally 保证 |
| subagent | `{ onEvent: subAgentEventHandler, todoStore }` |
| subagentFactory | `subagentTool`（来自 SDK，注入避免循环依赖） |
| onImageStripSelfHeal | `() => updateConfig(setVisionSupport(false))` |

构造完同时：
- `agentLogger.attach(runtime)` —— 通过兼容 AgentEventSource 写 debug 日志
- `devToolsSetAgent(runtime)` —— devtools server 切换订阅源
- `devToolsSetReaders({ getConversation, getSystemPrompt, getConfig })` ——
  推 fresh snapshot
- `createProjectRuntimeEventStore(cwd)` —— RuntimeEvent 写入独立项目级 JSONL

---

## `agent/contextAttachments.ts` —— 每 turn 注入

LoopAgent 的 `RunOptions.contextPrefix` 是函数，每次 LLM call 前重算
一次。这个模块构造那个函数：

```ts
buildPerTurnAttachments(autoMemory, {
  memoryQuery,
  contextWindow,
}) → { memoryAttachment, workingPackAttachment, diagnostics metadata }
```

- `memoryAttachment`：`buildMdIndex(mdStore, { query, tokenBudget })`
  生成 query-ranked compact index，包成 `<system-context>...</system-context>`；
  默认 768 tokens / 24 records，小 context window 按比例缩小。
- `workingPackAttachment`：`buildMdPack(mdStore, { query, tokenBudget })`
  按相关性挑几条 memory 文件 body 合起来；默认 2048 tokens / 8 records，
  相关但过大的记录可降级为 bounded excerpt。
- `memoryQuery` 来自当前任务或 compact display text。提交层会用
  `memoryQueryText` 避免长 paste 正文污染召回；contextAttachments 还会剥离
  `<file_content>`、`<mcp_resource>`、runtime XML、代码块和超长 token/行。
- 低信号 continuation（例如“继续”）会拼接最近有意义的用户请求；如果严格
  relevance 过滤为空，会退回小预算 pack，保证 pinned compact state/timeline
  仍可恢复。

`makeContextPrefixBuilder({ attachments, getTodos, modelId })` 返回 `() => string`：
- 拼 memory + workingPack + `renderTodoAttachment(todos)`（产出 `<active_plan>`）
- 都为空返回 undefined（LoopAgent 跳过注入）

`makeTurnEndGuard(getTodos)` 返回 `() => string | null`：
- turn 自然结束前 LoopAgent 喊一声，如果有 in-progress todo 就注入
  `<system-reminder>` 让模型 todo_write 收尾或直接干活
- LoopAgent 保证每 run 最多 fire 一次，避免死循环

---

## `agent/streamingPreview.ts` —— `StreamingPreview`

text/thinking 的 `content_delta` 事件到达时：
- 累计到 `PreviewBuf.text`
- 找完整段落（`\n\n` 边界），把完成的段落 `addLog("agent", paragraph)`，
  剩余的尾巴塞进 `setStreamingText`（dynamic frame 实时显示）
- `getIsFrozen()` 返回 true 时 buffer 不 commit 到 Static（避免 eraseLines
  错位 ghost）；frozen offset 用 `bufferSentOffset` 跟踪，确保 unfreeze
  后 flush 一次而不重复

`content_final` 时把 trailing 段落 flush 掉，清空 `setStreamingText`。

`thinking` 走相似但独立的路径，并发 lazy-start `thinkingStartedAt`
计时用来 UI 显示「Thinking for 12.4s」。

---

## `agent/wireRunHandlers.ts` —— `createRunHandlers(deps)`

把 `AgentEvent` 翻译成 UI 状态变更 + log 写入。维护一个内部 map
`pendingToolLogById` 跟踪「tool 调用了但还没结果」的 logId，便于：
- `content_final.tool_result` 进来时 `replaceLog(logId, "result", ...)` 而
  不是再 addLog 一行
- 异常退出时 `settlePending(reason)` 把没收到结果的 tool 行批量标失败

事件 → 行为映射（精选）：

| 事件 | 行为 |
|---|---|
| `status` | `setStatus(detail || status)` |
| `run_step` | `setStep(step)` |
| `run_usage` | `setContextTokens(conversation.estimatedTokens)`；超阈值 emit 「context getting full」warning（去重 highestWarnedRatio） |
| `tool_call_pending` (preview/bytesHint) | `addLog("tool", name)` 然后 replaceLog 更新 args preview |
| `content_final.tool_call` | replaceLog 最终态 |
| `content_final.tool_result` | replaceLog `"result"` + meta |
| `content_delta.text/thinking` | 转交 `StreamingPreview` |
| `content_final.text/thinking` | 转交 `StreamingPreview` flush |
| `sub_agent_started/finished` | 在 logs 里挂 agentPath 折叠分组 |
| `observation.autocompact_*` | `compactLogs(summary, before, after, files)` —— UI 显示压缩条目 |
| `error` | `addLog("error", ...)` |

`subAgentEventHandler` 是同一个函数，但带 `event.path` 前缀；handler
把 path 透传给 `addLog` 让 group-logs 折叠为子 agent block。

---

## 工具授权

完整设计与验收标准见 [工具批量与宽泛授权](57-tool-authorization.md)。

- `permissions.ts` 负责规则匹配、session 生命周期、项目授权原子保存与撤销。统一 `deny > ask > allow`，来源顺序仅用于同类规则解释。
- `approval-queue.ts` 串行处理工具和 MCP sampling 的所有 host 审批，按请求 id 管理取消与界面状态。
- `permission-policy.ts` 负责 TUI/Headless 共用裁决：plan/disallowed → deny → 危险命令 → ask → sandbox 独立能力 → allow / 默认行为。
- `tool-grants.ts` 将“工具集合 × 资源范围 × 有效期”展开成明确规则；不使用未来工具通配符。
- `ui/dialog-tool-grant.tsx` 提供多选、文件 glob / Bash 模式、会话/项目有效期、逐条预览。
- `/permissions` 按 `a` 新建授权；普通审批条按 `g` 定制覆盖当前调用的授权。危险命令及显式 ask 仅允许逐次审批。
- 新项目授权写入用户数据目录 `permissions/projects/<canonical-cwd-hash>/settings.json`，不修改仓库配置。旧 local/project/global 规则仍读取。
- session UUID 改变时清除全部会话规则和 sandbox 授权；撤销在下一次调用生效，不自动停止已启动进程。

审批回调保留为 SDK 的 Promise 接口。React 状态不进入 SDK，App 授权不改变 broker、路径或 VM 限制。

# `zapsdk/agent` — Agent 主循环

整个 SDK 的「大脑」。把 `LLMProvider`、`ToolRegistry/Executor`、
`ConversationManager` 等组件串成一个能自我推进的 turn 循环：

```
user input
   │
   ▼
LoopAgent.run()
   │ for step in 1..maxSteps:
   │   ├ 序列化 conversation → Message[]
   │   ├ AutoCompact 检查 / 触发
   │   ├ provider.stream(msgs, tools, {signal, maxOutputTokens})
   │   ├ StreamingToolExecutor.consumeStream()
   │   │    ├ 边解析 partial_json 边 launch 工具
   │   │    └ 同 step 内多 tool 并发 / write 串行
   │   ├ buildToolTurn() + conversation.add()
   │   └ 没 tool_use → break
   └ → LoopAgentResult { text, steps, usage, stopped }
```

---

## 文件结构

```
zapsdk/agent/
├── loop.ts                     # LoopAgent（1700+ 行，主循环）
├── single-call.ts              # SingleCallAgent（一次性 LLM+工具，不循环）
├── streaming-tool-executor.ts  # 流式 chunk → tool launch / result
├── events.ts                   # AgentEvent 联合类型 + EventEmitter
├── budget.ts                   # AgentBudget（步数/spawn/token 全树共享）
└── state.ts                    # LoopState（单 run 内的健康标志位）
```

---

## `events.ts` —— 统一事件协议

事件分四组，所有都带 `path?: string[]` —— 缺省/空数组表示根 agent，
`["sa_1","sa_2"]` 表示嵌套 subagent：

| 组 | 事件 | 用途 |
|---|---|---|
| **Status** | `status: idle\|thinking\|writing\|tool\|compacting` | 单一权威状态机；UI footer 据此切换 |
| **Content** | `content_delta / content_final` × `thinking\|text\|tool_call\|tool_result` | 每段内容一个稳定 id；delta 阶段更新预览不写日志，final 阶段提交到 log |
| **Lifecycle** | `run_started / run_step / run_usage / run_ended / error / tool_call_pending / sub_agent_started / sub_agent_finished` | 上下游协议 |
| **Observation** | `observation` + `kind` （`autocompact_start/done`、`reactive_compact`、`provider_fallback`、`max_tokens_recovery`、`force_finish_timeout`、`prompt_leak_blocked`、`snapshot_created/evicted`、`rewind_done`、`turn_end_guard_fired`、`image_strip_self_heal`） | 侧信道遥测，不渲染到对话 |

`tool_call_pending` 是 streaming UX 的关键：模型刚开始流 tool_use（名字到了
但 JSON 还在传），就立刻发出来；JSON 流入过程中每 ~2KB 再发一次更新过的
`argsPreview`（cheap 从 partial JSON 抠出 path / command）+ `bytesHint`。
没这个事件的话，一个 18k 字符的 `write_file` 在用户眼里就是 30s+ 卡住。

`nextContentId(prefix)` 给每段 content 发 monotonic id；prefix 用 `th`
（thinking）、`tx`（text）等。

---

## `state.ts` —— 单 run 健康标志

```ts
interface LoopState {
  maxOutputTokensRecoveryCount: number;     // 撞 length/max_tokens 后注入「continue」次数
  hasAttemptedAutoCompact: boolean;          // 防止 compact 循环
  consecutiveAutoCompactFailures: number;    // 连续失败计数；到 MAX(=3) 时熔断
  imageStripAttempted?: boolean;             // 已自愈过一次图片 400
}
```

`isOutputTokenLimit(reason)` 把 OpenAI 的 `length` 和 Anthropic 的
`max_tokens` 都归一成「被输出长度截断」一类。

---

## `budget.ts` —— `AgentBudget`

整棵 agent 树（root + 所有 subagent）共享同一个实例。三个独立计数：

| 资源 | 默认上限 | 行为 |
|---|---|---|
| 步数 (`useStep`) | 200 | 满了 LoopAgent 强制收尾 |
| Subagent spawn (`reserveSpawn`) | 10 | 满了 `agent` 工具直接返回错误 |
| Token (`chargeTokens`) | 0 = 不限 | 满了下一步停止 |

不允许子代独立 budget — 必须用同一个实例，防止 fan-out 烧爆预算。

---

## `single-call.ts` —— `SingleCallAgent`

单 round：发一次 LLM → 跑所有 tool → 再发一次 LLM → 返回。

没有循环、没有压缩、没有事件、没有 retry。存在的意义：单元测试和外部
embed 场景里需要「函数式」工具调用而不是常驻 agent 时用它。
prod 路径走 `LoopAgent`。

---

## `streaming-tool-executor.ts` —— `StreamingToolExecutor`

`LoopAgent` 的内层 worker。每个 step 创建一个 instance，由 loop 把
`provider.stream()` 的 `AsyncIterable<LLMChunk>` 交给它消费。

### 关键不变量

1. **三段顺序**：thinking → text → tool_call。下一段开始时立刻 `content_final`
   上一段，否则全部 final 会堆到 stream 结束，UI 上文本会跑到 `✓ write_file`
   行下面。
2. **JSON 闭合即 launch**：每条 `tool_call_delta` 进来后检查
   `jsonBuffer.trimEnd().endsWith("}")`；闭合就 `tryLaunch()`，**不**等
   `tool_call_end` 也**不**等 stream 结束。
3. **同 step 内并发 + 写串行**：launch 出去的工具默认 `Promise.all` 并发；
   但 `writeChain` 把会修改文件的工具串成序列（`.then`），保证
   `[edit_file(a), read_file(a)]` 先后顺序时读到的是修改后的内容；
   `[edit_file(a), edit_file(a)]` 也不会撞 atomicWrite 的 mtime 检查。

### 进度反馈节流

```ts
const PROGRESS_STEP_BYTES = 2048;
```

每条 in-flight tool 记 `lastProgressBytes`，buffer 增长超过这个值再发一次
`tool_call_pending`（带 `bytesHint`），不会被高频流量轰炸 emit。

### 中断处理

`AbortedStreamError extends Error`，message 固定 `"aborted"`，payload 携带
`partial: { text, thinking, textId, thinkingId }`。loop.ts 捕获时还是会把
这段不完整的 thinking/text 当成 assistant Message 落到 conversation —
否则下一个 turn 模型会从头规划，体验差。

---

## `loop.ts` —— `LoopAgent`

最复杂的模块（~1700 行）。负责把所有组件粘起来 + 各种 fallback。

### 构造参数（精选）

| 选项 | 默认 | 说明 |
|---|---|---|
| `provider` | required | 主 LLM provider |
| `fallbackProvider` | undefined | 主 provider 非上下文原因失败时降级用 |
| `summarizer` | = provider | 单独的压缩 provider（可以更便宜） |
| `registry / executor` | required | 工具体系 |
| `conversation` | undefined | ConversationManager；不传则不持久化历史 |
| `maxSteps` | 200 | 单 run 步数上限 |
| `contextWindow` | undefined | 当 set 时启用 per-call 输出预算计算 |
| `outputTokenCeiling` | 8192（设置 `contextWindow` 时） | 单 call `max_tokens` 硬上限；宿主可显式传更高值 |
| `reservedOutputTokens` | 8192 | 保底输出预算，不够就抛 `ContextOverflowError` |
| `autoCompactThreshold` / `autoCompactTokenThreshold` | 320k chars / 由 ctx 算 | AutoCompact 触发线 |
| `subagent` + `subagentFactory` | undefined | 启用后注册 `agent` 工具，工厂避免循环依赖 |
| `budget` | new AgentBudget() | 全树共享 |
| `storageSessionId` | randomUUID | 大 tool result 落盘的子目录名 |
| `sessionId` + `onRunEnd` | undefined | Checkpoint 在 turn 结束时提交 snapshot |
| `modelOverride` | undefined | 单 agent 用便宜模型（如 Haiku 跑 explore） |
| `timeoutMs` | undefined | 单 run 墙钟上限，到点强制合成回复 |
| `forceFinishTimeoutMs` | 15,000 | 强制收尾合成的独立硬上限；provider 忽略 abort 时也会释放 run |
| `onImageStripSelfHeal` | undefined | 自愈 vision-400 后回调宿主，把 `false` 写回 config |

### 主循环大纲

```
async run(input, opts):
  state = createInitialLoopState()
  conversation.add({ kind:"user", content:input, images })
  emit run_started
  loop for step in 1..maxSteps:
    if signal.aborted: break
    if budget.useStep() === false: stop("budget")
    if timeoutMs reached: stop("timeout")

    // 1. AutoCompact 检查
    if AutoCompact.shouldCompact(): await runAutoCompact()
    // 2. 序列化：system 只保留 cacheable prefix；dynamic env 移到 transient tail
    msgs = conversation.toMessages() + maybe dynamicSystemContext() + maybe contextPrefix()
    // 3. budget 计算 max_tokens
    maxOutputTokens = computeOutputBudget(msgs)  // 不够 → throw ContextOverflowError
    // 4. stream
    try:
      stream = provider.stream(msgs, tools, { signal, maxOutputTokens })
      result = streamExec.consumeStream(stream, step, signal)
    catch ContextOverflowError: state.hasAttemptedAutoCompact=true; runAutoCompact(); continue
    catch AbortedStreamError: 持久化 partial 后 break
    catch err:
      if image-rejection-400 && !state.imageStripAttempted: provider.setVisionSupported(false); continue
      if fallbackProvider: 换 provider 重试一次
      else throw
    // 5. 拼 Turn
    turn = buildToolTurn({ text: result.text, completed, incomplete, raw: result.raw })
    conversation.add(turn)
    emit run_usage
    // 6. 终止判定
    if result.toolCalls.length === 0:
      if turnEndGuard()?: 注入合成 user 消息 continue
      break
    if isOutputTokenLimit(finishReason): inject continue prompt; continue
  emit run_ended
  onRunEnd?({ turnStartIndex, sessionId })
  return { text, steps, totalUsage, stopped }
```

### Self-healing 一览

| 现象 | 触发条件 | 行为 |
|---|---|---|
| 上下文溢出 | `ContextOverflowError` | `AutoCompact.run()`，重试 |
| 压缩反复失败 | 连续 3 次 | `MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES` 熔断 |
| Vision 400 | provider 抛特定字符串 | `setVisionSupported(false)` → 重试 |
| 输出 token 截断 | `finishReason in {length,max_tokens}` | 注入 continue prompt（次数受 `maxOutputTokensRecoveries` 限） |
| 重复同样 tool 太多次 | `stepSignature` 出现 N 次 | `stop("max_repeat")`（白名单：edit/multi_edit/todo_write 不计） |
| 模型死缠"我做完了"但忘 tool | 自然完成 turn | `turnEndGuard()` 注入一句话，最多一次 |
| Stream 长时间不发 chunk | watchdog 触发 | `StreamIdleTimeoutError`（在 core/stream-idle 里实现） |

### Repeat detection

- `primaryArgSig(name, args)` 把 tool call 折成 `(name, path|command|pattern|task)` 二元组。
- `REPEAT_FRIENDLY_TOOLS` = `{edit_file, multi_edit, todo_write}` 不计。
- 连续 step 出现同一个 signature N 次（默认 3）就 `stop("max_repeat")`，避免
  agent 死循环 grep 同一个文件。

### Subagent 集成

不直接 `import { subagentTool }`（防循环）。`LoopAgent` 通过 `subagentFactory`
注入：`registry` 里的 `agent` 工具是 factory 接收 `{ provider, registry,
budget, fallbackProvider, todoStore, ... }` 后造出来的。`subagentTool` 内部
再实例化新的 `LoopAgent`，传同样的 budget，让 step/spawn 跨树共享。

子 agent 事件：parent 把自己的 `subagent.onEvent` 透传给子 LoopAgent，
子 agent 在 emit 前把自己的 `path` 追加 `subagentId`，handler 上得到
`["sa_1"]` 这样的路径，宿主据此对 logs 做折叠展示。

---

## 上游联动（src/ 层）

`src/hooks/useAgentRunner.ts` 创建 LoopAgent 时：

```ts
new LoopAgent({
  provider: retryProvider,
  fallbackProvider: fallbackProvider,
  summarizer: summarizerProvider,   // 通常用 haiku
  registry, executor, conversation,
  systemPrompt: buildSystemPrompt(...),
  contextWindow: getActiveContextWindow(config),
  outputTokenCeiling: config.maxTokens,
  reservedOutputTokens: derived.reserveForOutput,
  autoCompactThreshold: derived.triggerAt * 4,    // chars
  autoCompactTokenThreshold: derived.triggerAt,    // tokens
  subagent: true,
  subagentFactory: subagentTool,
  budget: new AgentBudget({ maxSteps: config.maxSteps * 3 }),
  storageSessionId: getCurrentSessionId(),
  sessionId: getCurrentSessionId(),
  onRunEnd: ({ turnStartIndex, sessionId }) =>
     checkpoint.commitTurnSnapshot({ ... }),
  modelOverride: undefined,
  onImageStripSelfHeal: () => updateConfig(setVisionSupport(...)),
})
```

事件订阅同样在 `useAgentRunner` 里挂：`emitter.on("*", handler)`，
handler 一边 `addLog`/`replaceLog` 一边给 React 的 streaming state 喂数据。

---

## 不变量与契约总结

- **每个 turn 都是 wire-valid**：`buildToolTurn` 把 incomplete 合成成
  failure ToolResult，conversation 里看不到孤儿 tool_use。
- **AbortSignal 一路打到 SDK**：`opts.signal` → adapter → SDK 请求 → 流
  watchdog，也覆盖 tool-less force-finish 和 fallback provider 的非流式工具
  执行。Ctrl+C 在任何位置都能在 ~1 tick 内停下。
- **大输出落盘 → 引用替换**：单条 ToolResult 超过 `PERSIST_THRESHOLD_CHARS`
  时 `maybePersistToolResult` 写到 `tool-outputs/<storageSessionId>/<id>.txt`，
  conversation 里只剩 `<TOOL_RESULT_FILE path="...">` 文字。
- **预算独立于 maxSteps**：`AgentBudget` 是全树共享，`maxSteps` 是单 agent
  本地。subagent 占的步数会从 root 的 budget 扣。
- **状态机权威**：`status` 事件只由 LoopAgent 发；UI 不要从其他事件推断状态。

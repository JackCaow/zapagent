# `zapsdk/context` —— 上下文压缩 / token 估算

Agent 会话越跑越长，最终一定会撞到 context window 上限。这一层负责把
「下一轮的 input」压缩到模型放得下，且尽量不丢操作上有用的信号。

四种策略分别覆盖不同时机：

| 模块 | 时机 | 操作 | 是否调 LLM |
|---|---|---|---|
| `Microcompact` | 溢出恢复 / SDK 显式调用 | 把旧的 tool_result 用「head+tail+省略数字」替换 | 否 |
| `AutoCompact` | 触发线（默认 ~80k tokens / 320k chars） | 把中段对话喂给 LLM，要求按 9 段结构化总结 | 是 |
| `ReactiveCompact` | 反应式：API 返回 prompt-too-long | 先 Microcompact，不够再丢中段 + retry | 否 |
| `ResultCompressor` | 单条 tool_result 太大 | 截断 head+tail 或叫 summarizer 概括 | 可选 |

辅助：
- `TokenCounter` —— 不依赖 tokenizer SDK 的启发式估算
- `tool-use-summary.ts` —— `generateToolUseSummary(calls)`，把一轮 tool 调用
  压成 `✓ read_file(foo.ts) → 240 lines, 8192 chars` 的单行清单

---

## `token-counter.ts` —— 启发式 token 估算

为什么不接 tokenizer：tiktoken 体积大、与各家 provider 的真实 tokenizer
偏差也不小（OpenAI 的 cl100k_base 和 Claude tokenizer 完全不同）。所以
SDK 走自家启发式：

```
按字符类逐字加权：
  CJK     → 0.7 tokens/字   (~1.5 chars/token)
  英文词  → ceil(len/3.5)   (~3-4 chars/token)
  符号    → 0.5 tokens
  空白    → 0.25 tokens
  其他    → 0.5 tokens
```

加 framing 开销：
- 每条 Message: +4
- 每个 tool_call: +8 + name 文本 + JSON.stringify(args) 文本
- 每张图片: +765（保守估计）

误差对单条消息可能 20%-30%，但对一整次 Run 的预算判断够用。这层关键意义是
**0 deps**——压缩决策不依赖网络/tokenizer 加载。

---

## `microcompact.ts` —— 溢出恢复用 tool_result 压缩

`Microcompact` 把历史里**除最近 N 条**外的 `tool_result` 就地替换成
`head150  …[X chars compacted]…  tail150` 这样的占位。

关键点：
- **保留 head + tail**，不只保 head——bash / test 的退出码、错误尾、
  汇总都在尾巴。
- **按 toolCallId 去重**：`compactedIds: Set<string>`，同一条不会被反复
  压缩；reset() 在 /new 时清空。
- 内容 ≤ 100 chars 不压缩（划不来）。

`LoopAgent` 正常路径不再按年龄改写已经发给 provider 的历史；大结果会在首次
commit 前落盘/压缩，达到 token 阈值时则由 AutoCompact 建立显式的新 cache
epoch。`ReactiveCompact` 在拿到 prompt-too-long 错误时会调用激进的
microcompact（`keepRecent: 2`），SDK 外部调用者也可显式使用它。

---

## `autocompact.ts` —— LLM 主动结构化总结

触发：`AutoCompact.shouldCompact(messages)` 默认看 `totalChars > 320_000`
（≈ 80k tokens）；LoopAgent 还会传 token 阈值作 belt-and-suspenders（CJK
对话 char 阈值会晚于真实 token 限制触发）。

`compact()` 流程：

```
1. systemMsgs = 前缀里的 system 消息
2. tailStart = max(systemLen, len - keepRecent)   // 默认 keepRecent=10
3. while tail 起始是 tool_result：tailStart--
       // 不允许 tail 起点是 tool_result——它的 tool_use 会被压缩进
       // middle，导致 wire 上 tool_use 没对应 tool_result，API 直接 400
4. middle = messages[systemLen..tailStart]
5. historyText = middle.map(previewMessageForCompact(role, content)).join("\n\n")
6. provider.call([STRUCTURED_COMPACT_PROMPT, historyText])
7. return [systemMsgs, summaryMsg, ...tail]
```

### `STRUCTURED_COMPACT_PROMPT` —— 9 段结构

来自 Claude Code 的 `getCompactPrompt` 移植，强迫总结器枚举操作有用的事实
而不是写散文：

1. `<analysis>` 草稿区（用户看不到）
2. `# Primary Request and Intent`
3. `# All user messages (verbatim)` —— 短消息逐字保留，长消息保头尾、保
   shorthand 标签（`P1`、`option A`）
4. `# Current task status`
5. `# Files read / modified`
6. `# Commands run`
7. `# Key facts discovered`
8. `# Decisions made` —— 「用 jsdiff 不用 myers」之类
9. `# Errors encountered and their resolution`
10. `# Code changes summary`
11. `# Next steps`（imperative）

### `previewMessageForCompact(role, content)`

喂 summarizer 前每条消息的截断策略不同：
- `tool_result` cap 2000 chars（noise 多，头尾就够）
- `assistant` / `user` cap 6000 chars（user 喜欢在 turn 中间引入 shorthand）

### Fallback

`provider.call` 失败 → 不抛，写 `[N messages removed — context limit reached]`
继续往下走。`LoopAgent` 还有 `MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES=3` 熔断器，
连续失败超过就停止重试，避免在 ctx 顶端死循环。

---

## `reactive-compact.ts` —— 反应式重试

`ReactiveCompact.callWithCompaction(provider, msgs, tools, opts)`：

```
loop:
  try return await provider.call(msgs, tools, opts)
  catch err:
    if !isTokenLimitError(err): throw
    if attempt >= maxRetries: throw
    msgs = defaultCompact(msgs)
    attempt++
```

### `isTokenLimitError`

宽松字符串匹配，覆盖各家 provider 的错误信息：

```
"prompt too long" | "token" + "limit" | "context length exceeded"
| "maximum context" | "too many tokens" | "request too large"
| "413" | "prompt is too long"
| "400" + "json" | "failed to parse the request body"
| "unexpected end of" | "hex escape"
```

后半串的兜底是某些 gateway 把 oversized request 转译成"JSON 解析失败"。

### `defaultCompact`

- Step 1: `Microcompact({ keepRecent: 2 })` —— 紧急压缩旧 tool result
- Step 2: 还是太长就丢中段，只留 system + 末尾 6 条；tail 起点是
  `tool_result` 时同样回退一步避孤儿

LoopAgent **不**直接用 ReactiveCompact——主路径上是 AutoCompact 先于
provider 调用前主动触发。ReactiveCompact 是给 SingleCallAgent 或外部
调用者用的便利包装。

---

## `result-compressor.ts` —— 单条 tool_result 压缩

针对**单条**输出（不是整个对话）：

```ts
new ResultCompressor({
  maxTokens: 8000,
  headRatio: 0.7,
  summarizer?: provider,
})
```

- `compress(text)` —— 同步，纯截断：head 70% + tail 30%，中间塞
  `[truncated ~X tokens]`。
- `compressWithSummary(text)` —— 先尝试 LLM summarize（拿前 10k 字符喂）；
  失败回退到截断。

LoopAgent 在 `formatResult()` 链路里选择性启用。它先判断原始结果是否需要
完整落盘；只有无需落盘的结果才交给 `resultCompressor` 做有损截断。落盘失败
时改为有界 head/tail 预览并明确标记不可恢复，避免完整大结果重新撑爆上下文。
Zapcode 默认宿主不注入 `resultCompressor`，主要依赖可恢复的落盘预览。TUI 和
Loop 可能依次处理同一结果；进程内有界指纹表会在文件元数据未变化时复用首次
写入，正文变化、文件删除或损坏时仍回到原子重写。

---

## `tool-use-summary.ts` —— 单步 tool 调用清单

`generateToolUseSummary(calls)` 把一轮 tool calls 压成多行清单：

```
✓ read_file(src/foo.ts) → 240 lines, 8192 chars
✓ search_files("TODO") → 18 results
✗ bash(npm test) → Error: Module not found 'foo'
```

用途：autocompact 时的 fallback 文本；session JSONL 的 tool snapshot
摘要；UI 的 `pendingTools` 折叠展示。

`extractKeyArg(name, args)` 的优先级：
- `search_files` / `glob_files` 优先用 pattern
- 其他工具：`path|file|file_path|filePath` → `command` → `query|pattern`
  → `url`（取 hostname）→ 任意第一个 string arg

`summarizeOutput` 因工具而异：read 显示行数，search 显示 results 数，
bash 显示第一行，list/glob 显示 entries 数。

---

## 上下游协作

```
        AutoCompact.shouldCompact?  ──Y──> AutoCompact.compact()
                │                           │
                N                           ├─ provider.call(STRUCTURED_PROMPT, …)
                │                           ├─ 失败 → 文本 fallback
                ▼                           └─ 重写 conversation
        provider.stream(msgs, …)
                │
                │ 收到 prompt-too-long 错误
                ▼
        ReactiveCompact(Microcompact + 中段压缩)
        或直接 ContextOverflowError → 上层 autocompact 重试
```

`ResultCompressor` / `maybePersistToolResult` 在 LoopAgent 的 `formatResult()`
里作用于**单条结果**，与上面的对话级压缩相互独立。

`tool-use-summary` 不参与 LoopAgent 路径，主要服务 UI / session 持久化的
人类可读摘要。

## 调参建议

- **CJK 重的项目**：char 阈值会迟到，把 `autoCompactTokenThreshold`
  调低；`token-counter` 对 CJK 系数 0.7，比英文项目早触发。
- **小 context 模型**（Ollama 8k）：在 LoopAgent 构造时把
  `contextWindow` 显式传进去，让 budget planner 走 per-call max_tokens
  上限。
- **Summarizer 用便宜模型**：LoopAgent 接受单独的 `summarizer: provider`，
  通常配 Haiku 或本地 8B 模型，对成本敏感。

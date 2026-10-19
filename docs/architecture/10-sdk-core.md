# `zapsdk/core` — LLM 抽象 & 协议层

把不同厂家的 LLM 协议（OpenAI Chat Completions、Anthropic Messages、各家
兼容代理）藏进一个统一的 `LLMProvider` 接口；并提供：

- 统一的 `Message` / `Turn` 数据结构
- 流式 chunk 的统一类型 `LLMChunk`
- 重试（含流式整段重试）
- 流空闲（idle）看门狗
- prompt 静/动态边界 + provider 端的 prompt cache 注入
- 远端 `/models` 列表的多路径探测

这是整个 SDK 的最底层，向上不依赖任何其他子目录；向下只依赖
`@anthropic-ai/sdk` 和 `openai` 两个官方 SDK 以及 `zod`（schema）。

---

## 文件结构

```
zapsdk/core/
├── types.ts             # Message / ContentBlock / LLMResponse / LLMChunk / TokenUsage
├── turn.ts              # Turn[] 模型：assistant ↔ tool_result 配对的不变量
├── errors.ts            # ContextOverflowError
├── llm.ts               # LLMProvider 接口 + withModelOverride 包装
├── retry.ts             # RetryProvider（call + stream 两路重试）
├── stream-idle.ts       # 流空闲看门狗 withStreamIdleTimeout
├── prompt-boundary.ts   # 静态前缀 / 动态后缀分割
├── list-models.ts       # /models 端点探测
└── providers/
    ├── anthropic.ts            # AnthropicProvider
    └── openai-compatible.ts    # OpenAICompatibleProvider（含 <think> inline 切分）
```

---

## `types.ts` —— 互通的最小公约数

`Message.role` 只允许四种：`system | user | assistant | tool_result`，是
OpenAI/Anthropic 都能理解的最小集。

```ts
interface Message {
  role: "system" | "user" | "assistant" | "tool_result";
  content: string;
  contentBlocks?: ContentBlock[];     // 多模态时用，普通文本不填
  toolCallId?: string;                // 仅 tool_result 用
  toolCalls?: ToolCallRequest[];      // 仅 assistant 用
  raw?: Record<string, unknown>;      // 透传 sidecar（reasoning_content 等）
}
```

`raw` 是给 thinking-mode provider 留的通道：DeepSeek 的 `reasoning_content`、
Kimi 的 `thinking`、其他厂家的 vendor-specific 字段，SDK 完全不解释，「收到
什么就在下一轮原样回放」，避免代码里出现 brand-switch。

`ContentBlock` 支持文本和图片两种。`ImageContent.base64` 是惰性的：
保存时只存 `filePath`，序列化到 wire 前再 base64 读一次（见 LoopAgent
里的 `inflateImages`）。

```ts
type LLMChunk =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "tool_call_start"; toolCallId: string; toolName: string }
  | { type: "tool_call_delta"; toolCallId: string; partialJson: string }
  | { type: "tool_call_end"; toolCallId: string }
  | { type: "done"; usage: TokenUsage; finishReason?: string; raw?: ... };
```

Provider 各自把厂家 SSE 事件翻成这五种之一；上层 (agent loop +
streaming tool executor) 只对这五种编程。

---

## `turn.ts` —— 替代 `Message[]` 的 Turn 模型

历史背景：把会话以 `Message[]` 平铺存有三个角色——wire 格式、持久化
格式、内存状态——任一处出错就会留下「assistant 发了 `tool_use` 但没有
对应的 `tool_result`」的孤儿。Bedrock-backed 的端点对这种状态直接拒绝
（`TOOL_USE_RESULT_MISMATCH`），过去靠 `pruneOrphanedToolCalls` 弥补。

`Turn[]` 在类型层让孤儿状态不可表达：

```ts
type Turn =
  | { kind: "user"; content: string; images?: ImageContent[] }
  | { kind: "assistant"; text: string; raw?: ... }
  | { kind: "tool_turn"; text: string; calls: ReadonlyArray<CompletedCall> }
  | { kind: "system"; content: string };

interface CompletedCall {
  id: string; name: string; arguments: Record<string, unknown>;
  result: ToolResult;
  formattedOutput?: string;  // 模型实际看到的字符串
}
```

`buildToolTurn({ completed, incomplete })` 是唯一的构造入口：incomplete
（流被剪/JSON 不闭合/被中断）会被合成成 `success:false` 的 ToolResult，
保证 `tool_turn.calls` 数组在类型上「每一项都有结果」。

`turnToMessages` / `turnsToMessages` 是把 Turn[] 拍平成 wire 格式 Message[]
的纯函数；provider 收到的是已经配好对的，再不需要清理。

---

## `errors.ts` —— ContextOverflowError

唯一的 SDK-级错误类型，由 `LoopAgent` 的预算检查抛出：

```ts
class ContextOverflowError extends Error {
  readonly inputTokens: number;
  readonly reservedOutput: number;
  readonly contextWindow: number;
}
```

显式契约（`err instanceof` 而非字符串匹配）：loop 的 catch 会在收到这个
错误时调用 `AutoCompact` 压缩并重试。

---

## `llm.ts` —— `LLMProvider` 接口

```ts
interface LLMProvider {
  call(messages, tools?, opts?): Promise<LLMResponse>;
  stream?(messages, tools?, opts?): AsyncIterable<LLMChunk>;
  setVisionSupported?(supported: boolean): void;
}

interface LLMCallOptions {
  model?: string;            // 单次模型覆盖
  maxOutputTokens?: number;  // 由 budget 计算
  signal?: AbortSignal;      // Ctrl+C 链路
}
```

`withModelOverride(inner, model)` 是个轻包装：subagent 想用便宜模型 (Haiku)
跑探索时，主 agent 仍然停在默认模型上——这个包装把 `model` 永远拼到 opts 里。

`setVisionSupported(false)` 是 vision 关闭的运行时通道：LoopAgent 收到 400
图片拒绝时调用一次，provider 自动在后续 serialize 里把 image block 换成文字
breadcrumb，下一轮就不会再撞。

---

## `retry.ts` —— `RetryProvider`

实现了 `LLMProvider`，包在真 provider 外面。指数退避 + abort 友好：

- 攻击 `RetryOptions.retryableErrors`（字符串子串匹配）决定哪些错误算瞬态。
  默认 `undefined` = 全部重试；调用方一般传 `["rate limit", "timeout", "5"]` 之类。
- `signal` 不光在重试前检查，`sleep()` 内部也用 `AbortListener` 即时取消。
- `stream()` 整段重试：流抛错 → 重新发起整个 SSE，**不做部分重试**（前
  缀已经被消费方处理）。

---

## `stream-idle.ts` —— 看门狗

`withStreamIdleTimeout(iter, idleMs, signal?)`：包一层 async iterator，
chunk 之间间隔超过 `idleMs` 没新值就抛 `StreamIdleTimeoutError`。

关键细节（issue #10）：**必须包在 SDK 原生 iterator 上**，而不是 adapter
翻译后的 `LLMChunk` 流上。原因是 Anthropic 的 `ping` / `message_start` /
`content_block_stop` / `message_delta`、OpenAI 的空 delta 这些活性帧 adapter
通常不会翻译成 typed chunk，如果包在 typed yield 上就会把它们扔掉 → 健康
的流被误杀。

默认超时 180s，可通过 `ZAPCODE_STREAM_IDLE_MS` 覆盖。Abort sentinel 是
`Symbol("stream-abort")`，用 `resolve(SENTINEL)` 而非 `reject()`，让生成器
能干净地 `return`。

---

## `prompt-boundary.ts` —— 静/动态前缀分割

```
[STATIC PROMPT (system, tool catalog, AGENTS.md, skills)]
<!-- __ZAPCODE_DYNAMIC_BOUNDARY__ -->
[DYNAMIC SUFFIX (today, cwd, git branch, env)]
```

- Anthropic 端：在静态块尾打 `cache_control: ephemeral`，动态块不打 →
  prefix cache 跨 turn 命中。
- OpenAI 兼容端：自动 prefix cache 不需要标记，直接 `stripBoundary` 掉
  marker 再发出去。

边界字符串放在 core 里是为了 `src/prompts/*` 和 `zapsdk/core/providers/*`
共享同一个常量，否则会形成 src ↔ zapsdk 的循环依赖。

---

## `list-models.ts` —— `/models` 多路径探测

各家把 `/models` 放在 baseURL 的不同前缀上：

| Provider | chat endpoint | models endpoint |
|---|---|---|
| OpenAI | `…/v1/chat/completions` | `…/v1/models` |
| Anthropic | `…/v1/messages` | `…/v1/models` |
| DeepSeek | `…/v1/chat/completions` | `…/models` (root) |
| DeepSeek Anthropic mode | `…/anthropic/v1/messages` | `…/models` (root) |
| Zhipu | varies | varies |

实现：从 baseURL 的完整路径向上一级一级 walk（最多 3 层），每层尝试
`/models` 和 `/v1/models` 两个后缀，dedupe 后最多 6 个 URL 探测。

只有 `404 / 405 / "200 但不是 models 列表"` 才会触发下一个 URL，
`401 / 403 / 5xx` 视作请求已经到达真实 handler——失败原因真实，不应
被路径切换掩盖。

`Authorization: Bearer`、`x-api-key`、`anthropic-version` 三个 header 一起
发——不识别的 header 服务端会忽略，避免 provider-brand 分支。

---

## `providers/anthropic.ts` —— Anthropic Messages 适配

- **Prompt caching**：最多 3 个 cache breakpoint
  1. system 静态前缀
  2. tools 数组最后一项
  3. apiMessages 最后一条 user/assistant
- **tool_result 打包**：连续的 `tool_result` Message 合并成同一个
  `{role:"user", content:[...]}`——Anthropic API 要求 tool_result 必须是
  user message 内的 block，分散成多条 user 会被 Bedrock/Vertex 拒绝。
- **stream**：直接拿 SDK iterator，用 `withStreamIdleTimeout` 包一层。
  把 `content_block_start(tool_use)` → `tool_call_start`、
  `content_block_delta(text_delta|input_json_delta)` → `text_delta|tool_call_delta`、
  `message_stop` 取 `finalMessage()` → `done`。

## `providers/openai-compatible.ts` —— OpenAI Chat Completions 适配

- **InlineThinkSplitter**：MiniMax M2.7 等模型把 `<think>...</think>` 直接
  写在 `delta.content` 里（而不是 `delta.reasoning_content`）。Splitter
  在跨 chunk 边界处缓存可能的部分 tag 匹配（"</thi"），保证不被切断。
- **ROUNDTRIP_SIDECAR_KEYS**：白名单（目前只有 `reasoning_content`）的
  字段流式累加到 `msg.raw`，下一轮序列化时再原样 spread 出去——
  thinking-mode 多轮工具调用得以工作，全程零 brand 分支。
- **defaultHeaders**：用来伪装 User-Agent（Moonshot Kimi For Coding 这种
  按 UA 鉴权的端点必须）。
- **supportsVision**：默认 undefined（透传）；LoopAgent 撞 400 图片
  拒绝时 `setVisionSupported(false)`，下次序列化把 image block 换成
  `[Referenced image in conversation]` 文字。
- **extraRequestParams**：直接 spread 进请求体——DeepSeek V4 的
  `{ thinking: { type: "enabled" } }`、`reasoning_effort` 都走这里。

---

## 上下游联动

```
LoopAgent
   │
   ▼  withModelOverride / RetryProvider / 真 provider 这一串
LLMProvider.stream(messages, tools, { signal, maxOutputTokens })
   │
   ▼
官方 SDK iterator
   │ 包 withStreamIdleTimeout
   ▼
adapter 翻译成 LLMChunk
   │
   ▼
StreamingToolExecutor 一边解析 partial_json 一边 launch 工具
```

`ContextOverflowError` 是 loop ↔ AutoCompact 的合同——loop 在 budget 阶段
抛出，AutoCompact 收到就压缩 Conversation。除此之外 core/ 不向外发出任何
SDK 级异常类型，由 RetryProvider 决定哪些错误是瞬态、哪些 bubble。

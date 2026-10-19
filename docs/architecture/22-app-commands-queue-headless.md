# `src/commands*`、`src/queue/`、`src/headless/` —— 命令分发、输入队列、非交互模式

把「用户怎么把意图送到 agent」这条链路相关的三块代码并在一起讲。

```
src/
├── commands.ts                 # parseCommand —— pure 文本 → CommandResult
├── commands/
│   ├── dispatcher.ts           # dispatchSlashCommand —— 跑 effect
│   └── submit.ts               # @path 解析、模型可见文本组装、drag-drop 启发式
├── queue/
│   ├── inputQueue.ts           # 用户输入队列（external store）
│   └── systemInbox.ts          # 系统事件 inbox（任务完成 XML 等）
└── headless/
    ├── run.ts                  # entry shim（动态 import 进来）
    ├── args.ts                 # CLI argv 解析
    ├── runHeadless.ts          # 主循环：build agent + run + format + exit code
    ├── formatter.ts            # text / json / stream-json 三模式
    └── approval.ts             # bypass / acceptEdits / 拒绝 三套审批
```

---

## `commands.ts` —— `parseCommand(input)`

唯一职责：把 `/help` / `/connect` / `/effort high` / 等字符串映射成
`CommandResult` 联合类型。**零副作用**——只是解析，方便单测。

`CommandResult.type` 是一个大 union：

| type | 触发条件 | dispatcher 干啥 |
|---|---|---|
| `output` | `/help` | `addLog("system", text)` |
| `clear` | `/clear` / Ctrl+L | 清屏 + 清 logs |
| `new_session` | `/new` | `startNewSession()` + 重置所有 ref |
| `copy` | `/copy` | `pbcopy` 读 `last-output.md` |
| `compact_session` | `/compact` | 直接调 `agent.runCompact()` 或类似 |
| `open_connect` | `/connect` | `setDialog("connect")` |
| `open_model_picker` / `set_model` | `/model [name]` | dialog or `setActive(...)` |
| `open_mode_picker` / `set_permission_mode` | `/mode [name]` | dialog or 写入 config.permissionMode |
| `open_sessions` / `open_mem` / `open_serper` / `open_mcp` / `open_rewind` | `/sessions /mem ...` | dialog 路由 |
| `init_project` / `review` / `commit` | `/init /review /commit` | `dispatchUserTurn(text, systemPromptOverride)` |
| `run_skill` | `/<skill-name> [...args]` | `dispatchUserTurn` with skill 的 systemPrompt + params |
| `show_permissions` | `/permissions` | open dialog |
| `clear_todos` | `/todos clear` | `setTodos([])` |
| `set_effort` | `/effort [value/cycle]` | `setEffort` 写入 config |

没识别的 `/xxx` token 但用户装了同名 skill → 走 `run_skill`；否则 fallback 走
普通对话（把整段当 user message 提交）。

---

## `commands/dispatcher.ts` —— `dispatchSlashCommand(input, deps)`

`parseCommand` 返回的 `CommandResult` 在这里被执行。`deps` 是 `App.tsx`
里 `useCallback` bind 出来的局部依赖大全（exit/setDialog/setLogs/setTodos/
addLog/configRef/updateConfig/agentRef/checkpointRef/dispatchUserTurn 等）。

主要分支：

- **dialog 路由**：把 `dialog` state 翻成对应 ID，App 渲染对应 component。
- **`set_model` / `set_effort` / `set_permission_mode`**：直接
  `updateConfig(next)`；写文件由 `App.tsx` 的 `updateConfig` 包装。
- **`/init` / `/review` / `/commit`**：分别用预设 system prompt
  （`prompts/builtin-commands.ts`）调 `dispatchUserTurn`。本身不是 skill，
  写死在 zapcode 里。
- **`/run_skill`**：从 `skillsRef` 拿 SkillDefinition，apply template，调
  `dispatchUserTurn(input, systemPrompt)`。
- **`/clear` / `/new`**：
  - `/clear` 只擦终端 + UI logs；conversation 还在
  - `/new` `startNewSession()` + `conversation.clear()` + 重置 checkpoint
    + bumpTranscript

返回 `boolean`：true 表示「这是个命令，已处理」，false 表示「不是命令，
照普通输入处理」。

---

## `commands/submit.ts` —— 提交前的文本预处理

三个独立纯函数：

### `resolveAtPathReferences(value, addLog)`

扫 `@some/file/path` 引用（前后是空白或边界），读取（最大 256 KB），包
成：

```xml
<file_content path="src/foo.ts">
...
</file_content>
```

`null` 表示有错（文件不存在/超大/读失败），caller 取消提交。验证发生在
push history 之前，避免错路径污染 history.jsonl。

### `buildModelText(trimmed, fileBlocks)`

把用户输入 + `<file_content>` 块拼成模型实际看的文本：
- 剥掉 `[Image #N]` 占位符（它们走 ImageContent 通道）
- collapse whitespace
- 多块用 `\n\n` 拼接

### `stripDropPathQuoting(trimmed)` + `looksLikeDroppedFilePath(input)`

终端 drag-drop 文件时会把 `/Users/foo/bar.png` 一字一字打到 stdin 里
（不是 paste 协议）。这两个函数：
- 第一个：去掉 `\ ` 转义 + 首尾引号
- 第二个：`/...` 但含第二个 `/` → 是路径不是 slash command（避免
  把 `/Users/foo` 当 `/users` 命令）

---

## `queue/inputQueue.ts` —— 用户输入队列

**核心设计**：state 在 React 外面。

```ts
const queue: QueuedCommand[] = []
let snapshot = Object.freeze([])
const subscribers = new Set<() => void>()
```

React 通过 `useSyncExternalStore(subscribe, getSnapshot, getSnapshot)` 订阅。

为什么：
- streaming agent loop（非 React 代码）也能直接读写
- 没有「现在 React state 是不是 stale」的批量渲染竞态
- `handleSubmit` **永远** enqueue；drain 路径是唯一交给 agent 的入口——
  消灭「live submit 和 drain submit 两条路径不对称」的 bug

`QueuedCommand`：
```ts
{
  text: string           // 模型看的，去 [Image #N]
  displayForm: string    // UI 看的，保留 markers
  images?: PendingImage[]
}
```

API：
- `enqueue(cmd)` / `dequeueAll()` / `peek()` / `clear()`
- `subscribeToQueue(cb)` / `getQueueSnapshot()` / `getQueueLength()`
- `popLastBackToInput()` —— Esc 在 queue 不空时回退最后一条到输入框

---

## `queue/systemInbox.ts` —— 系统事件 inbox

跟 inputQueue 平级但独立。**绝对**不能进 inputQueue：
- 不能在 UI queue preview 里被显示成「用户的待发送消息」
- 不能 Esc 弹回输入框被用户编辑/丢弃
- 数据 shape 只有 `{ kind, payload, ts }`——没 displayForm/images，杜绝
  误渲染成 user bubble

目前的 producer 只有 `taskStore.on("exited")` → 推
`{ kind:"task-notification", payload: xml }`。未来 cron/monitor/delegate-done
都会接进来。

`useTurnDispatcher` 在每个 turn 边界先 `drainSystemInbox()` 再处理用户
queue——系统事件先于 user 输入交给模型，保证模型看到 state 变化再处理
用户的反应。

---

## `useTurnDispatcher`（hook，详见 23-app-ui-hooks）

把 `handleSubmit` 实现：
- isRunning 时只 enqueue 不发出
- 不 running 时：drain systemInbox + drain inputQueue + 当前提交，
  按顺序 dispatch 给 agent（每个之间 `await` 一下）
- slashOpen + Enter：用 palette 当前 idx 的 entry 替换输入；不真发
- file-palette 打开：blockSubmit
- 校验 provider 就绪，未就绪 `addLog("error")` + toast

---

# `headless/` —— `zapcode -p ...` 非交互模式

启动决策在 `src/index.tsx`：触发条件之一就 `dynamic-import(headless/run)`
然后整个 Ink 路径不加载。

## `run.ts` —— Entry shim

`runHeadlessFromArgv(argv)`：
1. `--help-headless` → 打 HELP 退出 0
2. `parseHeadlessArgs(argv)`（第一次尝试）
3. `readStdinIfPiped()` 异步读管道 stdin（30s 超时）
4. piped 内容存在：
   - 已有 explicit prompt → append piped 到 prompt 末尾当 context
   - 没 prompt → 重新解析参数加 `-p <piped>`
5. 第一次解析失败且无 piped → 打 error + HELP，返回 `EXIT_BAD_ARGS=2`
6. `runHeadless(args)` 返回 exit code

## `args.ts` —— 手写参数解析

无依赖。支持的 flag：

```
-p / --print <text>           # 显式 prompt
--permission-mode <m>          # default / acceptEdits / bypassPermissions / plan
--output-format <f>            # text / json / stream-json
--max-turns <n>
-c / --continue                # 接最近一条 session
--session-id <id>              # 显式 session 接续
--model <id>                   # 单 run 模型覆盖
--system-prompt-append <s>     # 追加到 default system prompt
--allowed-tools <csv>          # 主 registry subset
--disallowed-tools <csv>       # registry exclude
--cwd <dir>                    # 工作目录（在 index.tsx 已先 chdir）
--no-devtools / --quiet
```

位置参数：第一个非 flag 当 prompt（如果 -p 没给）。

## `runHeadless.ts` —— 主循环

跟 TUI 共享 `buildAgentObjects`，但**不**用：
- React / Ink / streamingPreview
- CheckpointManager（headless 没回滚意义）
- PlanModeCallbacks（plan 模式直接 deny 写工具，不需要 UI）
- devtools server（除非 env 显式设置）

主要步骤：

```
1. config = loadAppConfig(); 应用 --model 覆盖
2. hasApiKey ? : EXIT_NO_PROVIDER=3
3. cwd already set by index.tsx
4. session 接续 (--continue / --session-id):
   - loadSavedSession(id) → setActiveSession(logs)
   - sessionLogsToMessages → conversation.add(...) 重放
5. systemPrompt = buildSystemPrompt + planDisciplineSection
   + args.systemPromptAppend
6. registry = buildAgentObjects(config, headlessApproval, ...).registry
   (subset by allowedTools / exclude by disallowedTools)
7. agent = new LoopAgent({...})
8. formatter = createFormatter(outputFormat)
9. agent.on("*", e => formatter.onEvent(e))
10. result = await agent.run(prompt, { contextPrefix, turnEndGuard })
11. formatter.finalize({ ok, text, sessionId, turns, usage, toolCalls, stopReason })
12. return stopReasonExitCode(stopReason)
```

`stopReasonExitCode`：
- `end_turn` → 0
- `permission_denied` → 4
- `aborted` → 130
- `error` → 1
- `max_steps / max_tokens / budget / timeout / max_repeat` → 0（soft stop）

## `formatter.ts`

三种 output format 实现 `HeadlessFormatter` 接口：

| 模式 | run 期间 | finalize |
|---|---|---|
| `text` | stderr 进度行（除非 `--quiet`） | stdout: 最终 assistant text |
| `json` | 静默 | stdout: 一个 JSON object —— `{ok, text, sessionId, turns, usage, toolCalls[], stopReason}` |
| `stream-json` | NDJSON：每条 AgentEvent 一行 | 最后一条：`{"type":"result", ...}` |

`getToolAlias(name)` 让输出里 tool 名字风格统一（read_file → "Read"
之类，跟 TUI Transcript 一致）。

## `approval.ts`

非交互模式没有 UI 弹窗，只有三种策略：

- `bypassPermissions`：所有 tool 直接 allow
- `acceptEdits`：write/edit/move/delete 自动 allow，其他按 PermissionManager
- 默认 / `default` / `plan`：等价于「无人值守」——任何 ask 直接 **deny**
  + `addLog("error")`；plan 模式对 write 工具显式拒

权限失败的退出码是 4，让 CI 脚本能区分 "agent decided not to" vs
"permission gate blocked"。

---

## 端到端：TUI 一次普通提交

```
ui/prompt.tsx (Enter)
  → useTurnDispatcher.handleSubmit
      ├─ palette 处理（slash/file）
      ├─ submit.resolveAtPathReferences + buildModelText
      ├─ inputQueue.enqueue({ text, displayForm, images })
      └─ isRunning ? wait : drain():
          ├─ drainSystemInbox() → 每条 dispatchUserTurn(xml, undefined, undefined, undefined, silent=true)
          └─ for cmd in queued: dispatchUserTurn(cmd.text, ...)
              ├─ parseCommand(cmd.text) → 非 null → dispatchSlashCommand
              └─ null → addLog("user") + runAgent(cmd.text)
```

Headless 路径短得多：

```
argv → parseHeadlessArgs → readStdinIfPiped → runHeadless
  ↓
buildAgentObjects + LoopAgent (no checkpoint, no devtools)
  ↓
agent.run(prompt) ── formatter.onEvent 实时输出 ──→ formatter.finalize
  ↓
process.exit(stopReasonExitCode)
```

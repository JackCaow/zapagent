# `src/` App 层 —— Shell（入口 / 主组件 / 单例 / 配置 / 会话）

App 层是 TUI 宿主，把 `zapsdk/` 接上 Ink/React。这一篇覆盖最外层的几个文件：

```
src/
├── index.tsx               # CLI 入口 + stdin 标准化 + Ink render + 渲染补丁
├── App.tsx                 # 主 React 组件 —— 状态串联 / dialog 路由
├── session.ts              # 会话 JSONL 写读 / SessionLog ↔ Turn[] 转换
├── singletons.ts           # 模块级单例：autoMemory / conversation / cron / monitor / ...
├── config.ts               # AppConfig + Provider preset 表 + vision 推断
├── devtools-integration.ts # fetch monkey-patch + devtools server 启动
└── version.ts              # 单一版本号源（package.json）
```

---

## `index.tsx` —— CLI 入口

非常小心地按顺序处理：

1. **`--help / --version`**：不进 TUI 直接退出。
2. **`--dev [port]`**：设 `ZAPCODE_DEVTOOLS_PORT` + `openBrowser`。
3. **`--no-devtools`**：清掉 env（父 shell 漏掉的逃生）。
4. **Headless 检测**：以下任一条件成立都走 `headless/run.ts` 不渲染 TUI：
   - `-p / --print <text>`
   - `-c / --continue`
   - `--session-id <id>`
   - 任意位置参数
   - stdin 非 TTY（管道输入）
5. **`--cwd` 早于 singletons 应用**：`process.chdir(args)` 必须在 import
   `singletons.ts` 之前——后者在模块加载时就拿 `process.cwd()` 构造
   `autoMemory` 和 `mdStore`，晚了就 split。
6. **加载 `.env`**：手写解析（不引 dotenv）。
7. **`startDevToolsIfEnabled()`**：在 Ink render 之前——banner 行打到 UI 之上。
8. **清屏 + 滚动条**：`\x1b[H\x1b[2J\x1b[3J`。
9. **stdin 标准化补丁**：
   - 把 `ESC[27;2;13~`（xterm modifyOtherKeys）/ `ESC[13;2u`（kitty kbd）/
     `ESC\r`（iTerm2 meta+enter）全部归一化成 `\n`
   - 抽出 `ESC[I` / `ESC[O`（DEC 1004 focus）改成 `terminal-focus` 模块的
     状态广播，从字节流剔除
   - 替换 `stdin.read()` 而不是监听 `data` —— Ink 7 用 paused mode 主动
     `read()`，所以只能在这里截
   - 启用 1004 焦点上报；进程退出时关掉
10. **Ink render**：`exitOnCtrlC: false`（App 自己处理 Ctrl+C），
    `incrementalRendering: true`（只重写改变的行，避免每帧把 viewport
    yank 到底）。
11. **log-update 补丁**：跟踪每次写出的「视觉行数」与终端宽度；resize
    时按新宽度重算 erase 行数，修 CJK 长行重排后的 ghost。
12. `globalThis.__zapInkClear` 暴露 `inst.clear()` 给 `/new` 之类用。
13. `await inst.waitUntilExit()` → `process.exit(0)`。

CLI/TUI 复杂度的 80% 都在这个文件，因为它处理终端 quirk；剩下的 20%
状态管理在 `App.tsx`。

---

## `App.tsx` —— 主 React 组件

只做编织（orchestration），没业务逻辑。所有重活在 `src/hooks/*` 和
`src/commands/*`，由 App 把它们粘起来。

### 状态

```
config / inputValue / inputEpoch / dialog
logs                         (useLogs)
todos + subagentTodosRef
checkpointRef (CheckpointManager)
toasts                       (useToasts)
pendingImages
inputQueue + systemInboxSize (useSyncExternalStore)
pendingApproval / pendingPlan  (usePermissionApproval / usePlanMode)
agentRef                     (useAgentObjects —— 重建 agent 实例)
status/step/streamingText/...  (useAgentRunner —— 跑 agent + 写 logs)
```

### 关键 callback

| Callback | 由谁调 | 做什么 |
|---|---|---|
| `dispatchUserTurn(text, sys?, imgs?, displayText?, silent?)` | `useTurnDispatcher` + slash command 的 `/review`、`/commit` 等 | `addLog("user", ...)` + `runAgent(...)`；`silent: true` 走 `task-notification` 路径，UI 显示成淡化的系统消息 |
| `dispatchCommand(input)` | `useTurnDispatcher` 检测到斜杠开头 | bind 了 App-local deps 的 `dispatchSlashCommand` |
| `precheckProvider()` | 提交前 | 没 provider/key → addLog 错误 + 拒绝提交 |
| `onClearScreen` | `/clear` + Ctrl+L | 擦终端 + `conversation.clear()` + 重置 logs/todos |

### Static frame freeze（Ink-specific）

Approval bar / plan-approval bar / dialog / palette 任一打开都会
`setStaticCommitFrozen(true)`，让 Transcript 暂时不 commit 新 static row
（avoid eraseLines undershoot when frame height changes mid-stream）。
Overlay 关掉时 batch flush 缓冲的段落。

### 一次性 hygiene

`useEffect(() => { void pruneImageStorage() }, [])` —— 启动后清掉
`~/.zapcode/image-paste/` 里没被任何 log 引用的孤儿、`image-cache/`
里过期的 SVG/URL 缓存。

---

## `session.ts` —— JSONL 持久化

### 路径布局

```
<dataDir>/
└── projects/
    └── <project-id>/           ← git remote/root identity, legacy sanitized cwd fallback
        ├── <sessionId>.jsonl
        ├── memory/             ← AutoMemory
        └── snapshots/...
```

`projectSessionsDir` 是 mkdir 出来的；reader 会同时扫描 legacy sanitized-cwd
目录，保证旧 session 在升级后仍可见。每启动一次进程开一个 `SessionWriter`
单例 + UUID 文件名；session 进程退出时 finalize。

### CCB 兼容 JSONL

每条事件按以下 type 写：

| logType | 写成 | 备注 |
|---|---|---|
| `user` | `{ type:"user", message:{role:"user",content,images?}, permissionMode, promptId }` | |
| `task-notification` | 同上 + `subtype:"task-notification"` | 后台任务完成的 XML 注入 |
| `agent` | `{ type:"assistant", message:{role:"assistant",content:[{type:"text",text}]} }` | |
| `tool` / `result` | `{ type:"progress", data:{ toolCallId, toolName, arguments, output, success, meta, logType, agentPath? } }` | |
| `thinking` | `{ type:"assistant", message:{content:[{type:"thinking",thinking}]} }` | |
| `system` / `error` | `{ type:"system", subtype:"info"\|"error", message }` | |
| snapshot | `{ type:"snapshot", snapshot:{...} }` | checkpoint 调用 |
| rewind-marker | `{ type:"rewind-marker", targetTurnStartIndex, logIndex }` | rewind 之后写一条 |
| todo-update | `{ type:"todo-update", key, todos }` | TodoStore 每次写都顺手记 |

所有条目带 `baseEntry`：`parentUuid`（上一条 uuid，形成链）/ `uuid` /
`timestamp` / `cwd` / `sessionId` / `version` / `gitBranch` / `userType` /
`isSidechain`。

### `appendReplace` —— 不允许覆盖怎么做更新？

写一条新行 + `replacesUuid: <旧 uuid>`。reader 在解析时把所有
`replacesUuid` 引用的 uuid 加进 `replacedUuids: Set`，跳过它们。
chain `A → B → C` 通过链式 replace 实现，最终只有 C 出现在解析输出里。

用途：streaming tool call 三阶段（`tool_call_pending` → `argsPreview` →
`final`）每个阶段写一行，UI 看到的是最终态而不是三条堆叠。

### `parseSessionJsonl(raw)` → `SessionLog[]`

按上面 type 反映射。CCB 用户消息的 `content` 可能是 `string` 或者
`[{type:"text"|"tool_result"|...}]` 数组；后者会被拆成多条 SessionLog
（每条 tool_result 一条 `"result"` log），让 restore 能重建 tool pair。

### `sessionLogsToTurns(logs)`

恢复时的核心：把 SessionLog[] 转回 `Turn[]`，wire-valid by construction
（孤儿 tool_use 合成 IncompleteCall，被 `buildToolTurn` 折叠成
failure ToolResult）。`mergeConsecutiveUserTurns` 把连着的 user message
合并，因为 CCB 格式偶尔会拆开。

`sessionLogsToMessages = turnsToMessages(sessionLogsToTurns(logs))` —— 老
callers 还接受 Message[]，但新代码该走 Turn[]。

### Public API

```ts
appendLog(type, text, tool?, images?, agentPath?): number   // 自增 journalLogIndex
peekJournalLogIndex()
getCurrentSessionId()
replaceLog(idx, type, text, tool?, agentPath?)
startNewSession()                  // /new
appendSnapshot(snapshot)
appendRewindMarker(...)
appendTodoUpdate(key, todos)
listSavedSessions(): SessionInfo[] // 同步兼容 API，不用于 TUI render
listSavedSessionsPage({ offset, limit }): Promise<SavedSessionPage> // /sessions
loadSavedSession(id): SessionLog[] // 严格校验；失败抛 SessionLoadError
prepareSavedSession(id): Promise<PreparedSessionRestore> // 无状态变更
setActiveSession(logs, { sourceSessionId, metadata }) // durable commit
loadLastSession(): { id, logs } | null   // 自动恢复
deleteSavedSession(id)
parseSessionJsonl(raw)             // 单测用
```

`injectRestoreDividers(logs)` —— restore 时塞回 turn 分隔符（live 模式
每个 turn 结束 emit 一次，但不持久化）。

`/sessions` 使用 prepare/commit 两阶段恢复：异步读取、解析和构建
conversation/checkpoint/todo/usage bundle 成功后，才用可回滚的事务切换
ConversationManager 与 active writer。列表按文件 mtime 分页加载，不信任
JSONL 内部的 `sessionId` 作为文件定位符。

---

## `singletons.ts` —— 进程级单例

启动时一次性初始化、长生命周期、跨 hook 共享：

```ts
autoMemory  = new AutoMemory(cwd)
appLogger   = new Logger()
agentLogger = new AgentLogger(appLogger)
permissionManager = new PermissionManager(cwd, appLogger)
conversation = new ConversationManager({ ... })
mdStore     = openMdStore(autoMemory.memoryDir)
cronHandle  = cronTools({})
taskStore   = new TaskStore({})
monitorHandle = monitorTool({ store: taskStore })
delegateProviders = []
delegateProvidersReady = detectProviders(2000)
delegateEventBridge = { handler: null }
```

注意点：
- **构造前置 effect**：模块加载时把 `SKILLS`（`src/skills.ts`）写到
  `~/.agents/skills`，供 codex 也能复用。
- **fresh session 启动**：`conversation.clear()` —— 上次的 in-memory 历史
  作废；要恢复走 `/sessions`。
- **task → systemInbox 桥**：`taskStore.on("exited")` 立刻构造
  `<task-notification>` XML 推到 systemInbox，下个 turn 静默给模型。
- **shutdown 钩子**：`exit/SIGINT/SIGTERM` 都 stopAll task + stop cron，
  避免 Ctrl+C 留下孤儿子进程。
- **delegate provider 探测**：异步 `which claude / which codex`，
  detection 完了 `agentRef` 重建（`useAgentObjects` await 它），让
  `delegate_agent` 工具在初次 LoopAgent 就能注册——否则首条 user message
  发出去时模型看不到这个工具。

---

## `config.ts` —— 配置

### 数据模型

```ts
interface AppConfig {
  providers: Provider[]
  active: { providerId, model }
  serperKey: string
  maxTokens: 65536
  maxSteps: 200
  customSystemPrompt: ""
  compaction: { auto, prune, reserved }
  mcpServers: MCPServerConfig[]
  permissionMode: "default" | "acceptEdits" | "plan" | "bypassPermissions"
  fileCheckpointingEnabled?, maxSnapshotFileBytes?, maxSnapshots?, ...
}

interface Provider {
  id: "sp_<ts>"
  name: string
  baseURL: string
  apiKey: string
  contextWindow: number
  models: string[]
  sourcePresetId?: string
  protocol?: "openai" | "anthropic"
  extraRequestParams?: Record<string, unknown>
  visionByModel?: Record<string, boolean>     // 自愈记忆
}
```

### Provider 预设表

`PROVIDER_PRESETS` 列出 11 家常用 provider：OpenAI、Anthropic、Anthropic-
compat（自定义 URL）、Gemini、xAI、Moonshot、DashScope、OpenRouter、
DeepSeek、Zhipu、MiniMax、Ollama。每条携带 baseURL、默认模型示例、
contextWindow、`effortValues`（reasoning_effort cycle）、可选
`extraRequestParams`（DeepSeek 的 `thinking.type:"enabled"`）和 protocol
（Anthropic 协议 vs OpenAI 协议）。

`detectPresetId(baseURL)` 启发式回填——env 引导出来的 provider 或老
config 没有 `sourcePresetId` 时用。

### Vision 推断

`inferVisionSupport(modelId)` 通过 regex 白名单识别：
- gpt-4o / gpt-5 / o1-o9 / claude-3+ / gemini-1.5+ / qwen-vl / deepseek-vl
  / pixtral / llava 等

`resolveVisionSupport(provider, modelId)` 先看显式 `visionByModel`，
没有再 fallback 到 infer。**LoopAgent 撞 400 image rejection 时调
`setVisionSupport(false)`**，写入 config 并通过 `onImageStripSelfHeal`
回调让 App 持久化——下次启动就不会再撞。

### Compaction 阈值衍生

```ts
deriveCompaction(contextWindow) = {
  triggerAt: ctx * 0.80,
  keepFloorTokens: ctx * 0.40,
  reserveForOutput: clamp(ctx * 0.10, 1024, 8192),
}
```

ConversationManager 和 LoopAgent 都从这里取阈值，统一来源。

### Reasoning effort cycle

`cycleEffort(config, providerId)`：cycle 顺序
`off → values[0] → values[1] → … → off`。提交时写到
`provider.extraRequestParams.reasoning_effort`，由 OpenAI-compat
adapter 直接 spread 进请求体。

### `buildSystemPrompt(config, cwd, ...)`

custom prompt 模式直接返回（加 today + cwd 尾巴）；否则委托给
`src/prompts/index.ts: buildDefaultPrompt`。

### `loadAppConfig(path)` / `saveAppConfig(path, config)`

- 缺失 → defaults
- 读到 → 合并 defaults，强制 `permissionMode: "default"`（session-scoped）
- `normalize()` 强制不变量：`active` 必须指向 providers 里实际存在的
  provider 和 model

---

## `devtools-integration.ts`

`startDevToolsIfEnabled()` 在 `index.tsx` 调用：
- 没 env var → 直接返回 null
- 有 → `startDevToolsServer({ port, agent: noopAgent, getConversation, ... })`
  然后立刻 `patchFetchForDevtools` 把每次 `fetch()` 出口都捕获给 server

`devToolsSetAgent(agent)` / `devToolsSetReaders({ getConversation, ... })`
由 `useAgentObjects` / `useAgentRunner` 在每次 agent 实例化后调用——
server 保持单例不变，但订阅源在背后被换。

fetch monkey-patch 关键细节：
- 解析 `Request` 对象 / `string|URL` + init 两种调用形态
- body 类型分流：`string` / `Uint8Array` / `Blob.text()` / fallback `[type]`
- **拦截 WS upgrade 也是 HTTP，所以要过滤 `127.0.0.1` 自身请求**——
  否则每个 WS 心跳都在 Network tab 留一条
- request 阶段先 push 一次；response/error 时再 push 一次（pair via `id`）

---

## 端到端：一次启动里这些文件怎么协作

```
process start
  ↓
index.tsx args 处理
  ↓
import singletons.ts ← 触发 AutoMemory.ensure、安装 zapcode 自带 skills、
                       预拉 cron/monitor/conversation
  ↓
loadAppConfig(configPath) — 从 ~/.zapcode/config.json 读
  ↓
ink.render(<App />) → App() 渲染
  ↓
useAgentObjects 用 config 构造 LoopAgent → devToolsSetAgent(agent)
  ↓
useAgentRunner 等用户输入
```

`session.ts` 在每条 log 写入时被动调用；`config.ts` 在 `/connect /model
/mode /effort /permissions` 等 dialog 提交时更新。devtools 是惰性的——
没设 env var 整个子系统都不加载，零开销。

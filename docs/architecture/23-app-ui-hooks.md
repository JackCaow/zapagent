# `src/ui/` + `src/hooks/` —— TUI 视图与状态

Ink/React 实现的整个 TUI 表面。App.tsx 只做编织，所有真正的状态机
和组件实现都在这两个目录。

```
src/
├── hooks/                       # 状态机 / 副作用
│   ├── useLogs.ts               # 日志数组 + Static-commit freeze + JSONL append
│   ├── useAgentObjects.ts       # 配置变化时重建 provider/registry/executor + 接 MCP
│   ├── useAgentRunner.ts        # 跑 LoopAgent 的真主体
│   ├── useTurnDispatcher.ts     # 用户提交 + 队列 drain + 系统事件 drain
│   ├── usePermissionApproval.ts # tool 审批决策
│   ├── usePlanMode.ts           # plan / exit-plan-mode 状态机
│   ├── usePalettes.ts           # slash 和 @ 文件 palette
│   ├── usePasteHandler.ts       # 粘贴文本 / 图片 / 历史导航
│   ├── useKeyboardShortcuts.ts  # 全局快捷键路由
│   ├── useSpinner.ts            # 旋转动画 idx + elapsed
│   └── useToasts.ts             # 顶部 toast 列表
└── ui/                          # 组件
    ├── Transcript.tsx           # 日志渲染（聊天 + 工具 + 折叠）
    ├── prompt.tsx               # 输入框 + 历史导航 + IME 光标
    ├── controlled-input.tsx     # 受控字符串 + cursor 状态机
    ├── text-field.tsx           # 文本输入低层 primitive
    ├── footer.tsx               # 底部状态栏
    ├── live-activity.tsx        # 运行中的 spinner + pending tool 行
    ├── dialog-*.tsx             # 各种模态：connect / model / sessions / mem / permissions / rewind / approval / plan-approval
    ├── slash-palette.tsx        # / 命令补全
    ├── file-palette.tsx         # @ 文件补全
    ├── conversation-surface.tsx # Box 包装 + 一些 layout 约束
    ├── todos-panel.tsx          # /todos 视图
    ├── toast.tsx                # 顶部 toast 列表渲染
    ├── markdown.tsx             # 自实现 Markdown → Ink Box/Text
    ├── code-block.tsx           # ``` 代码块 + shiki 高亮
    ├── diff.tsx                 # unified diff 上色
    ├── highlight.ts             # shiki 单例 + 主题
    ├── edit-preview.ts          # ApprovalBar 用的 diff 预览
    ├── group-logs.ts            # 把 subagent 段折叠
    ├── transcript-format.ts     # tool 图标、alias、ResultLabel
    ├── compact-utils.ts         # auto-compact 摘要的解析
    ├── input-nav.ts             # 多行编辑光标移动 / history nav 边缘判定
    ├── truncate.ts              # visualWidth-aware 截断
    ├── theme.ts                 # 颜色对象 c.*
    ├── terminal-focus.ts        # DEC 1004 焦点广播 + cursor 隐藏
    ├── welcome-raw.ts / Welcome.tsx / logo.tsx  # 启动横幅
    ├── types.ts                 # LogEntry / LogType / ToolCallInfo / UserImageRef
    └── dialog-frame.tsx / dialog-picker.tsx     # 共用模态外壳 / 列表选择器
```

---

## Hooks（按职责）

### `useLogs` —— 日志数组 + Static-commit freeze

`logs[]` 是 Transcript 的数据源。每条 `addLog`：
1. `journalAppend(...)` 同步写 JSONL（崩了不丢失）
2. 在 `logIndexMap` 里记 `id → journalIdx`，供后续 `replaceLog`
3. 如果当前 frozen（dialog/palette 打开），entry 进
   `pendingBufferRef` 缓冲，不调 `setLogs`
4. 否则 `setLogs(prev => [...prev, entry])`

**Static-commit freeze**：Ink 把已 commit 的行从 dynamic frame 移到 Static
区（不会再被 erase）。dialog 浮在 dynamic 区——这时候 commit 新行会触
发 erase→draw 路径，把 dialog 部分内容推进 terminal 滚动条永远救不回来。
所以 freeze 期间所有 commit 缓冲，dismiss 时一次性 flush。

JSONL 写**不**被 freeze 影响——磁盘是单一真相，UI 只是延迟显示。

`registerStaticFlushCallback(cb)` 让 streamingPreview 注册一个清空
streaming-text 的回调；在 flush 之前**先**调用，保证两者在同一个
React batch 里渲染（不然会有"streaming tail 已消失但 Static 还没来"的
flash）。

`compactLogs(summary, before, after, files)` —— autocompact 触发后调用，
直接 `setLogs([{type:"compacted", ...}])` 一条总结条目；JSONL 不动（磁盘
保留全部历史，仅 UI 折叠）。

### `useAgentObjects`

订阅 `config` 变化重建 provider/registry/executor。同时：
- await `delegateProvidersReady`（首次 PATH 探测），完成后再 build 一次
  让 `delegate_agent` 工具能在初次 LoopAgent 注册上
- `config.mcpServers` diff → 增量 connect / disconnect MCPToolBridge

返回 `agentRef`（mutable ref），`buildAgentRuntime` 每个 turn 从这里取。

### `useAgentRunner`

最核心的 hook。`runAgent(text, systemPrompt?, images?)` 触发：

```
1. attachments = await buildPerTurnAttachments(autoMemory)
2. abortRef.current = new AbortController()
3. preview = createStreamingPreview({addLog, setStreamingText, ...})
4. handlers = createRunHandlers({controller, preview, ...})  // 含 subAgentEventHandler
5. delegateEventBridge.handler = handlers.subAgentEventHandler  // delegate_agent 转发
6. runtime = buildAgentRuntime({ provider, registry, executor, conversation, ...
                                subAgentEventHandler: handlers.subAgentEventHandler })
7. handlers.wire(runtime)
8. contextPrefix = makeContextPrefixBuilder({attachments, getTodos, modelId})
9. turnEndGuard = makeTurnEndGuard(getTodos)
10. result = await runtime.run(text, { signal, images, contextPrefix, turnEndGuard })
11. finally: handlers.settlePending("..."); preview.flush(); setStatus("ready")
12. emit run_ended divider, saveLastOutput(result.text)
```

setStatus / setStep / setActiveTool 等 state 全在这里聚合；React 把变化
推到 Transcript / LiveActivity / Footer。

### `useTurnDispatcher`

`handleSubmit(value, fileBlocksOverride?)`：
1. slash-palette open + Enter：替换输入为 selected entry，不发
2. file-palette open：blockSubmit
3. `resolveAtPathReferences(value)` —— 取 @path 文件块；失败返回（已 addLog 错误）
4. `buildModelText(trimmed, fileBlocks)` —— 模型可见文本
5. 显示形态 `displayForm` —— 用户可见原文
6. `enqueueCommand({ text, displayForm, images })`
7. `pushHistory(value)` —— prompt history
8. `setInputValue("")` / `setPendingImages([])`
9. `drainIfIdle()` —— useEffect 触发的

`drainIfIdle` effect 在 `!isRunning && (queueLen + systemInboxLen) > 0`
时跑：
- 先 `drainSystemInbox()` —— 系统事件先于用户输入
- 再 `dequeueAllCommands()` —— 用户 queue
- 每条 `await dispatchUserTurn(...)`，串行

### `usePermissionApproval`

`onApproval(name, args)` 决策树（短路）：

1. `permissionMode==="plan"` + WRITE_TOOLS 命中 → DENY without prompting
2. `matchDangerous(cmd)` (bash) → 强弹 ApprovalBar（无视任何 allow 规则
   或 bypass 模式）
3. `permissionManager.checkPermission`：
   - allow → ALLOW（audit log）
   - deny → DENY
   - ask → 强弹 ApprovalBar（即使 bypass/acceptEdits）
4. `bypassPermissions` → ALLOW
5. `acceptEdits` + EDIT_TOOLS → ALLOW
6. fallback → 弹 ApprovalBar

每个决定都 log 到 `appLogger.info` + 必要时 `addLog("system")` 让用户看到。

ApprovalBar 选 "always allow" 时返回的 choice 携带 scope（session / project
/ global），写回 PermissionManager 对应 store。

### `usePlanMode`

`enter_plan_mode` 工具调用：`config.permissionMode = "plan"`，UI footer
显示 plan 标记。`exit_plan_mode` 工具调用：发出 `pendingPlan` state（带
模型给的 plan 文本），UI 弹 PlanApprovalBar。用户接受 → `permissionMode`
恢复 default + 工具 resolve；拒绝 → 模型继续在 plan mode 内规划。

### `usePalettes`

监听 `inputValue` 变化：
- 以 `/` 开头不含空格 → slash palette 打开，按前缀过滤命令 + 已装 skill
- `@xxx` 模式 → file palette 打开，`file-completer.ts` 做 fuzzy 文件名匹配

`slashEntries` / `fileEntries` + 当前 selected idx 暴露给 App 和
useKeyboardShortcuts。

### `usePasteHandler`

绑定 ink 的 `paste` 事件 + Ctrl+V：
- 长粘贴文本（> threshold）折叠成 `[Pasted #N]` 占位符，原文存
  `pasteStoreRef`；提交时 `expandPastes` 还原。队列和 session 分别保存
  compact `displayForm` 与完整 `restoreText`，超过 64 KiB 的 session
  restore text 使用 `~/.zapcode/paste-history/` 内容寻址 sidecar；sidecar
  丢失或哈希损坏时，恢复链路必须显示 unavailable 标记，不能静默把
  compact placeholder 当作已恢复原文传给模型
- 图片粘贴（macOS pbpaste image，Linux xclip，Windows clip）→
  `attachImageWithPlaceholder` 把图存到 `~/.zapcode/image-paste/<id>.png`，
  在 input 插入 `[Image #N]` 占位
- `handleHistoryNav(direction)` —— ↑↓ 命令历史；多行 buffer 时按 edge
  判断（光标在第一行才上一条历史，最后一行才下一条），由 `input-nav.ts`
  里 `atTopEdge / atBottomEdge` 实现

### `useKeyboardShortcuts`

全局 `useInput` 钩子，按上下文分发：
- palette 开着：↑/↓ 移动选中，Enter 选中，Esc 关闭
- dialog 开着：键盘事件让 dialog 自处理（这里只兜底 Esc）
- pendingApproval / pendingPlan：箭头键移动选项
- 普通输入态：
  - Ctrl+C：首次取消 agent，第二次 exit
  - Ctrl+L：onClearScreen
  - Ctrl+V：调用 paste handler
  - Esc：popLastBackToInput / 清 pendingImages
  - dragdrop image：捕获并 attach

### `useToasts`

简单 list state；`addToast(text, { variant, duration })` 推一条，定时
removeToast。`toasts[]` 被 `<ToastContainer>` 渲染在顶部。

### `useSpinner`

`{ spinIdx, elapsed }`：在 status 非 ready 时跑 `setInterval(80ms)`
增 spinIdx；elapsed 由 turn 起始时间算。LiveActivity 和 footer 都用。

---

## UI 组件（按层次）

### 输入层：`prompt.tsx` + `controlled-input.tsx` + `text-field.tsx`

`controlled-input` 是 zapcode 自己实现的「受控字符串 + cursor 状态机」，
没用 ink-text-input 的原因是后者不支持中文宽字符、不支持多行、不支持
IME 光标位置。

`prompt.tsx` 在上面包：placeholder、shell mode 切换（`/shell`）、
provider/model/token 显示、token 计数条、Enter/Shift+Enter 处理。

`text-field.tsx` 是底层最 raw 的字符渲染——visualWidth 计算、CJK 宽
字符、IME 区域可视化。

### 显示层：`Transcript.tsx` + `markdown.tsx` + `code-block.tsx` + `diff.tsx`

`Transcript` 用 Ink 的 `<Static>` commit 已完成的日志条目，dynamic 区只
管 streamingTail。两栏布局：左边 gutter（图标 / agent 路径标签），
右边内容列（**显式 width，不是 flexGrow**——flexGrow 在 Ink 里 wrap
会回到 col 0）。

每条 log 按 `type` 选 renderer：
- `user` / `agent` / `thinking` —— Markdown 渲染
- `tool` —— gutter 图标 + tool alias + args preview
- `result` —— 折叠 + 摘要（`formatResultLabel`）
- `compacted` —— autocompact 总结条
- `divider` —— turn 分隔
- `error` / `system` —— 高亮文本
- `task-notification` —— 淡化系统消息

`group-logs.ts` 在渲染前把 subagent 段（`agentPath` 不为空）折叠成
single block。

`markdown.tsx` 是手实现的——支持 `#` 标题、有序/无序列表、加粗/斜体/
代码 inline、链接（`[text](url)` → 仅显示 text，url 提示底部）、
fence code block 走 `code-block.tsx`。**不**用任何 react-markdown 之类
重依赖，因为 Ink 里他们都不工作。

`code-block.tsx` 调 `highlight.ts` 拿 shiki tokens → 转 Ink Text 节点。
shiki 单例初始化在 App 顶部 `initHighlighter()` 触发（fire-and-forget，
未 init 时回退到纯色）。

`diff.tsx` 把 unified diff 上色：`+` 绿、`-` 红、`@@` 灰。
`looksLikeDiff(text)` 简单 sniff（首行 `--- ` / `diff --git` 等）。

### 状态层：`footer.tsx` + `live-activity.tsx` + `conversation-surface.tsx` + `todos-panel.tsx` + `toast.tsx`

- `footer.tsx` —— cwd 简称 / provider/model / token 进度条 /
  permission mode badge / step counter / shell mode
- `live-activity.tsx` —— 运行中时显示「Thinking · 12.4s」「⌽ write_file
  (foo.ts · 18 KB)」+ 最近 3 个 pending tool 行
- `conversation-surface.tsx` —— Box wrapping + min-height
- `todos-panel.tsx` —— `/todos on` 时显示 todo 列表
- `toast.tsx` —— `<ToastContainer>` 顶部短信息

### Palette / Dialog

- `slash-palette.tsx` / `file-palette.tsx` —— 简单列表 + 高亮选中
- `dialog-frame.tsx` / `dialog-picker.tsx` —— 通用模态外壳和选择器
- 各 `dialog-*`：
  - `dialog-connect` —— provider 设置向导（650 行，最大）
  - `dialog-config` —— `ModelDialog` / `ModeDialog` / `EffortDialog`
  - `dialog-sessions` —— 会话列表 + load/delete
  - `dialog-mem` —— memory 浏览 / forget
  - `dialog-permissions` —— 规则浏览 + shadow 标灰 + 删除
  - `dialog-rewind` —— snapshot 列表 + dry-run diff stats
  - `dialog-approval` (ApprovalBar) —— 横在 prompt 上方，按上下选
    allow/deny/edit/always allow
  - `dialog-plan-approval` —— 接 plan 提交

### Helpers

- `transcript-format.ts` —— `getToolAlias(name)`、`getToolIcon(name)`、
  `formatResultLabel(result)`、`formatThinkingDuration(ms)`
- `edit-preview.ts` —— ApprovalBar 展示前 N 行 diff 预览
- `truncate.ts` —— visualWidth-aware 字符截断（CJK 宽字符算 2）
- `compact-utils.ts` —— autocompact 总结里抓 file mentions 列出
- `terminal-focus.ts` —— `setTerminalFocus(bool)` 触发组件订阅，让
  prompt 在窗口失焦时隐藏光标（解决 Apple Terminal mark 问题）
- `input-nav.ts` —— atTopEdge / atBottomEdge / 多行光标移动
- `theme.ts` —— color object `c.{accent,text.faint,error,...}`

---

## Render 层级 / Ink-specific quirks

1. **`<Static>` vs dynamic**：commit 进 Static 的内容不再被 erase；
   dynamic 部分每帧 erase+redraw。Transcript 把 logs 全推到 Static，
   streamingTail 留在 dynamic。
2. **`incrementalRendering: true`**：Ink 7 选项，每帧只重写改变的行，
   避免 viewport jump。
3. **`exitOnCtrlC: false`**：App 自己接 Ctrl+C，第一次 cancel，第二次 exit。
4. **prompt 的 IME 光标**：用 Ink `useCursor` 报告位置，让原生 IME
   composition box 正确浮在光标位置。
5. **Apple Terminal `[…]` mark 问题**：见 `memory/feedback_apple_terminal_marks.md`
   —— 不解，但 `terminal-focus` 隐藏 cursor 减少视觉干扰。

---

## 跨 hook 数据流（简版）

```
useLogs    ←—— useAgentRunner.addLog/replaceLog
              ←—— wireRunHandlers (events → log)
              ←—— streamingPreview (deltas → commit / tail)

useAgentObjects ── 产 agentRef ──→ useAgentRunner.buildAgentRuntime

useTurnDispatcher ── inputQueue/systemInbox drain ──→ dispatchUserTurn ──→ runAgent

usePermissionApproval.onApproval ── 注入 ToolExecutor

usePlanMode.planCallbacks ── 注入 createBuiltinRegistry

usePalettes ── 监听 inputValue ──→ slashEntries/fileEntries

useKeyboardShortcuts ── 总线，按 state 路由按键
```

App.tsx 把所有这些粘起来 + 渲染对应 UI 组件。完整的状态/事件路径走完
通常需要 6-8 个 hook 协作——但每个 hook 自己关注点很窄，单测和阅读都
比 monolithic 版本（refactor 前 2200 行 App.tsx）友好得多。

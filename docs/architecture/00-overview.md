# Architecture Overview

Zapcode 是一个终端里的 AI coding agent，运行在 Bun 上，靠 Ink/React 渲染 TUI。
代码分成两层，二者目录平行：

```
zapcode/
├── src/        ← App 层（Ink TUI + 交互/headless/会话管理）
└── zapsdk/     ← Agent SDK 层（LLM 抽象 / agent loop / 工具 / 上下文）
```

`src/` 是这套 SDK 的一个 **消费者**；`zapsdk/` 不依赖任何 React 或 Ink 代码，
理论上可以单独嵌入到 web、bot 或其他宿主进程里。

---

## 两层的边界

| 关注点 | 归属 |
|---|---|
| LLM 协议（OpenAI / Anthropic 兼容协议、流式、重试、错误分类） | `zapsdk/core` |
| Runtime 装配、Thread/Turn/Item/Run 协议、事件/控制状态存储与崩溃分类 | `zapsdk/runtime` |
| Agent 主循环（step → tool → step）、事件、预算、流式工具执行 | `zapsdk/agent` |
| 工具注册表、JSON-Schema、审批 hook、结果落盘 | `zapsdk/tools` |
| 内置工具集合（文件、shell、edit、http、search、subagent、todo…） | `zapsdk/builtin-tools` |
| 上下文压缩（autocompact / microcompact / 反应式压缩 / 工具结果摘要） | `zapsdk/context` |
| Checkpoint / Rewind（文件快照 + content-addressed blob store） | `zapsdk/checkpoint` |
| 跨会话长期记忆（auto-memory MD 文件）和会话历史（Turn[]） | `zapsdk/memory` |
| MCP 桥接、Skill 模板、后台 Task | `zapsdk/{mcp,skills,tasks}` |
| 平台/剪贴板/图片/shell 解析等小工具 | `zapsdk/utils` |
| 终端入口、stdin 标准化、Ink 渲染 patch | `src/index.tsx` |
| TUI 主组件树、状态串联 | `src/App.tsx` |
| 命令分发（slash commands）、输入队列、系统事件投递 | `src/commands*`, `src/queue` |
| Headless / 非交互模式（`zap -p`、stdin 管道、CI） | `src/headless` |
| React hooks（runner、键盘、palette、approval、plan-mode…） | `src/hooks` |
| 视图组件（dialog、palette、Transcript、prompt、footer…） | `src/ui` |
| 系统 prompt 构造、上下文片段注入 | `src/prompts` |
| Markdown memory 存储 + 前置 frontmatter 解析 | `zapsdk/memory` |
| 工具审批策略、模式匹配 | `src/permissions.ts` |
| 配置文件、provider 模型表、effort/vision 推断 | `src/config.ts` |
| 会话 JSONL 落盘（CCB 兼容）与回放 | `src/session.ts` |

---

## 一个交互式 turn 的请求流

```
用户输入
   │
   ▼
src/ui/prompt.tsx ── 控件捕获到 Enter
   │
   ▼
src/hooks/useTurnDispatcher  ── 排队 / 命令 vs 普通输入
   │
   ├─→ slash command（/connect /clear /shell …）
   │       └─ src/commands/dispatcher.ts ── 直接对 React state 操作
   │
   └─→ 普通对话
           │
           ▼
        src/hooks/useAgentRunner ── 调用 AgentRuntime.run
           │
           ▼
   zapsdk/runtime ── 统一装配、版本化事件、EventStore + RuntimeStateStore
           │
           ▼
   ┌────────────────────────────────────────────┐
   │  zapsdk/agent/loop.ts (LoopAgent)          │
   │                                            │
   │   for step in 1..maxSteps:                 │
   │     ① ConversationManager.serialize()      │
   │        → Message[]                         │
   │     ② AutoCompact 检查 / 触发压缩          │
   │     ③ LLMProvider.stream(msgs, tools)      │
   │        ├─ StreamingToolExecutor 边解析     │
   │        │  边对成熟 tool_call 并发执行       │
   │        │  → ToolExecutor.execute()         │
   │        │     ├─ permissions check          │
   │        │     ├─ approval callback          │
   │        │     ├─ post-process (snapshot)    │
   │        │     └─ tool-result-storage 落盘   │
   │        └─ AgentEventEmitter 广播事件        │
   │     ④ buildToolTurn() 凑齐 Turn            │
   │     ⑤ ConversationManager.add(Turn)        │
   │     ⑥ 若没有 tool_use → break              │
   └────────────────────────────────────────────┘
           │
           ▼
   事件流回到 useAgentRunner → 写入 logs → React 重渲染 Transcript
           │
           ▼
   src/session.ts ── 每条 log 异步落盘到 .zapcode/projects/<project-id>/<id>.jsonl
```

每一步都尽量是 **streaming-first**：模型 token 边到边渲染、tool 参数 JSON 边解析边
执行、tool 输出大于阈值时压缩并落盘成 `<TOOL_RESULT_FILE>` 占位符。

---

## 数据持久化的几个位置

| 路径 | 由谁写 | 写什么 |
|---|---|---|
| `~/.zapcode/config.json` | `src/config.ts` | 用户 provider 列表 + active 绑定 + MCP servers |
| `~/.zapcode/projects/<project-id>/<sessionId>.jsonl` | `src/session.ts` | 单会话事件流（CCB 兼容：user/assistant/progress/snapshot/rewind-marker/todo-update） |
| `~/.zapcode/projects/<project-id>/runtime-events/<thread-hash>.jsonl` | `zapsdk/runtime` | 版本化 Thread/Turn/Item/Run 事实流 |
| `~/.zapcode/projects/<project-id>/runtime-state/<thread-hash>.json` | `zapsdk/runtime` | 原子控制状态、approval/workspace/artifact/merge 与恢复报告 |
| `~/.zapcode/memory/` | `zapsdk/memory/md-store.ts` + `memory_save` | 全局个人记忆，仅 `user` / `feedback` |
| `~/.zapcode/projects/<project-id>/memory/` | `zapsdk/memory/auto-memory.ts` + `zapsdk/memory/md-store.ts` | 项目长期记忆，`project` / `reference` + compact state/timeline |
| `~/.zapcode/projects/<project-id>/snapshots/` + `blobs/` | `zapsdk/checkpoint` | 文件级快照（每条 turn 前快照写入文件的 sha256-blob） |
| `~/.zapcode/projects/<project-id>/tool-outputs/` | `zapsdk/utils/tool-result-storage.ts` | 超阈值的 tool 输出（agent 拿到的是引用） |
| `~/.zapcode/projects/<project-id>/mcp-images/` | `zapsdk/mcp/bridge/tools.ts` | MCP server 返回的 inline 图片落盘副本 |
| `~/.zapcode/projects/<project-id>/tasks/outputs/` | `zapsdk/tasks/store.ts` | background bash / monitor 的 stdout+stderr 日志 |
| `~/.zapcode/image-paste/` + `image-cache/` | `src/imageStore.ts` | 剪贴板粘贴图片 + SVG/URL 图片本地缓存 |
| `~/.zapcode/logs/` | `zapsdk/debug` | 当 `--debug` 开启时的 agent 内部日志 |

`ZAPCODE_DATA_DIR` 环境变量统一覆盖以上根目录（见
`zapsdk/utils/platform.ts:getAppDataDir`）。
`<project-id>` 由 `zapsdk/utils/project-paths.ts` 生成：git 仓库优先使用
remote/root identity，非 git 目录回退到 legacy 的 sanitized cwd；session reader 会同时
扫描 legacy cwd 目录，保证升级后旧会话仍可见。

---

## 启动流程（src/index.tsx）

1. 处理 `-h/-v/--dev/--no-devtools`。
2. **Headless 触发判断** —— 任一条件满足就 dynamic-import `src/headless/run.ts` 走非交互路径：
   - `-p / --print`
   - `-c / --continue`
   - `--session-id`
   - 任意位置位置参数
   - stdin 不是 TTY（管道输入）
3. 加载 `.env`。
4. `startDevToolsIfEnabled()`（`ZAPCODE_DEVTOOLS_PORT` 时启动 devtools server）。
5. 清屏 `\x1b[H\x1b[2J\x1b[3J`，把残留滚动条历史也擦掉。
6. **stdin 标准化补丁** —— 把所有形式的 Shift+Enter（xterm modifyOtherKeys / kitty
   kbd / iTerm2 meta+enter）改写成 `\n`；把 DEC 1004 焦点事件 `ESC[I/O` 抽离并
   广播给 `terminal-focus`。
7. `ink.render(<App />, { exitOnCtrlC: false, incrementalRendering: true })`。
8. 给 Ink 的 `log-update` 实例打补丁：跟踪上次写入时的终端宽度，resize 时按新宽度
   重算视觉行高度，避免 CJK 长行重排出 ghost 行。
9. `App` 内部按需 hydrate：`useLogs / useAgentRunner / usePermissionApproval /
   usePlanMode / usePalettes / useTurnDispatcher / useKeyboardShortcuts`，每个
   hook 各管一个子系统。

---

## 模块目录索引

按本文档阅读顺序：

| 文件 | 范围 |
|---|---|
| `10-sdk-core.md` | `zapsdk/core` —— LLM 抽象、provider、retry、turn、stream-idle |
| `11-sdk-agent.md` | `zapsdk/agent` —— LoopAgent / SingleCallAgent / 事件 / 预算 / 流式工具执行 |
| `12-sdk-tools.md` | `zapsdk/tools` 框架 + `zapsdk/builtin-tools` 全套内置工具 |
| `13-sdk-context.md` | `zapsdk/context` —— 4 种压缩策略 + token 计数 + 工具摘要 |
| `14-sdk-checkpoint.md` | `zapsdk/checkpoint` —— 文件快照、blob store、rewind |
| `15-sdk-memory-mcp-skills-tasks.md` | `zapsdk/{memory,mcp,skills,tasks}` |
| `16-sdk-devtools-debug-utils.md` | `zapsdk/{devtools,debug,utils}` |
| `20-app-shell.md` | `src/index.tsx`、`App.tsx`、`session.ts`、`singletons.ts`、`config.ts` |
| `21-app-agent-permissions.md` | `src/agent/`、`agent-factory.ts`、`permissions.ts` |
| `22-app-commands-queue-headless.md` | `src/commands*`、`src/queue/`、`src/headless/` |
| `23-app-ui-hooks.md` | `src/ui/` 和 `src/hooks/` |
| `24-app-prompts-memory-skills.md` | `src/prompts/`、`zapsdk/memory/`、`src/skills.ts`、image store |
| `30-agent-runtime.md` / `31-runtime-state-recovery.md` | 统一 Runtime、事实事件、控制状态和崩溃恢复边界 |

---

## 设计上几个反复出现的模式

- **流式优先**：每条 LLM 输出尽量边到边消费；模型说要调用工具，参数 JSON 还没
  解析完就交给 `StreamingToolExecutor` 试探性 launch；输出超过阈值就落盘成文件
  引用，模型只看到 `<TOOL_RESULT_FILE path="...">`。
- **每条 turn 是一个原子**：`Turn[]` 替代了平铺的 `Message[]`，类型上禁止出现
  「assistant 有 tool_use 但没对应 tool_result」的状态，从根本上消灭 Bedrock 的
  `TOOL_USE_RESULT_MISMATCH`（详见 `zapsdk/core/turn.ts` 头注）。
- **append-only 持久化**：会话 JSONL 不允许覆盖；replaceLog 用 `replacesUuid`
  指针让 reader 在解析时丢掉旧版本。
- **可重入 + 可恢复**：Checkpoint 把每条 turn 前的文件状态打成 snapshot；rewind
  能把 `logs[]`、`conversation`、磁盘 `cwd` 三者一起回到过去某一点。
- **provider 不被信任**：image 不支持 / context overflow / stream idle /
  rate limit 都在 SDK 里有 fallback，捕获之后写入 config（如 `visionByModel`）
  防止下一轮再撞一次。
- **审批是 Promise**：执行器调用 `approval(req)` 返回 Promise；UI 把它挂到
  `ApprovalBar`，用户点了之后 resolve，loop 才继续。这种 inversion 让 SDK 不
  需要知道任何 UI 细节。

具体每一层的细节展开见后续各篇。

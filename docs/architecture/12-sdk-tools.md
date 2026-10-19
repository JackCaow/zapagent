# `zapsdk/tools` 框架 + `zapsdk/builtin-tools` 内置工具

工具 = 模型可以调用的函数。框架定义「一条工具是什么」和「怎么把它跑起来」；
`builtin-tools/` 提供一套箱即用、覆盖 95% 编码 agent 需求的具体实现。

```
zapsdk/tools/
├── types.ts        # Tool / ToolDefinition / ToolResult / ToolHandler / ToolPermission
├── registry.ts     # ToolRegistry —— Map<name, Tool>
├── executor.ts     # ToolExecutor —— permission + 校验 + 超时 + post-process
└── schema.ts       # zodToJsonSchema —— zod v3/v4 兼容，给 provider 发 JSON Schema
```

---

## 框架核心：`types.ts`

```ts
interface ToolDefinition {
  name: string;
  description: string;                        // 进 tool schema
  prompt?: string;                            // 不进 schema；拼到 system prompt 给模型「什么时候用」
  parameters: z.ZodType;                      // 单一 source of truth：zod schema
  permission?: "auto" | "confirm" | "deny";   // 审批策略
  timeoutMs?: number;                         // 每工具覆盖；否则 ToolExecutor 全局值
  writesPath?: (args) => string[] | null;     // 给 checkpoint 用：声明要写哪些文件
  readOnly?: boolean;                         // true → 并发执行；false → write-chain 串行
}

interface ToolResult {
  success: boolean;
  output: string;
  error?: string;
  meta?: unknown;                             // UI/telemetry 用，不喂模型
  contentBlocks?: ContentBlock[];             // 多模态（read_file on image）
}

type ToolHandler = (args, signal?) => Promise<ToolResult>;
```

几条强约定：

- **zod 是唯一 schema 来源**。`zodToJsonSchema()` 把它翻成 provider 需要的
  JSON Schema 子集，同时 `ToolExecutor.execute` 用同一个 zod schema 做运行时
  校验（`parameters.safeParse(args)`），保证模型乱传参数时返回结构化错误而
  不是 crash。
- **`prompt` 不进 schema**。tool description 短到 1-3 行；详细的「什么时候
  调、为什么调」拼到 system prompt 一次性发出去——避免每次 tool call 都把
  长 description 也带上一遍。`tests/agent/toolDiagnostics.test.ts` 对主要体积
  热点同时设置 schema 和 guidance 预算，防止重复说明重新膨胀固定 prompt。
- **`writesPath` 让 checkpoint 反向感知 mutation**。工具实现描述自己要碰
  哪些路径；executor 在 handler 之前调用宿主注入的 `onTrackEdit` 把这些
  文件的 pre-edit 内容做 backup。
- **`allowedPaths` 校验真实文件系统边界**。写工具会解析目标和允许根目录的
  最近存在祖先 `realpath`，因此允许正常创建新目录，但拒绝通过目录符号链接
  跳到允许根目录之外。
- **`readOnly` 决定并发性**。`true`（read_file / glob / grep / web_search）
  并发跑；`false` 或省略（保守默认）通过 `StreamingToolExecutor.writeChain`
  串行。`bash` / `http_fetch` / `skill` / `agent` 一律 opt-out（能干任何事）。

---

## `registry.ts` —— `ToolRegistry`

`Map<name, Tool>` 的薄包装。

- `register(tool)` —— 重名抛错。
- `subset(names[])` —— 返回子集 registry（subagent 用：只让 explore 看到
  read_file/glob/grep 这几个）。
- `clone()` —— 浅拷贝；MCP 工具桥接时用，避免污染主 registry。
- `definitions()` —— 给 provider 发的 tool schema 数组。
- `toolPrompts()` —— 拼接所有工具的 `prompt` 字段，组成
  `# Tool usage guidance\n\n## tool_a\n...\n\n## tool_b\n...` 一大段，
  注入 system prompt。

---

## `executor.ts` —— `ToolExecutor`

单次 tool 调用的标准流程：

```
execute(name, args, signal?):
  ① registry.get(name) → 不存在则失败
  ② permission 检查
       permission==="deny"        → 失败
       permission==="confirm"     → 排队走 onApproval(name, args)；拒绝 → 失败
       permission==="auto" (default)→ 直通
  ③ parameters.safeParse(args)
       失败 → 返回 zod error 文本
  ④ signal.aborted → 立即失败
  ⑤ writesPath(args) → onTrackEdit(paths)（错误吞掉，不能阻塞 tool）
  ⑥ Promise.race([
       handler(args, signal),
       setTimeout(reject, effectiveTimeout),
       signal.abort listener
     ])
  ⑦ postProcess?(name, args, result)
  ⑧ return result
```

几个关键设计：

- **审批是串行队列**：`approvalQueue: Promise<void>`，并发 tool call 都要先
  `await` 这个 chain。UI 一次只会看到一个 approval 弹窗，依次处理。
- **超时是 race**：默认 30s，单 tool 可以通过 `definition.timeoutMs` 覆盖
  （bash 通常给 120s）。
- **postProcess 是宿主切入点**：`src/agent/wireRunHandlers.ts` 在这里串入
  「输出超长→落盘成 `<TOOL_RESULT_FILE>`」、「diff meta 美化」等逻辑。
- **onTrackEdit 失败一律忽略**：checkpoint 抖了不能拖死正常 tool。

`isReadOnly(name)` 暴露给 `StreamingToolExecutor` 决定并发 vs 串行。

---

## `schema.ts` —— Zod → JSON Schema

手写的 lightweight 转换器，**同时兼容 zod v3 和 v4**（v4 把所有
`typeName` 改成小写 `type`、把 `ZodArray` 的 element 从 `def.type` 移到
`def.element` 等等）。支持的形态：
`object / string / number / boolean / array / enum / optional / default /
union / literal / record`。够覆盖现有内置工具；遇到未支持类型回退到
`{ type: "string" }`。

---

# `zapsdk/builtin-tools/` —— 内置工具集

`createBuiltinRegistry(options)` 是入口；按需通过 `options.exclude` 关闭
某条工具。所有工具一律走 `Tool { definition, handler }` 结构。

## 全套工具（28 条）

按职责分组：

### 文件系统（无副作用）

| 工具 | 主要参数 | 说明 |
|---|---|---|
| `read_file` | `path, offset?, limit?, as?` | 自带 line numbers；path 找不到时自动 glob/basename 回退；图片走 `loadImageFromFile` 走 multimodal `contentBlocks`；SVG 默认本地光栅化成 PNG，传 `as:"text"` 拿源码编辑 |
| `list_tree` | `path, maxDepth, includeHidden?` | 递归树，跳 `.git`、node_modules 等 |
| `glob_files` | `pattern, cwd?` | 同 `**/*.ts` 风格匹配，`walkAndMatch` 实现 |
| `search_files` | `pattern, path?, type?, contextLines?` | 走 `@vscode/ripgrep`，结构化输出 |
| `read_document` | `path, pages?, format?` | 根据扩展名分发 pdf-parse / mammoth |
| `current_time` | `tz?` | 给模型一个固定的 now() 入口 |
| `http_fetch` | `url, method?, body?, headers?` | timeout 默认 30s；Readability 提取主要内容 |
| `web_search` | `query` | 多 backend（SerpApi / Serper / Brave），由 host 注入实现 |

### 文件修改（写操作）

| 工具 | 参数 | 关键行为 |
|---|---|---|
| `write_file` | `path, content` | `atomicWrite`：先写同目录临时文件再发布；新文件使用原子 create-if-absent，避免覆盖并发创建；写前 `validateSyntax`（ts/js/json） |
| `edit_file` | `path, old_string, new_string, replace_all?, skip_syntax_check?` | 默认 unique-match；找不到时给 `nearestLines` 提示；可写 `writesPath` |
| `multi_edit` | `path, edits: [{old, new}]` | 一次多处替换，半事务 |
| `delete_file` / `move_file` | `path[, dest]` | 都声明 `writesPath` 给 checkpoint；`move_file` 默认原子 no-clobber，只有显式 `overwrite=true` 才替换目标 |

### Shell / 后台

| 工具 | 关键行为 |
|---|---|
| `bash` | `exec()` 包装；通过 `pathConverter` 处理 Windows 路径；error 输出格式化（抽 file:line、SyntaxError/TypeError/ModuleError 分类）。当 `options.store: TaskStore` 注入且未禁用时，参数表暴露 `run_in_background:true` —— 走 `taskStore.start(...)`，返回 task id；否则同步等结果 |
| `monitor` | 配合 `taskStore`：列 / 杀 / 取输出。Task lifecycle 见 `zapsdk/tasks` |
| `cron_create / cron_delete / cron_list` | `croner` 封装；调用方持有 `cronTools()` handle，可注入 `onFire` 把命中投递到对话 |

### Plan / Todo / Skill / Memory

| 工具 | 行为 |
|---|---|
| `todo_write` | 通过注入的 `TodoStore` 读/写。`getKey()` 决定主 vs subagent key，主 agent 用 `"main"`，subagent 用自己的 `sa_xxx` |
| `enter_plan_mode` / `exit_plan_mode` | 切换 PermissionMode 到 `plan`，所有写工具被拦截；exit 时通过 callback 让宿主决定是否 commit |
| `skill` | 接收 skill name，把对应 `SkillDefinition` body 注入 conversation 作为系统指令；见 `zapsdk/skills` |
| `memory_save` | 调用宿主注入的 `mdStore` 写一条 .md + 更新 MEMORY.md |

### Agent（多 agent）

| 工具 | 行为 |
|---|---|
| `agent` | `subagentTool` 返回；类型枚举 `general / plan / explore`。每次调用启动一个嵌套 LoopAgent，**共享 budget**。`explore` 类型用 `READONLY_BIN_ALLOWLIST` 替换 bash + 关闭 write 工具；`exploreModel` 选项允许用 Haiku 等更便宜模型 |
| `delegate_agent` | 把任务转给系统里已经装好的外部 CLI agent（`claude` 或 `codex`）。`delegate-detect.ts` 启动时 `which` 一遍 PATH；找到才注册这个工具。`delegate-stream.ts` 解析它的输出并通过 onEvent 回传 |

## 几个共享 helper

- `filesystem.ts` 内的 `atomicWrite` / `isPathAllowed` 被 `edit.ts` / `multi-edit.ts`
  共用。
- `diff-meta.ts` 出 `buildDiffMeta(before, after)`，进 `ToolResult.meta`，
  UI 用 jsdiff 渲染。
- `glob-util.ts: matchGlob(pattern, str)` 是 zero-deps 的 micromatch 子集；
  `walkAndMatch` 给 glob_files / read_file 的 ENOENT 回退用。
- `syntax-check.ts` 调 `bun --check` 等做 ts/js/json 静态检查；命中错误时
  edit/write 直接 fail，强制模型修补。
- `gitignore.ts` —— search/glob 的过滤源。

## `subagent.ts` 细节

构造时把 explore 的特殊 registry 拼好：
- 用 `READONLY_BIN_ALLOWLIST` 替换 bash（`ls/find/grep/rg/sort/wc/diff/git`
  等等只读命令白名单）
- 关掉 write_file / edit_file / multi_edit / delete_file / move_file
- 关掉 plan / cron / monitor / agent（避免再嵌套）

每个 subagent 内部 new 一个 `LoopAgent`，传同一个 `AgentBudget` 实例 + 同一个
`fallbackProvider`，再叠一层 `eventPath` 把自己 id 推入数组——所有事件回放给
parent 时 path 自然形成 `["sa_outer","sa_inner"]` 的树。

`maxSalvageChars`（默认 32k）的兜底：如果 subagent 跑完没产出 text 但跑了
工具，从工具结果里拉一段挽救输出回去，避免 parent 看到空白。

---

## App 层是怎么用的

`src/agent-factory.ts` 大致这样组合：

```ts
const registry = createBuiltinRegistry({
  // 各种 options：allowedPaths、defaultCwd、todoStore、planCallbacks
  todoWrite: { store: todoStore },
  planMode:   { callbacks: planCallbacks },
  skill:      { skills: skillsRef.current },
  cronHandle, monitorHandle,
  delegateAgent: { providers: delegateProviders, onEvent: bridge.handler },
})
// MCP 工具用 MCPToolBridge 桥进来后用 registry.register(...) 拼上去

const executor = new ToolExecutor(registry, {
  timeoutMs: 30_000,
  onApproval: onApproval,         // 来自 src/hooks/usePermissionApproval
  postProcess: wireRunHandlers.postProcess,  // 落盘 + diff meta
  onTrackEdit: checkpoint.trackEdit,
})

const agent = new LoopAgent({
  provider, fallbackProvider, summarizer,
  registry, executor, conversation,
  subagent: true,
  subagentFactory: subagentTool,
  // ...
})
```

---

## 工具实现一致的约定

- **handler 永远 try/catch**：内部失败不抛，包成 `{ success:false, error, output:"" }`
  返回。让 LoopAgent 总能拼成合法 Turn，不要让一条工具炸掉整个 step。
- **error 文本要可执行**：edit_file 找不到 old_string 时输出 `nearestLines`
  片段，告诉模型「附近实际的几行长这样」；bash 失败时把 SyntaxError/
  TypeError/ModuleError 抽出来 + file:line。这是 self-correcting 行为的
  关键——好的错误文本让下一 step 模型就能修。
- **output 不要无限大**：大输出由 `maybePersistToolResult` 在
  postProcess 里换成 `<TOOL_RESULT_FILE>`，但工具实现自己应该做基本的截断
  + chunking_hint 文字（见 `chunkingHint` in filesystem.ts）。
- **不依赖 React/Ink**：builtin-tools 完全纯 node API，是 SDK 可移植性的
  基石。

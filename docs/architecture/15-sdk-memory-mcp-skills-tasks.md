# `zapsdk/{memory, mcp, skills, tasks}` —— 四个相对独立的子系统

把四个互相不依赖、规模都不大的子系统并在一篇。

| 子系统 | 一句话 |
|---|---|
| `memory/` | 会话内 `ConversationManager`（Turn[]）+ 跨会话长期 `AutoMemory`（每项一份 .md） |
| `mcp/` | MCP 协议 client，把第三方 server 暴露的工具桥接成 `Tool` |
| `skills/` | 加载、模板化、运行可复用的 agent 子任务（每个 `.agents/skills/<name>/SKILL.md`） |
| `tasks/` | 后台运行的 shell 任务 + 完成时的通知 XML |

---

## `zapsdk/memory/`

### `conversation.ts` —— `ConversationManager`

**内部状态：`Turn[]`**，唯一权威；`getMessages()` 是它的纯投影（`turnsToMessages`）。
这一改使「wire 上 tool_use ↔ tool_result 孤立」从代码 bug 变成类型上不可
表达。

```ts
new ConversationManager({
  // LoopAgent owns token-aware compaction. The complete backing store stays
  // intact until an explicit compact epoch is committed; getMessages() only
  // bounds the interim provider view.
  maxMessages: Number.POSITIVE_INFINITY,
  maxTokens: contextWindow,
  triggerAtTokens: 0.8 * contextWindow,
  targetTokensAfterCompress: 0.4 * contextWindow,
  summarizer?: provider,
  autoCompress: true,
})
```

主要 API：

| 方法 | 含义 |
|---|---|
| `commitTurn(turn)` | 原子提交一条 Turn（user / assistant / tool_turn / system） |
| `add(message)` | Legacy 兼容：assistant+toolCalls / tool_result 缓冲合并，下一个非 tool_result 自动 flush 成 tool_turn；测试和老用法走这条 |
| `getMessages()` | 派生 Message[]；保证 wire-valid |
| `getTurns()` | 直接拿 Turn[] |
| `compress(provider)` | 调 `STRUCTURED_COMPACT_PROMPT` 总结中段；与 AutoCompact 实现一致 |
| `truncateAfter(index)` | rewind 用：保留前 N 条 Turn |
| `estimatedTokens` | 经 `TokenCounter` 估算的累计 |
| `clear()` | 重置全部 |

`afterMutate()` 在每次 commit / add 后跑：
- 重新估 token；
- 若超过 `triggerAtTokens`，置 `needsCompression`；
- 若超过 `maxTokens` 且没有 summarizer，**同步**强裁中段；
- `waitForCompression()` 是异步出口：LoopAgent 在 step 之间 await 一下，
  顺带触发压缩。

### `auto-memory.ts` —— `AutoMemory`

跨会话长期记忆。每个项目一个目录：
`<dataDir>/projects/<project-id>/memory/`，里面：
- `MEMORY.md` —— 单行索引（`- [Title](slug.md) — one-line hook`）
- `<slug>.md` —— 单条 memory 内容 + frontmatter（`name`、`description`、`type`）

另有一个全局个人记忆目录：`<dataDir>/memory/`。它只承载 `user` /
`feedback` 类型，用于跨项目复用用户偏好和工作方式；`project` /
`reference` 仍写入项目目录，避免旧版全局 store 把项目事实带到无关仓库。

```ts
const am = new AutoMemory(process.cwd())
await am.ensure()                            // mkdir + 空 MEMORY.md
await am.buildInstructions()                 // 给 system prompt 用：分类法 / 何时写
await am.buildContextAttachment()            // 每 turn 注入的 MEMORY.md 索引
am.isMemoryPath(path)                        // 用于判断是不是 memory 文件
am.stalenessNote(path)                       // "Memory from 7 days ago — verify..."
```

`<project-id>` 与 session 层共用 `zapsdk/utils/project-paths.ts`：git 项目优先按
remote identity 分桶；无 remote 时按 git root realpath 分桶；非 git 目录回退到
legacy sanitized cwd。启动时会
best-effort 迁移 legacy sanitized-cwd 目录；如果新目录已经有内容则不覆盖。

设计要点：
- **System prompt 只放分类法**（taxonomy），不放索引内容。索引和正文
  working pack 每 turn 注入到 `contextPrefix` 里。这样 system prompt 是稳定
  可 cache 的；memory 文件变化只影响最后一条 transient user-context 消息。
- **项目 mdStore 共享同一个目录**：`zapsdk/memory/md-store.ts` 也用
  `autoMemory.memoryDir`，所以项目记忆的 writer、`/mem` dialog、
  context attachment 都看到同一份数据。`memory_save` 额外接入全局 store：
  `user` / `feedback` 路由到全局个人记忆，`project` / `reference`
  继续路由到项目记忆。
- **Staleness 注释**：memory 文件被读时挂一段「N 天前的记录」提示，避免
  agent 把陈旧信息当真。1 / 7 / 30 天分级。

### `md-store.ts` —— Markdown store

`openMdStore(autoMemory.memoryDir)` 是长期记忆的单写入口：
- 每条 memory 是一个 `<name>.md` 文件，frontmatter 包含 `name`、
  `description`、`type`、`tags`、`source`、可选 canonical `lifecycle`、
  host-authored `provenance`、`createdAt`、`updatedAt`。
- `save()` 以 `name` 为稳定 key；同名写入是更新，不产生重复文件。
- `lifecycle` 用 `high|medium|low` confidence、绝对有效期和 `supersedes`
  表达准入与事实演进；只有 high-confidence successor 可以替代旧事实。低置信、未生效、已过期、被替代或 lifecycle 无效的
  记录仍可审计，但不会进入自动召回。
- 写入走 sibling tmp file + fsync + rename，目录级 `.memory.lock` 防止多进程
  同时重写 `MEMORY.md`。
- `MEMORY.md` 每次由 store 重建；如果已索引文件暂时无法解析，会保留旧索引
  行并发 warning，避免一次坏文件导致索引静默丢记录。

### `md-pack.ts` —— 每轮召回

`buildMdIndex()` 和 `buildMdPack()` 共用同一套选择器：
- query relevance：`name`、`description`、`tags`、`source`、正文分权重打分；
- 中英文 alias：例如 `cache` / `缓存`、`hit` / `命中`、`memory` / `记忆`、
  `recall` / `召回`、`stability` / `稳定`、`query` / `查询`；
- `pinned` / `pin` tags 默认给高分，调用方可按当前 query 上下文取消 pin
  bonus/bypass，而不影响记录通过普通相关性进入召回；
- optional recency boost 按 UTC day 量化，避免同一天内 prompt hash 持续漂移；
- token budget、max records、duplicate body 去重都是硬约束；
- working pack 会给超过 stale 阈值的记录追加 verify 提示，index 不追加；
- `excerptOversizedRecords` 开启时，相关但过大的记录会用 bounded excerpt
  保留可行动片段，并提示用 `read_file` 读取完整文件。

App 层的 `src/agent/contextAttachments.ts` 在每个 run 开始调用一次：
- compact index：默认 768 tokens / 24 records；
- working pack：默认 2048 tokens / 8 records；
- global personal index / working pack：只从全局 `user` / `feedback`
  读取，预算是项目记忆的一半，segment 名称为 `global_memory_index` /
  `global_memory_working_pack`；
- 小 context window 按比例缩小预算，最低保留 25%；
- low-signal prompt（例如“继续”）如果 relevance 过滤为空，会退回到小预算
  fallback pack，保证 compact state/timeline 仍可恢复任务；普通 direct query
  不做无命中 fallback，也不会仅因 compact 的 `pinned` tag 强制注入；由于
  compact 是多主题聚合记录，direct query 至少命中两个不同词项才可选择它。

记忆召回 query 使用用户原始 task 或 compact display form 派生，但会先清洗
生成型上下文：`<file_content>`、`<mcp_resource>`、runtime XML、代码块、
长 token/行和 paste placeholder 会从 query 中剥离或替换，超长 query 保留头尾。
低信号 continuation（例如“继续”）会拼上最近有意义的用户请求。这只影响
memory ranking，不改变模型实际收到的用户输入和附件内容。

App 同时为实际进入 working pack 的记录生成 host-only hashed feature profile，
交给 `src/agent/memoryUtility.ts` 做在线效用归因。它不增加 model tool、额外
回合或 prompt bytes：成功读取记为 `read/used`；去掉实际 recall query 和当前用户输入特征后，
assistant/tool 参数仍命中某条记录独有的 line/phrase feature，才保守记为
`used`，且未读取时记为 `avoidedReRead`。成功更新、merge、supersedes 分别
形成 revised/contradicted 证据。JSONL 只保存 scope、filename、量化 score
和固定 evidence enum，不保存正文、输入、输出、feature hash 或绝对路径。

### `persist-compact-summary.ts` —— compact 到长期记忆

普通 compact summary 会在下一轮 compact 中被再次压缩，存在信息衰减。为此
compact 成功后会 best-effort 提取结构化 summary 里的 durable sections，写回：
- `project_compact_state.md`：最新 snapshot，带 fingerprint，内容相同则不重写；
- `project_compact_timeline.md`：最近 8 个 snapshot，新到旧排序。

两条记录都带 `compact` / `summary` / `status` / `pinned` 等 tags；App 层只在
“继续”这类低信号任务里启用其 pin bonus，普通 query 仍可按真实相关性召回。
若 state 和 timeline 同时进入 working pack，
App 层会省略 timeline 中与 state 重复的最新 snapshot，避免浪费 tokens。

---

## `zapsdk/mcp/`

### `client.ts` —— `MCPToolBridge`

`@modelcontextprotocol/sdk` 的薄包装。负责：
1. 建立 stdio / SSE 连接
2. `listTools()` 拉取远端工具表
3. 把每条 MCP tool 翻成本地 `Tool { definition, handler }`
4. `handler` 把调用转给 MCP client，回包翻回 `ToolResult`

```ts
const bridge = new MCPToolBridge()
const tools = await bridge.connect({
  name: "db",
  transport: "stdio",
  command: "uvx",
  args: ["mcp-server-sqlite", "--db", "./local.db"],
  prefix: "db_",     // 避免和内置工具撞名
})
for (const t of tools) registry.register(t)
```

关键策略：
- **permission 默认 `"confirm"`**：第三方 server 跑在用户机器上、拿用户
  Token，必须走 approval 链路。用户 `/permissions allow <tool>` 后转 auto。
- **JSON Schema → Zod**：`jsonSchemaToZod()` 反向把 server 给的 schema
  生成 `z.object(...)`，让 `ToolExecutor.parameters.safeParse` 仍能工作。
- **prefix**：`prefix: "db_"` 防止 server 的 `query` 和别人的 `query`
  冲突 —— `ToolRegistry.register` 是严格不允许重名的。
- **生命周期**：`bridge.disconnect(name)` 关单个 server；进程退出由
  app 层 `singletons.ts` 兜底。

`src/hooks/useAgentObjects.ts` 在 `config.mcpServers[]` 变化时增量 connect /
disconnect，并把新工具 register 到 cloned registry 上。

---

## `zapsdk/skills/`

可复用的 agent 子任务模板。`src/App.tsx` 启动时 `loadAllSkills(cwd)` 把
四个目录的 skill 全部加载进 `skillsRef`，再喂给 `skill` 工具和
system prompt。

### 数据模型

```ts
interface SkillDefinition {
  name: string;
  description: string;
  systemPrompt: string;          // 模板字符串，含 {{param}} 占位
  tools: string[];                // 允许的工具白名单（subset registry）
  parameters?: SkillParameter[]; // {name, description, required, default}
  maxSteps?: number;             // 默认 10
  reserveSteps?: number;
  loadedFrom?: string;           // 来源目录，UI 分组用
}
```

`SKILL.md` 文件 frontmatter + body：

```markdown
---
name: code-review
description: Review a PR / diff against project conventions
tools: ["read_file","glob_files","search_files","bash"]
parameters:
  - name: scope
    description: Where to focus
    required: true
max_steps: "15"
---

You are a code reviewer. Focus on {{scope}}.
...
```

### `loader.ts`

`loadAllSkills(cwd)` 按以下优先级合并（**就近覆盖**）：

```
1. /etc/codex/skills
2. ~/.codex/skills        ← codex 的 skill 缓存，能直接复用
3. ~/.agents/skills        ← 用户级
4. 项目 .agents/skills      ← 走 git 树往上找，最近覆盖最远
```

`installSkillIfMissing(dir, skill)` 在 startup 时用：把 `src/skills.ts`
里硬编码的几条 zapcode 自带 skill 写到 `~/.agents/skills`，让 codex 也能看到。

### `registry.ts` + `template.ts` + `runner.ts`

- `SkillRegistry` —— 内存 `Map<name, SkillDefinition>` 薄包装
- `applySkillTemplate(skill, params)` —— `{{name}}` 替换；缺必填 → 返回
  `missingRequired[]` 让上层抛错
- `SkillRunner.run({ skill, input, params })` ——
  1. registry.subset(skill.tools) 出受限工具集
  2. 新建 `ToolExecutor` + `LoopAgent`（带 skill 的 systemPrompt + maxSteps）
  3. 执行 `agent.run(input)`，返回 LoopAgentResult

App 路径下，`/run_skill <name>` slash command 走的就是这条。

---

## `zapsdk/tasks/`

后台 shell 任务的存储 + 通知。`bash` 工具传 `run_in_background: true`、
`monitor` 工具列表/杀任务都走 `TaskStore`。

### `store.ts` —— `TaskStore`

`EventEmitter`，事件 `started` / `exited`：

```ts
const store = new TaskStore({ outputDir: ... })
const snap = store.start({ command: "bun run dev", description: "dev server", ownerAgentId })
// → 异步 spawn child，stdout+stderr 都重定向到 <outputDir>/<taskId>.log
store.on("exited", (e) => { ... })
store.list()                       // 全部 snapshot
store.get(taskId)
store.kill(taskId, signal)
store.killByOwner(agentId)         // sub-agent 退出时清理
store.stopAll(signal)              // 进程关停
store.readOutput(taskId, tailLines?)
```

默认 `outputDir` 是
`<dataDir>/projects/<project-id>/tasks/outputs/`；显式传入 `outputDir`
时保持调用方控制，测试和嵌入场景可以继续使用临时目录。

`ownerAgentId` 是关键：subagent 启了后台进程，agent 自己消亡时
`killByOwner` 把它的孤儿全杀掉，否则 reparent 给 init 后只能靠
`monitor` 显式杀。

### `notification.ts` —— Task-completion XML

任务退出时构造 `<task-notification>` envelope，结构对齐 CCB 的训练 schema：

```xml
<task-notification>
  <task-id>3a7f1c</task-id>
  <task-type>shell</task-type>
  <status>completed</status>
  <summary>dev server</summary>
  <output-file>~/.zapcode/.../3a7f1c.log</output-file>
  <output-bytes>18923</output-bytes>
  <exit-code>0</exit-code>
</task-notification>
```

`classifyTaskExit(code, signal)`：signal → `killed`；非零退出且无 signal →
`failed`；其他 → `completed`。

### App 层桥接

`src/singletons.ts` 监听 `taskStore.on("exited", ...)` → 构造 XML →
`pushSystemEvent({ kind: "task-notification", payload: xml })` 推到
`systemInbox`。`useTurnDispatcher` 在每个 turn 边界把 inbox drain 掉，
作为静默的 user-role 消息送到模型——模型回应（"the build succeeded,
here is the failing test"），用户看到的是模型对结果的反应。

故意走 `systemInbox` 而**不**是 input queue：用户不能编辑/取消这种系统
事件，UI 不渲染为用户消息。

---

## 跨子系统协同点

```
            ┌── ConversationManager (in-memory turns)
            │
LoopAgent ──┤── AutoMemory (system prompt taxonomy + ctxAttach 索引)
            │
            ├── ToolRegistry ←── MCPToolBridge (外部工具)
            │              ←── builtin tools
            │
            └── SkillRunner (按需挂 LoopAgent 子实例)

TaskStore ←── bash(run_in_background) / monitor
            │
            └── on(exited) → notification.xml → systemInbox → 下个 turn
```

这四个子系统彼此独立，可以单独 import 用——`AutoMemory` 没 React 依赖；
`MCPToolBridge` 单独连 server 也行；`TaskStore` 接管任何 shell 进程；
`SkillRegistry/Runner` 可以接到非 zapcode 宿主上当 task template 框架。

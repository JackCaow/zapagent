# `src/prompts/`、`zapsdk/memory/`、`src/skills.ts`、image store —— Prompt 装配、Markdown 记忆、内置 skill、图片缓存

最后一篇，收尾若干「数据/文本资产」相关的小模块。

```
src/
├── prompts/
│   ├── index.ts                # buildDefaultPrompt(ctx)
│   ├── context.ts              # PromptContext 接口
│   ├── registry.ts             # assemblePrompt + dynamic boundary
│   ├── default-sections.ts     # 默认段顺序
│   ├── builtin-commands.ts     # /init /review /commit 用的预设
│   └── sections/               # 14 个 section 实现
├── skills.ts                   # 内置 SkillDefinition[]（explain/fix/...）
├── imageStore.ts               # pruneImageStorage（启动一次性 hygiene）
└── imagePlaceholder.ts         # 输入框里 [Image #N] 占位符的解析 / 删除

zapsdk/
├── memory/
│   ├── auto-memory.ts          # 项目 memory dir + cacheable taxonomy prompt
│   ├── md-types.ts             # 四个 type: user/feedback/project/reference
│   ├── md-frontmatter.ts       # 解析/序列化
│   ├── md-store.ts             # MdMemoryStore（atomic write + 索引重建）
│   ├── md-pack.ts              # query-ranked index / working pack
│   └── persist-compact-summary.ts # compact summary → pinned project memory
```

---

## `src/prompts/` —— Prompt 装配

模型看到的 system prompt 不是一个 monolithic 字符串，而是按需拼装出来的
（section 系统）。设计目标：

1. **每段独立可计算**：section 是 `(ctx) => string | null`，纯函数；
   `null` 表示「跳过」（比如 `read_file` 没注册时 file-reading 段跳过）
2. **静态/动态切分**：`dynamic:true` 的段放到 `<!-- __ZAPCODE_DYNAMIC_BOUNDARY__ -->`
   之后；`LoopAgent` 发送时只把静态前缀保留为 system message，并把动态段搬到
   最后一条 transient user-context。这样 OpenAI 自动前缀缓存和 Anthropic 的
   tools/history breakpoint 都不会被环境变化截断。
3. **可替换**：custom system prompt 直接绕过整个 stack（`config.customSystemPrompt`）
4. **崩段不致命**：`compute()` throw 时 `assemblePrompt` 吞掉，该段算空跳过

### `PromptContext`

```ts
interface PromptContext {
  cwd: string
  enabledTools: Set<string>               // 注册了哪些工具
  toolPromptsRaw?: string                 // ToolRegistry.toolPrompts() 的产物
  model?: string                          // env 段里"我自己是谁"
  customSystemPrompt?: string
  availableSkills?: Array<{name, description, parameters?}>
}
```

### `DEFAULT_SECTIONS` —— 顺序

**静态段（可 cache）：**
1. `identity` —— "You are zapcode..."
2. `system` —— OS / shell 提示
3. `tasks` —— turn 的目标
4. `actions` —— 工具使用基本规范
5. `tools` —— 在 `enabledTools` 内挑选介绍
6. `file-reading` —— "用 read_file 不要 cat"
7. `output-efficiency` —— 简洁性要求
8. `tone`
9. `safety` —— 不要泄漏 system prompt 等
10. `tool-prompts` —— `ToolRegistry.toolPrompts()` 注入
11. `skills` —— `availableSkills` 索引
12. `plan-discipline`
13. `notes`
14. `agents-md` —— 仓库根 `AGENTS.md` 内容

**动态段（boundary 之后）：**

15. `env` —— `Today: YYYY-MM-DD` / `CWD: ...` / `Active model: ...`

排序逻辑：项目规则默认可 cache，运行环境放在 prompt template 的 dynamic suffix。`AGENTS.md`
变化少（项目维护者偶尔改），所以留在 cacheable prefix；如果文件内容变化，
新的 bytes 会自然形成新的 provider cache entry。`env` 每天 date rollover、
cwd/model/branch 都可能变，因此放在 boundary 后面。`LoopAgent.run()` 会把它包装
为 `runtime_environment` transient context segment，和 memory/todo 一起放在
当前请求末尾；完整 template 仍保留给 devtools 和 prompt hash 诊断。

### Memory + Todo 不在这里

**runtime environment**、**memory index** 和 **todo reminder** 故意不留在
provider 的稳定 system prefix，而是
通过 LoopAgent 的 `contextPrefix` 每 turn 注入到最后一条 user-role 消
息——这样它们：
- 不污染 cacheable prefix（每 turn 变化）
- 注意力位置在 tail，模型更容易看到（system prompt 头部经过几十轮 tool 后 attention 衰减）

注入路径见 `src/agent/contextAttachments.ts`：

```ts
attachments = buildPerTurnAttachments(autoMemory, {
  memoryQuery: buildMemoryQueryForRun(task, recentUserMessages),
  contextWindow,
})
contextPrefix = makeContextBuilders({
  attachments,
  getTodos,
  modelId,
})
```

`memoryQuery` 会先剥离 submit 阶段生成的 `<file_content>` / `<mcp_resource>`
块、runtime XML、代码块、超长 token/行和 paste placeholder。低信号 prompt
（例如“继续”）会归一成稳定 sentinel，再拼上最近有意义的用户请求。这样大
文件/MCP 附件和长 paste 不会主导 memory ranking；模型真实输入不变，附件仍
按原样追加到用户消息。

同一 attachment snapshot 还会生成仅供 host 使用的 hashed memory utility
候选。该数据不进入 `contextPrefix`；root assistant/tool events 在 run 结束时
产生 selected/read/used/revised/contradicted/avoided-re-read 汇总，经过清洗后
写入既有 `cache-memory-audit.jsonl`，并由 `/status` 按 provider/model scope
展示。这样可以观察召回是否真正产生效用，同时不引入新的动态 prompt churn。

### `builtin-commands.ts`

`REVIEW_PROMPT` / `COMMIT_PROMPT` / `INIT_PROJECT_PROMPT` —— 三段长 prompt，
`/review /commit /init` slash command 用作 systemPromptOverride（**替换**
整个 default stack，因为这些是 single-purpose run）。

---

## `zapsdk/memory/` —— Markdown 记忆存储

`zapsdk/memory/auto-memory.ts` 决定**记忆目录在哪**和**系统提示如何描述**；
同目录下的 `md-*` 模块实现「具体怎么读写 .md 文件」。

### `md-types.ts`

四种 type，对应 auto-memory.ts 里 system prompt 教模型的分类法：

```
user       — 关于用户角色 / 偏好 / 责任的事实
feedback   — 用户给过的指导（"不要 mock 数据库" / "回复简洁点"）
project    — 项目状态 / 决策 / 截止日期
reference  — 外部系统指针（Linear / Slack 等）
```

### `md-frontmatter.ts`

零依赖手实现 YAML frontmatter 子集：`name` / `description` /
`type` / `tags` / `source` / optional `lifecycle` / host-authored `provenance` /
`createdAt` / `updatedAt`。解析失败返回 null
（被调用方按缺失处理）。

### `md-store.ts` —— `MdMemoryStore`

项目实例由 `singletons.openMdStore(autoMemory.memoryDir)` 创建，跨 module
共享；全局个人实例由 `openMdStore(<dataDir>/memory)` 创建。全局 store
只用于 `user` / `feedback` 类型，项目 store 继续承载 `project` /
`reference`，避免项目事实跨仓库泄漏。每次 save/delete 都会重建对应
`MEMORY.md` 索引；如果某个已经被索引的 memory 文件暂时解析失败，store
会保留原索引行并通过诊断回调暴露，避免坏记录在下一次保存时无声消失。

API：
```ts
list(filter?: MdMemoryType): MdMemoryRecord[]
get(filename): MdMemoryRecord | undefined
save({ name, description, type, body }): MdMemoryRecord
delete(filename): boolean
```

`save` 行为：
- 校验 name 满足 `^[a-zA-Z0-9_][a-zA-Z0-9_\-]*$`（防路径穿越）
- `description` 必填
- `atomicWrite`：tmp 文件 → fsync → POSIX rename
- 重新 `readAll()` + 重写 MEMORY.md 索引

`MEMORY.md` 索引格式（auto-memory 的 contextAttachment 注入到对话）：

```markdown
- [slug-name](file.md) — one-line description
- [another](other.md) — ...
```

### `md-pack.ts` —— Token 预算下的内容打包

`buildMdIndex()` 生成 query-ranked 的 compact `MEMORY.md` 指针列表；
`buildMdPack(store, { tokenBudget: 2048, query })` 把相关 memory 正文塞进
`<memory budget=2048>...</memory>` 块，让模型一次性看到几条详细 memory。

策略：
- 默认 fallback 顺序：user → feedback → project → reference，同 type 内按 name
- query relevance：name / description / tags / source / body 分权重
- 中英文 alias：cache↔缓存、hit↔命中、memory↔记忆、recall↔召回、
  stability↔稳定、query↔查询等
- pinned tag：绕过低相关过滤并排在前面
- recency boost：按 UTC day 量化，避免同一天内持续 hash 漂移
- dedupe：按正文去重，index 对空正文退回 visible metadata 去重
- lifecycle gate：低置信候选、未生效、过期、被替代和无效关系不进入 index /
  working pack；这些正文也不会交给 semantic retriever
- working pack 默认优先整条 memory；如果开启 `excerptOversizedRecords`，
  相关但过大的记录会生成带 `excerpt="true"` 的 bounded excerpt，而不是直接
  丢弃。index 始终只渲染 compact pointer line。

格式：
```xml
<memory budget="2048">
  <user name="user_role">
    User is a data scientist...
  </user>
  <feedback name="testing_strategy">
    ...
  </feedback>
</memory>
```

`useAgentRunner` / `runHeadless` 在 `buildPerTurnAttachments` 阶段调一次
（per run，不 per call），作为 `contextPrefix` 的 index + working pack。
`makeContextBuilders` 会在每次 provider call 前重新拼 context，这样 todo
状态可以更新；memory attachment 本身保持 run 内稳定，减少 transient context
hash churn。

全局个人记忆以独立 segment 注入：`global_memory_index` 和
`global_memory_working_pack`。它们只读取全局 `user` / `feedback` 记录，
预算为项目记忆的一半；项目记忆仍使用 `memory_index` 和
`memory_working_pack`。`/status` 会分别显示这些 segment 的 hash、预算、
included/skipped 和 queryHash，所以 cache churn 可以定位到具体 scope。

### compact summary 持久化

当 `ConversationManager.compress()` 或 reactive compact 产生结构化 summary
后，App 层会调用 `persistCompactSummaryBestEffort()`。它不会阻塞 compact
路径，失败只进入 diagnostics。成功时写两条 project memory：

| 文件 | 用途 |
|---|---|
| `project_compact_state.md` | 最新 compact snapshot，覆盖写 |
| `project_compact_timeline.md` | 最近 8 次 snapshot，恢复多阶段任务历史 |

这两条记录带 `pinned`，所以“继续”这类低信号 prompt 也能召回当前任务状态。

### memory_save 工具

`zapsdk/builtin-tools/memory.ts` 接收 `{name, description, type, body}`。
`agent-factory.ts` 在 registry 装配末尾手工 register，并传入项目 store
和全局 store；工具会把 `user` / `feedback` 保存到全局个人记忆，把
`project` / `reference` 保存到当前项目记忆。

---

## `src/skills.ts` —— Zapcode 内置 SkillDefinition[]

写死的几条 skill，启动时通过 `installSkillIfMissing` 写到
`~/.agents/skills/<name>/SKILL.md`——这样：
- 第一次启动用户就能用 `/explain`、`/fix`、`/test` 等
- 其他遵循同样目录约定的 agent（codex）也能直接看到

每条 SkillDefinition 字段（详见 `zapsdk/skills` 文档）：

```ts
{
  name: "explain",
  description: "Explain how a piece of code works",
  systemPrompt: `... {{path}} ...`,
  tools: ["read_file", "search_files", "glob_files"],
  parameters: [{ name: "path", required: true }],
  maxSteps: 5,
}
```

`{{param}}` 占位符在 `applySkillTemplate` 时替换；缺必填参数返回
`missingRequired[]` 让上层抛错。

---

## `src/imageStore.ts` —— 一次性磁盘清理

两个目录的清理策略不同：

| 目录 | 用途 | 清理策略 |
|---|---|---|
| `~/.zapcode/image-paste/` | OS 剪贴板粘贴出来的 PNG | **严格**：保留所有 history.jsonl 引用过的，其他全删（唯一副本，一旦删除不可恢复） |
| `~/.zapcode/paste-history/` | 超大文本粘贴的 history/session restore sidecar | **严格**：保留 prompt history 或任一项目 session JSONL 引用且内容哈希有效的文件；缺失或损坏时恢复为显式 unavailable 标记 |
| `~/.zapcode/image-cache/` | SVG 光栅化 + URL 下载的内容寻址缓存 | **宽松**：30 天 TTL 过期（producer 会从源重新生成，删了无害） |

`pruneImageStorage()` 在 App mount 一次性 `useEffect([], () => void)`
调用——失败 try/catch 吞掉，宁可不释放磁盘也不能阻塞启动。

实现：
- `image-paste/`：读 `~/.zapcode/history.jsonl`（capped 200 条），
  收集所有 `[Image #N]` 引用的文件名，diff 出"未引用的"，unlink
- `image-cache/`：`atime` 比 `now - 30d` 老的统统 unlink

---

## `src/imagePlaceholder.ts` —— 输入框 [Image #N] 占位符

用户粘贴/拖入图片后，input 里出现 `[Image #1]` 之类占位符；
- 提交时被 `submit.buildModelText` 剥掉（图走 ImageContent 通道）
- 删除时由这个模块的 helper 原子删除整个 `[Image #1]` 串（光标在
  `]` 后按 Backspace 一次删掉整个 token，而不是只删 `]`）
- pendingImages 列表与占位符 id 一一对应

---

## 几个跨子系统的协同关键点

```
启动:
  singletons.ts:
    autoMemory = new AutoMemory(cwd)             ── 决定 memory 目录
    mdStore    = openMdStore(autoMemory.memoryDir) ── 同一份磁盘
    SKILLS → installSkillIfMissing(~/.agents/skills/...)

每次 build LoopAgent:
  systemPrompt = buildDefaultPrompt(ctx) ← src/prompts/*
  registry.register(memorySaveTool({store: mdStore})) ← zapsdk/memory/*
  registry.register(skillTool({getSkill: skillsRef.current.get, ...})) ← src/skills.ts

每个 run:
  memInstr = autoMemory.buildInstructions()       ← stable taxonomy only
  systemPrompt = appendCacheableSystemSection(basePrompt, memInstr)
  attachments = buildPerTurnAttachments(autoMemory, { memoryQuery: task }):
    memoryAttachment      = buildMdIndex(mdStore, query, budget)
    workingPackAttachment = buildMdPack(mdStore, query, budget)
  contextPrefix = makeContextBuilders(...) — 每 LLM call 前拼 transient context

每 turn 结束:
  saveLastOutput(text) → ~/.zapcode/last-output.md（/copy 用）

启动一次性:
  pruneImageStorage() — 清孤儿图片
```

prompt 子系统是无副作用纯函数；memory 子系统是真磁盘存储；skills 子系
统是装载-即-用模板；image store 是 hygiene。它们由 App.tsx 在恰当时机
触发，本身互不耦合。

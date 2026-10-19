# `zapsdk/{devtools, debug, utils}` —— 工具箱

整个 SDK 的「附属设施」：浏览器里的 devtools 客户端、结构化日志、平台
检测、剪贴板/图片/路径/shell 各类零碎 helper。

---

## `zapsdk/devtools/` —— 浏览器 devtools

```
zapsdk/devtools/
├── protocol.ts    # ServerFrame / ClientFrame / DevtoolsSnapshot / DevtoolsHttpRecord
├── server.ts      # startDevToolsServer —— Bun.serve 起 HTTP + WS
└── client.html    # 单文件前端（vanilla JS，无构建）
```

环境变量 `ZAPCODE_DEVTOOLS_PORT=9229` 触发；`zapcode --dev [port]` 是
便利 shortcut（顺手 `open http://127.0.0.1:9229`）。

### 工作原理

`Bun.serve` 暴露：
- `GET /` → `client.html`
- `WebSocket /ws` → JSON 帧流（`protocol.ts` 定义）

服务端记一个长度为 500 的事件 ring buffer；任何 client 连上来先发
`snapshot` 帧（conversation + system prompt + config + recent events），
之后每条 `AgentEvent` 实时 `broadcast`。

`DevToolsServerOptions.agent` 只要满足 `{ on/off("*", handler) }`，所以
LoopAgent 满足；也方便 mock 测试。`attachAgent(newAgent)` 允许在重建
agent 实例时切换订阅源（每次 `useAgentObjects` 重建会重新 attach），
但 event ring 保留。

### `DevtoolsHttpRecord`

App 层装了一个 fetch 拦截器（`src/devtools-integration.ts`），把每次
HTTPS 出口的请求/响应（headers + body + 时长）压成 `DevtoolsHttpRecord`
推过来。前端的 Network 标签页就是这个数据。

### 安全约束

- 服务端 bind **`127.0.0.1`** —— 暴露的是完整 agent state（包括 system
  prompt 和有时候的 token 片段），不能让远程访问。
- `--no-devtools` 是 escape hatch：父 shell 漏写了 `ZAPCODE_DEVTOOLS_PORT`
  时显式禁用。

---

## `zapsdk/debug/` —— 结构化日志

```
zapsdk/debug/
├── logger.ts          # Logger —— 每会话一份 JSONL，写到 ZAPCODE_DATA_DIR/logs/
└── agent-logger.ts    # AgentLogger —— 订阅 LoopAgent 事件，自动算 step/tool 耗时
```

### `Logger`

```ts
const log = new Logger({ maxFiles: 20 })
log.info("run_started", { input: "..." })
log.warn("retry", { attempt: 1, err: ... })
log.error("crash", { stack })
await log.flush() / await log.close()
```

- **每会话一个文件**：`<dataDir>/logs/<ts>-<rand>.jsonl`，启动时创建。
- **append 队列 + 异步 drain**：`log()` 不 await 写盘；drain 失败吞掉，
  日志不该拖死主进程。
- **housekeeping**：`init()` 在后台拣选最新的 N 个文件保留，其余 unlink；
  同时维护 `latest.jsonl` 符号链接（Windows 上 fallback 到 copy）。
- **format**：`{ ts, level, event, ...fields }` 一行 JSON。

### `AgentLogger`

`Logger` 之上的事件订阅者。`attach(agent)` 后所有 `AgentEvent` 自动算时间
线：

```
run_started   → 记 runStartMs
run_step      → 记 stepStartMs
content_final.tool_call → 记 toolStartMs[id]
content_final.tool_result → durMs = now - toolStartMs[id]
run_ended     → totalMs = now - runStartMs
```

每条事件转成一行 JSON 写到 logger。结果是一个可 grep 的「这次 run 各步
耗时多少、哪个 tool 慢」的时间线。

---

## `zapsdk/utils/` —— 跨模块小工具

13 个文件，按主题分组：

### 平台 / 系统

| 文件 | 关键 export |
|---|---|
| `platform.ts` | `getOS() / IS_WINDOWS / IS_MACOS / IS_LINUX / detectPlatform() / copyToClipboard() / detectShell() / getAppDataDir()` |
| `shell.ts` | `splitShellArgs()` —— 把命令行字符串切成 argv |

`detectPlatform()` 返回 `PlatformFeatures`（symlinks 支持 / 大小写敏感 /
原生通知 / fsEvents / Unix 权限 / 可执行扩展名 / path separator / devNull）。
单例缓存，结果跨子系统复用。

`getAppDataDir()`：
- Windows: `%APPDATA%/zapcode` 或 `~/AppData/Roaming/zapcode`
- macOS / Linux: `~/.zapcode`
- 都被 `ZAPCODE_DATA_DIR` env var 覆盖

`copyToClipboard()`：`pbcopy` / `xclip` / `wl-copy` / `clip.exe`，按平台
依次尝试，失败回 `false`。

### 路径

| 文件 | 关键 export |
|---|---|
| `path.ts` | `expandHome(path)` —— `~/foo` → `/Users/.../foo`；`pathConverter` —— Windows 路径 ↔ MSYS/Cygwin/WSL 互转 |

### 图片

| 文件 | 关键 export |
|---|---|
| `image.ts` | `loadImageFromFile(path)` —— 文件 → base64 ImageContent；`isSupportedImage(path)` |
| `image-parser.ts` | 文本里识别图片占位符 / data URL |
| `clipboard-image.ts` | macOS / Linux / Windows 下从剪贴板捕获图片到临时文件，给 paste-handler 用 |

`isSupportedImage` 接受 `.png / .jpg / .gif / .webp`；SVG 不算（走 resvg
本地光栅）。

### 文件类型

| 文件 | 关键 export |
|---|---|
| `filetype.ts` | `filetypeFromPath(path)` —— 后缀 → `"ts"/"py"/"md"/...`；`isProbablyText(buf)` —— sniff 二进制 |

### 安全

| 文件 | 关键 export |
|---|---|
| `safety.ts` | `matchDangerous(cmd, patterns?)` —— bash 命令的危险模式 deny |

```ts
const DEFAULT_DANGEROUS_PATTERNS = [
  { id: "rm_recursive_system_path", reason: "...", match },
  { id: "sudo_elevation", ... },
  { id: "curl_pipe_shell", ... },   // curl ... | bash
  { id: "credential_exfil", ... },  // cat ~/.ssh/id_rsa | ...
  ...
]
```

哲学：**denylist 危险 pattern，不是 whitelist 安全命令**。`rm tmp.txt` OK；
`rm -rf /` 不 OK。`splitSegments` 按 shell operator 分段后 per-segment
检查，避免 `echo hi; rm -rf /` 这种藏在尾巴里的 case。

`src/permissions.ts` 在 confirm 路径之前会先用这个工具拒一刀。

### 工具结果落盘

| 文件 | 关键 export |
|---|---|
| `tool-result-storage.ts` | `maybePersistToolResult({ toolCallId, sessionId, toolName, content })`、`PERSIST_THRESHOLD_CHARS=50_000`、`PREVIEW_CHARS=2_000` |

行为：tool_result 文本超过 50k 字符 → 写
`<dataDir>/tool-outputs/<sessionId>/<toolCallId>.txt`，conversation 里换
成：

```
<persisted-output tool="read_file" file="/Users/.../report.md" bytes="18432">
[前 2000 字符预览]
…
</persisted-output>
```

LoopAgent 在 executor.postProcess 里调用。模型可以通过 read_file 那个文件
路径再读全文，但日常用预览就够了——把每个超长 read 从「永远 5k tokens
入下一轮 input」变成「2k tokens preview + 引用」。

`storageSessionId` 是 LoopAgent 选项里的，scope 这个目录；session 切换时
不再混淆。

---

## 哪些 helper 被 src/ 直接 import

`src/singletons.ts` 直接 import：
- `Logger / AgentLogger` —— 装在主 agent 上
- `getAppDataDir / IS_WINDOWS` —— `~/.zapcode` 解析

`src/imageStore.ts` 直接 import：
- `clipboard-image.ts` —— `/paste` 的图片捕获
- `image.ts` —— 转 base64

`src/permissions.ts` 直接 import：
- `safety.ts: matchDangerous` —— bash 危险命令拒绝

`src/headless/` 直接 import：
- `platform.ts: getAppDataDir`

理论上其余 `src/` 文件只接 `zapsdk/index.ts` 的 public surface；utils 是
internal-ish 但因为没破坏性 API 变化，跨过 index 直接 import 也无害。

# CLI reference

[← README](../README.md) · [中文版](../README.zh-CN.md)

Download a native binary or install the package using the [quick start](../README.md#quick-start), then connect a provider. Examples below use `zap`; a downloaded binary retains its platform filename unless you rename it. With `bun link`, use `zapdev` instead.

## npm installation

Install Node.js 22+ and run `npm install -g zapagent`. The package downloads the matching native CLI, which already contains its runtime; no separate Bun installation is needed. Run `zap --watch` in your working folder.

If installation scripts were disabled or the binary download failed, `zap` retries the verified download at first launch. Initial setup requires access to GitHub Releases; subsequent cached launches can run offline. Building from source or using the TypeScript SDK still requires Bun.

## Native binary setup

Download the binary matching your OS and CPU from [GitHub Releases](https://github.com/JackCaow/zapagent/releases/latest). This is a terminal application, not a desktop installer. Keep it outside folders you ask agents to modify. See the [release guide](releasing.md) for checksums and signing details.

### macOS and Linux

Give the downloaded file permission to run, then start it from the folder you want to work with. For example, on an Apple Silicon Mac:

```bash
chmod +x /path/to/zap-macos-arm64
cd /path/to/your-workspace
/path/to/zap-macos-arm64 --watch
```

Replace the binary filename with your platform's filename. macOS binaries are not notarized; macOS may require you to approve opening the downloaded program in System Settings → Privacy & Security.

### Windows

Open PowerShell, switch to your working folder, and run the downloaded executable:

```powershell
cd C:\path\to\your-workspace
& "C:\path\to\zap-windows-x64.exe" --watch
```

Use `/connect` in the terminal interface to set up your model service, then enter your task. The browser view opened by `--watch` shows progress; interaction stays in the terminal.

## Usage

```bash
zap
```

Watch the current process in a local, read-only browser view:

```bash
zap --watch
zap --watch --watch-no-open
zap --watch -p "Inspect this project" --output-format stream-json --watch-linger 30
```

The graph updates live from runtime events: model requests, tool approval and
execution, internal subagents, external CLI process states, and final outcomes.
The URL is printed to stderr. It listens on `127.0.0.1` with a per-process access
token; treat the URL as private. Prompts, arguments and tool output are excluded.
Refresh and reconnect restore the view without running tools again. Headless
runs exit normally unless `--watch-linger` is specified (0–300 seconds).
`--watch-port` selects a local port; Watch cannot be combined with `--dev`, ACP,
or workflow commands. See the [runtime design and validation record](architecture/57-watch-runtime-observability.md).

## Getting Started

On first run, use `/connect` to add an AI provider:

```
/connect
```

Supported providers:

- Anthropic (Claude)
- OpenAI Chat Completions (`/chat/completions`)
- OpenAI Responses (`/responses`)
- Compatible endpoints using either OpenAI protocol

### OpenAI Responses API

In `/connect`, create or edit a connection and select **OpenAI Responses** at
**wire protocol**. Set the base URL to `https://api.openai.com/v1` (or your
compatible gateway's API base), then enter its API key and choose a model.
The SDK appends `/responses`; do not add it to the base URL yourself.
Existing connections keep their current protocol until you change it.

Saved connections use `"protocol": "openai-responses"`. `/effort high` is mapped
to `reasoning.effort`; other Responses options such as
`"reasoning": { "summary": "auto" }` may be set in `extraRequestParams` when the
chosen model supports them. Reasoning summaries depend on model/account support.

The adapter supports streamed text, reasoning summaries, parallel function calls,
image inputs, tool-result images, cached-token accounting, cancellation and
request/stream timeouts. It keeps conversation state locally with `store: false`
and replays returned reasoning items and assistant message phases, including
across tool calls. Function arguments are released to the executor only after a
successful terminal response. Token-limit truncation requests continuation without
executing unfinished calls; failed or disconnected responses report errors.

SDK consumers can import `OpenAIResponsesProvider` from `zapagent` with the same
connection options as `OpenAICompatibleProvider`. Responses does not support
`stopSequences`; supplying it produces an explicit error. Server-side conversation
IDs and background responses are not used; built-in hosted tools are not exposed
by this adapter. Existing Chat Completions and Anthropic connections are unchanged.

Protocol reference: [OpenAI Responses migration guide](https://developers.openai.com/api/docs/guides/migrate-to-responses).

## Slash Commands

| Command | Description |
|---------|-------------|
| `/help` | Show command reference |
| `/connect` | Set up provider & API key |
| `/model` | Show or switch model |
| `/effort` | Set reasoning effort (`off`, `cycle`, or a provider value) |
| `/mode` | Set permission mode (`default`, `acceptEdits`, `plan`, `bypass`) |
| `/permissions` | Manage active permission rules |
| `/sessions` | Browse saved sessions |
| `/queue` | Manage individual follow-ups: edit, delete, reorder, retry, Steer, or toggle default queuing (also Ctrl+Q) |
| `/rewind` | Restore code, conversation, or both to a previous turn (empty prompt: Esc twice) |
| `/mem` | Browse memory (`list`, `show`, `forget`) |
| `/mcp` | Manage MCP servers |
| `/serper` | Set Serper web search API key |
| `/todos` | Show/hide the todo panel or clear todos |
| `/compact` | Summarize and compact conversation history |
| `/status` | Show session snapshot: provider, context, cache, MCP |
| `/new` | Start a new session |
| `/clear` | Clear the screen |
| `/copy` | Copy last output to clipboard |
| `/copy-input` | Copy last user input to clipboard |
| `/review` | Review code for bugs & security |
| `/commit` | Stage changes and create a conventional commit |
| `/init` | Generate AGENTS.md for this project |
| `/supertask` | Start, resume, abort, status, or watch a long-horizon task |
| `/exit` | Exit zapAgent (`/quit` and `/q` also work) |

The footer shows output speed as `105.4 token/s` for the latest root model request. `~` marks a live estimate (streamed characters ÷ 4); provider-reported output usage calibrates the final rate. Timing starts at first output and excludes tool execution. Missing usage keeps the estimate; non-streaming or very short responses may have no rate.

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Enter` | Send message |
| `Shift+Enter` | New line — Ghostty / Kitty / iTerm2 / WezTerm / Warp |
| `\` + `Enter` | New line — universal (works in Apple Terminal too) |
| `Ctrl+C` | Cancel running agent / exit |
| `Ctrl+L` | Clear screen |
| `Ctrl+Q` | Manage follow-ups without replacing the current draft |
| `↑ / ↓` (or `Ctrl+P / Ctrl+N`) | Walk prompt history (per-project, prefix-filtered, edge-aware in multi-line buffers) |

Messages sent during a task queue as separate subsequent turns. In `/queue`, use
`e` to edit, `x` to delete, `[`/`]` to reorder, `s` to Steer the active task, and
`q` to toggle the default between Queue and Steer. Steering waits for a complete
tool-result boundary and shares the active run's budget. Editing preserves the
original draft; Esc cancels the edit. Failed or recovered messages stay held for
transcript review and explicit `r` retry; accepted input is never automatically
resent after an API failure. Queue storage is private and bound to each session.

## Built-in Tools

The agent has access to the following tools:

- **Filesystem** — read, write, edit files
- **Glob / Search** — find files and search content
- **Shell commands** — run terminal commands
- **HTTP** — make web requests
- **Web search** — search the web
- **Document reader** — read PDFs, Word docs, and more
- **MCP** — connect external tools via Model Context Protocol

## Environment Variables

Use `/connect` for interactive provider setup. For a new configuration, copy
[`.env.example`](../.env.example) to `.env` and set all three bootstrap values:

```env
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_API_KEY=your_key_here
MODEL=your_model_id
```

The bootstrap requires `OPENAI_BASE_URL`; setting a key alone does not create a
provider. These names also apply to compatible endpoints. For Anthropic, use
`/connect`. Existing saved provider settings take precedence over bootstrap values.
Never commit `.env`.

| Variable | Purpose |
|---|---|
| `ZAPCODE_DATA_DIR` | Override the data directory (default: `~/.zapcode` on macOS, `${XDG_DATA_HOME:-~/.local/share}/zapcode` on Linux, `%APPDATA%\zapcode` on Windows). Affects config, sessions, logs, image cache, memory, monitor outputs, and tool-result storage. Useful for CI, sandboxed runs, and per-environment isolation. |

## Permissions and sandbox approvals

When a Bash command requests to run outside the OS sandbox, the approval menu
supports **this command**, **this session**, or **this project**, plus deny.
Session consent ends on `/new` or session restore. Project consent is bound to
the canonical working directory and stored under the user data directory at
`permissions/projects/<directory-hash>/settings.json`; other clones do not inherit
it. View or revoke `SandboxEscape(*)` in `/permissions`. Project consent also
applies to headless runs from that directory. Repository settings and ordinary
`Bash(*)` rules cannot grant sandbox escape. Explicit deny/ask rules, one-time
approval for dangerous commands, plan mode, and execution-backend restrictions
continue to apply. Choosing a scope authorizes subsequent outside-sandbox commands
in that scope, with full access to host files and network.

For ordinary tools, open `/permissions` and press `a` to select multiple tools,
choose entire tools or a project-relative file glob / Bash command pattern,
then review and save for this session or project. Press `g` on an ordinary
approval prompt to customize its scope. Read/edit groups expand into exact
currently registered tool names; future MCP tools do not inherit the grant.
All session tool grants expire on `/new` or session restore. New project grants
use the same host-owned data directory as sandbox consent; existing repository,
personal and global rules remain readable. Across sources and in both TUI and
Headless, explicit **deny wins over ask, and ask wins over allow**, including
`--allowed-tools` and bypass mode. See [authorization design](architecture/57-tool-authorization.md).

## Optional VM runtime

Local OS sandboxing is the default; it does not require a running VM. Set `executionBackend: "vm"` or `ZAPCODE_EXECUTION=vm` to opt in after provisioning a compatible runtime and image.

The optional VM runtime targets macOS (x64 / arm64), Linux (x64), and Windows (x64 via
Git Bash / MSYS). For VM execution, Linux needs KVM, cgroup v2, and systemd 254 or newer. Windows
needs an Administrator install terminal and Windows build 20348 or newer with
Hyper-V/HCS enabled. macOS needs Apple Virtualization.framework support.

The signed Guest image advertises its execution contract to Zap. Current
images include Python/pip/virtualenv, Node/npm, jq, ripgrep, zip and unzip.
The Guest root filesystem remains read-only; Zap tells the model to use
project-local environments such as `.venv` and `node_modules` instead of OS
package managers or temporary runtime bootstraps. The project workspace is
executable inside the VM, while `.git` and `.zapcode` remain read-only and
non-executable for Guest commands.

The release workflow builds independent Host Runtime images (`host-runtime`),
not images with an embedded Agent. Cloud/Web deployments are a separate delivery
mode and must supply their own Resident Agent runtime and validate its execution
contract. The normal local `zap` command remains host-orchestrated.


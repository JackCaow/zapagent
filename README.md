# zapAgent

**zapAgent. Code flows.**

Source candidate: publication is pending the [provenance and release checks](docs/open-source-readiness.md).

A terminal-based AI coding assistant powered by Claude, OpenAI, or any OpenAI-compatible provider.

## Monorepo modules

- `src/`: zapAgent CLI and TUI.
- `zapsdk/`: reusable Agent/Harness, including the execution-backend contract.
- `zapvm/`: independent Go module for VM Host, Guest, image tooling and cloud services.
  Its Apache-2.0 license and notices remain under that directory.

The Agent uses the VM through the execution protocol, not its implementation.
VM source is versioned in the same Git commit, but does not inject prompts,
force permissions or determine Agent completion. Agent-only builds still use
`bun run build`; `bun run build:all` also builds the native VM tools.
Use `bun run check:all` for Bun/TypeScript plus VM source/test/vet gates.
See [migration and release boundaries](docs/architecture/36-zapvm-monorepo.md).

## Installation

The npm package name is `zapagent`, with `zap` as its main command. npm
distribution is being prepared; use the installation options below until it
is published. Maintainers build the candidate with `bun run pack:npm`; see the
[npm publication procedure](docs/npm-publishing.md).

### Release installer (not yet available)

This new repository starts with source only. It has no published binary assets
or npm release. Use the source installation below. `install.sh` and the release
workflow are retained for maintainers; the installer becomes usable only after
a verified signed release is published in this repository.

The installer verifies the release checksum and installs Zap together with its
pinned zapVM binary, trusted image public key, and signed Linux Guest image.
Users still run only `zap`. Commands run under the host OS sandbox by default; the VM is
opt-in (`executionBackend: "vm"` or `ZAPCODE_EXECUTION=vm`) and starts lazily.

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
`--allowed-tools` and bypass mode. See [authorization design](docs/architecture/57-tool-authorization.md).

Supported targets are macOS (x64 / arm64), Linux (x64), and Windows (x64 via
Git Bash / MSYS). Linux needs KVM, cgroup v2, and systemd 254 or newer. Windows
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

### From source (requires [Bun](https://bun.sh))

```bash
git clone https://github.com/JackCaow/zapagent.git
cd zapagent
bun install --frozen-lockfile
bun start
```

For a global development command that points at this checkout (Bun required):

```bash
bun link
zapdev
```

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
or workflow commands. See the [runtime design and validation record](docs/architecture/57-watch-runtime-observability.md).

## Getting Started

On first run, use `/connect` to add an AI provider:

```
/connect
```

Supported providers:
- Anthropic (Claude)
- OpenAI
- Any OpenAI-compatible API

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
| `/exit` | Exit ZapCode (`/quit` and `/q` also work) |

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
[`.env.example`](.env.example) to `.env` and set all three bootstrap values:

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

## License

The CLI and SDK use [ISC](LICENSE). The independent VM module uses
[Apache-2.0](zapvm/LICENSE); third-party components retain their own licenses.
See [third-party notices](THIRD_PARTY_NOTICES.md).

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) for development and verification, and
[SECURITY.md](SECURITY.md) for vulnerability reporting and execution boundaries.
Maintainers should complete the [open-source checklist](docs/open-source-readiness.md)
before changing repository visibility or publishing artifacts. Platform builds,
unit tests, and basic agent smoke tasks are not equivalent to VM/security or
complex-task acceptance.

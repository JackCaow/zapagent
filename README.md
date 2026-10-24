<p align="center">
  <img src="docs/images/readme/hero.png" alt="zapAgent — Code flows. Your terminal. A team of agents." width="100%" />
</p>

<h1 align="center">One task. A team of coding agents.</h1>

<p align="center">
  Delegate independent work. Review isolated edits. Watch the run unfold.<br />
  An open-source terminal coding agent and TypeScript SDK.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/zapagent"><img src="https://img.shields.io/npm/v/zapagent?style=flat-square&color=b4e66e" alt="npm version" /></a>
  <a href="https://github.com/JackCaow/zapagent/releases"><img src="https://img.shields.io/github/v/release/JackCaow/zapagent?style=flat-square" alt="Latest release" /></a>
  <a href="https://github.com/JackCaow/zapagent/actions/workflows/ci.yml"><img src="https://github.com/JackCaow/zapagent/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/CLI_%26_SDK-MIT-blue?style=flat-square" alt="CLI and SDK: MIT" /></a>
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#give-your-agents-a-task">Try it</a> ·
  <a href="#watch-the-work-happen">Live view</a> ·
  <a href="#how-it-works">Architecture</a> ·
  <a href="docs/usage.md">Docs</a> ·
  <a href="README.zh-CN.md">简体中文</a>
</p>

zapAgent helps you explore a repository, implement changes, and run tests from your terminal. For larger tasks, a coordinator can delegate work to child agents, collect their results, and merge their edits back into your project.

- **Work in parallel.** Split exploration, implementation, and review into independent tasks, with dependencies and messages connecting the agents.
- **Keep edits isolated.** Writing agents use private workspace snapshots, including for non-Git projects. Review their artifacts before merging; merge checks detect conflicts and parent-workspace drift.
- **See the whole run.** `zap --watch` opens a local view of agents, tool calls, approvals, and completion states alongside your terminal.

Bring your own model connection: **Anthropic Messages, OpenAI Chat Completions, and OpenAI Responses API**, including compatible services. Keep your existing editor and toolchain.

## Quick start

Install [Bun](https://bun.sh) **1.3+** and [Git](https://git-scm.com), then:

```bash
bun add --global zapagent
cd /path/to/your-project
zap --watch
```

In the terminal UI:

1. Run `/connect` to add your provider's Base URL and API key. Select the API protocol supported by that service, including **OpenAI Responses** for a Responses endpoint.
2. Run `/model` to select a model. Use `/effort` to adjust reasoning effort when the model supports it.
3. Describe the task. Watch progress in the terminal and the local browser view.

You provide your own model credentials; usage is billed by your provider. See the [connection guide](docs/usage.md#getting-started), including [Responses configuration](docs/usage.md#openai-responses-api).

<details>
<summary>Other installation options: npm, native binaries, or source</summary>

**npm** — Bun 1.3+ must also be installed to run the CLI:

```bash
npm install --global zapagent
zap
```

**Native binaries** are available from [GitHub Releases](https://github.com/JackCaow/zapagent/releases/latest), with SHA-256 checksums:

| Platform | Downloads |
| :--- | :--- |
| macOS | [Apple Silicon](https://github.com/JackCaow/zapagent/releases/latest/download/zap-macos-arm64) · [Intel](https://github.com/JackCaow/zapagent/releases/latest/download/zap-macos-x64) |
| Linux | [ARM64](https://github.com/JackCaow/zapagent/releases/latest/download/zap-linux-arm64) · [x64](https://github.com/JackCaow/zapagent/releases/latest/download/zap-linux-x64) |
| Windows | [x64](https://github.com/JackCaow/zapagent/releases/latest/download/zap-windows-x64.exe) |

macOS binaries are ad-hoc signed, not Developer ID signed or notarized. Release contents and verification steps are documented in the [release guide](docs/releasing.md).

**From source** — the repository pins Bun 1.3.14:

```bash
git clone https://github.com/JackCaow/zapagent.git
cd zapagent
bun install --frozen-lockfile
bun start
```

Run `bun link` in the checkout, then use `zapdev` from your project. Or run `bun run build` and use `dist/zap`.

</details>

## Give your agents a task

Start with a real change in your repository:

```text
Add input validation to this project's API.
First inspect the codebase, then delegate independent parts to child agents:
implement validation, add regression tests, and review compatibility.
Run the relevant tests and summarize the results.
Ask before merging implementation artifacts into my workspace.
```

The coordinator manages child-agent dependencies, concurrency, messages, and lifecycle states. Delegation follows the task and model decisions; independent work can run together, while dependent work waits for prerequisites.

Writing agents can edit files, install dependencies, run tests, and stage or commit changes in their private workspaces, subject to tool permissions and the platform sandbox. Merging applies file changes to the parent workspace; it does not import the child's commit history. See [workspace isolation](docs/architecture/48-non-git-workspace-isolation.md).

## Watch the work happen

![The actual Watch UI showing connected agents, tool activity, and an approval wait, using synthetic demo events.](docs/images/readme/watch-preview.png)

*Captured from the actual Watch UI using synthetic preview events. This illustrates the interface, not a benchmark or a recorded model run. The header artwork is a concept illustration.*

Run `zap --watch` to follow the agent tree and tool lifecycle in a local browser. See which agents are active, which tools are executing, and where approval is needed.

Watch is **read-only** and displays runtime metadata rather than prompts, tool arguments, or tool output. Refreshing the page does not replay tools. Its loopback URL contains a private access token; do not share it. Use `--watch-no-open` to print the URL without opening a browser. [Watch details →](docs/architecture/57-watch-runtime-observability.md)

## Fit it into your workflow

| What you need | What zapAgent provides |
| :--- | :--- |
| Use your model provider | `/connect`, `/model`, and `/effort`; Anthropic, Chat Completions, and Responses protocols. |
| Continue a long task | Context compaction, project memory, saved sessions, and `/queue` for follow-up requests. |
| Control tool access | `/permissions`, scoped approvals, and the host OS sandbox by default. [Platform boundaries](docs/architecture/39-local-sandbox-default.md). |
| Return to earlier work | `/rewind` for conversation, tracked code changes, or both. External effects and some filesystem changes are outside checkpoint coverage. |
| Bring existing tools | Built-in file, search, shell, HTTP, and document tools, plus MCP integrations and skills. |
| Automate or build a host | Structured headless output, an ACP adapter, and a reusable TypeScript SDK. |

After configuring a provider, use the CLI in scripts:

```bash
zap -p "Explain this repository's architecture" --output-format json
zap --watch -p "Review the latest changes" --output-format stream-json --watch-linger 30
```

See `zap --help-headless` and the [CLI reference](docs/usage.md) for commands, configuration, approvals, and automation.

## How it works

![Architecture: a host and coordinator delegate to read-only agents or isolated writing agents. Artifacts pass merge checks, tools run through policy and execution layers, and runtime events feed the read-only Watch view.](docs/images/readme/architecture.svg)

The host starts a run through `AgentRuntime`. `LoopAgent` manages the model/tool loop, context, and execution budgets. The coordinator manages child runs; writing agents return frozen artifacts that pass conflict and workspace-drift checks before merging. Runtime events feed Watch. Execution success and task acceptance are separate: acceptance requires an explicit evaluator or human review.

| Module | Responsibility |
| :--- | :--- |
| [`src/`](src/) | Terminal UI, provider setup, sessions, headless/ACP hosts, and Watch. |
| [`zapsdk/`](zapsdk/) | TypeScript agent runtime: model loop, orchestration, tools, permissions, workspaces, merge, context, memory, and events. |
| [`zapvm/`](zapvm/) | Independent Go execution runtime. Optional VM execution connects through the SDK protocol; the VM does not own agent prompts, permissions, or completion decisions. |

Git workspaces use private clones of a working-tree snapshot, including eligible uncommitted changes. Non-Git projects use controlled copy snapshots. Read-only agents can share the parent workspace view.

Read the [architecture guide](docs/architecture/README.md) and [multi-agent design](docs/architecture/26-multi-agent-orchestration.md) for implementation details.

## Contributing

Help improve provider compatibility, sandbox behavior, collaboration, or the live view. Bug reports are most useful with expected behavior and a minimal reproduction, with credentials and private code removed.

```bash
bun run typecheck
bun test
bun run build
```

For the independent VM module, use `bun run check:vm`; `bun run build:all` builds both host components. See [CONTRIBUTING.md](CONTRIBUTING.md), [open issues](https://github.com/JackCaow/zapagent/issues), and [SECURITY.md](SECURITY.md).

## License

CLI and SDK: [MIT](LICENSE). Independent VM module: [Apache-2.0](zapvm/LICENSE). See [third-party notices](THIRD_PARTY_NOTICES.md) and [visual asset notes](docs/images/readme/README.md).

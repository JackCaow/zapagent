<p align="center">
  <img src="docs/images/readme/logo.png" alt="zapAgent logo" width="360" />
</p>

<h1 align="center">One task. A team of agents.</h1>

<p align="center">
  Delegate independent work. Review isolated edits. Watch the run unfold.<br />
  An open-source, general-purpose agent and TypeScript SDK.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/zapagent"><img src="https://img.shields.io/npm/v/zapagent?style=flat-square&color=b4e66e" alt="npm version" /></a>
  <a href="https://github.com/JackCaow/zapagent/releases"><img src="https://img.shields.io/github/v/release/JackCaow/zapagent?style=flat-square" alt="Latest release" /></a>
  <a href="https://github.com/JackCaow/zapagent/actions/workflows/ci.yml"><img src="https://github.com/JackCaow/zapagent/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/CLI_%26_SDK-MIT-blue?style=flat-square" alt="CLI and SDK: MIT" /></a>
</p>

<p align="center">
  <a href="#what-can-you-do-with-it">Use cases</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#give-your-agents-a-task">Try it</a> ·
  <a href="#watch-the-work-happen">Live view</a> ·
  <a href="#how-it-works">Architecture</a> ·
  <a href="docs/usage.md">Docs</a> ·
  <a href="README.zh-CN.md">简体中文</a>
</p>

zapAgent works from your terminal to understand tasks, call tools, and deliver results. Use it to research a topic, organize documents, analyze data, develop software, or automate a workflow. For complex tasks, a coordinator can delegate work to child agents and bring their findings and artifacts together.

- **Work in parallel.** Split research, analysis, execution, and review into independent tasks, with dependencies and messages connecting the agents.
- **Keep edits isolated.** Agents produce files and edits in separate workspaces. Collect and review their artifacts before merging, with a clear delivery boundary for each change.
- **See the whole run.** `zap --watch` opens a local view of agents, tool calls, approvals, and completion states alongside your terminal.

Bring your own model connection: **Anthropic Messages, OpenAI Chat Completions, and OpenAI Responses API**, including compatible services. Connect your existing files, tools, and workflows.

## What can you do with it?

| Task | Try asking |
| :--- | :--- |
| Research | “Read these materials, compare the viewpoints, and summarize the findings with sources.” |
| Organize documents | “Turn the notes in this folder into a structured report.” |
| Analyze data | “Find trends and anomalies in this dataset and explain the evidence.” |
| Automate a workflow | “Organize these files by the given rules and produce an inventory and summary.” |
| Develop software | “Understand this project, implement the change, add tests, and review the result.” |

Start with a task in plain language. When it benefits from delegation, agents can explore, analyze, and execute separate parts, then combine their results. Available capabilities depend on your model connection, configured tools, and permissions.

## Quick start

**1. Install zapAgent**

Requires the [Bun 1.3+](https://bun.sh) runtime. Install with npm:

```bash
npm install -g zapagent
```

**2. Start in your working folder**

Open a terminal in the folder containing your materials or project and run:

```bash
zap --watch
```

Interact in the terminal and follow task progress in the live browser view.

**3. Connect a model and describe your task**

On first use, enter `/connect` and follow the setup prompts to connect your model service. Then describe what you want: “Read the materials in this folder, summarize the key points, and write a report.”

You need your own model service account and API key; usage is billed by your provider. [Connection guide](docs/usage.md#getting-started).

<details>
<summary>Other installation options and advanced setup: Bun, binaries, source, API protocols</summary>

**Install with Bun**:

```bash
bun add --global zapagent
```

Git workspaces also require [Git](https://git-scm.com).

**Native binaries** — download from the [latest release](https://github.com/JackCaow/zapagent/releases/latest) and follow the [launch instructions](docs/usage.md#native-binary-setup):

| Platform | Downloads |
| :--- | :--- |
| macOS | [Apple Silicon](https://github.com/JackCaow/zapagent/releases/latest/download/zap-macos-arm64) · [Intel](https://github.com/JackCaow/zapagent/releases/latest/download/zap-macos-x64) |
| Linux | [ARM64](https://github.com/JackCaow/zapagent/releases/latest/download/zap-linux-arm64) · [x64](https://github.com/JackCaow/zapagent/releases/latest/download/zap-linux-x64) |
| Windows | [x64](https://github.com/JackCaow/zapagent/releases/latest/download/zap-windows-x64.exe) |

**Model configuration** — use `/model` to choose a model and `/effort` to adjust supported reasoning settings. For custom services, enter the Base URL and API key in `/connect` and select the service's API protocol; choose **OpenAI Responses** for a Responses endpoint. [Responses configuration](docs/usage.md#openai-responses-api).

**From source** — the repository pins Bun 1.3.14:

```bash
git clone https://github.com/JackCaow/zapagent.git
cd zapagent
bun install --frozen-lockfile
bun start
```

Run `bun link` in the checkout, then use `zapdev` from your working folder. Or run `bun run build` and use `dist/zap`.

Binaries include SHA-256 checksums. macOS binaries are ad-hoc signed, not Developer ID signed or notarized. See the [release guide](docs/releasing.md).

</details>

## Give your agents a task

Start with a task that benefits from several perspectives:

```text
Read the materials in this directory and prepare a project assessment.
Delegate independent parts to child agents: map the project background,
analyze risks, and review the conclusions against the evidence.
Combine the results in report.md. Cite sources and flag missing information.
Ask before merging the report into my workspace.
```

The coordinator manages child-agent dependencies, concurrency, messages, and lifecycle states. Delegation follows the task and model decisions; independent work can run together, while dependent work waits for prerequisites.

Writing agents can process files, write reports, and run scripts in their private workspaces. Development tasks can also install dependencies, run tests, and stage or commit changes, subject to tool permissions and the platform sandbox. Merging applies file changes to the parent workspace; it does not import the child's commit history. See [workspace isolation](docs/architecture/48-non-git-workspace-isolation.md).

## Watch the work happen

![The actual Watch UI showing connected agents, tool activity, and an approval wait, using synthetic demo events.](docs/images/readme/watch-preview.png)

*Captured from the actual Watch UI using synthetic preview events. This illustrates the interface, not a benchmark or a recorded model run.*

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
zap -p "Organize the materials in this directory into themes, findings, and open questions" --output-format json
zap --watch -p "Analyze the data in this directory and write a report" --output-format stream-json --watch-linger 30
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

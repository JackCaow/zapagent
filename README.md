<p align="center">
  <img src="docs/images/readme/hero.png" alt="zapAgent — Code flows. Your terminal. A team of agents." width="100%" />
</p>

<h1 align="center">One task. A coordinated team of agents.</h1>

<p align="center">
  Delegate work. Keep edits isolated. Watch every step.<br />
  A terminal coding agent with a reusable TypeScript runtime.
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#see-the-work-as-it-happens">Live visualization</a> ·
  <a href="#how-the-agents-work-together">Architecture</a> ·
  <a href="docs/usage.md">CLI reference</a> ·
  <a href="README.zh-CN.md">简体中文</a>
</p>

zapAgent brings **multi-agent collaboration, isolated workspaces, and live runtime visualization** into your terminal. Ask it to investigate a codebase, split an implementation into independent pieces, or review a change. Writing agents work in private snapshots; you can inspect their progress and approve artifact merges back into your project.

Use Anthropic Messages, OpenAI Chat Completions, or **OpenAI Responses API**, including compatible endpoints. Keep your editor, terminal, and existing toolchain.

## Built for work that needs more than one agent

| Collaborate | Isolate | Observe |
| :--- | :--- | :--- |
| Delegate exploration, planning, and implementation to child agents. The coordinator manages dependencies, concurrency, messages, and run state. | Writing agents get private workspaces, including in non-Git projects. Their edits return as artifacts for an explicit merge. | `--watch` opens a live graph of model requests, tools, approvals, and child agents alongside the terminal. |
| **Independent work can happen together.** | **Child edits reach your project through a merge gate.** | **See what is running, waiting, or finished.** |

Try a prompt like this:

```text
Investigate how authentication works in this repository.
Delegate independent parts to agents: map the request flow, review session
handling, and inspect the tests. Summarize their findings, then propose a fix.
Ask before merging implementation artifacts into my workspace.
```

Delegation follows the task and model decisions; independent steps can run concurrently, while dependent steps wait for their prerequisites.

## Quick start

Requires **Git** and **[Bun](https://bun.sh) 1.3+**. Bun 1.3.14 is the version pinned by this repository.

```bash
git clone https://github.com/JackCaow/zapagent.git
cd zapagent
bun install --frozen-lockfile
bun start
```

In the terminal UI, run `/connect` to configure a provider, then `/model` to choose a model.

To use this checkout from your own project:

```bash
# Run once inside the zapagent checkout.
bun link

# Then run from the project you want to work on.
cd /path/to/your-project
zapdev --watch
```

Prefer a compiled CLI? Run `bun run build`, then use `dist/zap` from your checkout. Examples below use `zap`; the development command `zapdev` accepts the same arguments.

> **Source preview:** this repository is being prepared for public release. npm and binary releases are not yet published here; source installation currently requires repository access. See [release readiness](docs/open-source-readiness.md).

## See the work as it happens

```bash
zap --watch
```

Keep coding in the terminal while a local browser view shows the run unfolding: which agent is active, which tool is running, where approval is needed, and which steps have finished.

![Watch UI showing a root agent, a child agent, tool activity, and an approval wait. Synthetic demo events.](docs/images/readme/watch-preview.png)

*The actual Watch interface, captured with the repository's synthetic preview events. This is a UI demonstration, not a benchmark or a recorded model run.*

- **Follow the agent tree:** root and child runs stay connected to their tools and lifecycle states.
- **Understand waits:** distinguish model activity, tool execution, approval, and completion.
- **Keep the terminal in control:** Watch is read-only. Refreshing the page does not replay tools or change the run.
- **Keep content out of the viewer:** Watch projects runtime metadata; prompts, tool arguments, and tool output are excluded. Its loopback URL contains a private access token.

Use `--watch-no-open` to print the viewer URL without opening a browser. See [Watch architecture](docs/architecture/57-watch-runtime-observability.md) for the event flow and current limits.

## How the agents work together

![Agent architecture: the host drives a root agent and coordinator; read-only agents share a view, writing agents use private snapshots, and artifacts pass conflict and drift checks before merging. Tools run through policy and execution layers; events feed the read-only Watch view.](docs/images/readme/architecture.svg)

1. **The host starts a run.** The terminal, headless CLI, or ACP adapter uses `AgentRuntime`. `LoopAgent` handles the model/tool loop with context management and execution budgets.
2. **The coordinator delegates.** Child runs have their own identities, lifecycle states, dependencies, and messaging. Independent work can run concurrently within configured limits.
3. **Writing agents work in isolation.** Git projects use private clones of a working-tree snapshot, including eligible uncommitted changes. Non-Git projects use controlled copy snapshots. Read-only agents can share the parent workspace view.
4. **Results come back through a merge gate.** Writing agents produce frozen artifacts. Merging checks conflicts and parent-workspace drift before applying changes. Child staging and commits stay private; merging delivers file changes, not child commit history.
5. **Runtime events make progress visible.** Watch observes the execution lifecycle without controlling it. The runtime distinguishes execution outcomes from acceptance; task acceptance requires an explicit evaluator or human review.

The three modules have separate responsibilities:

| Module | Responsibility |
| :--- | :--- |
| [`src/`](src/) | Terminal UI, provider setup, sessions, headless/ACP hosts, and Watch. |
| [`zapsdk/`](zapsdk/) | Reusable TypeScript agent runtime: model loop, orchestration, tools, policy, workspaces, merge, context, memory, and events. |
| [`zapvm/`](zapvm/) | Independent Go execution runtime. Optional VM execution sits behind the SDK's execution protocol; the VM does not own agent prompts, permissions, or completion decisions. |

Explore the [architecture guide](docs/architecture/README.md), [multi-agent design](docs/architecture/26-multi-agent-orchestration.md), and [non-Git workspace isolation](docs/architecture/48-non-git-workspace-isolation.md).

## More of your workflow, in one place

- **Choose your model.** Connect Anthropic or OpenAI-compatible providers and switch with `/model`; adjust supported reasoning settings with `/effort`.
- **Keep long tasks moving.** Context compaction, project memory, saved sessions, and a follow-up queue help carry work across turns. Steer the active task or queue the next request with `/queue`.
- **Control tool access.** Inspect permissions and scoped approvals with `/permissions`. Commands use the host OS sandbox by default; VM execution is opt-in. See the [execution boundary](docs/architecture/39-local-sandbox-default.md) for platform-specific restrictions.
- **Return to earlier work.** `/rewind` can restore conversation, tracked code changes, or both. Checkpoints have coverage limits; external effects and every filesystem topology change are not fully reversible.
- **Bring your tools.** Built-in file, search, shell, HTTP, and document tools sit alongside MCP integrations and skills.
- **Build your own host.** Reuse the SDK, stream structured headless output, or connect an ACP-compatible client.

### Script it

After configuring a provider:

```bash
zap -p "Explain this repository's architecture" --output-format json
zap --watch -p "Review the latest changes" --output-format stream-json --watch-linger 30
```

Use `zap --help-headless` for automation options. See the [CLI reference](docs/usage.md) for all slash commands, keyboard shortcuts, environment variables, approval scopes, and optional VM setup.

## Build with us

Useful contributions include reproducible agent failures, clearer runtime visualization, provider compatibility fixes, and platform-specific sandbox tests. Include the expected behavior and a minimal reproduction; remove credentials and private code from reports.

```bash
bun run typecheck
bun test
bun run build
```

Working on the independent VM module? Use `bun run check:vm`; `bun run build:all` builds both host components. See [CONTRIBUTING.md](CONTRIBUTING.md) and report vulnerabilities via [SECURITY.md](SECURITY.md).

If this is the workflow you want in your terminal, star the repository and help shape it.

## License

CLI and SDK: [MIT](LICENSE). Independent VM module: [Apache-2.0](zapvm/LICENSE). See [third-party notices](THIRD_PARTY_NOTICES.md) and [visual asset notes](docs/images/readme/README.md).

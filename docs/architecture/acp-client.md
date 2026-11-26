# Zap as an ACP Client

Status: phase 1 implemented (`zapsdk/acp-client/`, `acp_agent` tool); phases 2–4 are design. Zap today is an ACP **agent** (`zap acp`, `src/acp/`).
This document makes it an ACP **client** too, so it can drive external agents
over standard ACP, ACP extensions, or adapters for non-ACP CLIs.

## Goals

1. **Tool mode (A)**: zap's own model stays in charge and hands subtasks to an
   external agent through one generic tool. This replaces the per-CLI parsers in
   `delegate.ts` / `delegate-stream.ts`.
2. **Session mode (B)**: the TUI becomes a front end for an external agent. The
   user talks to agy/codex/another zap directly; zap renders
   messages, thinking, tool calls and plans, answers permission prompts, and
   serves fs/terminal requests.
3. **Extensions**: `_meta` and `_zap/*` methods carry zap-specific
   capabilities. The same remote interface also covers non-ACP CLIs (adapters)
   and zap↔zap calls.

Non-goals: changing `src/acp/` agent behaviour (it only gains the extension
methods), running agents inside zapVM (zapVM lives in its own repository and
VM execution is disabled in zap), and MCP passthrough (phase 4+).

## Layers

```text
                ┌──────────────── src/ (TUI) ────────────────┐
 Session mode   │ RemoteAgent adapter  ─► useAgentRunner      │
                │ (same .on/.run surface as LoopAgent)       │
                └──────────────┬─────────────────────────────┘
 Tool mode      zapsdk/builtin-tools/acp-agent.ts (tool "acp_agent")
                               │
                ┌──────────────▼──────── zapsdk/acp-client/ ──────────┐
                │ AcpClientSession   (connect, initialize, session/*, │
                │                     prompt, cancel, modes, config)  │
                │ ClientHandlers     permission / fs / terminal       │
                │ EventMapper        SessionUpdate ─► AgentEvent      │
                │ Extensions         _meta + _zap/* negotiation       │
                │ Transports         stdio (spawn) │ in-process       │
                │ Adapters           claude-stream-json, codex-json   │
                └─────────────────────────────────────────────────────┘
```

`zapsdk/acp-client/` sits on `@agentclientprotocol/sdk`
(`ClientSideConnection`, `ndJsonStream`), which is already a dependency. It does
not import from `src/`.

### Agent registry (config)

`~/.zapcode/config.json` gains `acpAgents`:

```json
"acpAgents": [
  { "id": "agy",    "command": "agy",    "args": ["acp"] },
  { "id": "zap",    "command": "zap",    "args": ["acp"] },
  { "id": "claude", "adapter": "claude-stream-json" },
  { "id": "codex",  "adapter": "codex-json" }
]
```

Each entry can also set `env`, `preserveEnvironment`, `mode`, `model`
(unstable `session/set_model`), `config` (session config options to apply),
`timeoutMs`, `description` and `selfGoverned`. Setup steps the agent rejects
are reported as warnings; the run continues. Startup auto-detection, like
`delegate-detect.ts`, seeds entries for binaries found on PATH.

## Core: AcpClientSession

- **Lifecycle**: spawn → `initialize` (send `clientCapabilities.fs` and
  `terminal` based on the host policy; record `agentInfo` and
  `agentCapabilities`) → `authenticate` if the agent requires it →
  `session/new`, or `session/load`/`resume` when supported → `prompt`* →
  `cancel` → close (SIGTERM, grace period, then SIGKILL the process tree,
  reusing `terminateProcessTreeWithGrace`).
- **Prompt content**: text, images (when `promptCapabilities.image`), and
  `resource_link` for files the user mentions.
- **Modes and config**: expose `session/set_mode` and
  `session/set_config_option`. This is how the thought level in the agy README
  gets set without parsing model names.
- **Robustness**: stderr goes to a bounded ring buffer and becomes the error
  detail. A process exit mid-turn becomes a structured error, never a hang. The
  request timeout is configurable, and cancellation goes through
  `session/cancel`.

## Client handlers (zap answers the agent)

Requests are mapped to zap's existing tool names so `evaluateApprovalPolicy`
(mode, rules, workspace scope, dangerous commands, edit previews) applies
unchanged (`zapsdk/acp-client/host-handlers.ts`):

| ACP request | Approval asked as | Notes |
|---|---|---|
| `fs/read_text_file` inside the workspace | `read_file {path}` | Absolute paths only; `line`/`limit` clamped; size checked before reading (10 MiB cap). |
| `fs/read_text_file` outside the workspace | `acp_<agent>_read` | Always a one-time prompt (zap's executor confinement is bypassed here, so the handler enforces it). |
| `fs/write_text_file` inside the workspace | `write_file {path, content}` | Checkpoint (`createEditTracker`) runs **before** the write, so `/rewind` covers it. |
| `fs/write_text_file` outside the workspace | `acp_<agent>_edit` | One-time prompt; never auto-allowed by acceptEdits. `.git` / `.zapcode` writes are refused outright. |
| permission, kind `execute` with a command (`command`, or agy's `CommandLine`; argv is shell-quoted) | `bash {command}` with explicit facts | Dangerous-command and command rules apply; the sandboxed-command auto-allow does not (`workspaceShell: false`), because the agent runs it outside zap's sandbox. |
| permission, kind `edit`, one file, content known (diff `newText`, or `Content`/`content`) | `write_file {path, content}` | Edit preview, acceptEdits and workspace scope apply (agy and codex both qualify). |
| permission, kind `delete` / `read`, one file | `delete_file` / `read_file {path}` | |
| permission, edit/delete/read on an out-of-workspace or protected path, or anything else | `acp_<agent>_<kind> {title, paths, input}` | One-time only: no session/project scope (`inferPattern` → null) and bare allow rules never match. Treated as a write unless kind is read/search/think, so plan mode refuses it. |

When the turn is cancelled, pending permission requests are answered
`cancelled` (ACP requirement) and the zap approval prompt is dismissed.

Zap only ever selects `allow_once`/`reject_once`: an "always" grant lives in
zap's rules, never inside the external agent. `terminal/*` is not advertised
yet (`clientCapabilities.terminal: false`); agents fall back to their own
execution and ask permission first.

Agents that edit on their own (agy does: it asks `request_permission` with
kind `edit`, then writes itself) are still captured by the git status diff
before and after the call, as `delegate` does (`delegate-changes.ts`), and the
tool result says checkpoints do not cover those edits.

## EventMapper: SessionUpdate → AgentEvent

| ACP `sessionUpdate` | zap `AgentEvent` |
|---|---|
| `agent_thought_chunk` | `content_delta{kind:thinking}`; finalized when text or a tool starts |
| `agent_message_chunk` | `content_delta{kind:text}` → `content_final` at turn end |
| `tool_call` | `content_final{kind:tool_call}` (toolName = `kind`/`title`) + `status:tool` |
| `tool_call_update` (completed/failed) | `content_final{kind:tool_result}`; diff content → diff metadata (`diff-meta.ts`) |
| `plan` | a todo update, reusing the todo UI |
| `usage_update`, `_meta.usage` | `run_step` usage |
| `current_mode_update`, `config_option_update` | status bar / mode indicator |
| `available_commands_update` | slash-command palette entries (`/agent:<cmd>`) |
| `stopReason` | run outcome (`end_turn`, `max_tokens`, `refusal`, `cancelled`) |

In tool mode, events are re-emitted with `path: ["acp:<id>"]`, the existing
subagent path mechanism, so the transcript nests them like subagents.

## Mode A: `acp_agent` tool

```ts
acp_agent({ agent: "agy", task: "...", cwd?, sessionId?, mode? })
  → { report, stopReason, changes: <git diff summary>, sessionId, usage }
```

- The tool description lists only configured and healthy agents.
- `sessionId` resumes the conversation (`session/load`) when supported;
  otherwise zap keeps the process alive in a small pool keyed by
  (agent, sessionId) with an idle timeout.
- `delegate` becomes a thin alias. Claude and codex move behind adapters,
  preferring their real ACP agents (`claude-code-acp`, `codex-acp`) when
  installed. The old parsers are deleted once the adapters pass the existing
  delegate tests.

## Mode B: session backend

Implemented without a second agent class: `runAgent` (`useAgentRunner`)
branches to `runRemoteTurn` (`src/agent/remote-turn.ts`) when
`config.activeAgent` is set. That path reuses `createStreamingPreview` and
`createRunHandlers().wire(emitter)`; `wire()` only needs an
`AgentEventSource`, so ACP updates mapped to `AgentEvent`s render exactly like
zap's own turns (thinking, text, tool rows, diffs, errors, run divider).

- `/agent` lists agents, `/agent <id>` switches, `/agent zap` (or `off`)
  switches back. `activeAgent` is session-scoped like `permissionMode`:
  cleared on load and stripped on save.
- `RemoteAgentManager` (`src/agent/remote-agent.ts`) keeps one agent process
  and ACP session alive across turns, so the agent keeps its own context. It
  is replaced on agent or cwd change, dropped after a failed turn, and
  closed on `/new`, on switching, and at exit.
- Approval and checkpoint hooks are read from `remoteAgents.host` at request
  time; `useAgentObjects` updates them on every rebuild, so permission-mode
  changes apply mid-session without reconnecting.
- Each exchange is appended to zap's conversation
  (`user` + `assistant: "[<id> via ACP] …"`), so `/agent zap` continues with
  the context. The agent's plan, if any, is logged after the turn.
- The turn returns a `LoopAgentResult` (`stopped` from the ACP stop reason),
  and calls `onInputAccepted` when the prompt is sent, so the follow-up queue
  treats remote turns like local ones.
- The provider check is skipped while an agent is active (the agent brings
  its own model); the prompt label and footer show `ACP/<id>`.
- `/goal` stays on zap's own model and is refused in agent mode.
- Each remote turn opens and closes a checkpoint turn (`beginTurn` /
  `makeSnapshot`), so it appears in `/rewind` and fs writes are attributed
  to it. zap's context gauge is hidden while an agent is active.
- A failed turn (including an agent that ignores cancellation) closes the
  agent process; the next message starts a fresh agent session. `/clear`,
  Ctrl+L, `/new`, session restore and a conversation rewind also close it.
  A start that completes after a reset is discarded; `/exit` closes the
  agent gracefully and the process-exit hook SIGKILLs anything left.
- `/review`, `/commit`, `/init` and skills carry zap prompts and are refused
  while an agent is active.

Not yet: agent slash commands (`available_commands_update`) in the palette,
an agent mode picker, image prompts beyond pass-through, steering mid-turn,
and resuming the remote session after a zap restart (`session/load`).

## Extensions

Negotiated in `initialize` via `_meta.zap`:
`{ "zap": { "version": 1, "features": [...] } }`, sent in both directions. A
side that doesn't echo the feature never receives it, so standard agents see
plain ACP.

| Feature | Mechanism | Purpose |
|---|---|---|
| `thinking-effort` | `_meta.zap.effort` on `session/prompt` | Per-turn effort without a config option |
| `usage` | `_meta.zap.usage` on the prompt response | Token, cache and reasoning breakdown |
| `checkpoint` | `_zap/checkpoint` request, client → agent | Ask a zap agent to snapshot and rewind |
| `events` | `_zap/event` notification, agent → client | Full AgentEvent stream for zap↔zap (lossless subagent nesting, compaction and budget events) |
| `steer` | `_zap/steer` request | Inject a user message mid-turn (zap supports steering) |

`src/acp/agent.ts` (the zap agent side) implements the agent half of these, so
zap↔zap gets near-native fidelity and other agents degrade to plain ACP.

### Adapters for non-ACP CLIs

An adapter implements the same `Agent` interface in-process and translates:
`claude -p --output-format stream-json` and `codex exec --json` to and from
ACP. The logic moves out of `delegate-stream.ts`. The in-process transport
uses a pair of `TransformStream`s with `ndJsonStream`, so the core cannot tell
an adapter from a real agent.

## Security

- The external agent is untrusted. Every fs and permission request is checked
  by zap's policy as described above; nothing is auto-allowed beyond what zap
  would allow its own tools.
- `acp_agent` itself is `permission: "confirm"`. Session/project grants are
  scoped to `agent@cwd` exactly like `delegate_agent(provider@cwd)`; a bare
  `acp_agent` allow rule never grants delegation. Although its process effect
  is `unsandboxed`, `approvalFacts` does not treat it as a sandbox escape: the
  agent-scoped approval is the consent, and it neither uses nor grants bash's
  outside-sandbox authorization.
- The agent process runs **outside the OS sandbox** (`unsandboxed: true`
  process effect): external agents need their own state directories,
  credentials and model endpoints, which zap cannot enumerate per agent. It
  inherits the host environment, like an approved unsandboxed command. Hosts
  that set `allowUnsandboxedCommands: false` therefore cannot use `acp_agent`.
  A per-agent sandbox profile (state paths + domains, as `delegate` has for
  claude/codex) is future work.
- Agents marked `selfGoverned` get a note in every result that their direct
  writes bypass checkpoints.

## Phases

1. **Core + tool mode** (done): `zapsdk/acp-client/` (stdio and in-process
   transports, connection, host handlers, mapper, `runAcpTask`), `acp_agent`
   tool, `acpAgents` config and PATH detection. Tests:
   `zapsdk/tests/acp-client/` (in-process fake agent and a real stdio child).
   Verified end to end with `agy acp`: create file, permission mapping,
   session resume. Built-in agents: agy and codex (via
   `@agentclientprotocol/codex-acp`), both marked `selfGoverned`. Codex keeps
   its default "agent" mode: "read-only" routes every edit to zap but stalls
   ~3 minutes upstream before each permission request (reproduced with a bare
   client, so not zap). Zap's plan mode already denies `acp_agent` itself.
2. **Session mode** (done): `/agent` switching, `runRemoteTurn`,
   `RemoteAgentManager`. Tests: `tests/agent/remote-agent.test.ts`. Verified
   in the real TUI with no zap provider configured: agy two-turn session
   (approval dialog, diff rendering, context kept), codex turn, switch back.
3. **Extensions + zap↔zap**: `_meta.zap` negotiation on both sides,
   `_zap/event` lossless stream.
4. **Adapters**: move claude and codex to adapters, then retire the
   delegate-specific parsers.

## Open questions

- Should tool mode keep agent processes warm across calls by default (faster,
  but uses resources), or start one per call (simpler)? Proposal: per call,
  with a pool only when `sessionId` is reused.
- Plan updates from remote agents: merge them into zap's todo list or keep a
  separate panel? Proposal: separate, labelled by agent.

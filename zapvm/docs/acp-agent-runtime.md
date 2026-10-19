# ACP Agent Runtime

## Delivery contract

zapVM exposes Agent integration through the Agent Client Protocol (ACP). The
Cloud control plane never runs an Agent and never interprets Agent-specific
tool calls. A signed Agent package is mounted read-only in the Guest VM and the
Guest runtime acts as the ACP Client.

```text
Web / API
   -> Control plane
   -> zapvm-node
   -> zapvm daemon
   -> Guest VM
        zapvm-resident-agent (ACP Client)
          <-> /opt/zapvm-agent/bin/agent acp (ACP Agent, for example Dim)
          -> Guest terminal and workspace filesystem
```

The trust boundary is deliberate:

- ACP owns Agent identity, session lifecycle, streamed messages, tool updates,
  permission requests, terminal requests, and filesystem requests.
- zapVM owns image and Agent-package signatures, placement, VM lifecycle,
  workspace isolation, credential leases, network policy, quotas, and artifact
  collection.
- Railway hosts Web and control services only. Agent execution and tool
  callbacks stay inside the selected Guest VM.

There is no fallback to a Host process or to the bundled ZapCode Agent when an
ACP package is selected. A missing, incompatible, or unhealthy ACP Agent fails
the task with a structured error.

## Signed Agent package

An ACP package uses the `acp-resident-v1` adapter contract and exposes the
regular executable `/opt/zapvm-agent/bin/agent`. The executable must accept the
subcommand `acp` and speak newline-delimited JSON-RPC 2.0 on stdin/stdout. Logs
must go to stderr.

The package may contain its own runtime and support files. It is mounted
read-only. Per-session writable state is provided through the private Guest
home directory. Model credentials are injected only for the command lease and
must not be copied into the workspace or artifacts.

Dim is packaged behind this entrypoint together with its pinned minimal glibc
runtime (the Alpine Base remains Agent-agnostic). Its package wrapper configures the
task-scoped provider in the private `DIMCODE_HOME`, launches `dim acp`, and
removes credential material when the ACP process exits.

## ACP flow

The runtime performs this sequence with protocol version 1:

1. Start `/opt/zapvm-agent/bin/agent acp`.
2. Send `initialize` with filesystem and terminal client capabilities.
3. Record and emit `agentInfo`; this is the execution-identity evidence used
   by E2E acceptance.
4. Send `session/new` on a new zapVM session, or `session/resume` when a stored
   ACP session ID exists and the Agent advertises resume support.
5. Send `session/prompt` with the exact, unmodified user request.
6. Serve Agent-to-Client requests while the prompt is active.
7. Normalize ACP notifications into zapVM JSONL events and emit a final result.

The ACP session ID is stored in the private session home with mode `0600`. It
is never accepted from a browser and never shared across zapVM sessions.

## Agent policy independence

The runtime does not prepend instructions to the user request, choose a retry
strategy, impose a planning algorithm, or change the Agent's permission mode.
In particular it never sends `session/set_config_option` to force `full-access`.
An Agent can keep its own mode and request one-shot permissions through ACP.

The requested model and leased credentials are transport configuration, not
runtime-selected Agent policy. The output directory remains available as
`ZAPVM_ARTIFACT_DIR` in the Agent package environment. The package/Agent owns
consumption of this fact; the runtime no longer injects artifact-writing or
network-retry instructions into the prompt. Existing packages that depended
on that injected text need artifact E2E acceptance before rollout. Collection
remains bounded to the task's output directory; it does not collect arbitrary
workspace files as a fallback.

Isolation remains authoritative: signatures, read-only mounts, protected
paths, egress, lease deadlines and process cleanup still apply. Execution
denial is an observable error, not a command to the Agent to abandon its task.
The Agent/Harness owns interpretation and recovery within granted authority.

## Guest callbacks

### Permissions

Unattended Cloud tasks select `allow_once` only when the Agent presents that
option. The runtime rejects permanent grants and fails closed when no one-shot
grant is available. zapVM's VM, mount, credential, network, and timeout limits
remain authoritative even after the ACP permission is granted.

### Filesystem

`fs/read_text_file` and `fs/write_text_file` accept absolute paths only under
`/workspace`. Paths are canonicalized to portable relative paths, `.git` and
`.zapcode` are rejected, symlinks are not followed, content is bounded, and
writes are performed through pinned directory handles.

### Terminal

`terminal/create` starts a process in the Guest. Its working directory must be
`/workspace` or a real directory below it. Environment overrides are bounded;
credential and zapVM-internal variables cannot be replaced. Output is bounded
at a valid UTF-8 boundary and the runtime implements output, wait, kill, and
release for the ACP terminal ID.

## Event normalization

ACP remains the wire protocol between the Guest runtime and Agent package. The
Cloud/Web stream keeps zapVM's stable event vocabulary:

- `agent_message_chunk` -> `assistant`
- `agent_thought_chunk` -> `observation` with source `acp-thought`
- `tool_call` -> `tool_use`
- `tool_call_update` -> `tool_result` or tool progress
- prompt completion -> `result`

This keeps ACP transport concerns out of the browser and preserves ordered
Agent-loop rendering.

## End-to-end acceptance

A release is deliverable only when one trace proves all of the following:

1. **Agent identity:** `initialize.agentInfo` identifies Dim and the expected
   version.
2. **ACP loop:** a prompt produces ordered thought/message/tool updates.
3. **Guest execution:** a `terminal/create` callback writes a nonce inside the
   VM workspace; no Host fallback process exists.
4. **Isolation:** reads/writes outside `/workspace` and access to `.git` or
   `.zapcode` fail; permanent permission grants are refused.
5. **Continuation:** a second turn resumes the stored ACP session.
6. **Artifacts:** Dim creates a regular file in the exact task artifact
   directory and Web exposes a working authenticated download.
7. **Failure behavior:** Agent crash, malformed JSON-RPC, timeout, offline
   node, and unsupported ACP capability become terminal structured states
   instead of indefinite loading.
8. **Cloud chain:** Web, Control, Node, daemon, VM, ACP Agent, and the returned
   artifact share one task/session correlation ID.

Unit and fake-Agent protocol tests are necessary but do not satisfy this gate.
The final evidence must use the signed Dim Agent package in a real zapVM Guest.

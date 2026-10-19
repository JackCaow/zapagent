# Host Agent Adapter Layer

Host Agent Adapter Layer lets external Agent products delegate command
execution to zapVM without importing zapVM's daemon codec, VMM implementation,
or Guest RPC. It is separate from signed Agent packages:

- Agent packages define which Resident Agent is mounted read-only inside a
  Guest.
- Host adapters translate an external Agent's tool protocol into the public
  `zapvm daemon exec` contract.

The first registered protocol is Dim sandbox runner protocol v1. More protocols
must be added as independent codecs rather than by adding Agent-specific
branches to the executor.

## Architecture

```text
External Agent
  -> protocol codec (Dim, future Agent B, future Agent C)
  -> agentadapter.Request
  -> shared zapVM CLI executor
  -> owner-only daemon endpoint
  -> Guest Agent
  -> protocol-specific result codec
```

Ownership is intentionally narrow:

| Component | Owns | Must not own |
| --- | --- | --- |
| `internal/agentadapter` | normalized execution authority, registry, zapVM CLI executor | vendor JSON schemas |
| `internal/agentadapter/<agent>` | matching, strict decode, policy translation, result encoding | daemon/VMM access |
| `cmd/zapvm-agent-adapter` | bounded stdin, protocol selection, signals, executable discovery | Agent-specific policy logic |

The registry requires exactly one protocol match. Unknown and ambiguous input
fails closed. The command accepts at most 1 MiB on stdin and never falls back to
Host execution when zapVM is unavailable or rejects authority.

## Build and inspect

```bash
make build-adapters
bin/zapvm-agent-adapter list
bin/zapvm-agent-adapter version
```

By default the adapter finds a sibling `zapvm` executable, then searches
`PATH`. Production launchers should set an absolute path:

```bash
export ZAPVM_BIN=/absolute/path/to/zapvm
export ZAPVM_ENDPOINT=/absolute/path/to/owner-only/zapvm.sock
```

`ZAPVM_ENDPOINT` is optional and otherwise uses zapVM's platform default.
The adapter binary is included in macOS, Linux, and Windows Host release
archives and is installed alongside `zapvm` by the standard installers.

## Dim source-free integration

Dim Desktop and development CLI already accept an external native runner.
Point those existing variables to this binary; no Dim source change is needed:

```bash
export DIM_SANDBOX_BACKEND=native
export DIM_SANDBOX_RUNNER=/absolute/path/to/zapvm-agent-adapter
export ZAPVM_BIN=/absolute/path/to/zapvm
dimcode
```

Enable Dim sandbox mode `workspace-write` or `read-only`. Dim invokes the
binary as `zapvm-agent-adapter run` and sends one protocol v1 JSON request on
stdin. The adapter auto-detects the protocol and returns a standard
`NativeRunnerResult` JSON object on stdout.

Packaged Dim CLI builds that set `DIMCODE_REQUIRE_PACKAGED_RUNTIMES=1` force
their bundled runner and do not honor an external path. Those distributions
need an explicit package integration decision; replacing a signed bundled
binary is not supported.

### Dim policy mapping

| Dim input | zapVM authority |
| --- | --- |
| `read-only` | read-only workspace mount |
| `workspace-write` | read-write workspace mount |
| no domains or `disableNetwork=true` | network `off` |
| `allowedDomains=["*"]` | network `unrestricted` |
| concrete domains | network `restricted`, exact domains, port 443 |
| Host absolute cwd inside workspace | canonical workspace-relative Guest cwd |
| POSIX `shell -lc <script>` | `/bin/sh -lc <script>` in the Linux Guest |
| workspace-relative `readDenyPaths` | masked file or directory in the Guest private mount namespace |
| Host paths outside the workspace | absent from the Guest; no Host path is mounted |

The adapter rejects cwd and readable/writable roots outside the workspace,
Windows shell syntax, `danger-full-access`, per-command CPU/memory/process
limits, and `blockChildProcesses`. It does not silently weaken those fields.

Current Dim protocol v1 limitations are returned as diagnostics:

- It has no Session ID, so the adapter derives a request-scoped Guest Session.
- Host environment values are not forwarded. The Guest keeps zapVM's fixed
  safe environment and credentials remain outside argv/env.
- The existing Dim native-runner bridge requests buffered output. A completed
  result is compatible, but true live streaming needs a later Dim contract
  change.

The adapter rejects `stdio.mode=stream` instead of claiming streaming support.
For buffered requests, `zapvm daemon exec` writes a private structured terminal
result so the adapter preserves the original Guest program exit code rather
than reporting the Host CLI process status.

These limitations mean the first adapter protects Host execution from builtin
Dim `exec`; it does not move Dim file tools, plugins, MCP servers, or the Agent
loop into the Guest.

## Add another Agent protocol

1. Add `internal/agentadapter/<agent>`.
2. Implement `agentadapter.Protocol`: unique `Match`, strict `Decode`, and
   `EncodeResult`.
3. Translate all authority into `agentadapter.Request`; reject any field that
   cannot be represented safely.
4. Register the codec in `cmd/zapvm-agent-adapter/main.go`.
5. Add codec contract tests, ambiguous-match tests, argv-boundary tests, and an
   end-to-end normalized execution test.
6. Document whether the integration isolates only command tools or the whole
   Agent runtime.

Do not add vendor switches to `CLIExecutor`, expose the daemon socket to the
external Agent, parse commands with a Host shell, forward secret environment
values, or retry rejected requests on the Host.

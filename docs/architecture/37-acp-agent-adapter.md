# ACP Agent adapter

Zap exposes Agent Client Protocol v1 over stdio using the official TypeScript SDK.
This is an Agent-side endpoint, independent of the Go ACP client in `zapvm/`.

## Launch

Configure a provider and model in Zap first, then launch:

```sh
zap acp
# Source checkout
bun src/index.tsx acp
```

An editor's custom-agent configuration should use `command: "zap"` and
`args: ["acp"]`. Protocol JSON-RPC is the only output on stdout; diagnostics
go to stderr. The endpoint does not open the TUI. `ZAPCODE_DATA_DIR` isolates
configuration and persisted sessions for tests or separate profiles.

## Implemented methods and capabilities

| Surface | Implementation |
| --- | --- |
| Lifecycle | initialize; authenticate validates the configured local provider |
| Sessions | new, load with history replay, resume without replay, list with cwd filtering/pagination, close |
| Turns | prompt; streamed text/thoughts and tool calls/results; cancel |
| Configuration | default, plan, acceptEdits modes; configured provider/model selection between turns |
| Permissions | session/request_permission with allow-once and reject-once |
| Prompt content | text, embedded text resources, resource links, PNG/JPEG/WebP/GIF images |
| MCP | client-supplied stdio, HTTP, SSE servers, initialized on the next prompt |

Capabilities are negotiated explicitly. Audio and embedded binary resources are
unsupported. Additional directories, session fork/delete, provider OAuth login,
and draft protocol features are not implemented. The authentication method
does not accept credentials over ACP: configure credentials locally in Zap.

If a client advertises `fs.readTextFile`, file resource links inside the session
workspace are read through that callback to capture unsaved editor contents.
Symlinks resolving outside the workspace are rejected. Native file writes and
commands still use the existing local tools, broker, checkpoints, and OS sandbox;
the adapter does not route these through client terminal or file-write callbacks.

## Runtime and persistence

Each prompt uses an isolated worker process in the session's canonical cwd and
reuses the production headless AgentRuntime. This prevents cwd-scoped singleton
state from leaking between sessions. Different sessions can run concurrently;
only one prompt per session is allowed. Mode changes are delivered to a running
worker, including a recheck after an outstanding permission request.
Persistent memory writes, cron/monitor management, task termination, external
requests, and delegated execution are also hard-denied in Plan mode before any
saved rule or client approval is considered.
Plan mode also denies external MCP tools, whose side effects cannot be reliably
inferred from a tool name or untrusted server annotation.

Stable ACP IDs map to the latest native JSONL session ID. Restoring a native
session creates a new journal, without changing the ACP identity. ACP manifests
are stored under `<data-dir>/acp/sessions/` with restricted file permissions and
contain model binding, mode, cwd, history, and journal identity. Images are stored
under the corresponding session directory. User/tool history can contain sensitive
content; treat the entire data directory as private.

Provider API keys and MCP credentials are not included in ACP manifests. MCP
configuration stays in memory and must be supplied again on load/resume. Worker
startup configuration is sent through stdin, not command-line arguments. Session
close unloads it but does not delete persisted history.

### Authenticated external delegation

Headless workers await installed-CLI discovery before creating the registry.
External delegate events are bound to that worker's formatter/ACP transport,
independently of the TUI's event bridge.

Claude delegation keeps per-workspace CLI state under
`<data-dir>/delegates/claude/<canonical-cwd-hash>/` (0700), so sessions survive
between `delegate_agent` calls. `CLAUDE_CONFIG_DIR` points there;
`CLAUDE_CODE_TMPDIR` points to the sandbox's private per-command directory.
Host Claude settings and credentials are not copied into this store or granted
write access. The default host credential namespace remains selected through
`CLAUDE_SECURESTORAGE_CONFIG_DIR`; API-key/OAuth-token environment variables are
preserved only by the trusted delegate adapter.

Codex uses a separate per-workspace `delegates/codex/<canonical-cwd-hash>/`
directory as `CODEX_HOME`. Its `auth.json` and `config.toml` initially link to
the read-only host files; sessions, SQLite databases and caches stay private.
State roots, provider directories and workspace directories must be private,
user-owned real directories. A symlink cannot redirect a state write grant.

Only broker-authorized external delegation can extend its command-owned network
proxy with the provider's official service domains. Explicit network denials
still win, and ordinary shell commands do not inherit these domains. Custom
provider endpoints need the user's configured network allowlist.

Approved delegates can stage, commit and merge in their declared Git repository.
A standalone repository receives an explicit `.git` write grant; a validated
linked worktree receives its own Git directory and the common objects, refs and
logs directories, excluding common configuration and hooks. Ordinary shell and
file tools retain their existing control-plane protection, including `.zapcode`.
The sandbox sets `TMPPREFIX` inside private temporary storage as well as
`TMPDIR`, so zsh heredocs do not fall back to `/tmp`. Codex is launched with
`allow_login_shell=false` so login profiles cannot reset the broker PATH and
bypass the Apple toolchain shims.

On macOS, Security.framework requires read access to the host Keychains directory
and existing per-user MDS cache, plus locking access to its single `mds.lock`
file. Claude authentication and Codex's native TLS stack both need this access.
These paths are declared in the permission effects; Keychain files do not
receive write grants. Delegation still runs through the OS sandbox. This is an
authenticated external CLI with access to host login credentials, not an
untrusted plug-in isolation guarantee. Host credential refresh/login should be
performed in the host CLI if the read-only credential store prevents refresh.

The credential-free regression runs a fake delegate on the first cold ACP
prompt and checks nested tool updates. A platform sandbox test covers private
temp/state writes, resume, and denied unrelated/control-plane writes. Real
Claude/macOS acceptance is separate from these tests.

Cancellation aborts pending client callbacks and signals the worker. A bounded
fallback kills its process group on Unix if graceful shutdown stalls. Windows
currently uses child-process termination, not a job-object process-tree guarantee.

## Boundaries and verification

```sh
bun test tests/acp tests/headless/approval.test.ts
bunx tsc --noEmit
bun test
bun run build
```

Tests use the official ACP client SDK and a local mock model. The real stdio test
executes an approved file tool, restarts the Agent, resumes native conversation
history, and isolates sessions with different working directories. These tests
also verify an image-only turn retains image bytes in subsequent model requests,
including after an Agent restart; restoring a missing image emits a diagnostic
and an explicit unavailable-image placeholder.
These tests
do not establish real-provider image support, compatibility with every editor,
or Windows process-tree cleanup. Protocol conformance must not be inferred solely
from SDK type checking.

The official experimental ACP TCK can be run against the compiled binary with a
local mock backend (no paid requests):

```sh
uv --project /path/to/acp-tck run acp-tck \
  --auth-method configured-provider --cancel-prompt ACP_CANCEL_TEST \
  --report-json /tmp/zap-acp-tck-report.json -- \
  bun tests/acp/fixtures/mock-agent.ts /absolute/path/to/dist/zap
```

The fixture is test-only, not an alternative production runtime. TCK is incomplete
and experimental; a passing verdict is not an official ACP certification.

Existing zapVM packaging is unchanged; restarting Zap does not deploy this adapter
into a VM Runner or replace the VM's configured Agent command.

# Agent / execution environment boundary

## Responsibility split

The Agent/Harness owns task decomposition, model choice, retry strategy,
progress, budgets and completion criteria. An execution backend owns process
placement, workspace isolation, networking, leases and resource enforcement.
An execution failure is input to the Harness, not a backend-authored plan.

```text
CLI composition -> ExecutionEnvironment { broker, commandOptions, facts }
                              |
Agent -> ToolExecutor -> ExecutionBroker -> local / VM / cloud
  ^                           |
  +------ execution result ---+
```

`src/execution-environment.ts` is the application adapter for installed
runtimes (zapVM is opt-in, see [39](39-local-sandbox-default.md)). It is the only part of Agent composition that discovers zapVM,
interprets its image/profile, or configures trusted outer mounts and proxy
variables. A resident process reuses its existing boundary and does not
discover a nested VM. Invalid installed Host bindings still fail closed.

`buildAgentObjects` optionally accepts an `ExecutionEnvironment` as its last
argument, so embedders can supply another backend without any VM discovery:

```ts
const objects = buildAgentObjects(
  config, onApproval, todoStore, planCallbacks, checkpoint, skills,
  cwd, "required", {
    broker: myExecutionBroker,
    commandOptions: { restrictedNetwork: true, disableBackgroundTasks: true },
    facts: myEnvironmentFacts,
  },
)
```

## Data is not policy

`ExecutionEnvironmentFacts` carries descriptive fields: process platform,
shell, workspace mapping, root filesystem, temporary storage lifetime,
network scope, output directory, commands and package-manager availability. It has no prompt,
model-selection, retry, max-turns or completion-policy fields. The selected
backend's facts are captured at composition and passed through `AgentObjects`
to both TUI and headless prompt construction; prompt sections do not discover
runtimes independently. Custom prompts receive the same factual suffix.

No backend-specific prompt tells the Agent to stop, never retry, use a specific
recovery path or report a missing command as terminal. Shell errors retain
codes, exit status and output without VM-specific recovery instructions.
Package-manager availability is a fact, not an instruction to install.

Network destination declarations describe requested egress; they are not a
claim that every backend can enforce a separate per-command allowlist. A
cloud Computer may enforce a shared allowlist. The backend remains responsible
for grant validation and network enforcement.

## Tool routing

Trusted workspace process tools declare
`definition.executionLocation = "workspace"`. The transparent broker routes
that capability, not the tool's name. Renaming `bash` does not change placement.
Host integrations retain the Host boundary; model arguments cannot override
the trusted declaration. `vmToolNames` remains an explicit deprecated override
for SDK compatibility, not the default routing policy.

New process tools must declare the intended location and use
`ToolExecutionContext.process`. With a VM selected, undeclared process tools
fail with `EXECUTION_LOCATION_REQUIRED` rather than silently running on the
Host. Existing SDK integrations can use the explicit legacy routing override
while adopting location declarations. Moving host-integrated file/MCP/delegate tools
into a VM is not implied by this refactor. Installed runtime startup failure or
execution failure does not cause an automatic Host fallback or Agent retry.

## Capability limits remain real

Decoupling does not disable security or invent unavailable capabilities.
Detached commands remain unavailable on transports whose child process lease
cannot outlive the request. Timeouts, protected paths, signing, credentials,
network restrictions and resource limits are enforced by their existing
backends. The Harness decides what to do with a failure within user authority.

## Resident ACP runtime (zapVM repository)

The resident ACP runner forwards user text unchanged. It does not prepend
artifact/retry instructions or force the Agent into `full-access`. Artifact
directory and leased provider values travel in the Agent package environment.
The Agent/package owns using them. One-shot ACP permission callbacks and VM
security enforcement remain in place. The actual Agent package must be tested
for artifact delivery after removing the previous injected instructions.

## Validation gates

- Byte-for-byte prompt preservation through the resident runner and ACP wire.
- No Agent configuration rewrite on either new or resumed sessions.
- Renamed workspace tools still route to the selected backend.
- Backend failure returns once, with no local fallback or retry.
- Invalid Host configuration fails closed; residents do not nest runtimes.
- Captured runtime facts, not fresh discovery, drive prompts.
- Existing file, network, process and signed-package guards remain green.
- Real signed-Agent / Guest / cloud artifact and continuation E2E is a separate
  deployment gate; unit tests are not evidence of deployment acceptance.

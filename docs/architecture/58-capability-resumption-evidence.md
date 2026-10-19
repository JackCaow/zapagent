# Capability execution, dependency resumption, and completion evidence

## Problem

An approved read outside the project could still fail in the file handler because
the handler used startup roots instead of the per-call capability. Background
completion could launch another model turn even after `task_status` had delivered
the same result. Plans could record a failed dependency as completed, and a zero
pipeline exit could be mistaken for a valid artifact.

These are separate contracts. File paths, command names, model names, and HTTP
error strings must not decide whether these contracts hold.

## 1. Authorization reaches execution

The host policy remains the decision maker. Deny rules, plan mode, sandbox escape
approval, and isolated workspace policy still run before execution. The broker
passes its call-bound grant to the handler. App filesystem readers and mutations
opt into `useExecutionGrants`; they check the current canonical target, operation,
call identity, and expiry against that grant. A read grant cannot authorize a
write. Protected control directories remain protected. Canonical grant roots are
not re-resolved after approval, so retargeting a symlink does not expand a grant.

SDK consumers retain static `allowedPaths` semantics by default. Opting into
execution grants fails closed when a handler is invoked without a grant. Missing
file candidate discovery may suggest a path inside the default project roots,
but reading that candidate requires a new exact-path call and policy decision.
Browser screenshot retains its existing host-browser boundary; this change does
not grant arbitrary browser access or change the VM protocol.

Skill lookup refreshes host discovery once on a missing name, including when the
startup catalog was empty. A loaded skill includes its exact source file, so
relative resources can be resolved without guessing the directory from its name.
Loading instructions does not authorize their commands or extra file accesses.

Sandbox command failures expose the existing approval route based on actual
sandbox execution and host configuration, not a whitelist of error strings.
An HTTP error alone is not classified as a sandbox denial, and commands are never
automatically retried outside the sandbox. The model must identify the required
resource and request the normal approval.

## 2. Explicit dependency state and event delivery

`task_status` already provides cancellable, bounded event-driven waits. A timeout
does not stop the process. Returning terminal metadata records an observation
receipt in its TaskStore. The notification bridge attaches task/store identity,
session ownership, an obsolescence check, and an acceptance callback. The inbox:

- coalesces duplicate pending event IDs;
- removes already-observed results before dispatch;
- retains events for another session or an unresolved dependency;
- does not drain when the provider is unavailable;
- restores events if dispatch fails before input acceptance, holding retries
  until subsequent successful human input rather than starting a retry loop;
- marks notification delivery only at the agent's input-accepted boundary.

Human steering precedes automatic notification turns. Events arriving during a
notification turn are drained at its next boundary. Sub-agent-owned completions
are not injected into the main agent's inbox. Task tools cannot inspect or stop
a task explicitly owned by a different session. Legacy unowned tasks remain
visible for compatibility.

Todos may declare `blocked: { reason, waitingFor, taskIds? }`. When every unfinished
item is blocked, only a matching task dependency may cause an automatic wake-up.
Waiting on the user or a capability suppresses unrelated background wake-ups.
Human input always remains available. An approval already pending inside a tool
continues that same invocation when answered; this is separate from a blocked
todo. The harness never infers waiting state from assistant prose.

Readiness also follows observed state transitions: an inconclusive first VM
daemon probe does not suppress a later degraded observation. Startup can recycle
that daemon once within the existing readiness attempt instead of waiting until
timeout. The initial readiness deadline is not reset by this recovery. This is a
Host execution change; the independent Go VM policy and protocol are unchanged.

Receipts and tasks are process-local. This is not a durable exactly-once queue
across crashes. A post-acceptance provider failure follows normal conversation
recovery; it does not automatically replay a side effect. A model must explicitly
report blocked state for dependency filtering to apply.

## 3. Process facts and task acceptance are distinct

Background metadata and notifications carry `verification: unverified` regardless
of exit code. Unknown exit status stays unknown. The terminal labels notifications
as process exit and unverified result. Shell pipeline semantics remain intact:
the harness does not claim it can infer every upstream failure from exit zero.

Completion of an item with `acceptanceCriteria` requires `completionEvidence`.
Omitting an existing criterion retains it; changing it in the same update that
marks it complete is rejected. Blocked items require a reason, and task waits
require task IDs. Evidence and criteria remain in the tool transcript when an
all-completed list clears. Current plan attachments include criteria, blockers,
and reported evidence for both supported reminder styles.

Evidence is explicitly **agent-reported**, not an independent verifier verdict.
This contract prevents accidental omission and same-update criterion replacement;
it cannot prove natural-language evidence true or prevent a model from inventing
a weaker initial plan. The existing turn-end review still compares observations
against the original request. Functional claims require an appropriate artifact
or behavior check; failed attempts remain blocked/incomplete.

## Validation

Regression fixtures cover approved external reads/writes through the real
executor, denied/expired/wrong-call grants, SDK roots, protected paths, read/write
separation, symlink retargeting, missing skill refresh, task wait/notification
receipts, session isolation, explicit dependency filtering, human-first dispatch,
provider unavailability, pre-acceptance failure, events during a turn, unknown
exit status, a failing producer behind a successful pipeline, and todo evidence.
Execution fixtures also cover a daemon becoming reachable but degraded after an
initially inconclusive probe.

Run `bun test` with isolated `ZAPCODE_DATA_DIR`, `bunx tsc --noEmit`, and
`bun run build`. These checks validate deterministic host behavior; they do not
establish live-provider TTS success, GPU access, or model weights availability.

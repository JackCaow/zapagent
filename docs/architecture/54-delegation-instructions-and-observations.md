# Delegation instructions and observations

## Problem and boundary

A root prompt could contain explicit host instructions while an SDK child saw
only its role and task. A custom child `system_prompt` replaced that role, and
there was no separate channel for shared host instructions. At the same time,
headless `stream-json` suppressed all events with a child path. Full runtime
traces retained those events, but consumers of the stream alone missed them.

These are generic delegation and observability defects. Neither repair adds
benchmark task names, reference solutions, hidden checks, or algorithm advice to
production prompts.

## Instruction ownership

`SubagentConfig.inheritedInstructions` is host-owned text, forwarded through
subagent assembly and the runtime coordinator into every internal descendant.
SDK hosts select this text explicitly. The CLI selects its prepend, configured
custom system prompt, and append, in that order. The TUI selects the active
per-turn custom prompt, falling back to the configured custom prompt, matching
the root's custom-prompt selection.

Child `system_prompt` changes only the role. Shared host instructions are
appended in a separate labeled section after that role. A model-supplied
`inheritedInstructions` tool argument has no authority and is ignored. Nested
construction forwards the original host text rather than copying the parent's
assembled prompt, avoiding recursive duplication. Empty host text preserves
the prior role prompt.

This channel does not automatically copy the root conversation, generated plan
discipline, project files, memory, or the complete root system prompt. Existing
child role guidance, permission checks, workspace boundaries and budgets remain
owned by their existing components. External CLI delegates are outside this SDK
child channel and require their own host integration.

Prompt inheritance makes instructions available to the model; it does not
prove compliance or enforce network isolation. Permissions and process/network
controls must remain independent of prompt text.

## Delegation capability contract

The parent must be able to distinguish inspection from executable diagnostics.
`explore` and `plan` cannot compile, run tests or execute custom programs.
Their `bash` tool is exposed only when the source registry contains it and the
execution broker reports an available OS sandbox; it remains restricted to the
existing inspection allowlist. The `agent` description reports that availability
when read, so it follows changes to the registry or broker status. This is tool
availability, not a promise that a particular command will receive permission.

The default delegation guidance assigns builds, tests and diagnostic scripts to
`general` when its runtime supports them, or to the parent's own tools. The
existing isolation requirements can still block a general agent. No role gains
permissions from this guidance.

At child construction, a separate capability section reflects the final filtered
registry for both read-only roles, including custom `system_prompt` overrides.
The default explore prompt no longer recommends a shell unconditionally. A
child that cannot obtain an observation should report the missing capability to
its parent. The runtime does not inspect task wording to force a role, expand an
allowlist, retry a delegation or require extra reflection rounds.

## Interrupted delegation observations

Each tool execution owns a transient buffer of completed child tool observations.
The child records settled tool results, including failed-tool diagnostics, without
depending on a UI event listener. Thinking, prose drafts, pending arguments and
descendant events are excluded; a nested delegation contributes its own settled
result once it returns to the immediate child.

The coordinator receives this binding separately from its serializable spawn
input. It is specific to one run, installed before scheduling, cleared on
settlement, and never restored from persisted state or reused during resume.
The executor closes the buffer when the invocation returns; late callbacks are
ignored even if a handler does not cooperate with cancellation.

Retention is capped at 32,000 UTF-8 bytes, including its partial-result label,
and can only shrink to the broker's effective output limit. Recent observations
are retained and omission is labeled. Very small limits can retain no text.
These are unverified tool observations, not a child summary or proof of completion.

On a structured deadline or cancellation failure with empty output, the executor
attaches that buffer while preserving the original failure code, success=false,
and execution receipt. Existing outputs and normal completions are unchanged.
No model summary request, grace period, automatic retry, operation replay,
permission change or artifact finalization is introduced. A cancelled parent
remains cancelled; preserving evidence does not resume its model loop.

The coordinator settles returned `success=false` results as `failed`. A pending
or delivered cancellation takes precedence over a late returned success, retains
the diagnostic text, and settles as `cancelled`. Neither case advertises an
artifact for merge or unblocks dependent work. Cancellation remains authoritative
while its state write is pending, before the executor receives its abort signal.
Successful artifact runs continue through `ready_to_merge` and become successful
dependencies only after merge completion.

Regression tests cover direct/coordinated completion, timeout and cancellation,
concurrent children with repeated local call IDs, failed diagnostics, UTF-8/output
limits, a broker deadline shorter than the tool deadline, late callbacks and
uncooperative handlers. Compiled CLI and Bench acceptance remain separate gates.

## Stream contract

In `stream-json`, child tool calls and results emit `subagent_tool_use` and
`subagent_tool_result`. Each carries the full runtime `path` plus the existing
tool event fields. Consumers pair calls by `(path, id)`, since IDs can repeat
across branches. Root event types and final root tool accounting are unchanged.
Child prose, thinking, and context events remain suppressed. Text and aggregate
JSON output keep their existing presentation behavior.

Result previews retain the existing bounded preview behavior. Therefore this
stream supports screening and locating evidence, not a complete source audit.
The Terminal-Bench adapter screens both root and scoped child events and records
the path of a detected source exposure. A positive detection excludes independent
accuracy attribution; an absence of detections still requires full trajectory
review. Official rewards, execution failures, verifier execution and independent
evaluation eligibility must remain separate facts.

## Regression and delivery evidence

- SDK tests exercise both prompt profiles, nested descendants, custom roles,
  forged tool arguments and absence of root workflow copying.
- Read-only capability tests inspect actual provider tools and system messages
  for both roles, with/without a registered shell and available OS sandbox, and
  with default/custom roles. These fixtures do not execute a shell or prove
  improved model delegation decisions.
- Real CLI tests use a local fake provider and a local file through the actual
  coordinator. They inspect root/child provider requests, child tool results,
  scoped stream events and root accounting under both profiles and with/without
  configured custom prompts. `ZAP_TEST_COMPILED_BINARY` runs the same assertions
  against a compiled executable.
- The TUI fixture exercises real coordinated children with configured and
  per-turn custom prompts. This is runtime-adapter coverage, not interactive UI
  acceptance of every command that constructs a custom prompt.
- Formatter tests exercise interleaved branches with identical call IDs.
- Adapter tests exercise root and nested source exposure, preserving execution
  metadata while excluding contaminated runs from grading.

Passing these fixtures proves the repaired data paths, not an increased Bench
success rate. New Bench runs must bind the source revision, binary, adapter and
configuration hashes. The adapter audit revision changes with this repair and
must be disclosed in comparisons. Previously contaminated results remain
excluded; they cannot be relabeled as clean after the code changes.

## Delegated deadline feedback

A delegated loop previously inherited cancellation but could not see the outer
execution deadline. `deadlineAtMs` now carries the earliest known host deadline
through tool authorization, execution, the broker and transient coordinator
bindings. The executor includes its tool timeout; the broker can shorten that
bound to its own ceiling. The parent loop contributes its remaining execution
window, excluding its existing final-response reserve, on native streaming,
non-streaming and XML tool paths. Queuing and child setup consume the same
absolute deadline; nested delegation cannot restart the clock.

Children display the remaining milliseconds in transient context before model
requests. The deadline is not a model argument, persisted conversation entry or
resumable coordinator input. Unknown/non-finite bounds add no deadline feedback;
an elapsed bound displays zero. Resuming a coordinator run receives no stale
invocation deadline.

This field reports a boundary already owned by a timeout or cancellation signal.
It adds no timer, grace period, forced summary request, retry, role selection or
permission change. An SDK caller supplying this informational field must retain
its own enforcement signal. Parent cancellation can still stop execution before
the advertised latest deadline. Existing interruption semantics and bounded
completed observations remain unchanged. Runtime regression coverage establishes
propagation and lifecycle behavior; improved Bench outcomes require a separate
frozen candidate run.

## Reading persisted runtime output

Oversized tool output is stored outside the workspace. Previously its marker
instructed the model to use `read_file`, while headless policy rejected that
same path as outside cwd. This made information retained by the runtime
inaccessible to the agent, including read-only children.

Each LoopAgent now owns a reserved `read_tool_output` tool bound to its storage
session and project. The marker points to this tool. It offers Unicode character
pagination and literal text search, including within a long single line. Pages
have a default size of 2,000 characters and a maximum of 8,000; reads above 25 MB
fail explicitly. Responses include offsets and continuation metadata. Reading
an output uses the host runtime store capability, declared as an external read,
not a workspace filesystem grant. This also works for isolated workspaces and
VM-backed agents without exposing the host data tree to guest file tools.

The tool accepts only direct regular `.txt` files in its host-selected session
namespace. It rejects other sessions/projects, traversal spellings, symlinks,
hardlinks and redirected directories below the configured data root, and checks
file identity and modification metadata around a bounded descriptor read.
Resuming the same saved storage session can reopen its outputs. Merely receiving
another agent's path does not transfer access; child readers are rebound even
when the registry was inherited. The host data directory remains a trusted
runtime resource, not a sandbox against a hostile process with host filesystem
write access.

The CLI grants this scoped read after explicit policy rules; disallow, deny and
ask rules remain authoritative. Bare SDK embedders retain the normal confirmation
callback requirement. Generic file reads keep their existing permissions. Custom
policies may reject the `tool-output-store` external effect. The reader name is
reserved by LoopAgent and caller registries are cloned before registration.
The low-level persistence utility retains its legacy marker unless the caller
opts into the scoped reader; LoopAgent always opts in.

Synthetic regression coverage includes tail recovery, Unicode paging, literal
search, direct and coordinator children, session resume, inherited-reader
rebinding, isolation and permission denials. Bench improvement remains a separate
acceptance step against a frozen revision; this change contains no task-specific
paths, algorithms, answers, or verifier feedback.

## Reading background task logs

Background logs belong to the current in-process `TaskStore`. Their `outputFile`
metadata is not a workspace permission grant. Bash and shared-store monitor
guidance directs the model to `task_status` with `include_output=true` for a tail,
or `output_offset=0` for pages. A page requires a task ID owned by that store and
returns `outputPage` with byte offset, byte length, captured file size, content
and `next_offset`. It does not accept a filesystem path or reopen previous
sessions' tasks. Ordinary file access and task cancellation policies are unchanged.

Pages use `tail_bytes` as their byte limit (default 4096, maximum 16384), with up
to three lookahead bytes to finish a UTF-8 character. Following returned offsets
preserves valid UTF-8 text. An incomplete character at the end of a live log is
retained for a later read; its cursor can remain unchanged until output arrives.
Invalid UTF-8 is represented with replacement characters. Pages are immediate
unless `wait_ms` is specified; ordinary selected-task status retains its existing
default bounded wait. A page reaching EOF is only a capture snapshot, not proof
that the process has exited.

Tails and pages read bounded descriptor ranges instead of loading the whole log.
The descriptor must reference a regular file with the device/inode identity
recorded at spawn; substituted files and symlinks to foreign files are rejected.
The host data directory remains a trusted runtime resource. This is not OS
containment against a process with host write access. Unshared standalone monitor
hosts remain responsible for exposing their captured logs.

Tests cover early diagnostics outside the workspace, byte/Unicode pagination,
large sparse logs, live partial characters, ownership, replacement rejection and
unchanged ordinary path denial. These are access-path checks, not evidence of
improved model performance or new Windows/VM acceptance.

## Provider failure after child observations

A child can finish tool operations and then fail during its next model request.
The executor-owned observation buffer retains bounded completed tool output for
`EXECUTION_FAILED` as well as cancellation and deadline failures, when the final
failed result has no output of its own. The original failure code, error and
success=false remain authoritative. This is partial evidence, not a completed
child report; unfinished model drafts are excluded.

The same buffer crosses direct and coordinator execution and closes when that
invocation settles. Recovery adds no model request and replays no tool operation.
Existing nonempty handler diagnostics and successful outputs are preserved.
Synthetic regressions cover both successful and failed child observations before
a provider exception. Real-model improvement requires a separate frozen run.

## Inputs outside the parent workspace

An isolated general child receives the workspace snapshot, not every path the
parent can read. Parent-facing capability guidance states that external paths
are not shared and later parent edits may be absent. When required inputs live
outside that snapshot, the parent can inspect them using its own authorized
tools and include relevant observations in the briefing. Child guidance preserves
their provenance: parent-provided observations do not establish an independent
child read. This context also survives a custom child role prompt.

This is guidance for the existing briefing path, not an automatic file-transfer
mechanism. No outside path is copied, remapped or authorized merely because it
appears in a task description. Snapshot timing, exclusions and permission checks
are unchanged; legacy shared-workspace agents do not receive an isolation claim.
Direct and coordinator fixtures verify parent-authorized reads, denied child
reads, successful delivery of a parent observation and unchanged original bytes.
These checks establish the input boundary and available handoff, not improved
model planning or Bench accuracy.

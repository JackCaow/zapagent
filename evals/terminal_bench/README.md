# Terminal-Bench / Harbor adapter

This adapter runs the current Zap checkout through Harbor's official
Terminal-Bench 2.0 harness. Build the Linux executable for the Docker host
architecture before starting a job:

```bash
bun build --compile --target=bun-linux-x64-baseline src/index.tsx \
  --outfile /tmp/zap-terminal-bench

PYTHONPATH="$(pwd)" uvx --from harbor harbor run \
  --path /path/to/terminal-bench-task \
  --agent evals.terminal_bench.zap_agent:ZapAgent \
  --model deepseek-v4-flash \
  --agent-kwarg binary_path=/tmp/zap-terminal-bench \
  --agent-kwarg config_path="$HOME/.zapcode/config.json" \
  --agent-kwarg max_turns=80 \
  --agent-kwarg result_schema=outcome-v1 \
  --agent-kwarg outer_timeout_sec=900 \
  --agent-kwarg finalize_reserve_sec=60 \
  --n-concurrent 1
```

`--model` selects an exact model ID listed in the active provider's `models` in
`config_path`. It changes only the disposable container configuration, never the
owner's file. Unknown IDs and models belonging only to another provider fail setup;
the adapter does not silently fall back or copy another provider's credentials.
To change providers, supply a configuration with that provider active. Omitting
`--model` preserves the active model from the configuration.

`max_turns=80` is the baseline for a full Terminal-Bench run. A lower value
such as 40 is useful only for a targeted smoke test: it can establish that the
adapter, verifier, and container lifecycle work, but must not be used to judge
completion on hard multi-stage build tasks. The adapter uses the ordinary
Agent execution path; the official task verifier determines correctness.

The adapter explicitly permits ordinary owned background commands
(`ZAPCODE_DISABLE_BACKGROUND_TASKS=0`), with the same task-status tools, deadlines
and cleanup as local execution. Earlier App composition passed an explicit
`false` option that overrode the adapter's old `=1` setting, so those runs also
exposed background execution. The adapter now states that effective policy
directly; frozen historical runs retain their original adapter and binary.
Outside the adapter, `ZAPCODE_DISABLE_BACKGROUND_TASKS=1` disables background
command fields in ordinary local CLI/TUI runs. Backends that cannot retain
detached children continue to disable them regardless of that environment flag.

## Independent evaluation

For progress updates, use a Host-owned original plan and status snapshot:

```bash
python3 -m evals.terminal_bench.cohort_report \
  --plan /path/to/cohort-plan.json --status /path/to/cohort-status.json
```

The reporter recomputes counts from every original's hash-bound result and review,
ignoring cached summary counts and pass flags. It separates official zeros,
ungraded outcomes, raw passes awaiting review, reference-exposed ineligible passes,
and independently reviewed passes. Human skips stay in the original denominator;
missing, duplicate or reordered originals fail reporting. Changed or inconsistent
evidence is counted separately and produces exit 2. `snapshotAt` is the input
observation time; `generatedAt` does not refresh that observation. Never infer a
live image pull or running model from this report. Check its actual process handle
separately. The reporter binds existing Host audits; it does not replace source or
verifier review, run code, retry tasks, or assert a final aggregate score.

Every task receives the same short independent-solution instruction through
`--system-prompt-append`. It prohibits benchmark reference solutions, hidden
tests, answer keys and task-specific solution traces, while permitting ordinary
technical documentation and dependencies. It adds no task hints, planning
sequence or completion requirements.

After execution, the adapter screens network-tool inputs, shell inputs and
network result previews for known Terminal-Bench source URLs or explicit
benchmark searches. URL inputs include `http_fetch`, `http_request` and remote
`browser_screenshot` targets; local browser files are not network accesses.
A match records `evaluationIntegrity` metadata and fails
the adapter before grading. Preserve that trial as an integrity exception;
do not turn it into an official zero or silently retry it. Execution metrics
remain in the metadata. Source URLs in this metadata omit credentials, queries
and fragments.

For new binaries, the Host can opt into pre-model result scope with
`--agent-kwarg result_source_policy_path=/absolute/path/to/independent-source-policy.json`.
Use the generic example in this directory or an explicitly reviewed Host policy.
Setup checks binary support and uploads an immutable policy snapshot; unsupported
binaries fail before a model call. Results from configured root/child tools must
carry the selected file's digest or grading stops. Matching result bodies are
withheld before model/history projection; interception alone does not establish
reference consumption. This option is off unless explicitly selected and does
not change frozen cohorts. It is result-channel scope, not network isolation;
unbranded mirrors, images and other channels still require full review.

Current headless streams attach `sourceUrls` to known network-tool results,
including descendants. They enumerate sanitized literal HTTP(S) URLs from the full output,
independently of its short preview, and bind that output with SHA-256. Credentials,
query strings and fragments are removed; at most 32 URLs of 2048 characters are
retained. Omitted/malformed evidence requires review and blocks grading in this
adapter. Older streams without this field retain their preview-only coverage.
This audit is after model execution; it does not prevent reference exposure.

The screen is deliberately conservative and **is not network isolation**.
It can require review of harmless mentions and does not cover obfuscated
commands, request bodies, image contents, redirects, unbranded mirrors or
complete search results. Only URL/query/command inputs, result previews and supplied source URL evidence
are screened. A negative
screen is `not_detected_review_required`, never a clean attestation. Review the
full retained trajectory before claiming independent benchmark success; do not
feed reference material found during that audit back into subsequent runs.

Earlier unrestricted cohorts need separate integrity review even when all
runtime checks passed. In the frozen `08c2e779` Pro cohort, a model retrieved a
reference solution; its original score is retained but it is ineligible for
an independent capability claim. The Flash cohort accessed a benchmark task
page and needs review. New results use a changed evaluation instruction and
must be reported separately from those unrestricted cohorts.

`result_schema=outcome-v1` is the default. A valid `finished` or `limited`
outcome with exit 0 continues to the verifier, including `unverified` output.
Blocked, cancelled, failed, malformed, duplicate, or exit-conflicting results
fail the adapter. Metadata records execution, acceptance and the process exit
alongside usage. No final result is treated as verified task success.

For an older binary explicitly set `result_schema=legacy`. Setup reads its
`--help-headless` output before execution: old binaries without the selector
receive no new flag; current binaries receive `--result-schema legacy`. This
probe does not start the model. Legacy natural and
budget stops with exit 0 remain gradeable; `incomplete` with matching completion
status and exit 1 also continues to the verifier. The adapter never retries the
model under a different schema after an error.

`outer_timeout_sec` must match the Harbor task's agent wall-clock timeout.
The adapter passes Zap a shorter `--timeout-ms` after subtracting
`finalize_reserve_sec` (900 → 840 seconds by default). Zap exposes the
remaining self-managed budget to the model at each step and reserves its final
window for a tool-less result. The outer reserve also leaves time for terminal
persistence and Host cleanup; it does not guarantee those operations complete
before Harbor's deadline.

Controllers can opt into `artifact_capture.capture` for supplemental file-tool
evidence while the original container still exists. It retains full agent paths,
tool-call IDs and call/result positions. Child workspace bindings must come from
the execution host; an unknown child scope is recorded as `workspace_unproven`,
including absolute paths, rather than resolved against the parent. Ambiguous IDs,
failed/unsettled calls and escaped paths do not become captures. The observer
checks real paths, size and before/after hashes, with bounded reads, and stores
only audit data. It never executes captured files or sends them to the Agent.

These are final-filesystem observations, not earlier versions of every write or
an atomic snapshot. Missing child bindings, removed workspaces, shell-created
files and capture limits still require separate review. The adapter does not
enable this helper automatically. Freeze the selected observer with the host
controller, preserve earlier capture reports, and keep coverage gaps explicit.

`agent/zap-stream.jsonl` includes `provider_request` observations and
`runtime_lifecycle` timestamps for checkpoint, sealing, runtime return, and Host
cleanup. Use these to distinguish model latency from terminal persistence or
cleanup delays. A missing final result is a protocol/execution failure even if
Harbor subsequently runs the verifier; keep that separate from verifier reward.

An official binary reward does not prove that the verifier reached its tests.
A verifier setup script can write reward 0 after a dependency download fails,
while Harbor reports no execution exception. Preserve that raw score, and review
the retained verifier log separately before attributing it to the Agent/model.
Record setup failures, executed test outcomes, and missing/inconclusive evidence
as separate states. Bind that review to the trial, result hash, and verifier-log
hash; source-integrity review is an independent requirement. Unknown or stale
reviews are not eligible for accuracy comparisons. A timeout inside an executed
test of the submitted program remains an observed test failure, unlike a setup
download timeout. Do not replace the official score with a locally inferred pass,
rerun only favorable trials, or merge successes across cohorts.

### Admission between jobs

Controllers can start `docker_disk_probe.DockerDiskProbe` before a large pull,
using the already cached probe image's inspected ID, a local log and a durable
observation callback. Pass its `snapshot` method to `guarded_pull` inside the
probe's context manager. It runs one read-only, network-disabled sampler with
no capabilities; repeated snapshots read its existing stream and issue no Docker
RPCs. This avoids making each safety sample depend on starting another container
while the daemon is busy unpacking an image. Missing, malformed, old or reordered
samples reject the pull. Wall-clock freshness and monotonic receipt age both
apply, so buffered old output cannot renew an observation. Stop/cleanup binds
the actual container ID, random name and label; unconfirmed cleanup is an error.
If admission already failed, its original exception remains primary and cleanup
uncertainty is retained separately, with an exception note on Python 3.11+.
Successful admission still requires confirmed probe cleanup.
The sampler has a bounded lifetime if its controller disappears. Keep existing
disk floors, pull deadlines and independent post-pull admission unchanged.

Controllers that pre-pull Docker images can use `image_pull_guard.guarded_pull`
with a bounded live `snapshot` callback returning `hostFreeBytes` and
`dockerFreeBytes`, a durable local `record` callback, and an open log file.
Set `reserve_bytes` to the declared task storage plus host/evidence headroom;
keep the compressed-image pre-pull floor as an additional necessary check.
The helper checks both filesystems before, during and after pulling the original
amd64 reference. A low, missing or invalid observation, persistence failure,
deadline or client error rejects the pull. It terminates and waits for only its
own client, escalating to kill on timeout, without retrying or pruning.

This is sampled protection, not proof that unpacked layers will fit. A burst
between samples or a stalled probe can consume headroom. Cancellation of the
client also does not prove daemon extraction has stopped; a rejected pull
requires inspection before any new pull. Preserve its infrastructure record,
leave the original model task unstarted, and require a new capacity check.
Successful pulls still require a fresh check of task storage, memory and CPU
plus the frozen image digest before starting Harbor. The helper is opt-in and
does not intercept standalone Harbor or Docker commands.

Harbor can exit successfully while a trial reports an execution exception, for
example when a provider rejects a request for insufficient balance. A batch
controller must inspect the original trial results before starting the next job:

```bash
python3 -m evals.terminal_bench.cohort_gate /path/to/completed-job \
  --task expected-task-name --exit-code 0
```

Pass the actual exit code only after confirming the original process has exited;
an observation timeout is not a terminal exit. Repeat `--task` for every expected
original task in that job. Exit 2 stops admission on trial exceptions, incomplete
results, duplicate/missing originals, or missing verifier rewards. Official
reward 0 with a completed verifier phase allows the next job. The check preserves
all result files and does not certify that tests executed or source access was
independent; those still require evidence review.

This helper does not intercept standalone `harbor run` commands. Controllers
must call it and honor `continueAllowed` before launching subsequent jobs. Use
one original task per serial job when a failure must stop the very next task;
trials already scheduled inside a multi-task Harbor job are unaffected. Restore
provider availability before starting another cohort after a billing failure,
and retain the original failure separately from any later evaluation.

The adapter passes `--dangerously-disable-os-sandbox` because Harbor's
disposable Docker environment is already the OS isolation boundary and many
Terminal-Bench tasks must install packages inside it. Zap's permission policy
and workspace path checks still apply. Normal TUI/headless runs keep the
default `required` OS sandbox; the adapter neither makes the container
privileged nor mounts the Docker socket.

### Explicit prompt-profile comparison

The adapter accepts `--agent-kwarg prompt_profile=standard` or
`--agent-kwarg prompt_profile=concise` for binaries supporting the profile API.
Omission retains the existing default and does not inherit the owner's profile
or custom prompt. The selected value is written only to the disposable active
provider configuration. Unknown values fail before execution.

Freeze one binary and adapter for both cohorts, retain the original task set and
budgets, and verify the selected profile in actual runtime prompt diagnostics.
Profile and per-section purpose/length/hash diagnostics travel with persisted
usage, without storing additional prompt text. A smaller prefix alone is not an
accuracy improvement; complete source and verifier reviews remain required.

### Host-owned network treatment

`network_profile.py` prepares a new, explicitly declared network condition using
Harbor's native phase-scoped Docker egress control. The profile is selected by
the evaluation host and contains exact DNS destinations in `allowed_hosts`; it
contains no task names, solutions or verifier information. Include the actual
provider endpoint and intended documentation/dependency services. General search
engines and content relays can return arbitrary third-party sources, so allowing
them does not establish a source boundary.

Use the same Harbor Python environment as the adapter:

```sh
python -m evals.terminal_bench.network_profile prepare \
  --config /absolute/path/base-job.json \
  --profile /absolute/path/network-profile.json \
  --task task-name=/absolute/path/original/task-name \
  --destination /absolute/path/new-condition \
  --job-name new-condition
python -m evals.terminal_bench.network_profile verify /absolute/path/new-condition
harbor run --config /absolute/path/new-condition/job.json
```

Repeat `--task` for every original selected task. Preparation refuses an existing
destination, task selection changes, automatic retries, unreviewed custom
network/mount layouts, multi-service/multi-step tasks and existing restrictions
that would require explicit intersection. These cases need further integration;
do not silently omit them from a full-dataset report. The generated job uses
local copies and a capability overlay, so it does not modify the original task
cache. Only the agent network fields in `task.toml` change; instructions,
verifiers, environment files and all other files retain their exact hashes.
Original setup and verifier network policies remain unchanged.
The capability overlay applies to the container for its entire lifetime,
including setup and verification. Tasks requiring those capabilities need a
separately validated integration; preserving the network policy alone does not
prove compatibility with every task.

The overlay drops `NET_ADMIN` and `NET_RAW` and enables `no-new-privileges`.
Before the first model request, the adapter verifies Harbor's effective policy
and capability support plus the container's effective/bounding capability masks.
An absent or mismatched boundary fails before running the model. The profile
appears in external metadata and as a brief environment fact in the common
instruction, without adding an algorithm or a completion rule.

This is **destination control**, not semantic content filtering or complete
confidentiality isolation. Harbor's transparent proxy still permits resolver
DNS, ICMP and local traffic. An allowed host can serve unwanted content or act
as a relay; a hostile guest could attempt other channels. Test actual HTTP/TLS,
direct-IP, redirect, capability and phase-switch behavior on the execution host
before a cohort, retain the policy/image hashes, and review the complete source
trajectory afterwards. Failed startup, denied access and verifier failure are
separate outcomes. The existing conservative integrity screen remains enabled.

Freeze the prepared tasks, job, policy, capability overlay, adapter package
(including `network_profile.py`) and binary together. Re-run `verify` immediately
before launch. Changed task-config checksums and access rules constitute a new
experimental condition; they are not a model-only comparison and must never
replace or repair the outcomes of earlier cohorts.

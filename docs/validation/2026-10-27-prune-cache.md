# Phase 2: pressure-gated prune and cache diagnostics

Date: 2026-10-27. Follow-up: [Issue #14](https://github.com/JackCaow/zapagent/issues/14).
Based on the context-window / compact phase-one implementation in PR #13.

## Behavior

Before each provider request, after complete tool groups have committed, the
Loop may prune older bulky tool bodies and historical inline blocks. It uses
the phase-one protected-group policy, model-aware request counter, and atomic
snapshot/revision replacement. Current user intent, latest active tool groups,
short failure outputs, persisted-output references and execution status remain.
Historical images retain redacted references; omitted pixels are not evidence.
Mixed tool text blocks receive bounded, explicitly marked historical previews.

Prune runs only under context pressure. After pruning, the complete request is
counted again; automatic summarization runs only if its threshold is still
exceeded. Normal output-budget admission and bounded overflow recovery continue
to apply. No provider or user tool is called by the prune planner itself.

| `compaction.auto` | `compaction.prune` | Proactive behavior under pressure |
| --- | --- | --- |
| false | false | Neither prune nor semantic summary |
| false | true | Prune only |
| true | false | Semantic summary only |
| true | true | Prune, recount, then summary if still needed |

Manual `/compact` and bounded emergency recovery remain independent. The Host
uses the existing `compaction.prune` flag; SDK callers opt in with
`LoopAgentOptions.pruneEnabled` (default false for compatibility). Descendants
inherit both flags and the non-secret connection identity used for statistics.

A per-conversation gate avoids repeated soft-pressure rewrites until input grows
by 10% of the trigger threshold, with a 256-token minimum. A changed hard-overflow
request may retry maintenance. Persistent content markers survive message
serialization; rebuilding a Loop or pruning a restored preview does not shorten
it again. Full session journals retain their original evidence; the local wire
baseline does not claim to survive a process restart or reconstruct remote cache.

## Cache observations

Adapters capture digests of their final serialized Chat, Responses or Anthropic
requests. Connection/model/transport are scoped separately from schemas and
stable configuration. Token-bearing message prefixes are compared without
`cache_control` placement metadata; the existing exact request fingerprint still
covers the whole JSON body. Ordinary append, rewrite, scope change, shape change
and explicit maintenance causes are distinguished.

Only up to 256 message hashes are retained. Changes beyond that sample are
reported as unverified, not certified append. Each serialized request publishes
its digest list once, rather than on every streaming update. Prompt text,
credentials and image pixels are not retained in these diagnostics. Historical
JSON-byte reductions and complete request-token estimates are separate from
adapter-reported wire bytes and provider usage.

The existing Host cache/memory audit records prune counts and token reductions,
wire request/rewrite counts and the last prefix transition. `/status` shows prune
on/off, last prune and wire-prefix diagnostics. Missing provider cache usage
remains unavailable; local shape stability is not proof of remote cache hits.

## Verification

- Full suite: **4,700 passed, 18 skipped, 0 failures**, 407 files and 17,850 assertions.
- `bun run typecheck`, standalone build, and diff checks passed.
- Regressions include independent flags, children, pressure/recount, cancellation,
  concurrent append/clear, durable preview markers, CJK and multimodal text,
  complete short errors, output references, real adapter wire shapes, audit
  round-trip and missing cache accounting.
- Independent agent and real Claude Code CLI reviews passed. The mixed-text,
  error-tail, preview-idempotence and bounded streaming-telemetry fixes received
  incremental reviews and regression reruns.

```sh
bun run typecheck
bun test --timeout 20000
bun run build
bun scripts/bench-context-maintenance.ts
```

## Deterministic cache tradeoff benchmark

[Structured benchmark result](2026-10-27-prune-cache-benchmark.json).
The same local HTTP fixture and four real tool-handler executions are run with
prune off/on. The fixture supplies synthetic cache accounting; these numbers
are not measured upstream billing or production latency.

| Fixture metric | Prune off | Prune on |
| --- | ---: | ---: |
| Total input tokens | 73,233 | 47,183 |
| Fresh input tokens | 15,257 | 21,494 |
| Cache-read tokens | 57,976 | 25,689 |
| Explicit cache-write tokens | 0 | 0 |
| Main requests | 5 | 5 |
| Maintenance model requests / input / output | 0 / 0 / 0 | 0 / 0 / 0 |
| Tool executions | 4 | 4 |
| Completion checks | pass | pass |

Prune creates one expected prefix rewrite, followed by append-only requests.
It reduces total input but increases fresh input in this short cached workload
because of prefix rebuilding. Neither lower cost nor a fixed hit rate is
promised. Longer-run savings must be measured against the actual provider's
pricing, cache behavior and task quality.

## tmux acceptance after reviews

[Actual compiled CLI snapshot replay](2026-10-27-prune-cache.cast)
(asciinema v2; controlled snapshots, not a personal-session recording).
All runs used disposable data directories and a local mock HTTP service.

- Chat: all four auto/prune combinations passed with the expected prune and
  summary counts. If pruning suffices, no summary model call occurs.
- Responses: prune/recount and tools passed with the same protocol-neutral policy.
- Every headless case executed real `read_file` and `glob_files` exactly once,
  and returned their results to the provider with the current user constraint.
- TUI: restore a seeded tool history, prune under pressure, execute read/glob,
  inspect `/status`, manually compact, cancel a held second summary with double
  Esc, and receive a distinct new answer. The cancelled summary is absent and
  prior history remains in the subsequent request.
- Final acceptance exit code: 0, `PHASE2_TMUX_ACCEPTANCE_PASS`.

These fixtures establish local request and maintenance behavior. They do not
establish real upstream cache-hit rates or 1M-request capacity.

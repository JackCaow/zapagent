# Memory layer design

Zapcode 的记忆层由四条链路组成：

1. 长期 Markdown memory：跨 session 保存用户、反馈、项目、引用信息。
2. 每轮召回附件：按当前任务 query 选择 index 和 working pack，作为 transient context 注入。
3. 会话压缩记忆：把长对话压成结构化 summary，并把 durable sections 写回项目 memory。
4. Prompt/cache 诊断：把稳定说明和动态记忆分离，记录 hash、tokens、included/skipped 以解释 cache miss。

这四条链路共享存储和诊断，但职责不同。后续优化时要保持边界清晰。

## Topology

```text
                           ┌──────────────────────────────┐
                           │ src/hooks/useAgentRunner.ts  │
                           └──────────────┬───────────────┘
                                          │
                 ┌────────────────────────┼────────────────────────┐
                 │                        │                        │
                 ▼                        ▼                        ▼
      stable system prompt       per-turn context           conversation state
      memory instructions        memory attachments         Turn[] history
                 │                        │                        │
                 ▼                        ▼                        ▼
      cacheable prefix           transient user msg         auto/micro/reactive compact
                 │                        │                        │
                 └──────────────┬─────────┴──────────┬─────────────┘
                                ▼                    ▼
                       provider request       compact summary persistence
                                                     │
                                                     ▼
                                           project Markdown memory
```

The important split is stable instructions versus dynamic content:

- `AutoMemory.buildInstructions()` returns taxonomy and save rules only. This belongs in the cacheable system prompt prefix.
- `buildPerTurnAttachments()` returns current memory data. This belongs in `RunOptions.contextPrefix`, which LoopAgent appends as a transient user-role message.

Putting memory contents into the system prompt would make every memory edit change the prompt prefix and lower provider prompt-cache reuse.

## Storage scopes

Long-term memory is stored by `zapsdk/memory/md-store.ts`.

```text
~/.zapcode/
├── memory/
│   ├── MEMORY.md
│   └── *.md                 # global user / feedback memories
└── projects/<project-id>/
    └── memory/
        ├── MEMORY.md
        └── *.md             # project / reference memories
```

Scope rules:

| Type | Store | Purpose |
|---|---|---|
| `user` | global | User role, preferences, stable personal context |
| `feedback` | global | Corrections and working-style rules |
| `project` | project | Repo-specific facts, current work, decisions |
| `reference` | project | External issue trackers, dashboards, links |

The `memory_save` tool enforces this routing. Do not save project facts as global user/feedback memories just to improve recall.

## Write path

```text
model decides durable fact
  └─ memory_save
      ├─ validate name/type/body size
      ├─ route user/feedback to global store
      ├─ route project/reference to project store
      └─ MdMemoryStore.save()
          ├─ acquire .memory.lock
          ├─ atomic write <name>.md
          └─ rebuild MEMORY.md
```

Write invariants:

- Memory names are filenames, so they must stay path-safe.
- `MEMORY.md` is store-owned. Models should write through `memory_save`, not edit the index.
- Body size is capped. Large pasted text, transcripts, and tool output should be summarized with a pointer to the raw artifact.
- Same `name` means update in place, not create a duplicate.
- `source` is a model-authored, human-readable evidence note. Structured `provenance` is host-authored and records the
  `memory_save` / `memory_merge` / `compact_summary` origin, available session/tool-call/step identity, and an exact
  SHA-256 content hash. It is stored in canonical JSON frontmatter and is not accepted as a model tool argument.
- Optional canonical `lifecycle` metadata makes admission and fact evolution executable rather than advisory:
  `confidence` is `high`, `medium`, or `low`; `validFrom` / `expiresAt` define an absolute validity window; and
  `supersedes` names older same-scope, same-type records replaced by the new fact. Legacy records without lifecycle
  metadata remain high-confidence and active for backward compatibility.
- New `memory_save` and `memory_merge` targets default to medium confidence when the model omits the field; omission
  cannot silently create a high-confidence fact. Existing merge targets preserve their lifecycle unless explicitly
  changed. Explicit or verified evidence should declare high, while uncertain candidates declare low.
- Low-confidence records are durable review candidates, not working memory. They remain visible in `/mem` but are
  excluded from lexical attachments and semantic-retriever corpora. Medium-confidence records remain eligible with a
  quantized relevance discount; high-confidence and legacy records use full relevance.
- A valid, high-confidence effective successor removes its predecessors from automatic recall while retaining their files for audit.
  Future successors do not hide the current fact before `validFrom`; malformed metadata and supersession cycles fail
  closed. `memory_save` rejects missing, cross-type, self, and cyclic supersession transitions.
- Repeating an equivalent save preserves the previous provenance and timestamps, so retries do not churn memory files
  or transient-context hashes. A real update preserves the original creation event and records a new update event.
- `memory_save` rejects normalized logical-name collisions across global/project scopes and no-ops on equivalent normalized bodies. It never deletes or migrates the older record automatically.
- `/mem` marks stale, unknown-age, exact/near-duplicate-content, scope-conflict, scope-mismatch, and provenance-hash
  mismatch records for explicit user review; missing provenance on legacy/manual records remains valid. Deletion still
  requires confirmation. It shows mis-scoped legacy global project/reference records for maintenance, while per-turn
  global recall continues to filter them out.
- Near-duplicate review is deliberately conservative and language-independent: only same-type records with related logical-name tokens and non-exact bodies containing at least 24 normalized alphanumeric characters, 0.7 length ratio, and 0.8 Dice similarity over unique three-character shingles are paired. Short preferences, unrelated template instances, and merely topical records stay out; hosts may disable this check with `nearDuplicateThreshold: false`.
- `/mem` derives deterministic maintenance suggestions for exact duplicates, review-only near duplicates, safe scope moves, and same-type cross-scope conflicts. Suggestions validate target-name/file availability, never return bodies or mutate records, and keep execution behind `memory_merge` confirmation. Near-duplicate sources must all be read before supplying the complete merged target.
- `memory_merge` is an explicit confirm-only maintenance operation. It validates every scoped source and the complete target before writing, writes the target before deleting obsolete sources, and restores exact snapshots if a later mutation fails.

## Recall path

`src/agent/contextAttachments.ts` builds recall once per run.

```text
user task / memoryQueryText
  └─ normalizeMemoryQuery()
      ├─ remove generated file/MCP/runtime blocks
      ├─ fold long paste placeholders and huge tokens
      └─ for "继续", append recent meaningful user request
          │
          ▼
buildMdIndex() + buildMdPack()
  ├─ rank by lexical relevance
  ├─ optionally blend normalized semantic similarity
  ├─ enforce confidence / validity / supersession lifecycle
  ├─ boost context-eligible pinned records
  ├─ boost recent records by UTC day
  ├─ enforce token budget / max records / dedupe
  └─ optionally excerpt oversized records
          │
          ▼
contextPrefix segments
  ├─ global_memory_index
  ├─ global_memory_working_pack
  ├─ memory_index
  ├─ memory_working_pack
  └─ active_plan
```

The model receives the selected context as a transient user message at the tail of the provider request. It is not persisted into `ConversationManager`.

Recall invariants:

- Query construction must not include full pasted payloads or generated context blocks.
- Low-signal continuation turns must borrow recent meaningful user intent.
- No-hit fallback is reserved for low-signal continuation turns. A direct query with no relevant record receives no arbitrary memory attachment.
- Generated compact state/timeline pins are active only for continuation queries. Direct queries may still recall those records through ordinary lexical or semantic relevance.
- Because generated compact records aggregate many topics, direct queries must match at least two distinct lexical query terms before those records are eligible; this prevents one incidental word from selecting an entire task snapshot.
- Bilingual aliases expand query terms only; record fields remain canonical so the same concept cannot receive duplicate query-and-document alias credit.
- Diagnostics must expose selected and top-skipped records without logging memory bodies.
- Provenance stays available in the Markdown record for explicit audit but is not rendered into index/working-pack
  attachments or used as a ranking signal; host session identifiers therefore do not enter model context by default.
- Lifecycle metadata is also omitted from rendered attachments. Only its deterministic selection outcome and sanitized
  diagnostics are visible; inactive bodies are never submitted to optional semantic retrievers.
- Global memory recall must filter to `user` and `feedback` only.
- Semantic retrieval is optional and injected through `MemorySemanticRetriever`; retrievers omit low-confidence records, returned scores are bounded and quantized, each scope is scored once under a deadline, and one failure must fall back to lexical recall without failing the run.
- The default host wiring uses `LocalSparseMemoryRetriever`: an offline, in-memory, fingerprint-cached TF-IDF index with identifier, phrase, Latin trigram, and CJK n-gram features. It adds topical similarity without model downloads or network access, can be disabled with `ZAPCODE_DISABLE_LOCAL_MEMORY_SEMANTIC=1`, and can be replaced by a dense retriever through the same interface.
- A semantic retriever receives memory bodies. Remote implementations therefore require explicit host opt-in and must not be enabled implicitly.

## Compression path

Conversation memory is separate from long-term Markdown memory.

```text
ConversationManager Turn[]
  ├─ microcompact: shrink old tool_result / inline blocks
  ├─ autocompact: summarize middle turns with STRUCTURED_COMPACT_PROMPT
  └─ reactive compact: retry after provider context overflow
```

After a successful compact, durable sections are persisted by `persistCompactSummary()`:

| File | Behavior |
|---|---|
| `project_compact_state.md` | Latest compact snapshot, overwritten by fingerprint |
| `project_compact_timeline.md` | Bounded recent snapshots |

These records are project-scoped, tagged with `compact` / `summary` / `status` / `pinned`, and therefore remain recallable on "继续" turns.

Compression invariants:

- `Turn[]` is the source of truth; provider `Message[]` is a projection.
- A tool-use turn must remain atomic. Do not split assistant tool calls from their results during truncation or compact.
- Compact summaries must follow the required section contract. A vague summary is treated as failure.
- Recent file restoration happens after compact so the agent does not immediately re-read the same files.

## Prompt cache model

The memory layer is designed around prompt-cache stability:

```text
cacheable prefix:
  default prompt
  tool guidance
  skill index
  plan discipline
  AGENTS.md
  memory instructions

prompt-template dynamic suffix:
  date / cwd / model
  (LoopAgent relocates this out of the system message at send time)

transient tail message:
  runtime environment
  memory index
  memory working pack
  active todo plan
```

Diagnostics:

- `PromptCacheDiagnostics` records static prefix, dynamic suffix, tool schemas, boundary count, and hashes.
- `ContextDiagnostics` records transient context hash, token estimate, segment hashes, included/skipped memory records, recall query hash, and budgets.
- `ConversationCacheDiagnostics` splits provider-visible history into the reusable conversation prefix and fresh tail. Per-message hashes identify stable, append-only, contracted, or rewritten history without persisting message bodies.
- Persisted usage records carry a non-sensitive `cacheScope` (`providerId` + `model`) so `/status` never averages cache samples from different provider/model namespaces.
- `/status` combines provider usage with these diagnostics to explain low cache reuse. Legacy usage rows without a scope remain readable but are excluded once scoped samples exist for the active model.
- Each completed root run appends one sanitized record to the project-scoped `diagnostics/cache-memory-audit.jsonl`. The bounded 1 MiB log stores hashes, token counts, selected-record metadata, provider/model scope, compaction counters, per-provider-usage-sample cache-accounting coverage, within-run context/prefix shape counts, and bounded online memory-utility outcomes, but never prompt text, memory bodies, user input, candidate fingerprints, or local memory paths.
- `/status` reads the recent audit records for the active provider/model and reports cross-session cache reuse plus prompt/context shape counts. When the endpoint omits cache accounting, it compares only the cacheable static-prompt and tool-schema hashes: stable shapes point at endpoint support/telemetry, while multiple shapes keep app-side prefix churn visible. Dynamic memory context is not misclassified as cacheable-prefix churn.
- Online memory utility is host-observed and does not add a model tool, extra turn, or dynamic prompt bytes. Candidates are created from the exact per-turn working-pack selection and contain only in-memory content hashes and hashed phrase features. `selected` is not treated as `used`; a successful explicit `read_file` is deterministic use, while `content_overlap` requires unique evidence absent from the actual recall query and current user input. `avoidedReRead` requires overlap-attributed use without an explicit read. Successful selected-record content replacement via `memory_save` and selected-source consolidation via `memory_merge` mark revisions; an explicit high-confidence `supersedes` transition marks a contradiction. Excerpted records are ineligible for full-body overlap attribution because the model did not receive their full content.
- Content overlap is deliberately a conservative proxy, not proof of causal reasoning. `/status` reports selected/used/read/avoided/revised/contradicted aggregates separately so admission policy can be calibrated from observed outcomes without inflating selected records into successes.
- `src/agent/memoryUtilityEval.ts` provides an offline binary-classification harness for policy calibration. It reports precision, recall, specificity, false-positive rate, accuracy, classifier errors, and p50/p95 latency without retaining scenario payloads in the report. The golden corpus covers English and CJK evidence, current-input and recall-query echoes, shared features, sentence boundaries, excerpts, failed reads, subagent events, tool-result-only evidence, and the bounded maximum candidate set. The default one-line/two-phrase policy must pass with zero false positives; a permissive one-phrase policy is retained as a negative control and must fail the quality gate.

Cache invariants:

- Memory content and todo state must not move into the cacheable system prefix.
- Volatile runtime environment must not sit between the stable system prefix and tool/history bytes; `LoopAgent` moves it to transient tail context before provider serialization.
- Current user turn and transient context must not become Anthropic conversation cache breakpoints.
- Conversation-prefix fingerprints must ignore app-only cache hints and canonicalize provider-visible structured data so internal hint cleanup or object key ordering does not look like history churn.
- Tool schema diagnostics must hash the actual tools sent to the provider, including auto-registered `agent`.
- Cache trends must compare only samples from the active provider/model scope.
- Cache/memory audit persistence must remain best-effort, bounded, project-scoped, and free of raw prompt or memory content.
- Memory-utility attribution must use root assistant/tool events only, subtract actual recall-query and current-input features, ignore features shared by multiple selected records, and persist only sanitized aggregate evidence.
- Boundary marker copies from user/project text must be escaped before prompt assembly.

## Evolution checklist

When changing memory behavior, verify these gates:

1. Run memory selection tests: `bun test tests/memory zapsdk/tests/memory`.
   The golden corpus includes a quantified top-one gate for Hit@K, Recall@K,
   Precision@K, MRR@K, forbidden/duplicate selections, retrieval errors, and p95 latency.
2. Run context/cache diagnostics tests: `bun test tests/agent/contextAttachments.test.ts tests/commands/status.test.ts`.
   Include `tests/agent/memoryUtility.test.ts`, `tests/agent/memoryUtilityEval.test.ts`, `tests/agent/memoryUtility-golden.test.ts`, and `tests/agent/cacheMemoryAudit.test.ts` when utility evidence, thresholds, or persistence changes.
3. Run provider cache-shape tests when prompt boundaries or transient cache hints change: `bun test zapsdk/tests/provider/anthropic-tool-result-merge.test.ts zapsdk/tests/provider/openai-raw-passthrough.test.ts`.
4. Confirm `/status` can identify whether a low hit rate came from prompt shape, tool schemas, transient context churn, memory query/selection churn, high cache writes, or provider cache support.
5. For long-paste changes, verify display text, restore text, model text, and memory query text separately.

Preferred next evolutions:

- Evaluate an explicitly configured dense local/remote embedding adapter against recall goldens before replacing or augmenting the default sparse index.
- Evaluate near-duplicate thresholds against a larger real memory corpus before considering multi-record clustering; pairwise suggestions remain review-only until false-positive evidence is available.
- Collect reviewed real-run labels and evaluate them through the utility harness before using online utility to automate confidence promotion, demotion, or deletion. Synthetic calibration now guards the default threshold and its negative control, but it is not a substitute for production labels; until those exist the signals remain observability only.

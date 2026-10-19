import { z } from "zod";
import { join } from "node:path";
import type { Tool, ToolExecutionContext } from "../tools/types.js";
import type { MdMemoryRecord, MdMemoryStore } from "../memory/md-store.js";
import type {
  MdMemoryProvenanceInput,
  MdMemoryProvenanceOrigin,
  MdMemoryLifecycle,
  MdMemoryLifecycleInput,
  MdMemoryType,
} from "../memory/md-types.js";
import { normalizeMdMemoryLifecycle, resolveMdMemoryLifecycles } from "../memory/md-lifecycle.js";
import { countCodePoints } from "../utils/logical-lines.js";
import { redactTextSecrets } from "../utils/redact.js";
import {
  normalizeMemoryContent,
  normalizeMemoryIdentity,
  reviewMemoryRecords,
  type MemoryReviewRecord,
} from "../memory/review.js";

export interface MemorySaveToolOptions {
  store: MdMemoryStore;
  /** Optional cross-project personal store. When present, user/feedback
   *  memories route here while project/reference stay in the project store. */
  globalStore?: MdMemoryStore;
}

export type MemoryMergeToolOptions = MemorySaveToolOptions;
export type MemoryReviewToolOptions = MemorySaveToolOptions;

type MemoryScope = "global" | "project";

interface ScopedMemoryStore {
  scope: MemoryScope;
  store: MdMemoryStore;
}

interface ResolvedMemorySource extends ScopedMemoryStore {
  id: string;
  record: MdMemoryRecord;
}

const GLOBAL_MEMORY_TYPES = new Set(["user", "feedback"]);
const MAX_MEMORY_SAVE_CONTENT_CHARS = 24_000;
const DEFAULT_MEMORY_REVIEW_LIMIT = 50;
const MAX_MEMORY_REVIEW_LIMIT = 100;
const MEMORY_TIMESTAMP_SCHEMA = z.string().min(1).max(80).refine(
  (value) => Number.isFinite(Date.parse(value)),
  { message: "must be a valid ISO-8601 timestamp" },
);

/**
 * `memory_save` — persist a memory across sessions as a markdown file with
 * frontmatter. Future turns receive a query-ranked working pack as transient
 * context; stable memory instructions stay in the cacheable system prompt.
 *
 * Type taxonomy mirrors Claude Code's auto-memory:
 *   - user      — role, expertise, preferences about the user
 *   - feedback  — corrections/confirmations about how to work (use **Why:** + **How to apply:**)
 *   - project   — facts about the current project not derivable from code/git
 *   - reference — pointers to external systems (Linear, Slack, dashboards)
 *
 * Permission default is `confirm` so the user sees what's being saved on first
 * write. Allow via `/permissions allow memory_save` to skip prompts after vetting.
 */
export function memorySaveTool(options: MemorySaveToolOptions): Tool {
  const { store, globalStore } = options;

  return {
    definition: {
      name: "memory_save",
      description:
        "Create or update durable memory. `user` and `feedback` are global; `project` and `reference` stay in the current project. " +
        "Reuse names for updates. Duplicate bodies and cross-scope name conflicts require explicit review.",
      parameters: z.object({
        type: z.enum(["user", "feedback", "project", "reference"])
          .describe("user=role/preferences; feedback=working rules; project=current work; reference=external pointers"),
        name: z.string().regex(/^[a-zA-Z0-9_][a-zA-Z0-9_\-]*$/)
          .describe("Stable file identifier; reuse it to update an existing memory"),
        description: z.string().min(1).max(200)
          .describe("One-line relevance hook shown in the index"),
        tags: z.array(z.string().min(1)).max(12).optional()
          .describe("Optional relevance tags; `pinned` bypasses relevance filtering"),
        source: z.string().min(1).max(200).optional(),
        confidence: z.enum(["high", "medium", "low"]).optional(),
        validFrom: MEMORY_TIMESTAMP_SCHEMA.nullable().optional(),
        expiresAt: MEMORY_TIMESTAMP_SCHEMA.nullable().optional(),
        supersedes: z.array(z.string().max(200).regex(/^[a-zA-Z0-9_][a-zA-Z0-9_\-]*$/)).max(8).optional(),
        content: z.string().min(1).refine(
          (value) => countCodePoints(value) <= MAX_MEMORY_SAVE_CONTENT_CHARS,
          { message: `memory content must be ${MAX_MEMORY_SAVE_CONTENT_CHARS} Unicode characters or fewer` },
        )
          .describe("Concise durable Markdown; do not copy transcripts, long pasted text, or large tool output"),
      }),
      permission: "confirm",
    },
    handler: async (args, _signal, context) => {
      const a = args as {
        type: "user" | "feedback" | "project" | "reference";
        name: string;
        description: string;
        tags?: string[];
        source?: string;
        confidence?: "high" | "medium" | "low";
        validFrom?: string | null;
        expiresAt?: string | null;
        supersedes?: string[];
        content: string;
      };
      try {
        assertMemoryNameHasNoCredential(a.name);
        const contentChars = countCodePoints(a.content);
        if (contentChars > MAX_MEMORY_SAVE_CONTENT_CHARS) {
          return {
            success: false,
            output: "",
            error:
              `memory content is ${contentChars} chars, above the ${MAX_MEMORY_SAVE_CONTENT_CHARS} char limit. ` +
              "Save a concise durable summary instead of verbatim pasted/tool output, or save a reference pointer.",
          };
        }
        const safe = sanitizeMemoryWriteFields(a);
        const redactionNotice = memoryRedactionNotice(safe.redacted);
        const target = globalStore && GLOBAL_MEMORY_TYPES.has(a.type)
          ? { store: globalStore, scope: "global" }
          : { store, scope: "project" }
        const filename = `${a.name}.md`;
        const existing = target.store.get(filename);
        const other = target.scope === "global"
          ? { store, scope: "project" }
          : globalStore ? { store: globalStore, scope: "global" } : undefined;
        const stores = [
          { store: target.store, scope: target.scope },
          ...(other && other.store !== target.store ? [other] : []),
        ];
        const nameConflict = findMemoryNameConflict(a.name, stores, {
          scope: target.scope,
          filename,
        });
        if (nameConflict) {
          return {
            success: false,
            output: "",
            error:
              `memory name conflict: logical name ${a.name} already exists as ${nameConflict.filename} ` +
              `in ${nameConflict.scope} memory. No record was changed. Run memory_review or inspect /mem, then explicitly delete ` +
              "or rename the obsolete record, or re-use its exact name to update it.",
          };
        }
        const duplicate = findDuplicateMemoryBody(safe.content, stores, { scope: target.scope, filename });
        if (duplicate) {
          return {
            success: true,
            output:
              `not saved: equivalent memory already exists as ${duplicate.filename} ` +
              `(${duplicate.scope}); no duplicate was written${redactionNotice}`,
          };
        }
        const requestedLifecycle = memoryLifecycleInput(a);
        const lifecycleUpdate = memoryLifecycleAdmissionUpdate(requestedLifecycle, existing);
        const lifecycle = lifecycleUpdate === undefined
          ? existing?.frontmatter.lifecycle
          : normalizeMdMemoryLifecycle(lifecycleUpdate, existing?.frontmatter.lifecycle);
        assertMemoryLifecycleTransition(target.store, a.name, a.type, lifecycle);
        const existed = existing !== undefined;
        const rec = target.store.save({
          type: a.type,
          name: a.name,
          description: safe.description,
          tags: safe.tags,
          source: safe.source,
          ...(lifecycleUpdate !== undefined ? { lifecycle: lifecycle ?? null } : {}),
          provenance: memoryToolProvenance("memory_save", context),
          body: safe.content,
        });
        return {
          success: true,
          output: `${existed ? "updated" : "saved"} ${rec.filename} (${target.scope})${redactionNotice}`,
        };
      } catch (err) {
        return { success: false, output: "", error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

/** Read-only, paginated inventory and deterministic maintenance suggestions. */
export function memoryReviewTool(options: MemoryReviewToolOptions): Tool {
  const { store, globalStore } = options;

  return {
    definition: {
      name: "memory_review",
      description:
        "Review global and project memory metadata for lifecycle state, stale, exact/near-duplicate, scope-conflict, and scope-mismatch records. " +
        "Returns deterministic maintenance suggestions and source paths without returning memory bodies or changing records.",
      prompt:
        "Use before memory_merge when memory conflicts or duplicates need maintenance. Review the suggested source paths, " +
        "read every required source body explicitly, and preserve all durable details in the final target. This tool is " +
        "read-only; memory_merge remains confirmation-gated.",
      parameters: z.object({
        include_clean: z.boolean().optional()
          .describe("Include records with no review issues. Defaults to false."),
        offset: z.number().int().min(0).optional()
          .describe("Zero-based offset within the filtered, stable record order."),
        limit: z.number().int().min(1).max(MAX_MEMORY_REVIEW_LIMIT).optional()
          .describe(`Page size. Defaults to ${DEFAULT_MEMORY_REVIEW_LIMIT}, maximum ${MAX_MEMORY_REVIEW_LIMIT}.`),
      }),
      permission: "confirm",
      readOnly: true,
    },
    handler: async (args) => {
      const a = args as { include_clean?: boolean; offset?: number; limit?: number };
      try {
        const stores = scopedMemoryStores(store, globalStore);
        const resolved = listScopedMemoryRecords(stores)
          .sort((left, right) => left.id.localeCompare(right.id));
        const reviewRecords: MemoryReviewRecord[] = resolved.map((entry) => ({
          id: entry.id,
          scope: entry.scope,
          record: entry.record,
        }));
        const review = reviewMemoryRecords(reviewRecords, {
          availableScopes: stores.map((entry) => entry.scope),
        });
        const filtered = a.include_clean
          ? resolved
          : resolved.filter((entry) => review.issuesById.has(entry.id));
        const offset = finiteReviewOffset(a.offset);
        const limit = finiteReviewLimit(a.limit);
        const page = filtered.slice(offset, offset + limit);
        const pageIds = new Set(page.map((entry) => entry.id));
        const suggestions = review.suggestions.filter((suggestion) =>
          suggestion.sources.some((source) => pageIds.has(source.id)));
        const output = {
          readOnly: true,
          totalRecords: resolved.length,
          matchingRecords: filtered.length,
          pagination: {
            offset,
            limit,
            returned: page.length,
            hasMore: offset + page.length < filtered.length,
          },
          issueCounts: review.counts,
          records: page.map((entry) => ({
            id: entry.id,
            scope: entry.scope,
            filename: entry.record.filename,
            path: join(entry.store.dir, entry.record.filename),
            name: entry.record.frontmatter.name,
            type: entry.record.frontmatter.type,
            description: entry.record.frontmatter.description,
            ...(entry.record.frontmatter.lifecycle
              ? { lifecycle: entry.record.frontmatter.lifecycle }
              : {}),
            ...(entry.record.frontmatter.updatedAt
              ? { updatedAt: entry.record.frontmatter.updatedAt }
              : entry.record.frontmatter.createdAt
                ? { createdAt: entry.record.frontmatter.createdAt }
                : {}),
            issues: review.issuesById.get(entry.id) ?? [],
          })),
          suggestions,
        };
        return { success: true, output: JSON.stringify(output, null, 2) };
      } catch (err) {
        return { success: false, output: "", error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

/**
 * Consolidate one or more explicitly named records into a complete target
 * record. The model supplies the merged body; the tool never invents merge
 * semantics. All sources are resolved and conflicts are checked before the
 * first write. A failed delete restores exact snapshots when the store
 * supports `restore()` and reports any incomplete rollback.
 */
export function memoryMergeTool(options: MemoryMergeToolOptions): Tool {
  const { store, globalStore } = options;

  return {
    definition: {
      name: "memory_merge",
      description:
        "Explicitly consolidate or move existing memories after memory_review or /mem review. " +
        "Supply every source record and the complete final target content. The target is written first, " +
        "then obsolete sources are deleted; failures are rolled back from snapshots.",
      prompt:
        "Use only for explicit memory maintenance after `memory_review` or inspecting `/mem`. Include every duplicate or " +
        "conflicting record in `sources`, and provide a self-contained final target body; omitted source " +
        "details are not merged automatically. The operation requires user confirmation. Do not use it " +
        "for ordinary memory updates; use `memory_save` with the existing name instead.",
      parameters: z.object({
        sources: z.array(z.object({
          scope: z.enum(["global", "project"]),
          name: z.string().regex(/^[a-zA-Z0-9_][a-zA-Z0-9_\-]*$/),
        })).min(1).max(12)
          .describe("Existing records to consolidate or move. Names are resolved within the explicit scope."),
        target: z.object({
          type: z.enum(["user", "feedback", "project", "reference"]),
          name: z.string().regex(/^[a-zA-Z0-9_][a-zA-Z0-9_\-]*$/),
          description: z.string().min(1).max(200),
          tags: z.array(z.string().min(1)).max(12).optional(),
          source: z.string().min(1).max(200).optional(),
          confidence: z.enum(["high", "medium", "low"]).optional()
            .describe("Confidence for the consolidated fact; new targets default to medium and existing targets preserve their current value"),
          validFrom: MEMORY_TIMESTAMP_SCHEMA.nullable().optional()
            .describe("Optional absolute activation time; null clears an existing value"),
          expiresAt: MEMORY_TIMESTAMP_SCHEMA.nullable().optional()
            .describe("Optional absolute expiry time; null clears an existing value"),
          content: z.string().min(1).refine(
            (value) => countCodePoints(value) <= MAX_MEMORY_SAVE_CONTENT_CHARS,
            { message: `memory content must be ${MAX_MEMORY_SAVE_CONTENT_CHARS} Unicode characters or fewer` },
          ),
        }).describe("Complete final memory. Its type determines global/project routing."),
      }),
      permission: "confirm",
    },
    handler: async (args, _signal, context) => {
      const a = args as {
        sources: Array<{ scope: MemoryScope; name: string }>;
        target: {
          type: MdMemoryType;
          name: string;
          description: string;
          tags?: string[];
          source?: string;
          confidence?: "high" | "medium" | "low";
          validFrom?: string | null;
          expiresAt?: string | null;
          content: string;
        };
      };
      try {
        assertMemoryNameHasNoCredential(a.target.name);
        const contentChars = countCodePoints(a.target.content);
        if (contentChars > MAX_MEMORY_SAVE_CONTENT_CHARS) {
          return {
            success: false,
            output: "",
            error:
              `merged memory content is ${contentChars} chars, above the ` +
              `${MAX_MEMORY_SAVE_CONTENT_CHARS} char limit. Provide a concise durable target.`,
          };
        }
        const safe = sanitizeMemoryWriteFields(a.target);
        const redactionNotice = memoryRedactionNotice(safe.redacted);

        const stores = scopedMemoryStores(store, globalStore);
        const sources = resolveMemorySources(a.sources, stores);
        const sourceIds = new Set(sources.map((source) => source.id));
        if (sourceIds.size !== sources.length) {
          throw new Error("duplicate source record; list each scoped memory once");
        }
        const target = routeMemoryStore(a.target.type, store, globalStore);
        const targetFilename = `${a.target.name}.md`;
        const targetId = scopedMemoryId(target.scope, targetFilename);
        const allRecords = listScopedMemoryRecords(stores);
        const existingTarget = target.store.get(targetFilename);
        const requestedLifecycle = memoryLifecycleInput(a.target);
        const lifecycleUpdate = memoryLifecycleAdmissionUpdate(requestedLifecycle, existingTarget);
        const lifecycle = lifecycleUpdate === undefined
          ? existingTarget?.frontmatter.lifecycle
          : normalizeMdMemoryLifecycle(lifecycleUpdate, existingTarget?.frontmatter.lifecycle);
        const targetIdentity = normalizeMemoryIdentity(a.target.name);
        const targetNameMatches = allRecords.filter(
          (entry) => normalizeMemoryIdentity(entry.record.frontmatter.name) === targetIdentity,
        );
        const unlistedNameConflict = targetNameMatches.find((entry) => !sourceIds.has(entry.id));
        if (unlistedNameConflict) {
          throw new Error(
            `target name conflicts with ${unlistedNameConflict.id}; include that record in sources or choose another target name`,
          );
        }
        if (existingTarget && !sourceIds.has(targetId)) {
          throw new Error(
            `target file conflicts with ${targetId}; include that record in sources or choose another target name`,
          );
        }
        const caseAlias = targetNameMatches.find(
          (entry) => entry.scope === target.scope && entry.record.filename !== targetFilename,
        );
        if (caseAlias) {
          throw new Error(
            `target name differs only by case from ${caseAlias.id}; use the record's exact existing name`,
          );
        }
        const contentKey = normalizeMemoryContent(safe.content);
        const unlistedDuplicate = contentKey
          ? allRecords.find(
              (entry) => !sourceIds.has(entry.id) && normalizeMemoryContent(entry.record.body) === contentKey,
            )
          : undefined;
        if (unlistedDuplicate) {
          throw new Error(
            `target content duplicates ${unlistedDuplicate.id}; include that record in sources before merging`,
          );
        }

        assertMemorySourcesUnchanged(sources);
        const previousTarget = existingTarget;
        const deletedSources: ResolvedMemorySource[] = [];
        let targetSaved = false;
        try {
          // Mark the attempt before save(): the record write may succeed and
          // the subsequent index rebuild may throw.
          targetSaved = true;
          const merged = target.store.save({
            type: a.target.type,
            name: a.target.name,
            description: safe.description,
            tags: safe.tags,
            source: safe.source,
            ...(lifecycleUpdate !== undefined ? { lifecycle: lifecycle ?? null } : {}),
            provenance: memoryToolProvenance("memory_merge", context),
            body: safe.content,
          });
          for (const source of sources) {
            if (source.id === targetId) continue;
            try {
              assertMemorySourceUnchanged(source);
              if (!source.store.delete(source.record.filename)) {
                throw new Error(`failed deleting source ${source.id}`);
              }
              deletedSources.push(source);
            } catch (err) {
              // delete() can unlink successfully and then fail rebuilding the
              // index. Track that source so rollback restores its snapshot.
              if (!source.store.get(source.record.filename)) {
                deletedSources.push(source);
              }
              throw err;
            }
          }
          return {
            success: true,
            output:
              `merged ${sources.length} memory record${sources.length === 1 ? "" : "s"} into ` +
              `${merged.filename} (${target.scope}); removed ${deletedSources.length} obsolete source ` +
              `record${deletedSources.length === 1 ? "" : "s"}${redactionNotice}`,
          };
        } catch (err) {
          const rollbackErrors = rollbackMemoryMerge({
            target,
            targetFilename,
            previousTarget,
            targetSaved,
            deletedSources,
          });
          const detail = err instanceof Error ? err.message : String(err);
          return {
            success: false,
            output: "",
            error: rollbackErrors.length === 0
              ? `memory merge failed: ${detail}. All changes were rolled back.`
              : `memory merge failed: ${detail}. Rollback incomplete: ${rollbackErrors.join("; ")}`,
          };
        }
      } catch (err) {
        return { success: false, output: "", error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

interface MemoryWriteFields {
  description: string;
  tags?: string[];
  source?: string;
  content: string;
}

interface MemoryLifecycleWriteFields {
  confidence?: "high" | "medium" | "low";
  validFrom?: string | null;
  expiresAt?: string | null;
  supersedes?: string[];
}

function memoryLifecycleInput(fields: MemoryLifecycleWriteFields): MdMemoryLifecycleInput | undefined {
  if (
    !("confidence" in fields) &&
    !("validFrom" in fields) &&
    !("expiresAt" in fields) &&
    !("supersedes" in fields)
  ) {
    return undefined;
  }
  return {
    ...(fields.confidence !== undefined ? { confidence: fields.confidence } : {}),
    ...(fields.validFrom !== undefined ? { validFrom: fields.validFrom } : {}),
    ...(fields.expiresAt !== undefined ? { expiresAt: fields.expiresAt } : {}),
    ...(fields.supersedes !== undefined ? { supersedes: fields.supersedes } : {}),
  };
}

function memoryLifecycleAdmissionUpdate(
  requested: MdMemoryLifecycleInput | undefined,
  existing: MdMemoryRecord | undefined,
): MdMemoryLifecycleInput | undefined {
  if (requested === undefined) return existing ? undefined : { confidence: "medium" };
  if (existing && !existing.frontmatter.lifecycleInvalid) return requested;
  return { confidence: "medium", ...requested };
}

function assertMemoryLifecycleTransition(
  store: MdMemoryStore,
  name: string,
  type: MdMemoryType,
  lifecycle: MdMemoryLifecycle | undefined,
): void {
  const records = store.list();
  const currentFilename = `${name}.md`;
  if ((lifecycle?.supersedes?.length ?? 0) > 0 && lifecycle?.confidence !== "high") {
    throw new Error("memory supersession requires high confidence");
  }
  for (const predecessorName of lifecycle?.supersedes ?? []) {
    if (normalizeMemoryIdentity(predecessorName) === normalizeMemoryIdentity(name)) {
      throw new Error("memory cannot supersede itself");
    }
    const matches = records.filter((record) =>
      normalizeMemoryIdentity(record.frontmatter.name) === normalizeMemoryIdentity(predecessorName));
    if (matches.length === 0) throw new Error(`supersedes target not found in this scope: ${predecessorName}`);
    if (matches.length > 1) throw new Error(`supersedes target is ambiguous in this scope: ${predecessorName}`);
    if (matches[0].frontmatter.type !== type) {
      throw new Error(`supersedes target ${predecessorName} must have the same memory type`);
    }
  }

  const existing = records.find((record) => record.filename === currentFilename);
  const candidate: MdMemoryRecord = {
    filename: currentFilename,
    frontmatter: {
      name,
      description: existing?.frontmatter.description ?? "prospective lifecycle validation",
      type,
      ...(lifecycle ? { lifecycle } : {}),
    },
    body: existing?.body ?? "",
  };
  const prospective = [...records.filter((record) => record.filename !== currentFilename), candidate];
  const resolution = resolveMdMemoryLifecycles(prospective).get(currentFilename);
  if (resolution?.problems.some((problem) =>
    problem.kind === "self_supersession" || problem.kind === "supersession_cycle")) {
    throw new Error("memory supersession would create a cycle");
  }
}

function sanitizeMemoryWriteFields(fields: MemoryWriteFields): MemoryWriteFields & { redacted: boolean } {
  const description = redactTextSecrets(fields.description);
  const tags = fields.tags?.map((tag) => redactTextSecrets(tag));
  const source = fields.source === undefined ? undefined : redactTextSecrets(fields.source);
  const content = redactTextSecrets(fields.content);
  const tagsRedacted = tags?.some((tag, index) => tag !== fields.tags?.[index]) ?? false;
  return {
    description,
    tags,
    source,
    content,
    redacted:
      description !== fields.description ||
      tagsRedacted ||
      source !== fields.source ||
      content !== fields.content,
  };
}

function assertMemoryNameHasNoCredential(name: string): void {
  if (redactTextSecrets(name) !== name) {
    throw new Error("memory name must not contain a credential-like value");
  }
}

function memoryRedactionNotice(redacted: boolean): string {
  return redacted ? "; credentials redacted" : "";
}

function memoryToolProvenance(
  origin: MdMemoryProvenanceOrigin,
  context: Readonly<ToolExecutionContext> | undefined,
): MdMemoryProvenanceInput {
  return {
    origin,
    ...(context?.sessionId ? { sessionId: context.sessionId } : {}),
    ...(context?.toolCallId ? { toolCallId: context.toolCallId } : {}),
    ...(context?.step !== undefined ? { step: context.step } : {}),
  };
}

function scopedMemoryStores(
  projectStore: MdMemoryStore,
  globalStore: MdMemoryStore | undefined,
): ScopedMemoryStore[] {
  return [
    { scope: "project", store: projectStore },
    ...(globalStore && globalStore !== projectStore
      ? [{ scope: "global" as const, store: globalStore }]
      : []),
  ];
}

function routeMemoryStore(
  type: MdMemoryType,
  projectStore: MdMemoryStore,
  globalStore: MdMemoryStore | undefined,
): ScopedMemoryStore {
  return globalStore && globalStore !== projectStore && GLOBAL_MEMORY_TYPES.has(type)
    ? { scope: "global", store: globalStore }
    : { scope: "project", store: projectStore };
}

function assertMemorySourcesUnchanged(sources: ResolvedMemorySource[]): void {
  for (const source of sources) assertMemorySourceUnchanged(source);
}

function assertMemorySourceUnchanged(source: ResolvedMemorySource): void {
  const current = source.store.get(source.record.filename);
  if (!current || !sameMemoryRecord(current, source.record)) {
    throw new Error(`source changed during merge: ${source.id}; inspect /mem and retry`);
  }
}

function sameMemoryRecord(a: MdMemoryRecord, b: MdMemoryRecord): boolean {
  return a.filename === b.filename &&
    a.body === b.body &&
    a.frontmatter.name === b.frontmatter.name &&
    a.frontmatter.description === b.frontmatter.description &&
    a.frontmatter.type === b.frontmatter.type &&
    a.frontmatter.source === b.frontmatter.source &&
    a.frontmatter.createdAt === b.frontmatter.createdAt &&
    a.frontmatter.updatedAt === b.frontmatter.updatedAt &&
    JSON.stringify(a.frontmatter.tags ?? []) === JSON.stringify(b.frontmatter.tags ?? []) &&
    JSON.stringify(a.frontmatter.lifecycle ?? null) === JSON.stringify(b.frontmatter.lifecycle ?? null) &&
    a.frontmatter.lifecycleInvalid === b.frontmatter.lifecycleInvalid &&
    a.frontmatter.lifecycleRaw === b.frontmatter.lifecycleRaw &&
    JSON.stringify(a.frontmatter.provenance ?? null) === JSON.stringify(b.frontmatter.provenance ?? null);
}

function resolveMemorySources(
  requested: Array<{ scope: MemoryScope; name: string }>,
  stores: ScopedMemoryStore[],
): ResolvedMemorySource[] {
  return requested.map((source) => {
    const scoped = stores.find((entry) => entry.scope === source.scope);
    if (!scoped) throw new Error(`${source.scope} memory store is unavailable`);
    const identity = normalizeMemoryIdentity(source.name);
    const matches = scoped.store.list().filter(
      (record) => normalizeMemoryIdentity(record.frontmatter.name) === identity,
    );
    if (matches.length === 0) {
      throw new Error(`source memory not found: ${source.scope}:${source.name}`);
    }
    if (matches.length > 1) {
      throw new Error(`source memory is ambiguous: ${source.scope}:${source.name}`);
    }
    const record = matches[0];
    return {
      ...scoped,
      id: scopedMemoryId(scoped.scope, record.filename),
      record,
    };
  });
}

function listScopedMemoryRecords(stores: ScopedMemoryStore[]): ResolvedMemorySource[] {
  return stores.flatMap((scoped) => scoped.store.list().map((record) => ({
    ...scoped,
    id: scopedMemoryId(scoped.scope, record.filename),
    record,
  })));
}

function scopedMemoryId(scope: MemoryScope, filename: string): string {
  return `${scope}:${filename}`;
}

function finiteReviewOffset(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : 0;
}

function finiteReviewLimit(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.min(MAX_MEMORY_REVIEW_LIMIT, Math.max(1, Math.floor(value)))
    : DEFAULT_MEMORY_REVIEW_LIMIT;
}

function rollbackMemoryMerge(options: {
  target: ScopedMemoryStore;
  targetFilename: string;
  previousTarget: MdMemoryRecord | undefined;
  targetSaved: boolean;
  deletedSources: ResolvedMemorySource[];
}): string[] {
  const errors: string[] = [];
  if (options.targetSaved) {
    try {
      if (options.previousTarget) {
        restoreMemoryRecord(options.target.store, options.previousTarget);
      } else if (
        options.target.store.get(options.targetFilename) &&
        !options.target.store.delete(options.targetFilename)
      ) {
        errors.push(`failed removing new target ${scopedMemoryId(options.target.scope, options.targetFilename)}`);
      }
    } catch (err) {
      errors.push(`failed restoring target: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  for (const source of [...options.deletedSources].reverse()) {
    try {
      restoreMemoryRecord(source.store, source.record);
    } catch (err) {
      errors.push(`failed restoring ${source.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return errors;
}

function restoreMemoryRecord(store: MdMemoryStore, record: MdMemoryRecord): MdMemoryRecord {
  if (store.restore) return store.restore(record);
  if (record.frontmatter.lifecycleInvalid) {
    throw new Error("store cannot exactly restore malformed lifecycle metadata");
  }
  return store.save({
    name: record.frontmatter.name,
    description: record.frontmatter.description,
    type: record.frontmatter.type,
    body: record.body,
    tags: record.frontmatter.tags,
    source: record.frontmatter.source,
    lifecycle: record.frontmatter.lifecycle,
  });
}

function findMemoryNameConflict(
  name: string,
  stores: Array<{ store: MdMemoryStore; scope: string }>,
  target: { scope: string; filename: string },
): { filename: string; scope: string } | undefined {
  const identity = normalizeMemoryIdentity(name);
  for (const candidate of stores) {
    for (const record of candidate.store.list()) {
      if (candidate.scope === target.scope && record.filename === target.filename) continue;
      if (normalizeMemoryIdentity(record.frontmatter.name) === identity) {
        return { filename: record.filename, scope: candidate.scope };
      }
    }
  }
  return undefined;
}

function findDuplicateMemoryBody(
  content: string,
  stores: Array<{ store: MdMemoryStore; scope: string }>,
  target: { scope: string; filename: string },
): { filename: string; scope: string } | undefined {
  const key = normalizeMemoryContent(content);
  if (!key) return undefined;
  for (const candidate of stores) {
    for (const record of candidate.store.list()) {
      if (candidate.scope === target.scope && record.filename === target.filename) continue;
      if (normalizeMemoryContent(record.body) === key) {
        return { filename: record.filename, scope: candidate.scope };
      }
    }
  }
  return undefined;
}

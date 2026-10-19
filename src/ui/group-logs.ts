import type { LogEntry } from "./types.js"
import { countCodePoints, sliceHeadCodePoints } from "../utils/logicalLines.js"
import type { AgentRunSnapshot, AgentRunStatus } from "../../zapsdk/agent/run-state.js"

// ── Short label for a subagent group header ────────────────────────────────

const LABEL_MAX = 40

/** Extract a short, human-friendly header from an agent task description.
 *  Keeps the first line (tasks often start with a one-sentence summary
 *  followed by bullet details), trims whitespace, and truncates at a word
 *  boundary if too long. No keyword/emoji recognition — the task text is
 *  treated opaquely so this helper stays domain-agnostic. */
export function shortAgentLabel(task: string | undefined): string {
  if (!task) return "…"
  const firstLine = task.split(/\r?\n/)[0]?.trim() ?? ""
  if (!firstLine) return "…"
  if (countCodePoints(firstLine) <= LABEL_MAX) return firstLine

  const cut = sliceHeadCodePoints(firstLine, LABEL_MAX)
  const lastSpace = cut.lastIndexOf(" ")
  // Break at the last space if it's late enough to still convey meaning;
  // otherwise hard-slice (CJK and other scripts without ASCII spaces).
  return lastSpace > 0 && countCodePoints(cut.slice(0, lastSpace)) > LABEL_MAX * 0.6
    ? cut.slice(0, lastSpace) + "…"
    : cut + "…"
}

// ── Log grouping ──────────────────────────────────────────────────────────

export interface LogGroup {
  /** Stable grouping key. Once started this is the real subagent id shared by
   *  parent meta and child agentPath[0]; queued groups use `pending:<toolId>`
   *  until sub_agent_started supplies the durable id. */
  subagentId: string
  /** False for a root agent tool call that is queued but has not emitted
   *  sub_agent_started yet. Provisional groups let parallel batches render
   *  atomically from their first frame instead of leaking ungrouped rows. */
  started?: boolean
  /** The root-agent tool call/result log for `agent(...)` that spawned this
   *  subagent. Optional for compatibility with restored/partial histories. */
  parent: LogEntry | undefined
  /** All logs whose agentPath starts with this subagent id, in original
   *  stream order. Includes nested-subagent events so one top-level
   *  agent(...) block rolls up cleanly into a single foldable unit. */
  children: LogEntry[]
  /** Stable React key. Reuses parent.id so mount identity is preserved. */
  id: number
}

export type RenderItem =
  | { kind: "log"; log: LogEntry }
  | { kind: "group"; group: LogGroup }

export interface AgentBatch {
  groups: LogGroup[]
  /** Stable key based on the first parent/child log in the batch. */
  id: number
}

export type BatchedRenderItem =
  | { kind: "log"; log: LogEntry }
  | { kind: "agent-batch"; batch: AgentBatch }

export type AgentGroupStatus = AgentRunStatus | "queued" | "succeeded"

export interface AgentGroupSummary {
  status: AgentGroupStatus
  label: string
  agentType?: string
  actionCount: number
  latestTool: LogEntry["tool"]
  durationMs?: number
  outputPreview: string
}

/** Virtual grouping of logs for the transcript. Turns a flat list of
 *  LogEntries into a mixed stream where each top-level `agent(...)` call
 *  plus all of its subagent child events collapse to a single LogGroup.
 *  Pure + idempotent — safe to run on every render. */
export function groupLogs(logs: LogEntry[]): RenderItem[] {
  // Pass 1: index known parents by subagentId and give not-yet-started root
  // agent calls a provisional key. StreamingToolExecutor may queue several
  // agent calls but execute them sequentially; without provisional anchors,
  // only the first row groups while the rest leak into scrollback.
  const parentBySubagent = new Map<string, LogEntry>()
  const groupKeyByParent = new Map<LogEntry, { key: string; started: boolean }>()
  for (const log of logs) {
    if (log.agentPath?.length) continue
    if (log.tool?.name !== "agent" && log.tool?.name !== "delegate_agent") continue
    const sid = (log.tool.meta as { subagentId?: string } | undefined)?.subagentId
    if (sid && !parentBySubagent.has(sid)) {
      parentBySubagent.set(sid, log)
      groupKeyByParent.set(log, { key: sid, started: true })
      continue
    }
    if (log.type === "tool") {
      groupKeyByParent.set(log, {
        key: `pending:${log.tool.id ?? log.id}`,
        started: false,
      })
    }
  }

  if (groupKeyByParent.size === 0) {
    // Fast path: no agent group is resolvable — pass through.
    return logs.map((log) => ({ kind: "log" as const, log }))
  }

  // Pass 2: collect children per subagent. A child is any log whose
  // agentPath's FIRST segment matches a known subagentId. Nested events
  // (path length > 1) still belong to their top-level parent in v1, so
  // one agent() call renders as one foldable unit even if the subagent
  // spawned its own subagent.
  const childrenBySubagent = new Map<string, LogEntry[]>()
  for (const log of logs) {
    const top = log.agentPath?.[0]
    if (!top || !parentBySubagent.has(top)) continue
    const arr = childrenBySubagent.get(top) ?? []
    arr.push(log)
    childrenBySubagent.set(top, arr)
  }

  // Pass 3: emit render items in original log order. Each parent is
  // emitted as a group at its own position; children are skipped since
  // they're now carried by the group.
  const out: RenderItem[] = []
  const emittedSubagents = new Set<string>()
  for (const log of logs) {
    // Parent anchor → emit group here.
    const anchor = groupKeyByParent.get(log)
    if (anchor && !emittedSubagents.has(anchor.key)) {
      emittedSubagents.add(anchor.key)
      const children = anchor.started ? childrenBySubagent.get(anchor.key) ?? [] : []
      out.push({
        kind: "group",
        group: {
          subagentId: anchor.key,
          started: anchor.started,
          parent: log,
          children,
          id: log.id,
        },
      })
      continue
    }
    // Child of an already-emitted group → skip (folded into the group).
    const top = log.agentPath?.[0]
    if (top && emittedSubagents.has(top)) continue
    // Anything else → inline.
    out.push({ kind: "log", log })
  }
  return out
}

/** Coalesce adjacent subagent groups into one parallel-work batch. Child logs
 *  are already folded by groupLogs(), so root-level parallel agent calls that
 *  were interleaved on the wire become adjacent here. */
export function batchAgentGroups(items: RenderItem[]): BatchedRenderItem[] {
  const out: BatchedRenderItem[] = []
  let pending: LogGroup[] = []

  const flush = () => {
    const first = pending[0]
    if (!first) return
    out.push({
      kind: "agent-batch",
      batch: { groups: pending, id: first.id },
    })
    pending = []
  }

  for (const item of items) {
    if (item.kind === "group") {
      pending.push(item.group)
      continue
    }
    flush()
    out.push(item)
  }
  flush()
  return out
}

export function summarizeAgentGroup(
  group: LogGroup,
  agentRun?: AgentRunSnapshot,
): AgentGroupSummary {
  const parent = group.parent
  const tool = parent?.tool
  const meta = tool?.meta as {
    agentType?: string
    durationMs?: number
  } | undefined
  const failed = parent?.type === "result"
    && (tool?.success === false || parent.text.startsWith("ERR"))
  const status: AgentGroupStatus = agentRun?.status ?? (
    parent?.type !== "result"
      ? group.started === false
        ? "queued"
        : "running"
      : failed
        ? "failed"
        : "succeeded"
  )
  const latestChild = group.children.findLast(log => !!log.tool)
  const output = [
    "scheduled",
    "waiting_dependency",
    "waiting_capacity",
    "starting",
    "running",
    "waiting_approval",
    "waiting_input",
    "cancelling",
    "validating",
    "ready_to_merge",
    "merging",
  ].includes(status)
    ? ""
    : tool?.output ?? ""

  return {
    status,
    label: shortAgentLabel(tool?.arguments?.task as string | undefined),
    agentType: agentRun?.agentType ?? meta?.agentType,
    actionCount: group.children.filter(log => !!log.tool).length,
    latestTool: latestChild?.tool,
    durationMs: typeof meta?.durationMs === "number"
      ? meta.durationMs
      : agentRun?.finishedAt !== undefined && agentRun.startedAt !== undefined
        ? agentRun.finishedAt - agentRun.startedAt
        : undefined,
    outputPreview: compactPreview(output),
  }
}

/** A pending tool or live status can still be replaced with its result. Keep the whole
 *  suffix from the earliest mutable item outside Ink's Static component so
 *  parallel agent batches update in place instead of leaking stale rows into
 *  terminal scrollback. */
export function isMutableRenderItem(item: BatchedRenderItem): boolean {
  if (item.kind === "log") return item.log.type === "tool" || item.log.pending === true
  return item.batch.groups.some(group => (
    group.parent?.type !== "result"
    || group.parent?.pending === true
    || group.children.some(child => child.type === "tool" || child.pending === true)
  ))
}

export function partitionRenderItems(items: BatchedRenderItem[]): {
  committed: BatchedRenderItem[]
  dynamic: BatchedRenderItem[]
} {
  const firstMutable = items.findIndex(isMutableRenderItem)
  if (firstMutable < 0) return { committed: items, dynamic: [] }
  return {
    committed: items.slice(0, firstMutable),
    dynamic: items.slice(firstMutable),
  }
}

function compactPreview(text: string, max = 160): string {
  const compact = text.replace(/\s+/g, " ").trim()
  if (countCodePoints(compact) <= max) return compact
  return `${sliceHeadCodePoints(compact, Math.max(1, max - 1))}…`
}

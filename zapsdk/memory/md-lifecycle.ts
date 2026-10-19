import type { MdMemoryRecord } from "./md-store.js"
import {
  MD_MEMORY_CONFIDENCE_LEVELS,
  type MdMemoryConfidence,
  type MdMemoryLifecycle,
  type MdMemoryLifecycleInput,
} from "./md-types.js"

export type MdMemoryLifecycleState =
  | "active"
  | "low_confidence"
  | "not_yet_valid"
  | "expired"
  | "superseded"
  | "invalid"

export type MdMemoryLifecycleProblemKind =
  | "invalid_metadata"
  | "invalid_window"
  | "non_high_confidence_supersession"
  | "self_supersession"
  | "supersession_cycle"
  | "missing_supersedes_target"
  | "ambiguous_supersedes_target"

export interface MdMemoryLifecycleProblem {
  kind: MdMemoryLifecycleProblemKind
  target?: string
}

export interface MdMemoryLifecycleResolution {
  state: MdMemoryLifecycleState
  confidence: MdMemoryConfidence
  validFromTimestamp?: number
  expiresAtTimestamp?: number
  supersededBy: string[]
  problems: MdMemoryLifecycleProblem[]
}

const MEMORY_NAME_RE = /^[a-zA-Z0-9_][a-zA-Z0-9_\-]*$/

/** Normalize lifecycle fields at the write boundary. Missing input preserves
 *  existing metadata; null date values explicitly clear those fields. */
export function normalizeMdMemoryLifecycle(
  input: MdMemoryLifecycleInput | null | undefined,
  existing?: MdMemoryLifecycle,
): MdMemoryLifecycle | undefined {
  if (input === undefined) return existing ? cloneLifecycle(existing) : undefined
  if (input === null) return undefined

  const confidence = input.confidence ?? existing?.confidence ?? "high"
  if (!(MD_MEMORY_CONFIDENCE_LEVELS as readonly string[]).includes(confidence)) {
    throw new Error(`unsupported memory confidence: ${String(confidence)}`)
  }
  const validFrom = lifecycleDateField("validFrom", input, existing)
  const expiresAt = lifecycleDateField("expiresAt", input, existing)
  if (validFrom && expiresAt && Date.parse(expiresAt) <= Date.parse(validFrom)) {
    throw new Error("memory expiresAt must be later than validFrom")
  }
  const supersedes = "supersedes" in input
    ? normalizeSupersedes(input.supersedes ?? [])
    : [...(existing?.supersedes ?? [])]

  if (confidence === "high" && !validFrom && !expiresAt && supersedes.length === 0) {
    return undefined
  }
  return {
    version: 1,
    confidence,
    ...(validFrom ? { validFrom } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    ...(supersedes.length > 0 ? { supersedes } : {}),
  }
}

/** Resolve temporal validity and supersession for one store inventory. The
 *  result is deterministic for the supplied instant and leaves every record
 *  visible to maintenance even when it is excluded from automatic recall. */
export function resolveMdMemoryLifecycles(
  records: readonly MdMemoryRecord[],
  now: Date = new Date(),
): Map<string, MdMemoryLifecycleResolution> {
  const nowMs = validDateTimestamp(now) ?? Date.now()
  const resolutions = new Map<string, MdMemoryLifecycleResolution>()
  const recordsByIdentity = new Map<string, MdMemoryRecord[]>()
  for (const record of records) {
    const identity = memoryIdentity(record.frontmatter.name)
    const group = recordsByIdentity.get(identity) ?? []
    group.push(record)
    recordsByIdentity.set(identity, group)
    resolutions.set(record.filename, baseResolution(record, nowMs))
  }

  const edges = new Map<string, Set<string>>()
  for (const record of records) {
    const resolution = resolutions.get(record.filename)!
    const supersedes = record.frontmatter.lifecycle?.supersedes ?? []
    if (supersedes.length > 0 && resolution.confidence !== "high") {
      resolution.problems.push({ kind: "non_high_confidence_supersession" })
      resolution.state = "invalid"
      continue
    }
    for (const targetName of supersedes) {
      const matches = recordsByIdentity.get(memoryIdentity(targetName)) ?? []
      if (matches.length === 0) {
        resolution.problems.push({ kind: "missing_supersedes_target", target: targetName })
        continue
      }
      if (matches.length > 1) {
        resolution.problems.push({ kind: "ambiguous_supersedes_target", target: targetName })
        continue
      }
      const target = matches[0]
      if (target.filename === record.filename) {
        resolution.problems.push({ kind: "self_supersession", target: targetName })
        resolution.state = "invalid"
        continue
      }
      const targets = edges.get(record.filename) ?? new Set<string>()
      targets.add(target.filename)
      edges.set(record.filename, targets)
    }
  }

  for (const filename of supersessionCycleMembers(edges)) {
    const resolution = resolutions.get(filename)
    if (!resolution) continue
    resolution.state = "invalid"
    resolution.problems.push({ kind: "supersession_cycle" })
  }

  for (const [successor, targets] of edges) {
    const successorResolution = resolutions.get(successor)
    if (!successorResolution || !supersessionIsEffective(successorResolution)) continue
    for (const target of targets) {
      const targetResolution = resolutions.get(target)
      if (!targetResolution) continue
      targetResolution.supersededBy.push(successor)
      if (targetResolution.state === "active") targetResolution.state = "superseded"
    }
  }

  for (const resolution of resolutions.values()) {
    resolution.supersededBy.sort((a, b) => a.localeCompare(b))
  }
  return resolutions
}

export function activeMdMemoryRecords(
  records: readonly MdMemoryRecord[],
  now: Date = new Date(),
): MdMemoryRecord[] {
  const resolutions = resolveMdMemoryLifecycles(records, now)
  return records.filter((record) => resolutions.get(record.filename)?.state === "active")
}

export function memoryConfidenceWeight(confidence: MdMemoryConfidence): number {
  switch (confidence) {
    case "high": return 1
    case "medium": return 0.8
    case "low": return 0
  }
}

function baseResolution(record: MdMemoryRecord, nowMs: number): MdMemoryLifecycleResolution {
  const lifecycle = record.frontmatter.lifecycle
  const confidence = lifecycle?.confidence ?? "high"
  const resolution: MdMemoryLifecycleResolution = {
    state: "active",
    confidence,
    supersededBy: [],
    problems: [],
  }
  if (record.frontmatter.lifecycleInvalid) {
    resolution.state = "invalid"
    resolution.problems.push({ kind: "invalid_metadata" })
    return resolution
  }
  const validFromTimestamp = lifecycle?.validFrom ? Date.parse(lifecycle.validFrom) : undefined
  const expiresAtTimestamp = lifecycle?.expiresAt ? Date.parse(lifecycle.expiresAt) : undefined
  if (validFromTimestamp !== undefined) resolution.validFromTimestamp = validFromTimestamp
  if (expiresAtTimestamp !== undefined) resolution.expiresAtTimestamp = expiresAtTimestamp
  if (
    (validFromTimestamp !== undefined && !Number.isFinite(validFromTimestamp)) ||
    (expiresAtTimestamp !== undefined && !Number.isFinite(expiresAtTimestamp))
  ) {
    resolution.state = "invalid"
    resolution.problems.push({ kind: "invalid_metadata" })
    return resolution
  }
  if (
    validFromTimestamp !== undefined &&
    expiresAtTimestamp !== undefined &&
    expiresAtTimestamp <= validFromTimestamp
  ) {
    resolution.state = "invalid"
    resolution.problems.push({ kind: "invalid_window" })
    return resolution
  }
  if (confidence === "low") {
    resolution.state = "low_confidence"
  } else if (validFromTimestamp !== undefined && nowMs < validFromTimestamp) {
    resolution.state = "not_yet_valid"
  } else if (expiresAtTimestamp !== undefined && nowMs >= expiresAtTimestamp) {
    resolution.state = "expired"
  }
  return resolution
}

function supersessionIsEffective(resolution: MdMemoryLifecycleResolution): boolean {
  return resolution.state === "active" || resolution.state === "expired" || resolution.state === "superseded"
}

function lifecycleDateField(
  key: "validFrom" | "expiresAt",
  input: MdMemoryLifecycleInput,
  existing: MdMemoryLifecycle | undefined,
): string | undefined {
  if (!(key in input)) return existing?.[key]
  const raw = input[key]
  if (raw === null || raw === undefined || raw.trim() === "") return undefined
  const timestamp = Date.parse(raw)
  if (!Number.isFinite(timestamp)) throw new Error(`memory ${key} must be a valid ISO-8601 timestamp`)
  return new Date(timestamp).toISOString()
}

function normalizeSupersedes(values: readonly string[]): string[] {
  const out = new Map<string, string>()
  for (const raw of values) {
    const name = raw.trim()
    if (name.length > 200 || !MEMORY_NAME_RE.test(name)) {
      throw new Error(`invalid supersedes memory name: ${raw.slice(0, 200)}`)
    }
    const identity = memoryIdentity(name)
    if (!out.has(identity)) out.set(identity, name)
  }
  return [...out.values()].sort((a, b) => a.localeCompare(b))
}

function supersessionCycleMembers(edges: ReadonlyMap<string, ReadonlySet<string>>): Set<string> {
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const stack: string[] = []
  const cycles = new Set<string>()
  const visit = (node: string) => {
    if (visited.has(node)) return
    if (visiting.has(node)) {
      const start = stack.lastIndexOf(node)
      for (const member of stack.slice(Math.max(0, start))) cycles.add(member)
      return
    }
    visiting.add(node)
    stack.push(node)
    for (const target of edges.get(node) ?? []) visit(target)
    stack.pop()
    visiting.delete(node)
    visited.add(node)
  }
  for (const node of edges.keys()) visit(node)
  return cycles
}

function memoryIdentity(value: string): string {
  return value.normalize("NFKC").toLowerCase().trim()
}

function validDateTimestamp(date: Date): number | undefined {
  const timestamp = date.getTime()
  return Number.isFinite(timestamp) ? timestamp : undefined
}

function cloneLifecycle(lifecycle: MdMemoryLifecycle): MdMemoryLifecycle {
  return {
    version: 1,
    confidence: lifecycle.confidence,
    ...(lifecycle.validFrom ? { validFrom: lifecycle.validFrom } : {}),
    ...(lifecycle.expiresAt ? { expiresAt: lifecycle.expiresAt } : {}),
    ...(lifecycle.supersedes ? { supersedes: [...lifecycle.supersedes] } : {}),
  }
}

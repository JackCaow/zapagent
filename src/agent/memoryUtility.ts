import { createHash } from "node:crypto"
import { isAbsolute, resolve } from "node:path"
import type { AgentEvent } from "../../zapsdk/agent/events.js"
import type { MdMemoryRecord } from "../../zapsdk/memory/md-store.js"
import type { MdMemoryType } from "../../zapsdk/memory/md-types.js"
import { countCodePoints, sliceHeadCodePoints } from "../utils/logicalLines.js"

export type MemoryUtilityScope = "global" | "project"

export type MemoryUtilityEvidence =
  | "content_overlap"
  | "explicit_read"
  | "memory_update"
  | "memory_merge"
  | "superseded"

export interface MemoryUtilityCandidate {
  scope: MemoryUtilityScope
  filename: string
  name: string
  type: MdMemoryType
  absolutePath: string
  excerpted: boolean
  normalizedContentHash: string
  lineFeatures: string[]
  phraseFeatures: string[]
}

export interface MemoryUtilityFingerprint {
  lineFeatures: string[]
  phraseFeatures: string[]
}

export interface MemoryUtilityOverlapPolicy {
  minMatchedLines: number
  minMatchedPhrases: number
}

export const DEFAULT_MEMORY_UTILITY_OVERLAP_POLICY: Readonly<MemoryUtilityOverlapPolicy> =
  Object.freeze({
    minMatchedLines: 1,
    minMatchedPhrases: 2,
  })

export interface MemoryUtilityRecord {
  scope: MemoryUtilityScope
  filename: string
  excerpted?: true
  read?: true
  used?: true
  revised?: true
  contradicted?: true
  avoidedReRead?: true
  overlapScore?: number
  evidence?: MemoryUtilityEvidence[]
}

export interface MemoryUtilityAttribution {
  selected: number
  read: number
  used: number
  revised: number
  contradicted: number
  avoidedReRead: number
  records: MemoryUtilityRecord[]
}

interface CandidateState {
  candidate: MemoryUtilityCandidate
  read: boolean
  revised: boolean
  contradicted: boolean
  evidence: Set<MemoryUtilityEvidence>
}

interface PendingMutation {
  keys: string[]
  evidence: MemoryUtilityEvidence
  contradictedKeys: Set<string>
}

const MAX_EVIDENCE_CHARS = 64_000
const MAX_EVENT_EVIDENCE_CHARS = 16_000
const MAX_FEATURES_PER_KIND = 512
const MIN_LINE_FEATURE_CHARS = 20
const MAX_LINE_FEATURE_CHARS = 240
const WORD_SHINGLE_SIZE = 3
const CJK_SHINGLE_SIZE = 6
const MEMORY_FILENAME_RE = /^[a-zA-Z0-9_][a-zA-Z0-9_\-]*\.md$/
const GLOBAL_MEMORY_TYPES = new Set<MdMemoryType>(["user", "feedback"])
const MEMORY_UTILITY_EVIDENCE = new Set<MemoryUtilityEvidence>([
  "content_overlap",
  "explicit_read",
  "memory_update",
  "memory_merge",
  "superseded",
])

export function buildMemoryUtilityCandidates(options: {
  scope: MemoryUtilityScope
  memoryDir: string
  records: readonly MdMemoryRecord[]
  included: readonly string[]
  excerpted?: readonly string[]
}): MemoryUtilityCandidate[] {
  const included = new Set(options.included)
  const excerpted = new Set(options.excerpted ?? [])
  return options.records
    .filter((record) => included.has(record.filename))
    .sort((a, b) => a.filename.localeCompare(b.filename))
    .map((record) => {
      const fingerprint = fingerprintMemoryUtilityText(record.body)
      return {
        scope: options.scope,
        filename: record.filename,
        name: record.frontmatter.name,
        type: record.frontmatter.type,
        absolutePath: resolve(options.memoryDir, record.filename),
        excerpted: excerpted.has(record.filename),
        normalizedContentHash: normalizedContentHash(record.body),
        lineFeatures: fingerprint.lineFeatures,
        phraseFeatures: fingerprint.phraseFeatures,
      }
    })
}

export class MemoryUtilityTracker {
  private readonly cwd: string
  private readonly states = new Map<string, CandidateState>()
  private readonly pendingReads = new Map<string, string>()
  private readonly pendingMutations = new Map<string, PendingMutation>()
  private readonly evidenceChunks: string[] = []
  private readonly baselineFeatures: MemoryUtilityFingerprint
  private readonly overlapPolicy: MemoryUtilityOverlapPolicy
  private evidenceChars = 0
  private inputFeatures = emptyFingerprint()

  constructor(
    candidates: readonly MemoryUtilityCandidate[],
    cwd: string,
    baseline?: MemoryUtilityFingerprint,
    overlapPolicy: MemoryUtilityOverlapPolicy = DEFAULT_MEMORY_UTILITY_OVERLAP_POLICY,
  ) {
    this.cwd = resolve(cwd)
    this.baselineFeatures = mergeFingerprints(baseline, emptyFingerprint())
    this.overlapPolicy = validateMemoryUtilityOverlapPolicy(overlapPolicy)
    this.inputFeatures = this.baselineFeatures
    for (const candidate of candidates) {
      if (!MEMORY_FILENAME_RE.test(candidate.filename)) continue
      this.states.set(candidateKey(candidate.scope, candidate.filename), {
        candidate,
        read: false,
        revised: false,
        contradicted: false,
        evidence: new Set(),
      })
    }
  }

  handle(event: AgentEvent): void {
    if (event.path && event.path.length > 0) return
    if (event.type === "run_started") {
      this.pendingReads.clear()
      this.pendingMutations.clear()
      this.evidenceChunks.length = 0
      this.evidenceChars = 0
      this.inputFeatures = mergeFingerprints(
        this.baselineFeatures,
        fingerprintMemoryUtilityText(event.input),
      )
      for (const state of this.states.values()) {
        state.read = false
        state.revised = false
        state.contradicted = false
        state.evidence.clear()
      }
      return
    }
    if (event.type !== "content_final") return
    if (event.kind === "text") {
      this.addEvidenceText(event.text)
      return
    }
    if (event.kind === "tool_call") {
      this.addEvidenceText(safeJson(event.arguments))
      this.recordToolCall(event.id, event.toolName, event.arguments)
      return
    }
    if (event.kind !== "tool_result") return
    const readKey = this.pendingReads.get(event.id)
    this.pendingReads.delete(event.id)
    if (readKey && event.result.success) {
      const state = this.states.get(readKey)
      if (state) {
        state.read = true
        state.evidence.add("explicit_read")
      }
    }
    const mutation = this.pendingMutations.get(event.id)
    this.pendingMutations.delete(event.id)
    if (!mutation || !event.result.success || /^not saved:/i.test(event.result.output.trim())) return
    for (const key of mutation.keys) {
      const state = this.states.get(key)
      if (!state) continue
      state.revised = true
      state.evidence.add(mutation.evidence)
      if (mutation.contradictedKeys.has(key)) {
        state.contradicted = true
        state.evidence.add("superseded")
      }
    }
  }

  summarize(): MemoryUtilityAttribution {
    const outputFingerprint = fingerprintMemoryUtilityText(this.evidenceChunks.join("\n"))
    const uniqueLineFeatures = uniqueCandidateFeatures(this.states, "lineFeatures")
    const uniquePhraseFeatures = uniqueCandidateFeatures(this.states, "phraseFeatures")
    const records = [...this.states.values()]
      .sort((a, b) => {
        const scopeDelta = a.candidate.scope.localeCompare(b.candidate.scope)
        return scopeDelta || a.candidate.filename.localeCompare(b.candidate.filename)
      })
      .map((state) => this.summarizeRecord(
        state,
        outputFingerprint,
        uniqueLineFeatures,
        uniquePhraseFeatures,
      ))
    return {
      selected: records.length,
      read: records.filter((record) => record.read).length,
      used: records.filter((record) => record.used).length,
      revised: records.filter((record) => record.revised).length,
      contradicted: records.filter((record) => record.contradicted).length,
      avoidedReRead: records.filter((record) => record.avoidedReRead).length,
      records,
    }
  }

  private summarizeRecord(
    state: CandidateState,
    output: MemoryUtilityFingerprint,
    uniqueLineFeatures: ReadonlySet<string>,
    uniquePhraseFeatures: ReadonlySet<string>,
  ): MemoryUtilityRecord {
    const candidate = state.candidate
    const overlap = candidate.excerpted
      ? { used: false, score: 0 }
      : memoryContentOverlap(
          candidate,
          output,
          this.inputFeatures,
          uniqueLineFeatures,
          uniquePhraseFeatures,
          this.overlapPolicy,
        )
    if (overlap.used) state.evidence.add("content_overlap")
    const used = state.read || overlap.used
    const avoidedReRead = overlap.used && !state.read
    const evidence = [...state.evidence].sort((a, b) => a.localeCompare(b))
    return {
      scope: candidate.scope,
      filename: candidate.filename,
      ...(candidate.excerpted ? { excerpted: true } : {}),
      ...(state.read ? { read: true } : {}),
      ...(used ? { used: true } : {}),
      ...(state.revised ? { revised: true } : {}),
      ...(state.contradicted ? { contradicted: true } : {}),
      ...(avoidedReRead ? { avoidedReRead: true } : {}),
      ...(overlap.used ? { overlapScore: overlap.score } : {}),
      ...(evidence.length > 0 ? { evidence } : {}),
    }
  }

  private addEvidenceText(text: string): void {
    if (!text || this.evidenceChars >= MAX_EVIDENCE_CHARS) return
    const remaining = MAX_EVIDENCE_CHARS - this.evidenceChars
    const bounded = sliceHeadCodePoints(text, Math.min(remaining, MAX_EVENT_EVIDENCE_CHARS))
    if (!bounded) return
    this.evidenceChunks.push(bounded)
    this.evidenceChars += countCodePoints(bounded)
  }

  private recordToolCall(id: string, toolName: string, args: Record<string, unknown>): void {
    if (toolName === "read_file") {
      const path = typeof args.path === "string" ? normalizeToolPath(args.path, this.cwd) : undefined
      if (!path) return
      for (const [key, state] of this.states) {
        if (path === state.candidate.absolutePath) {
          this.pendingReads.set(id, key)
          return
        }
      }
      return
    }
    if (toolName === "memory_save") {
      const mutation = this.memorySaveMutation(args)
      if (mutation.keys.length > 0) this.pendingMutations.set(id, mutation)
      return
    }
    if (toolName === "memory_merge") {
      const mutation = this.memoryMergeMutation(args)
      if (mutation.keys.length > 0) this.pendingMutations.set(id, mutation)
    }
  }

  private memorySaveMutation(args: Record<string, unknown>): PendingMutation {
    const type = memoryType(args.type)
    if (!type) return { keys: [], evidence: "memory_update", contradictedKeys: new Set() }
    const name = typeof args.name === "string" ? args.name : undefined
    const scope = GLOBAL_MEMORY_TYPES.has(type) ? "global" : "project"
    const keys = new Set<string>()
    const contradictedKeys = new Set<string>()
    if (name) {
      const key = candidateKey(scope, `${name}.md`)
      const state = this.states.get(key)
      if (state && typeof args.content === "string" &&
        normalizedContentHash(args.content) !== state.candidate.normalizedContentHash) {
        keys.add(key)
      }
    }
    if (Array.isArray(args.supersedes)) {
      for (const predecessor of args.supersedes) {
        if (typeof predecessor !== "string") continue
        const key = candidateKey(scope, `${predecessor}.md`)
        if (!this.states.has(key)) continue
        keys.add(key)
        contradictedKeys.add(key)
      }
    }
    return { keys: [...keys], evidence: "memory_update", contradictedKeys }
  }

  private memoryMergeMutation(args: Record<string, unknown>): PendingMutation {
    const keys = new Set<string>()
    if (Array.isArray(args.sources)) {
      for (const source of args.sources) {
        if (!isRecord(source)) continue
        if ((source.scope !== "global" && source.scope !== "project") || typeof source.name !== "string") continue
        const key = candidateKey(source.scope, `${source.name}.md`)
        if (this.states.has(key)) keys.add(key)
      }
    }
    return { keys: [...keys], evidence: "memory_merge", contradictedKeys: new Set() }
  }
}

export function sanitizeMemoryUtilityAttribution(value: unknown): MemoryUtilityAttribution | undefined {
  if (!isRecord(value) || !Array.isArray(value.records)) return undefined
  const records: MemoryUtilityRecord[] = []
  for (const raw of value.records.slice(0, 16)) {
    if (!isRecord(raw)) continue
    if (raw.scope !== "global" && raw.scope !== "project") continue
    if (typeof raw.filename !== "string" || raw.filename.length > 203 || !MEMORY_FILENAME_RE.test(raw.filename)) continue
    const excerpted = raw.excerpted === true
    const read = raw.read === true
    const used = read || raw.used === true
    const revised = raw.revised === true || raw.contradicted === true
    const contradicted = raw.contradicted === true
    const evidence = Array.isArray(raw.evidence)
      ? [...new Set(raw.evidence.filter((item): item is MemoryUtilityEvidence =>
          typeof item === "string" && MEMORY_UTILITY_EVIDENCE.has(item as MemoryUtilityEvidence)))]
          .filter((item) => evidenceMatchesOutcome(item, { excerpted, read, used, revised, contradicted }))
          .sort((a, b) => a.localeCompare(b))
      : []
    const contentOverlap = evidence.includes("content_overlap")
    const avoidedReRead = contentOverlap && used && !read && raw.avoidedReRead === true
    const overlapScore = contentOverlap && typeof raw.overlapScore === "number" && Number.isFinite(raw.overlapScore)
      ? quantizeUnit(raw.overlapScore)
      : undefined
    records.push({
      scope: raw.scope,
      filename: raw.filename,
      ...(excerpted ? { excerpted: true } : {}),
      ...(read ? { read: true } : {}),
      ...(used ? { used: true } : {}),
      ...(revised ? { revised: true } : {}),
      ...(contradicted ? { contradicted: true } : {}),
      ...(avoidedReRead ? { avoidedReRead: true } : {}),
      ...(overlapScore !== undefined ? { overlapScore } : {}),
      ...(evidence.length > 0 ? { evidence } : {}),
    })
  }
  records.sort((a, b) => {
    const scopeDelta = a.scope.localeCompare(b.scope)
    return scopeDelta || a.filename.localeCompare(b.filename)
  })
  return {
    selected: records.length,
    read: records.filter((record) => record.read).length,
    used: records.filter((record) => record.used).length,
    revised: records.filter((record) => record.revised).length,
    contradicted: records.filter((record) => record.contradicted).length,
    avoidedReRead: records.filter((record) => record.avoidedReRead).length,
    records,
  }
}

function evidenceMatchesOutcome(
  evidence: MemoryUtilityEvidence,
  outcome: {
    excerpted: boolean
    read: boolean
    used: boolean
    revised: boolean
    contradicted: boolean
  },
): boolean {
  if (evidence === "content_overlap") return outcome.used && !outcome.excerpted
  if (evidence === "explicit_read") return outcome.read
  if (evidence === "superseded") return outcome.contradicted
  return outcome.revised
}

export function fingerprintMemoryUtilityText(text: string): MemoryUtilityFingerprint {
  const normalized = text.normalize("NFKC").toLowerCase()
  const lineFeatures = new Set<string>()
  for (const rawLine of normalized.split(/\r\n|\r|\n/u)) {
    const line = rawLine.replace(/\s+/gu, " ").trim()
    const chars = countCodePoints(line)
    if (chars < MIN_LINE_FEATURE_CHARS || chars > MAX_LINE_FEATURE_CHARS) continue
    lineFeatures.add(featureHash(`line:${line}`))
    if (lineFeatures.size >= MAX_FEATURES_PER_KIND) break
  }

  const phraseFeatures = new Set<string>()
  const wordSegments = normalized.split(/[\r\n.!?;\u3002\uff01\uff1f\uff1b]+/u)
  for (const segment of wordSegments) {
    const words = segment.match(/[a-z0-9][a-z0-9_.:/\-]*/g) ?? []
    for (let i = 0; i + WORD_SHINGLE_SIZE <= words.length; i++) {
      const phrase = words.slice(i, i + WORD_SHINGLE_SIZE).join(" ")
      if (phrase.length < 12) continue
      phraseFeatures.add(featureHash(`word:${phrase}`))
      if (phraseFeatures.size >= MAX_FEATURES_PER_KIND) break
    }
    if (phraseFeatures.size >= MAX_FEATURES_PER_KIND) break
  }
  if (phraseFeatures.size < MAX_FEATURES_PER_KIND) {
    const cjkSegments = normalized.match(
      /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu,
    ) ?? []
    for (const segment of cjkSegments) {
      const chars = Array.from(segment)
      for (let i = 0; i + CJK_SHINGLE_SIZE <= chars.length; i++) {
        phraseFeatures.add(featureHash(`cjk:${chars.slice(i, i + CJK_SHINGLE_SIZE).join("")}`))
        if (phraseFeatures.size >= MAX_FEATURES_PER_KIND) break
      }
      if (phraseFeatures.size >= MAX_FEATURES_PER_KIND) break
    }
  }
  return {
    lineFeatures: [...lineFeatures].sort((a, b) => a.localeCompare(b)),
    phraseFeatures: [...phraseFeatures].sort((a, b) => a.localeCompare(b)),
  }
}

function memoryContentOverlap(
  candidate: MemoryUtilityCandidate,
  output: MemoryUtilityFingerprint,
  input: MemoryUtilityFingerprint,
  uniqueLineFeatures: ReadonlySet<string>,
  uniquePhraseFeatures: ReadonlySet<string>,
  policy: MemoryUtilityOverlapPolicy,
): { used: boolean; score: number } {
  const outputLines = new Set(output.lineFeatures)
  const outputPhrases = new Set(output.phraseFeatures)
  const inputLines = new Set(input.lineFeatures)
  const inputPhrases = new Set(input.phraseFeatures)
  const eligibleLines = candidate.lineFeatures.filter((feature) =>
    uniqueLineFeatures.has(feature) && !inputLines.has(feature))
  const eligiblePhrases = candidate.phraseFeatures.filter((feature) =>
    uniquePhraseFeatures.has(feature) && !inputPhrases.has(feature))
  const matchedLines = eligibleLines.filter((feature) => outputLines.has(feature)).length
  const matchedPhrases = eligiblePhrases.filter((feature) => outputPhrases.has(feature)).length
  const used = matchedLines >= policy.minMatchedLines || matchedPhrases >= policy.minMatchedPhrases
  if (!used) return { used: false, score: 0 }
  const evidence = matchedLines * 3 + matchedPhrases
  const possible = Math.max(1, Math.min(16, eligibleLines.length * 3 + eligiblePhrases.length))
  return { used: true, score: quantizeUnit(evidence / possible) }
}

function validateMemoryUtilityOverlapPolicy(
  policy: MemoryUtilityOverlapPolicy,
): MemoryUtilityOverlapPolicy {
  if (!Number.isInteger(policy.minMatchedLines) || policy.minMatchedLines <= 0) {
    throw new RangeError("memory utility minMatchedLines must be a positive integer")
  }
  if (!Number.isInteger(policy.minMatchedPhrases) || policy.minMatchedPhrases <= 0) {
    throw new RangeError("memory utility minMatchedPhrases must be a positive integer")
  }
  return {
    minMatchedLines: policy.minMatchedLines,
    minMatchedPhrases: policy.minMatchedPhrases,
  }
}

function uniqueCandidateFeatures(
  states: ReadonlyMap<string, CandidateState>,
  key: "lineFeatures" | "phraseFeatures",
): Set<string> {
  const counts = new Map<string, number>()
  for (const state of states.values()) {
    for (const feature of state.candidate[key]) {
      counts.set(feature, (counts.get(feature) ?? 0) + 1)
    }
  }
  return new Set([...counts].filter(([, count]) => count === 1).map(([feature]) => feature))
}

function emptyFingerprint(): MemoryUtilityFingerprint {
  return { lineFeatures: [], phraseFeatures: [] }
}

function mergeFingerprints(
  first: MemoryUtilityFingerprint | undefined,
  second: MemoryUtilityFingerprint,
): MemoryUtilityFingerprint {
  return {
    lineFeatures: [...new Set([...(first?.lineFeatures ?? []), ...second.lineFeatures])]
      .sort((a, b) => a.localeCompare(b)),
    phraseFeatures: [...new Set([...(first?.phraseFeatures ?? []), ...second.phraseFeatures])]
      .sort((a, b) => a.localeCompare(b)),
  }
}

function candidateKey(scope: MemoryUtilityScope, filename: string): string {
  return `${scope}:${filename}`
}

function normalizedContentHash(text: string): string {
  return featureHash(text.normalize("NFKC").replace(/\s+/gu, " ").trim())
}

function featureHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24)
}

function quantizeUnit(value: number): number {
  return Math.round(Math.max(0, Math.min(1, value)) * 1000) / 1000
}

function normalizeToolPath(path: string, cwd: string): string | undefined {
  const value = path.trim()
  if (!value) return undefined
  return isAbsolute(value) ? resolve(value) : resolve(cwd, value)
}

function memoryType(value: unknown): MdMemoryType | undefined {
  return value === "user" || value === "feedback" || value === "project" || value === "reference"
    ? value
    : undefined
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return ""
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

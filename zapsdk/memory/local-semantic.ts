import { createHash } from "node:crypto"
import { sliceHeadCodePoints } from "../utils/logical-lines.js"
import type {
  MemorySemanticDocument,
  MemorySemanticRequest,
  MemorySemanticRetriever,
  MemorySemanticScope,
} from "./semantic.js"

export interface LocalSparseMemoryRetrieverOptions {
  /** Omit weak similarities so hybrid recall does not treat noise as evidence. */
  minScore?: number
  /** Bound the map consumed by the hybrid ranker. */
  maxResults?: number
  /** Bound feature extraction for manually-authored oversized records. */
  maxDocumentChars?: number
}

interface IndexedDocument {
  filename: string
  vector: Map<string, number>
  norm: number
}

interface SparseMemoryIndex {
  fingerprint: string
  idf: Map<string, number>
  documents: IndexedDocument[]
}

const DEFAULT_MIN_SCORE = 0.08
const DEFAULT_MAX_RESULTS = 24
const DEFAULT_MAX_DOCUMENT_CHARS = 64_000
const INDEX_YIELD_INTERVAL = 32
const SCORE_YIELD_INTERVAL = 64

const ENGLISH_STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "but", "by",
  "for", "from", "has", "have", "how", "if", "in", "into", "is", "it",
  "of", "on", "or", "that", "the", "their", "then", "this", "to", "was",
  "were", "what", "when", "where", "which", "with", "without", "you", "your",
])

/**
 * Dependency-free local sparse-vector retrieval for durable memory.
 *
 * This is intentionally not a dense embedding model. It combines TF-IDF
 * word/stem features, identifier fragments, phrase bigrams, Latin character
 * trigrams, and CJK n-grams. That gives the hybrid ranker useful topical and
 * morphological similarity while remaining offline, deterministic, and safe
 * to enable by default. Hosts can replace it with a dense retriever through
 * the same MemorySemanticRetriever interface.
 */
export class LocalSparseMemoryRetriever implements MemorySemanticRetriever {
  private readonly minScore: number
  private readonly maxResults: number
  private readonly maxDocumentChars: number
  private readonly indexes = new Map<MemorySemanticScope, SparseMemoryIndex>()

  constructor(options: LocalSparseMemoryRetrieverOptions = {}) {
    this.minScore = finiteUnitInterval(options.minScore, DEFAULT_MIN_SCORE)
    this.maxResults = finitePositiveInteger(options.maxResults, DEFAULT_MAX_RESULTS)
    this.maxDocumentChars = finitePositiveInteger(
      options.maxDocumentChars,
      DEFAULT_MAX_DOCUMENT_CHARS,
    )
  }

  async score(request: MemorySemanticRequest): Promise<ReadonlyMap<string, number>> {
    throwIfAborted(request.signal)
    if (!request.query.trim() || request.documents.length === 0) return new Map()

    const documents = canonicalDocuments(request.documents)
    const suppliedRevision = request.corpusRevision?.trim()
    const fingerprint = suppliedRevision
      ? `revision:${suppliedRevision}`
      : await memoryDocumentFingerprint(
          documents,
          this.maxDocumentChars,
          request.signal,
        )
    let index = this.indexes.get(request.scope)
    if (!index || index.fingerprint !== fingerprint) {
      index = await buildSparseIndex(
        fingerprint,
        documents,
        this.maxDocumentChars,
        request.signal,
      )
      this.indexes.set(request.scope, index)
    }

    const rawQuery = textFeatures(request.query, 1, this.maxDocumentChars)
    const queryVector = toTfIdfVector(rawQuery, index.idf, true)
    const queryNorm = vectorNorm(queryVector)
    if (queryNorm === 0) return new Map()

    const ranked: Array<[string, number]> = []
    for (let i = 0; i < index.documents.length; i++) {
      if (i > 0 && i % SCORE_YIELD_INTERVAL === 0) {
        await yieldToEventLoop()
        throwIfAborted(request.signal)
      }
      const document = index.documents[i]
      if (document.norm === 0) continue
      const similarity = dotProduct(queryVector, document.vector) / (queryNorm * document.norm)
      if (!Number.isFinite(similarity) || similarity <= 0 || similarity < this.minScore) continue
      ranked.push([document.filename, Math.round(Math.min(1, similarity) * 1_000_000) / 1_000_000])
    }
    ranked.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    return new Map(ranked.slice(0, this.maxResults))
  }
}

async function buildSparseIndex(
  fingerprint: string,
  documents: MemorySemanticDocument[],
  maxDocumentChars: number,
  signal: AbortSignal | undefined,
): Promise<SparseMemoryIndex> {
  const rawDocuments: Array<{ filename: string; features: Map<string, number> }> = []
  const documentFrequency = new Map<string, number>()
  for (let i = 0; i < documents.length; i++) {
    if (i > 0 && i % INDEX_YIELD_INTERVAL === 0) {
      await yieldToEventLoop()
      throwIfAborted(signal)
    }
    const document = documents[i]
    const features = documentFeatures(document, maxDocumentChars)
    rawDocuments.push({ filename: document.filename, features })
    for (const feature of features.keys()) {
      documentFrequency.set(feature, (documentFrequency.get(feature) ?? 0) + 1)
    }
  }
  throwIfAborted(signal)

  const idf = new Map<string, number>()
  for (const [feature, frequency] of documentFrequency) {
    idf.set(feature, Math.log((documents.length + 1) / (frequency + 1)) + 1)
  }
  const indexedDocuments = rawDocuments.map(({ filename, features }) => {
    const vector = toTfIdfVector(features, idf, false)
    return { filename, vector, norm: vectorNorm(vector) }
  })
  return { fingerprint, idf, documents: indexedDocuments }
}

function documentFeatures(
  document: MemorySemanticDocument,
  maxDocumentChars: number,
): Map<string, number> {
  const features = new Map<string, number>()
  mergeFeatures(features, textFeatures(document.name, 3, maxDocumentChars))
  mergeFeatures(features, textFeatures(document.description, 2.5, maxDocumentChars))
  mergeFeatures(features, textFeatures(document.tags.join(" "), 2.5, maxDocumentChars))
  if (document.source) mergeFeatures(features, textFeatures(document.source, 1.25, maxDocumentChars))
  mergeFeatures(features, textFeatures(document.body, 1, maxDocumentChars))
  return features
}

function textFeatures(text: string, weight: number, maxChars: number): Map<string, number> {
  const features = new Map<string, number>()
  const bounded = sliceHeadCodePoints(text, maxChars).normalize("NFKC")
  const rawTokens = bounded.match(/[\p{L}\p{N}_-]+/gu) ?? []
  const phraseTokens: string[] = []
  for (const rawToken of rawTokens) {
    const runs = rawToken.match(/[\u3400-\u4dbf\u4e00-\u9fff]+|[^\u3400-\u4dbf\u4e00-\u9fff]+/gu) ?? []
    for (const run of runs) {
      if (isCjkRun(run)) {
        addCjkFeatures(features, run, weight)
        phraseTokens.push(`c:${run}`)
        continue
      }
      for (const part of identifierParts(run)) {
        const token = part.toLowerCase()
        if (token.length <= 1 || ENGLISH_STOP_WORDS.has(token)) continue
        addFeature(features, `w:${token}`, weight)
        phraseTokens.push(`w:${token}`)
        const stem = lightEnglishStem(token)
        if (stem !== token && stem.length > 2) addFeature(features, `s:${stem}`, weight * 0.85)
        if (/^[a-z0-9]+$/u.test(token) && token.length >= 4) {
          for (const gram of codePointNgrams(token, 3)) {
            addFeature(features, `g:${gram}`, weight * 0.25)
          }
        }
      }
    }
  }
  for (let i = 1; i < phraseTokens.length; i++) {
    addFeature(features, `p:${phraseTokens[i - 1]}|${phraseTokens[i]}`, weight * 0.5)
  }
  return features
}

function addCjkFeatures(features: Map<string, number>, run: string, weight: number): void {
  const chars = Array.from(run)
  if (chars.length <= 1) return
  addFeature(features, `c:${run}`, weight)
  for (const gram of codePointNgrams(run, 2)) addFeature(features, `c2:${gram}`, weight * 0.9)
  for (const gram of codePointNgrams(run, 3)) addFeature(features, `c3:${gram}`, weight * 0.6)
}

function identifierParts(token: string): string[] {
  return token
    .replace(/([\p{Lu}]+)([\p{Lu}][\p{Ll}])/gu, "$1 $2")
    .replace(/([\p{Ll}\p{N}])([\p{Lu}])/gu, "$1 $2")
    .split(/[_\-\s]+/u)
    .filter(Boolean)
}

function lightEnglishStem(token: string): string {
  if (!/^[a-z]+$/u.test(token) || token.length < 5) return token
  for (const suffix of ["ization", "ational", "fulness", "ousness", "iveness", "ation", "ments", "ment", "ness", "ingly", "edly", "ing", "ied", "ed", "es", "s", "e"]) {
    if (token.endsWith(suffix) && token.length - suffix.length >= 3) {
      return suffix === "ied" ? `${token.slice(0, -suffix.length)}y` : token.slice(0, -suffix.length)
    }
  }
  return token
}

function codePointNgrams(text: string, size: number): string[] {
  const chars = Array.from(text)
  if (chars.length < size) return []
  const grams: string[] = []
  for (let i = 0; i <= chars.length - size; i++) grams.push(chars.slice(i, i + size).join(""))
  return grams
}

function isCjkRun(text: string): boolean {
  return /^[\u3400-\u4dbf\u4e00-\u9fff]+$/u.test(text)
}

function mergeFeatures(target: Map<string, number>, source: Map<string, number>): void {
  for (const [feature, value] of source) addFeature(target, feature, value)
}

function addFeature(features: Map<string, number>, feature: string, weight: number): void {
  if (!feature || !Number.isFinite(weight) || weight <= 0) return
  features.set(feature, (features.get(feature) ?? 0) + weight)
}

function toTfIdfVector(
  raw: Map<string, number>,
  idf: ReadonlyMap<string, number>,
  omitUnknown: boolean,
): Map<string, number> {
  const vector = new Map<string, number>()
  for (const [feature, frequency] of raw) {
    const inverseDocumentFrequency = idf.get(feature)
    if (inverseDocumentFrequency === undefined && omitUnknown) continue
    const value = Math.log1p(frequency) * (inverseDocumentFrequency ?? 1)
    if (value > 0 && Number.isFinite(value)) vector.set(feature, value)
  }
  return vector
}

function vectorNorm(vector: ReadonlyMap<string, number>): number {
  let sum = 0
  for (const value of vector.values()) sum += value * value
  return Math.sqrt(sum)
}

function dotProduct(a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>): number {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a]
  let sum = 0
  for (const [feature, value] of small) sum += value * (large.get(feature) ?? 0)
  return sum
}

function canonicalDocuments(documents: MemorySemanticDocument[]): MemorySemanticDocument[] {
  const seen = new Set<string>()
  const canonical = [...documents].sort((a, b) => a.filename.localeCompare(b.filename))
  for (const document of canonical) {
    if (seen.has(document.filename)) {
      throw new Error(`duplicate semantic memory filename: ${document.filename}`)
    }
    seen.add(document.filename)
  }
  return canonical
}

async function memoryDocumentFingerprint(
  documents: MemorySemanticDocument[],
  maxDocumentChars: number,
  signal: AbortSignal | undefined,
): Promise<string> {
  const hash = createHash("sha256")
  for (let i = 0; i < documents.length; i++) {
    if (i > 0 && i % INDEX_YIELD_INTERVAL === 0) {
      await yieldToEventLoop()
      throwIfAborted(signal)
    }
    const document = documents[i]
    hash.update(JSON.stringify([
      document.filename,
      document.name,
      document.description,
      document.type,
      document.tags,
      document.source ?? "",
      sliceHeadCodePoints(document.body, maxDocumentChars),
    ]))
    hash.update("\n")
  }
  throwIfAborted(signal)
  return hash.digest("hex")
}

function finiteUnitInterval(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : fallback
}

function finitePositiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.max(1, Math.floor(value))
    : fallback
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return
  const error = new Error("memory semantic retrieval aborted")
  error.name = "AbortError"
  throw error
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

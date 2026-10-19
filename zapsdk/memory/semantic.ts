import type { MdMemoryType } from "./md-types.js"

export type MemorySemanticScope = "global" | "project"

export interface MemorySemanticDocument {
  filename: string
  name: string
  description: string
  type: MdMemoryType
  tags: string[]
  source?: string
  body: string
}

export interface MemorySemanticRequest {
  scope: MemorySemanticScope
  query: string
  documents: MemorySemanticDocument[]
  /** Opaque corpus revision. When supplied, it must change whenever any
   *  semantic document field changes. Retrievers may use it to skip hashing. */
  corpusRevision?: string
  signal?: AbortSignal
}

/**
 * Optional semantic scorer used by memory recall. Implementations may use a
 * local index or a remote embedding service. Scores are similarities in the
 * inclusive range [0, 1], keyed by the exact document filename. Implementors
 * should omit low-confidence documents instead of returning a baseline score
 * for every record; hybrid filtering treats every returned positive score as
 * evidence of relevance.
 *
 * The request includes memory bodies, so hosts must opt in deliberately when
 * the implementation sends data to a remote service.
 */
export interface MemorySemanticRetriever {
  score(request: MemorySemanticRequest): Promise<ReadonlyMap<string, number>>
}

export function normalizeMemorySemanticScores(
  scores: ReadonlyMap<string, number>,
  allowedFilenames: ReadonlySet<string>,
): Map<string, number> {
  const normalized = new Map<string, number>()
  for (const [filename, score] of scores) {
    if (!allowedFilenames.has(filename) || !Number.isFinite(score)) continue
    const clamped = Math.min(1, Math.max(0, score))
    normalized.set(filename, Math.round(clamped * 1000) / 1000)
  }
  return normalized
}

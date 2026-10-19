import { describe, expect, it } from "bun:test"
import { LocalSparseMemoryRetriever } from "../../memory/local-semantic.js"
import type { MemorySemanticDocument } from "../../memory/semantic.js"

describe("LocalSparseMemoryRetriever", () => {
  it("ranks related memories across English morphology and identifier variants", async () => {
    const retriever = new LocalSparseMemoryRetriever({ minScore: 0.03 })
    const scores = await retriever.score({
      scope: "project",
      query: "configure prompt caching",
      documents: [
        document("cache.md", "PromptCacheState", "Cached prompt configuration and cache reads."),
        document("database.md", "schema_migration", "Database indexes and migration rollback."),
      ],
    })

    expect(scores.get("cache.md")).toBeGreaterThan(0.1)
    expect(scores.get("cache.md")).toBeGreaterThan(scores.get("database.md") ?? 0)
  })

  it("uses CJK n-grams for partial phrase similarity", async () => {
    const retriever = new LocalSparseMemoryRetriever({ minScore: 0.03 })
    const scores = await retriever.score({
      scope: "project",
      query: "长文本消息显示不完整",
      documents: [
        document("long-paste.md", "输入完整性", "长文本消息展示和发送时不能截断。"),
        document("cache.md", "缓存诊断", "模型缓存读取比例异常。"),
      ],
    })

    expect(scores.get("long-paste.md")).toBeGreaterThan(0.1)
    expect(scores.has("cache.md")).toBe(false)
  })

  it("omits weak results and bounds the returned result set", async () => {
    const retriever = new LocalSparseMemoryRetriever({ minScore: 0.05, maxResults: 2 })
    const scores = await retriever.score({
      scope: "project",
      query: "prompt cache stability",
      documents: [
        document("a.md", "cache stability", "Stable prompt cache prefix."),
        document("b.md", "cache audit", "Prompt cache diagnostics."),
        document("c.md", "cache tokens", "Prompt cache token accounting."),
        document("unrelated.md", "release", "Upload desktop release artifacts."),
      ],
    })

    expect(scores.size).toBe(2)
    expect(scores.has("unrelated.md")).toBe(false)
    expect([...scores.values()].every((score) => score >= 0.05 && score <= 1)).toBe(true)
  })

  it("does not return zero-similarity documents when the threshold is zero", async () => {
    const retriever = new LocalSparseMemoryRetriever({ minScore: 0 })
    const scores = await retriever.score({
      scope: "project",
      query: "cache",
      documents: [document("unrelated.md", "release", "Desktop artifact upload procedure.")],
    })

    expect(scores.size).toBe(0)
  })

  it("invalidates the cached scope index when document content changes", async () => {
    const retriever = new LocalSparseMemoryRetriever({ minScore: 0.05 })
    const first = await retriever.score({
      scope: "project",
      query: "cache diagnostics",
      documents: [document("state.md", "state", "Prompt cache diagnostics and hit rate.")],
    })
    const second = await retriever.score({
      scope: "project",
      query: "cache diagnostics",
      documents: [document("state.md", "state", "Database migration rollback procedure.")],
    })

    expect(first.has("state.md")).toBe(true)
    expect(second.has("state.md")).toBe(false)
  })

  it("uses a supplied corpus revision to invalidate the cached scope index", async () => {
    const retriever = new LocalSparseMemoryRetriever({ minScore: 0.05 })
    const first = await retriever.score({
      scope: "project",
      query: "cache diagnostics",
      corpusRevision: "revision-1",
      documents: [document("state.md", "state", "Prompt cache diagnostics and hit rate.")],
    })
    const second = await retriever.score({
      scope: "project",
      query: "cache diagnostics",
      corpusRevision: "revision-2",
      documents: [document("state.md", "state", "Database migration rollback procedure.")],
    })

    expect(first.has("state.md")).toBe(true)
    expect(second.has("state.md")).toBe(false)
  })

  it("rejects duplicate filenames instead of producing ambiguous scores", async () => {
    const retriever = new LocalSparseMemoryRetriever()

    await expect(retriever.score({
      scope: "project",
      query: "cache",
      documents: [
        document("duplicate.md", "first", "Cache one."),
        document("duplicate.md", "second", "Cache two."),
      ],
    })).rejects.toThrow("duplicate semantic memory filename")
  })

  it("honors an already-aborted request", async () => {
    const controller = new AbortController()
    controller.abort()
    const retriever = new LocalSparseMemoryRetriever()

    await expect(retriever.score({
      scope: "project",
      query: "cache",
      documents: [document("cache.md", "cache", "Cache diagnostics.")],
      signal: controller.signal,
    })).rejects.toMatchObject({ name: "AbortError" })
  })

  it("yields while indexing so an in-flight abort can stop large requests", async () => {
    const controller = new AbortController()
    const retriever = new LocalSparseMemoryRetriever()
    const pending = retriever.score({
      scope: "project",
      query: "cache diagnostics",
      documents: Array.from({ length: 96 }, (_, index) =>
        document(`record-${index}.md`, `record_${index}`, `Cache diagnostic record ${index}.`)),
      signal: controller.signal,
    })
    setImmediate(() => controller.abort())

    await expect(pending).rejects.toMatchObject({ name: "AbortError" })
  })
})

function document(filename: string, name: string, body: string): MemorySemanticDocument {
  return {
    filename,
    name,
    description: name,
    type: "project",
    tags: [],
    body,
  }
}

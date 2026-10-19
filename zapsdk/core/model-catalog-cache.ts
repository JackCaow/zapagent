import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { randomUUID } from "node:crypto"

interface Snapshot { version: 1; fetchedAt: number; catalog: Record<string, unknown> }

/** Public metadata only. Never accepts connection settings or credentials. */
export class ModelCatalogCache {
  private snapshot?: Snapshot
  private pending?: Promise<Snapshot>
  private loaded?: Promise<void>
  private retryAt = 0

  constructor(private readonly options: {
    path?: string
    load: () => Promise<unknown>
    now?: () => number
    ttlMs?: number
  }) {}

  async get(): Promise<Record<string, unknown>> {
    this.loaded ??= this.readSnapshot()
    await this.loaded
    const now = this.now()
    if (this.snapshot) {
      if (now - this.snapshot.fetchedAt >= (this.options.ttlMs ?? 24 * 60 * 60 * 1000)
        && now >= this.retryAt) void this.refreshSnapshot().catch(() => {})
      return this.snapshot.catalog
    }
    return (await this.refreshSnapshot()).catalog
  }

  /** Explicit reload waits for fresh data, bypassing TTL and retry backoff.
   * Concurrent callers still share any in-flight request. */
  async refresh(): Promise<Record<string, unknown>> {
    this.loaded ??= this.readSnapshot()
    await this.loaded
    return (await this.refreshSnapshot()).catalog
  }

  private now(): number { return (this.options.now ?? Date.now)() }

  private async readSnapshot(): Promise<void> {
    if (!this.options.path) return
    try {
      const value = JSON.parse(await readFile(this.options.path, "utf8"))
      if (value.version === 1 && Number.isFinite(value.fetchedAt)
        && value.fetchedAt >= 0 && value.fetchedAt <= this.now()
        && validCatalog(value.catalog)) this.snapshot = value
    } catch { /* Missing/corrupt cache is not a configuration failure. */ }
  }

  private refreshSnapshot(): Promise<Snapshot> {
    if (this.pending) return this.pending
    this.pending = (async () => {
      try {
        const catalog = await Promise.resolve().then(() => this.options.load())
        if (!validCatalog(catalog)) throw new Error("Invalid public model catalog")
        const next: Snapshot = { version: 1, fetchedAt: this.now(), catalog }
        this.snapshot = next
        await this.persist(next)
        return next
      } catch (error) {
        this.retryAt = this.now() + 60_000
        throw error
      } finally { this.pending = undefined }
    })()
    return this.pending
  }

  private async persist(snapshot: Snapshot): Promise<void> {
    const path = this.options.path
    if (!path) return
    const temporary = `${path}.${randomUUID()}.tmp`
    try {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(temporary, JSON.stringify(snapshot), { mode: 0o600, flag: "wx" })
      await rename(temporary, path)
    } catch { /* Read-only storage must not break discovery. */ }
    finally { await unlink(temporary).catch(() => {}) }
  }
}

function validCatalog(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && Object.values(value).some(provider => !!provider && typeof provider === "object"
      && "models" in provider && !!provider.models && typeof provider.models === "object"
      && !Array.isArray(provider.models))
}

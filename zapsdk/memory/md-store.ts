import { chmodSync, readdirSync, readFileSync, openSync, writeSync, fsyncSync, closeSync, renameSync, unlinkSync, mkdirSync, existsSync, statSync } from "node:fs"
import { dirname, basename, join } from "node:path"
import { createHash, randomBytes } from "node:crypto"
import { parseMdFile, serializeMdFile } from "./md-frontmatter"
import { normalizeMdMemoryLifecycle } from "./md-lifecycle"
import {
  MD_MEMORY_PROVENANCE_ORIGINS,
  mdMemoryContentHash,
  type MdMemoryProvenance,
  type MdMemoryProvenanceEvent,
  type MdMemoryProvenanceInput,
  type MdMemoryLifecycle,
  type MdMemoryLifecycleInput,
  type MdMemoryType,
  type MdFrontmatter,
} from "./md-types"

/** Crash-safe write: tmp sibling → fsync → rename. POSIX rename is atomic on
 *  the same filesystem, so a crash mid-write either leaves the previous file
 *  intact or commits the new content fully — never a half-written file. */
function atomicWrite(path: string, content: string, mode = 0o600): void {
  const tmp = join(dirname(path), `.${basename(path)}.${randomBytes(4).toString("hex")}.tmp`)
  const fd = openSync(tmp, "w", mode)
  try {
    writeSync(fd, content)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, path)
  chmodBestEffort(path, mode)
}

export interface MdMemoryRecord {
  filename: string
  frontmatter: MdFrontmatter
  body: string
}

export interface MdStoreWarning {
  code: "indexed_record_unreadable"
  filename: string
  message: string
}

export interface MdMemorySnapshot {
  records: MdMemoryRecord[]
  /** Opaque inventory revision that changes when any record file changes. */
  revision: string
}

export interface MdMemoryStoreOptions {
  onWarning?: (warning: MdStoreWarning) => void
  /** Diagnostics hook invoked only when record contents are read from disk.
   *  Stable cache hits do not invoke it. */
  onRecordRead?: (filename: string) => void
  /** Max time to wait for another Zap process to finish a write. */
  lockTimeoutMs?: number
  /** Retry interval while waiting for a live lock holder. */
  lockRetryMs?: number
  /** Locks older than this are treated as abandoned when the pid is dead. */
  staleLockMs?: number
}

export interface MdMemoryStore {
  readonly dir: string
  /** Read one inventory and its cheap semantic-index revision in one scan. */
  snapshot?(): MdMemorySnapshot
  list(filter?: MdMemoryType): MdMemoryRecord[]
  get(filename: string): MdMemoryRecord | undefined
  save(rec: {
    name: string
    description: string
    type: MdMemoryType
    body: string
    tags?: string[]
    source?: string
    lifecycle?: MdMemoryLifecycleInput | null
    provenance?: MdMemoryProvenanceInput
  }): MdMemoryRecord
  delete(filename: string): boolean
  /** Restore an exact previously-read record, including timestamps. Used by
   *  maintenance tools to roll back multi-record operations. */
  restore?(record: MdMemoryRecord): MdMemoryRecord
}

const NAME_RE = /^[a-zA-Z0-9_][a-zA-Z0-9_\-]*$/
const INDEX_FILE = "MEMORY.md"
const LOCK_FILE = ".memory.lock"
const DEFAULT_LOCK_TIMEOUT_MS = 5_000
const DEFAULT_LOCK_RETRY_MS = 25
const DEFAULT_STALE_LOCK_MS = 30_000

interface CachedRecordFile {
  identity: string
  record?: MdMemoryRecord
  parseError?: string
}

interface CachedIndexFile {
  identity: string
  lines: Map<string, string>
}

function assertSafeName(name: string): void {
  if (!NAME_RE.test(name)) {
    throw new Error(`memory name must match ${NAME_RE} — got "${name}"`)
  }
}

function isSafeRecordFilename(filename: string): boolean {
  if (!filename.endsWith(".md") || filename === INDEX_FILE) return false
  return NAME_RE.test(filename.slice(0, -3))
}

function isIndexRecordFilename(filename: string): boolean {
  return filename.endsWith(".md") &&
    filename !== INDEX_FILE &&
    filename.length > ".md".length &&
    !filename.includes("/") &&
    !filename.includes("\\")
}

export function openMdStore(dir: string, options: MdMemoryStoreOptions = {}): MdMemoryStore {
  mkdirSync(dir, { recursive: true })
  chmodBestEffort(dir, 0o700)
  const recordCache = new Map<string, CachedRecordFile>()
  let indexCache: CachedIndexFile | undefined

  function warn(warning: MdStoreWarning): void {
    try { options.onWarning?.(warning) } catch { /* diagnostics must not break memory I/O */ }
  }

  function readIndexedLines(): Map<string, string> {
    const indexPath = join(dir, INDEX_FILE)
    const out = new Map<string, string>()
    if (!existsSync(indexPath)) {
      indexCache = undefined
      return out
    }
    try {
      const identity = fileIdentity(indexPath)
      if (indexCache?.identity === identity) return indexCache.lines
      for (const line of readFileSync(indexPath, "utf-8").split("\n")) {
        const filename = parseMdMemoryIndexLineFilename(line)
        if (filename) out.set(filename, line)
      }
      indexCache = { identity, lines: out }
    } catch {
      indexCache = undefined
      // Missing/unreadable index is non-fatal.
    }
    return out
  }

  function readRecordFile(filename: string): CachedRecordFile {
    const path = join(dir, filename)
    const identity = fileIdentity(path)
    const cached = recordCache.get(filename)
    if (cached?.identity === identity) return cached

    const text = readFileSync(path, "utf-8")
    try { options.onRecordRead?.(filename) } catch { /* diagnostics must not break memory I/O */ }
    let entry: CachedRecordFile
    try {
      const parsed = parseMdFile(text)
      entry = parsed
        ? { identity, record: { filename, ...parsed } }
        : { identity, parseError: "Indexed memory record has invalid frontmatter; preserving its MEMORY.md entry." }
    } catch (err) {
      entry = {
        identity,
        parseError: err instanceof Error ? err.message : String(err),
      }
    }
    recordCache.set(filename, entry)
    return entry
  }

  function readAll(): MdMemorySnapshot & { preserveIndexLines: string[] } {
    const out: MdMemoryRecord[] = []
    const indexedLines = readIndexedLines()
    const unreadableIndexedFiles = new Set<string>()
    const seenFiles = new Set<string>()
    const inventoryIdentities: string[] = []
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".md") || f === INDEX_FILE) continue
      seenFiles.add(f)
      try {
        const cached = readRecordFile(f)
        inventoryIdentities.push(`${f}\0${cached.identity}`)
        if (cached.record) {
          out.push(cloneMemoryRecord(cached.record))
        } else if (indexedLines.has(f)) {
          unreadableIndexedFiles.add(f)
          warn({
            code: "indexed_record_unreadable",
            filename: f,
            message: cached.parseError ?? "Indexed memory record is unreadable; preserving its MEMORY.md entry.",
          })
        }
      } catch (err) {
        inventoryIdentities.push(`${f}\0unreadable`)
        if (indexedLines.has(f)) {
          unreadableIndexedFiles.add(f)
          warn({
            code: "indexed_record_unreadable",
            filename: f,
            message: err instanceof Error ? err.message : String(err),
          })
        }
      }
    }
    for (const filename of recordCache.keys()) {
      if (!seenFiles.has(filename)) recordCache.delete(filename)
    }
    const preserveIndexLines = Array.from(indexedLines.entries())
      .filter(([filename]) => unreadableIndexedFiles.has(filename))
      .map(([, line]) => line)
    return {
      records: out.sort(compareMemoryRecordIdentity),
      preserveIndexLines,
      revision: memoryInventoryRevision(dir, inventoryIdentities),
    }
  }

  function rewriteIndex(records: MdMemoryRecord[], preserveIndexLines: string[] = []): void {
    const lines = records.map(r =>
      `- [${indexLabel(r.frontmatter.name, r.filename)}](${escapeMarkdownDestination(r.filename)}) — ${escapeMarkdownInline(oneLine(r.frontmatter.description))}`,
    )
    const written = new Set(records.map(r => r.filename))
    for (const line of preserveIndexLines) {
      const filename = parseMdMemoryIndexLineFilename(line)
      if (!filename || written.has(filename)) continue
      written.add(filename)
      lines.push(line)
    }
    const indexPath = join(dir, INDEX_FILE)
    const content = lines.join("\n") + (lines.length ? "\n" : "")
    try {
      if (existsSync(indexPath) && readFileSync(indexPath, "utf-8") === content) {
        chmodBestEffort(indexPath, 0o600)
        return
      }
    } catch {
      // Fall through and rewrite unreadable indexes.
    }
    atomicWrite(indexPath, content)
  }

  function withWriteLock<T>(operation: () => T): T {
    const release = acquireWriteLock(dir, options)
    try {
      return operation()
    } finally {
      release()
    }
  }

  return {
    dir,
    snapshot() {
      const { records, revision } = readAll()
      return { records, revision }
    },
    list(filter) {
      const all = readAll().records
      return filter ? all.filter(r => r.frontmatter.type === filter) : all
    },
    get(filename) {
      if (!isSafeRecordFilename(filename)) return undefined
      const path = join(dir, filename)
      if (!existsSync(path)) return undefined
      try {
        const cached = readRecordFile(filename)
        return cached.record ? cloneMemoryRecord(cached.record) : undefined
      } catch { return undefined }
    },
    save(rec) {
      return withWriteLock(() => {
        const { name, description, type, body } = rec
        assertSafeName(name)
        const descriptionText = oneLine(description)
        if (!descriptionText) throw new Error("description required")
        const filename = `${name}.md`
        const existing = this.get(filename)
        const normalizedBody = body.endsWith("\n") ? body : body + "\n"
        const now = new Date().toISOString()
        const frontmatter: MdFrontmatter = {
          name,
          description: descriptionText,
          type,
          createdAt: existing?.frontmatter.createdAt ?? now,
          updatedAt: now,
        }
        if ("tags" in rec) {
          const tags = normalizeTags(rec.tags ?? [])
          if (tags.length > 0) frontmatter.tags = tags
        } else if (existing?.frontmatter.tags?.length) {
          frontmatter.tags = existing.frontmatter.tags
        }
        if ("source" in rec) {
          const source = oneLine(rec.source ?? "")
          if (source) frontmatter.source = source
        } else if (existing?.frontmatter.source) {
          const source = oneLine(existing.frontmatter.source)
          if (source) frontmatter.source = source
        }
        if (existing?.frontmatter.lifecycleInvalid && !("lifecycle" in rec)) {
          throw new Error("existing memory has invalid lifecycle metadata; supply corrected lifecycle fields explicitly")
        }
        const lifecycle = "lifecycle" in rec
          ? normalizeMdMemoryLifecycle(rec.lifecycle, existing?.frontmatter.lifecycle)
          : existing?.frontmatter.lifecycle
            ? cloneMemoryLifecycle(existing.frontmatter.lifecycle)
            : undefined
        if (lifecycle) frontmatter.lifecycle = lifecycle
        const provenance = buildMemoryProvenance(
          existing?.frontmatter.provenance,
          rec.provenance,
          normalizedBody,
          existing !== undefined,
        )
        if (provenance) frontmatter.provenance = provenance
        if (existing && isUnchangedMemoryRecord(existing, frontmatter, normalizedBody)) {
          chmodBestEffort(join(dir, filename), 0o600)
          const all = readAll()
          rewriteIndex(all.records, all.preserveIndexLines)
          return existing
        }
        const text = serializeMdFile(frontmatter, normalizedBody)
        atomicWrite(join(dir, filename), text)
        const all = readAll()
        rewriteIndex(all.records, all.preserveIndexLines)
        return { filename, frontmatter, body: normalizedBody }
      })
    },
    delete(filename) {
      return withWriteLock(() => {
        if (!isSafeRecordFilename(filename)) return false
        const path = join(dir, filename)
        if (!existsSync(path)) return false
        unlinkSync(path)
        const all = readAll()
        rewriteIndex(all.records, all.preserveIndexLines)
        return true
      })
    },
    restore(record) {
      return withWriteLock(() => {
        if (!isSafeRecordFilename(record.filename)) {
          throw new Error(`unsafe memory filename: ${record.filename}`)
        }
        assertSafeName(record.frontmatter.name)
        if (!oneLine(record.frontmatter.description)) {
          throw new Error("description required")
        }
        const frontmatter: MdFrontmatter = {
          ...record.frontmatter,
          ...(record.frontmatter.tags ? { tags: [...record.frontmatter.tags] } : {}),
          ...(record.frontmatter.lifecycle
            ? { lifecycle: cloneMemoryLifecycle(record.frontmatter.lifecycle) }
            : {}),
          ...(record.frontmatter.provenance
            ? { provenance: cloneMemoryProvenance(record.frontmatter.provenance) }
            : {}),
        }
        atomicWrite(
          join(dir, record.filename),
          serializeMdFile(frontmatter, record.body),
        )
        const all = readAll()
        rewriteIndex(all.records, all.preserveIndexLines)
        return {
          filename: record.filename,
          frontmatter,
          body: record.body,
        }
      })
    },
  }
}

export function parseMdMemoryIndexLineFilename(line: string): string | null {
  const linkStart = line.indexOf("](")
  if (!/^\s*-\s+\[/.test(line) || linkStart < 0) return null
  let cursor = linkStart + 2
  let escaped = false
  for (; cursor < line.length; cursor++) {
    const ch = line[cursor]
    if (escaped) {
      escaped = false
      continue
    }
    if (ch === "\\") {
      escaped = true
      continue
    }
    if (ch === ")") break
  }
  if (cursor >= line.length) return null
  const rest = line.slice(cursor + 1)
  if (!/^\s+—\s+.+$/.test(rest)) return null
  const raw = line.slice(linkStart + 2, cursor).trim()
  const filename = raw
    .replace(/\\([\\()])/g, "$1")
    .replace(/%20/g, " ")
  return isIndexRecordFilename(filename) ? filename : null
}

function compareMemoryRecordIdentity(a: MdMemoryRecord, b: MdMemoryRecord): number {
  const nameDelta = a.frontmatter.name.localeCompare(b.frontmatter.name)
  if (nameDelta !== 0) return nameDelta
  return a.filename.localeCompare(b.filename)
}

function fileIdentity(path: string): string {
  const stat = statSync(path, { bigint: true })
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":")
}

function memoryInventoryRevision(dir: string, identities: string[]): string {
  const hash = createHash("sha256").update(dir).update("\n")
  for (const identity of identities.sort()) hash.update(identity).update("\n")
  return hash.digest("hex")
}

function cloneMemoryRecord(record: MdMemoryRecord): MdMemoryRecord {
  return {
    filename: record.filename,
    frontmatter: {
      ...record.frontmatter,
      ...(record.frontmatter.tags ? { tags: [...record.frontmatter.tags] } : {}),
      ...(record.frontmatter.lifecycle
        ? { lifecycle: cloneMemoryLifecycle(record.frontmatter.lifecycle) }
        : {}),
      ...(record.frontmatter.provenance
        ? { provenance: cloneMemoryProvenance(record.frontmatter.provenance) }
        : {}),
    },
    body: record.body,
  }
}

function buildMemoryProvenance(
  existing: MdMemoryProvenance | undefined,
  input: MdMemoryProvenanceInput | undefined,
  body: string,
  recordExists: boolean,
): MdMemoryProvenance | undefined {
  if (!input) return existing ? cloneMemoryProvenance(existing) : undefined
  if (!(MD_MEMORY_PROVENANCE_ORIGINS as readonly string[]).includes(input.origin)) {
    throw new Error(`unsupported memory provenance origin: ${String(input.origin)}`)
  }
  const updated: MdMemoryProvenanceEvent = {
    origin: input.origin,
    ...boundedProvenanceId("sessionId", input.sessionId),
    ...boundedProvenanceId("toolCallId", input.toolCallId),
    ...(input.step !== undefined ? { step: provenanceStep(input.step) } : {}),
    contentHash: mdMemoryContentHash(body),
  }
  return {
    version: 1,
    ...(existing?.created
      ? { created: { ...existing.created } }
      : recordExists ? {} : { created: { ...updated } }),
    updated,
  }
}

function cloneMemoryProvenance(provenance: MdMemoryProvenance): MdMemoryProvenance {
  return {
    version: 1,
    ...(provenance.created ? { created: { ...provenance.created } } : {}),
    updated: { ...provenance.updated },
  }
}

function cloneMemoryLifecycle(lifecycle: MdMemoryLifecycle): MdMemoryLifecycle {
  return {
    version: 1,
    confidence: lifecycle.confidence,
    ...(lifecycle.validFrom ? { validFrom: lifecycle.validFrom } : {}),
    ...(lifecycle.expiresAt ? { expiresAt: lifecycle.expiresAt } : {}),
    ...(lifecycle.supersedes ? { supersedes: [...lifecycle.supersedes] } : {}),
  }
}

function boundedProvenanceId(
  key: "sessionId" | "toolCallId",
  value: string | undefined,
): Partial<Record<"sessionId" | "toolCallId", string>> {
  if (value === undefined) return {}
  const normalized = oneLine(value)
  if (!normalized) return {}
  return {
    [key]: normalized.length <= 200
      ? normalized
      : mdMemoryContentHash(normalized),
  }
}

function provenanceStep(value: number): number {
  if (!Number.isInteger(value) || value < 0) throw new Error("memory provenance step must be a non-negative integer")
  return value
}

function isUnchangedMemoryRecord(
  existing: MdMemoryRecord,
  next: MdFrontmatter,
  normalizedBody: string,
): boolean {
  return existing.body === normalizedBody &&
    existing.frontmatter.name === next.name &&
    existing.frontmatter.description === next.description &&
    existing.frontmatter.type === next.type &&
    sameStringArray(existing.frontmatter.tags, next.tags) &&
    (existing.frontmatter.source ?? undefined) === (next.source ?? undefined) &&
    sameMemoryLifecycle(existing.frontmatter.lifecycle, next.lifecycle)
}

function sameMemoryLifecycle(
  a: MdMemoryLifecycle | undefined,
  b: MdMemoryLifecycle | undefined,
): boolean {
  if (!a || !b) return a === b
  return a.version === b.version &&
    a.confidence === b.confidence &&
    a.validFrom === b.validFrom &&
    a.expiresAt === b.expiresAt &&
    sameStringArray(a.supersedes, b.supersedes)
}

function sameStringArray(a: string[] | undefined, b: string[] | undefined): boolean {
  const aa = a ?? []
  const bb = b ?? []
  if (aa.length !== bb.length) return false
  return aa.every((value, index) => value === bb[index])
}

function acquireWriteLock(dir: string, options: MdMemoryStoreOptions): () => void {
  const path = join(dir, LOCK_FILE)
  const timeoutMs = Math.max(0, options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS)
  const retryMs = Math.max(1, options.lockRetryMs ?? DEFAULT_LOCK_RETRY_MS)
  const staleLockMs = Math.max(0, options.staleLockMs ?? DEFAULT_STALE_LOCK_MS)
  const deadline = Date.now() + timeoutMs
  while (true) {
    try {
      const fd = openSync(path, "wx", 0o600)
      try {
        writeSync(fd, `${process.pid}\n${new Date().toISOString()}\n`)
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      chmodBestEffort(path, 0o600)
      return () => {
        try { unlinkSync(path) } catch {}
      }
    } catch (err) {
      const code = (err as { code?: string }).code
      if (code !== "EEXIST") throw err
      cleanupStaleLock(path, staleLockMs)
      if (Date.now() >= deadline) {
        throw new Error(`memory store is locked: ${path}`)
      }
      sleepSync(Math.min(retryMs, Math.max(1, deadline - Date.now())))
    }
  }
}

function cleanupStaleLock(path: string, staleLockMs: number): void {
  try {
    const st = statSync(path)
    const pid = Number.parseInt(readFileSync(path, "utf-8").split(/\r?\n/, 1)[0] ?? "", 10)
    if (Number.isFinite(pid) && pid > 0) {
      if (processIsAlive(pid)) return
      unlinkSync(path)
      return
    }
    if (Date.now() - st.mtimeMs < staleLockMs) return
    unlinkSync(path)
  } catch {
    // Another process may have released the lock between stat/read/unlink.
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    const code = (err as { code?: string }).code
    return code === "EPERM"
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function chmodBestEffort(path: string, mode: number): void {
  if (process.platform === "win32") return
  try { chmodSync(path, mode) } catch {}
}

function normalizeTags(tags: string[]): string[] {
  const seen = new Set<string>()
  for (const raw of tags) {
    const tag = oneLine(raw).toLowerCase()
    if (!tag || seen.has(tag)) continue
    seen.add(tag)
  }
  return Array.from(seen).sort((a, b) => a.localeCompare(b))
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim()
}

function indexLabel(name: string, filename: string): string {
  const label = oneLine(name)
    .replace(/[\[\]]/g, "")
    .replace(/([\\()])/g, "\\$1")
    .trim()
  return label || escapeMarkdownInline(oneLine(filename.replace(/\.md$/i, "")))
}

function escapeMarkdownInline(value: string): string {
  return value.replace(/([\\[\]()])/g, "\\$1")
}

function escapeMarkdownDestination(value: string): string {
  return oneLine(value)
    .replace(/ /g, "%20")
    .replace(/([\\()])/g, "\\$1")
}

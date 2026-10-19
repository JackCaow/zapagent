import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { link, mkdir, open, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { OutcomeProtocolError } from "./outcome.js";
import { validateInlineAcceptanceRecord, type InlineAcceptanceRecord, type InlineAcceptanceStore } from "./inline-acceptance.js";

export class InMemoryAcceptanceStore implements InlineAcceptanceStore {
  private readonly records = new Map<string, InlineAcceptanceRecord>();
  async preflight(signal: AbortSignal): Promise<void> { signal.throwIfAborted(); }
  async load(id: string): Promise<InlineAcceptanceRecord | undefined> {
    const record = this.records.get(id);
    return record ? structuredClone(record) : undefined;
  }
  async save(record: InlineAcceptanceRecord): Promise<void> {
    validateInlineAcceptanceRecord(record);
    const existing = this.records.get(record.id);
    if (existing && !isDeepStrictEqual(existing, record)) throw new OutcomeProtocolError("ACCEPTANCE_CONFLICT", "Acceptance record is immutable");
    this.records.set(record.id, structuredClone(record));
  }
}

/** Independent immutable ledger. It never rewrites the Runtime terminal state. */
export class JsonAcceptanceStore implements InlineAcceptanceStore {
  constructor(readonly directory: string) {}

  private path(id: string): string {
    return join(this.directory, `${createHash("sha256").update(id).digest("hex")}.json`);
  }

  async preflight(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const probe = join(this.directory, `.probe-${randomUUID()}`);
    const linked = `${probe}.linked`;
    try {
      const handle = await open(probe, "wx", 0o600);
      try { await handle.sync(); } finally { await handle.close(); }
      // Publish uses no-replace hard links; fail before the model on unsupported filesystems.
      await link(probe, linked);
      signal.throwIfAborted();
    } finally {
      await Promise.all([unlink(probe).catch(() => {}), unlink(linked).catch(() => {})]);
    }
  }

  async load(id: string): Promise<InlineAcceptanceRecord | undefined> {
    let raw: string;
    try { raw = await readFile(this.path(id), "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    const record: unknown = JSON.parse(raw);
    validateInlineAcceptanceRecord(record);
    if (record.id !== id) throw new OutcomeProtocolError("ACCEPTANCE_CONFLICT", "Acceptance record identity mismatch");
    return record;
  }

  async save(input: InlineAcceptanceRecord): Promise<void> {
    const record = structuredClone(input);
    validateInlineAcceptanceRecord(record);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = join(this.directory, `.acceptance-${randomUUID()}.tmp`);
    try {
      const handle = await open(temporary, "wx", 0o600);
      try { await handle.writeFile(JSON.stringify(record) + "\n", "utf8"); await handle.sync(); }
      finally { await handle.close(); }
      try { await link(temporary, this.path(record.id)); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (!isDeepStrictEqual(await this.load(record.id), record)) throw new OutcomeProtocolError("ACCEPTANCE_CONFLICT", "Acceptance record is immutable");
      }
      // POSIX supports syncing the directory entry; Windows does not expose it.
      if (process.platform !== "win32") {
        const directory = await open(this.directory, "r");
        try { await directory.sync(); } finally { await directory.close(); }
      }
    } finally { await unlink(temporary).catch(() => {}); }
  }
}

import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { executionDigest } from "../execution/observation.js";
import { ServiceProtocolError, type ServiceReceipt, type ServiceStartIntent } from "./contracts.js";
import type { ServiceDispatchJournal } from "./client.js";

/** Sole purpose is durable, create-once dispatch/identity binding. It neither
 * stores command bodies nor launches, queries, kills or adopts any process.
 * Host must put this private directory outside Agent-writable paths. */
export class FileServiceDispatchJournal implements ServiceDispatchJournal {
  readonly durability = "durable" as const;
  private root?: Promise<string>;
  constructor(private readonly directory: string) {
    if (process.platform === "win32") throw new ServiceProtocolError("SERVICE_JOURNAL_INVALID", "Durable service file journal requires verified directory fsync semantics; Windows is not supported");
  }
  private location(): Promise<string> {
    return this.root ??= (async () => {
      const path = resolve(this.directory);
      await mkdir(path, { recursive: true, mode: 0o700 });
      const stat = await lstat(path);
      if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) {
        throw new ServiceProtocolError("SERVICE_JOURNAL_INVALID", "Service journal must be a private Host-owned directory");
      }
      return realpath(path);
    })();
  }
  private fields(intent: ServiceStartIntent) {
    return { version: 1, backendId: intent.backendId, ownerId: intent.ownerId, ownerGeneration: intent.ownerGeneration,
      workspaceId: intent.workspaceId, ownerScope: intent.ownerScope, operationId: intent.operationId, requestDigest: intent.requestDigest, expiresAt: intent.expiresAt };
  }
  private async createOnce(intent: ServiceStartIntent, suffix: string, value: Record<string, unknown>): Promise<boolean> {
    const body = JSON.stringify(value) + "\n";
    if (Buffer.byteLength(body) > 4096) throw new ServiceProtocolError("SERVICE_JOURNAL_INVALID", "Service journal binding exceeds its byte limit");
    const root = await this.location();
    const key = executionDigest({ backendId: intent.backendId, ownerId: intent.ownerId, ownerGeneration: intent.ownerGeneration,
      workspaceId: intent.workspaceId, operationId: intent.operationId });
    const path = join(root, `${key}.${suffix}.json`);
    // Publish only fully written/synced bytes. A racing reader never observes
    // the temporary record and cannot mistake an incomplete claim for absence.
    const pending = join(root, `.pending-${randomUUID()}`);
    const handle = await open(pending, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
    try { await handle.writeFile(body); await handle.sync(); }
    finally { await handle.close(); }
    try {
      let created = true;
      try { await link(pending, path); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        created = false;
        const existing = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
          const stat = await existing.stat();
          if (!stat.isFile() || stat.size > 4096 || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) {
            throw new ServiceProtocolError("SERVICE_JOURNAL_INVALID", "Invalid service journal record");
          }
          const bytes = Buffer.alloc(4097);
          const { bytesRead } = await existing.read(bytes, 0, bytes.length, 0);
          if (bytesRead > 4096) throw new ServiceProtocolError("SERVICE_JOURNAL_INVALID", "Oversized service journal record");
          let parsed;
          try { parsed = JSON.parse(bytes.subarray(0, bytesRead).toString("utf8")); }
          catch { throw new ServiceProtocolError("SERVICE_JOURNAL_INVALID", "Incomplete or corrupt service journal record; never redispatch"); }
          if (executionDigest(parsed) !== executionDigest(value)) {
            throw new ServiceProtocolError("SERVICE_OPERATION_CONFLICT", "Operation or service identity changed in the persistent journal");
          }
        } finally { await existing.close(); }
      }
      const directory = await open(root, constants.O_RDONLY);
      try { await directory.sync(); } finally { await directory.close(); }
      return created;
    } finally { await unlink(pending); }
  }
  async bindIntent(intent: ServiceStartIntent): Promise<void> { await this.createOnce(intent, "intent", this.fields(intent)); }
  claimDispatch(intent: ServiceStartIntent): Promise<boolean> { return this.createOnce(intent, "dispatch", this.fields(intent)); }
  async bindReceipt(intent: ServiceStartIntent, receipt: ServiceReceipt): Promise<void> {
    await this.createOnce(intent, "receipt", { ...this.fields(intent), serviceId: receipt.serviceId });
  }
}

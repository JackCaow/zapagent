import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { validateAcceptanceSpec, type AcceptanceSnapshot, type AcceptanceSnapshotProvider, type InlineHostVerifier } from "./inline-acceptance.js";
import { OutcomeProtocolError } from "./outcome.js";

/** Copies declared regular files into bounded, immutable memory. It does not
 * commit or modify the workspace. The host must settle its writers first;
 * this is snapshotting, not an OS sandbox against hostile filesystem races. */
export class FileBytesSnapshotProvider implements AcceptanceSnapshotProvider {
  readonly id = "file-bytes-v1";
  private readonly root: string;
  constructor(root: string, private readonly maxTotalBytes = 16 * 1024 * 1024) {
    this.root = resolve(root);
    if (!Number.isSafeInteger(maxTotalBytes) || maxTotalBytes < 1) throw new Error("Invalid snapshot byte limit");
  }

  async preflight({ spec, signal }: Parameters<AcceptanceSnapshotProvider["preflight"]>[0]): Promise<void> {
    validateAcceptanceSpec(spec);
    signal.throwIfAborted();
    if (!(await lstat(this.root)).isDirectory()) throw new OutcomeProtocolError("INVALID_SNAPSHOT_ROOT", "Snapshot root must be a directory");
  }

  async capture({ spec, signal }: Parameters<AcceptanceSnapshotProvider["capture"]>[0]): Promise<AcceptanceSnapshot | undefined> {
    validateAcceptanceSpec(spec);
    const root = await realpath(this.root);
    const files = new Map<string, Uint8Array>();
    const subjects: AcceptanceSnapshot["subjects"] = [];
    let total = 0;
    for (const subject of spec.subjects) {
      signal.throwIfAborted();
      let path = root;
      let absent = false;
      const parts = subject.path.split("/");
      for (let index = 0; index < parts.length; index++) {
        path = join(path, parts[index]!);
        try {
          const entry = await lstat(path);
          if (entry.isSymbolicLink() || (index < parts.length - 1 ? !entry.isDirectory() : !entry.isFile())) return undefined;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          absent = true;
          break;
        }
      }
      if (absent) {
        subjects.push({ subjectId: subject.id, exists: false, version: "file-bytes:absent" });
        continue;
      }
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const before = await handle.stat({ bigint: true });
        if (!before.isFile() || before.size > BigInt(this.maxTotalBytes - total)) return undefined;
        const bytes = new Uint8Array(Number(before.size));
        let offset = 0;
        while (offset < bytes.length) {
          signal.throwIfAborted();
          const read = await handle.read(bytes, offset, bytes.length - offset, offset);
          if (read.bytesRead === 0) return undefined;
          offset += read.bytesRead;
        }
        const after = await handle.stat({ bigint: true });
        if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) return undefined;
        signal.throwIfAborted();
        total += bytes.length;
        files.set(subject.id, bytes);
        subjects.push({ subjectId: subject.id, exists: true, version: `sha256:${createHash("sha256").update(bytes).digest("hex")}` });
      } finally { await handle.close(); }
    }
    if (await realpath(this.root) !== root) return undefined;
    const id = `file-bytes:${createHash("sha256").update(JSON.stringify(subjects)).digest("hex")}`;
    return { id, providerId: this.id, proof: "immutable_snapshot", subjects,
      async readFile(subjectId, readSignal) {
        readSignal.throwIfAborted();
        const bytes = files.get(subjectId);
        if (!bytes) throw new OutcomeProtocolError("SNAPSHOT_NOT_A_FILE", "Subject is absent or undeclared");
        return bytes.slice();
      },
    };
  }
}

/** Deterministic public byte constraints; maxBytes is inclusive. */
export class FileSizeVerifier implements InlineHostVerifier {
  readonly id = "file-size-v1";
  private readonly limits: Array<{ checkId: string; subjectId: string; maxBytes: number }>;
  constructor(limits: Array<{ checkId: string; subjectId: string; maxBytes: number }>) {
    if (!limits.length || new Set(limits.map(limit => limit.checkId)).size !== limits.length
      || limits.some(limit => !limit.checkId || !limit.subjectId || !Number.isSafeInteger(limit.maxBytes) || limit.maxBytes < 0)) throw new Error("Invalid file size constraints");
    this.limits = structuredClone(limits);
  }

  async preflight({ spec, signal }: Parameters<NonNullable<InlineHostVerifier["preflight"]>>[0]): Promise<void> {
    signal.throwIfAborted();
    const checks = spec.checks.filter(check => check.verifierId === this.id);
    if (checks.length !== this.limits.length || checks.some(check => {
      const limit = this.limits.find(limit => limit.checkId === check.id);
      return !limit || check.subjectIds.length !== 1 || check.subjectIds[0] !== limit.subjectId
        || spec.subjects.find(subject => subject.id === limit.subjectId)?.expected !== "exists";
    })) throw new OutcomeProtocolError("INVALID_SIZE_CHECK", "File size constraints must match declared existing file subjects");
  }

  async verify({ outcome, spec, snapshot, signal }: Parameters<InlineHostVerifier["verify"]>[0]) {
    const results = [];
    for (const check of spec.checks.filter(check => check.verifierId === this.id)) {
      const limit = this.limits.find(limit => limit.checkId === check.id);
      if (!limit || check.subjectIds.length !== 1 || check.subjectIds[0] !== limit.subjectId) throw new OutcomeProtocolError("INVALID_SIZE_CHECK", "File size check configuration does not match the spec");
      const bytes = await snapshot.readFile(limit.subjectId, signal);
      const passed = bytes.length <= limit.maxBytes;
      results.push({ checkId: check.id, attemptId: outcome.attemptId, specId: spec.id, specRevision: spec.revision,
        snapshotId: snapshot.id, dependencies: snapshot.subjects.filter(subject => subject.subjectId === limit.subjectId),
        status: passed ? "passed" as const : "failed" as const, code: passed ? "FILE_SIZE_OK" : "FILE_TOO_LARGE",
        evidenceRefs: [`file-size:${bytes.length}:max:${limit.maxBytes}`],
        publicDiagnostic: { expected: `at most ${limit.maxBytes} bytes`, actual: `${bytes.length} bytes` },
      });
    }
    return results;
  }
}

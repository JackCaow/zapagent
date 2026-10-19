import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import type { AcceptanceSpec } from "./outcome.js";
import { OutcomeProtocolError } from "./outcome.js";
import { validateAcceptanceSpec, type AcceptanceSnapshot, type AcceptanceSnapshotProvider, type SnapshotSubject } from "./inline-acceptance.js";

async function git(root: string, args: string[], signal: AbortSignal, allowedExitCodes = [0]): Promise<Buffer> {
  signal.throwIfAborted();
  return new Promise((resolveResult, reject) => {
    // Disable replacement refs so the object/version ID names the bytes read.
    const child = spawn("git", ["--no-replace-objects", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "-C", root, ...args], {
      signal, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0",
        // check-ignore accepts literal pathnames, but rejects pathspec magic.
        GIT_LITERAL_PATHSPECS: args[0] === "check-ignore" ? "0" : "1" },
    });
    const chunks: Buffer[] = [];
    let errorText = "";
    child.stdout.on("data", chunk => chunks.push(Buffer.from(chunk)));
    child.stderr.on("data", chunk => { errorText = (errorText + String(chunk)).slice(-8192); });
    child.once("error", reject);
    child.once("close", code => code !== null && allowedExitCodes.includes(code) ? resolveResult(Buffer.concat(chunks))
      : reject(new OutcomeProtocolError("GIT_SNAPSHOT_ERROR", errorText || `git exited ${code}`)));
  });
}

/** Snapshot of committed HEAD. Dirty worktrees are deliberately unverified. */
export class GitCommitSnapshotProvider implements AcceptanceSnapshotProvider {
  readonly id = "git-commit-v1";
  private readonly root: string;
  constructor(repositoryRoot: string) { this.root = resolve(repositoryRoot); }

  async preflight({ spec, signal }: { spec: AcceptanceSpec; signal: AbortSignal }): Promise<void> {
    validateAcceptanceSpec(spec);
    const top = (await git(this.root, ["rev-parse", "--show-toplevel"], signal)).toString().trim();
    if (await realpath(top) !== await realpath(this.root)) throw new OutcomeProtocolError("INVALID_SNAPSHOT_ROOT", "Snapshot root must be the repository root");
  }

  async capture({ spec, signal }: Parameters<AcceptanceSnapshotProvider["capture"]>[0]): Promise<AcceptanceSnapshot | undefined> {
    validateAcceptanceSpec(spec);
    const commit = (await git(this.root, ["rev-parse", "--verify", "HEAD^{commit}"], signal)).toString().trim();
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) throw new OutcomeProtocolError("GIT_SNAPSHOT_ERROR", "Invalid commit identity");
    // Includes untracked files. Ignored files and submodule content cannot be subjects.
    const dirty = await git(this.root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none"], signal);
    if (dirty.length || (await git(this.root, ["rev-parse", "--verify", "HEAD^{commit}"], signal)).toString().trim() !== commit) return undefined;
    const index = (await git(this.root, ["ls-files", "-v", "-z"], signal)).toString().split("\0").filter(Boolean);
    if (index.some(entry => /^[a-zS]/.test(entry))) return undefined;
    const objects = new Map<string, { oid: string; type: string }>();
    const subjects: SnapshotSubject[] = [];
    for (const subject of spec.subjects) {
      // An ignored workspace file must not become an accepted deletion merely
      // because it is absent from the committed tree.
      if ((await git(this.root, ["check-ignore", "--no-index", "--", subject.path], signal, [0, 1])).length) return undefined;
      const raw = (await git(this.root, ["ls-tree", "-z", commit, "--", subject.path], signal)).toString();
      if (!raw) {
        subjects.push({ subjectId: subject.id, exists: false, version: `git:${commit}:absent:${subject.path}` });
        continue;
      }
      const entries = raw.split("\0").filter(Boolean);
      const match = entries.length === 1 ? /^(\d+) (blob|tree|commit) ([a-f0-9]+)\t([\s\S]+)$/.exec(entries[0]!) : null;
      if (!match || match[4] !== subject.path || !["100644", "100755", "040000"].includes(match[1]!)) return undefined;
      const [, mode, type, oid] = match;
      objects.set(subject.id, { oid: oid!, type: type! });
      subjects.push({ subjectId: subject.id, exists: true, version: `git:${mode}:${type}:${oid}` });
    }
    const root = this.root;
    return {
      id: `git:${commit}`, providerId: this.id, proof: "immutable_snapshot", subjects,
      async readFile(subjectId, readSignal) {
        const object = objects.get(subjectId);
        if (!object || object.type !== "blob") throw new OutcomeProtocolError("SNAPSHOT_NOT_A_FILE", "Subject is absent or is not a regular file");
        const bytes = await git(root, ["cat-file", "blob", object.oid], readSignal);
        const hash = createHash(object.oid.length === 64 ? "sha256" : "sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
        if (hash !== object.oid) throw new OutcomeProtocolError("SNAPSHOT_OBJECT_CHANGED", "Git blob content does not match its version");
        return new Uint8Array(bytes);
      },
    };
  }
}

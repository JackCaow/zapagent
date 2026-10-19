import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  appendFileSync,
  statSync,
  chmodSync,
} from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import process from "node:process";

/**
 * Persistent state for `/supertask`. Each supertask owns a directory under
 *   <project-cwd>/.zapcode/supertasks/<id>/
 * containing:
 *   - meta.json      run-level metadata
 *   - prd.json       Ralph-style story list with passes:bool
 *   - progress.txt   append-only learnings log
 *   - queue.jsonl    legacy v1 queue (still seeded for back-compat; unused by v2)
 *   - log.md         legacy v1 log (still seeded for back-compat; unused by v2)
 *   - run.sh         generated bash runner (v2)
 *   - PLANNER_BRIEF.md / ITER_BRIEF.md   prompts for each phase
 *   - runner.log     captured stdout/stderr from each nested `zap -p` call
 *   - runner.pid     pid of the detached bash runner while alive
 *   - iter.txt       single-int current iteration number
 *   - done.flag      empty file; existence = terminated
 *
 * Why project-local (vs ~/.zapcode/projects/<flat>/)?
 * The inner `zap -p` invocations run with --cwd <project>. Models reliably
 * write files inside the project — they resist absolute paths under
 * unrelated trees like ~/.zapcode/. Living next to .zapcode/settings.json
 * means the agent can edit prd.json + progress.txt naturally.
 *
 * Design intent: the agent itself does NOT call into this module — it uses
 * raw read_file / write_file with the conventional paths. This module is
 * for the dispatcher (detect unfinished / create / abort / status) and tests.
 */

export type TaskStatus = "pending" | "in_progress" | "done" | "failed" | "blocked";

export interface SupertaskTask {
  id: string;
  status: TaskStatus;
  desc: string;
  acceptance: string;
  deps: string[];
  retry_count: number;
}

export type RunStatus =
  | "running"   // runner is (or was) actively iterating
  | "done"     // every story passes — terminal success
  | "aborted"   // user issued /supertask abort — terminal, intentional
  | "max_iter" // hit the iteration cap without completing
  | "blocked"  // STUCK guard tripped (no pass-count progress)
  | "failed";  // planner phase failed to produce prd.json

/** Statuses that the user can pick up via /supertask resume.
 *  Excludes "done" (already finished) and "aborted" (user intent was to kill
 *  the task — respawning would surprise them). Everything else represents a
 *  state where the work-in-progress on disk is still meaningful and a fresh
 *  spawn can advance it: running (in case of crash without status flip),
 *  blocked (after user fixes the underlying issue), max_iter (after bumping
 *  the cap), or failed (planner crash — resume re-runs Phase 1). */
export const RESUMABLE_STATUSES: ReadonlySet<RunStatus> = new Set([
  "running",
  "blocked",
  "max_iter",
  "failed",
]);

export interface SupertaskMeta {
  id: string;
  desc: string;
  created_at: string;
  iteration_count: number;
  status: RunStatus;
}

export interface SupertaskRef {
  id: string;
  dir: string;
  meta: SupertaskMeta;
}

const SUPERTASKS_SUBDIR = join(".zapcode", "supertasks");
const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

function chmodBestEffort(path: string, mode: number): void {
  if (process.platform === "win32") return;
  try { chmodSync(path, mode); } catch {}
}

function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
  chmodBestEffort(dir, PRIVATE_DIR_MODE);
}

function writePrivateFile(path: string, content: string): void {
  writeFileSync(path, content, { mode: PRIVATE_FILE_MODE });
  chmodBestEffort(path, PRIVATE_FILE_MODE);
}

function appendPrivateFile(path: string, content: string): void {
  appendFileSync(path, content, { mode: PRIVATE_FILE_MODE });
  chmodBestEffort(path, PRIVATE_FILE_MODE);
}

/** Root directory holding every supertask for a given cwd.
 *  Project-local: lives next to .zapcode/settings.json. Add `.zapcode/` to
 *  .gitignore (or just `.zapcode/supertasks/`) if you don't want generated
 *  briefings + iter outputs in the repo. The prd.json + progress.txt are
 *  worth checking in — they're real progress artifacts. */
export function rootDir(cwd: string): string {
  return join(cwd, SUPERTASKS_SUBDIR);
}

/** Directory for a single supertask. */
export function stateDir(cwd: string, id: string): string {
  return join(rootDir(cwd), id);
}

function metaPath(dir: string): string {
  return join(dir, "meta.json");
}
function queuePath(dir: string): string {
  return join(dir, "queue.jsonl");
}
function logPath(dir: string): string {
  return join(dir, "log.md");
}
function donePath(dir: string): string {
  return join(dir, "done.flag");
}

/** yyyymmdd-HHMMSS-<6 hex> — human readable + collision-resistant. */
function newId(now = new Date()): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const ts =
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
    `-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
  const rand = randomBytes(3).toString("hex");
  return `${ts}-${rand}`;
}

/** Create a new supertask state directory and seed meta.json. */
export function createSupertask(cwd: string, desc: string): SupertaskRef {
  const id = newId();
  const dir = stateDir(cwd, id);
  ensurePrivateDir(rootDir(cwd));
  ensurePrivateDir(dir);
  const meta: SupertaskMeta = {
    id,
    desc,
    created_at: new Date().toISOString(),
    iteration_count: 0,
    status: "running",
  };
  writeMeta(dir, meta);
  // Seed empty queue + log so the agent doesn't have to handle ENOENT.
  writePrivateFile(queuePath(dir), "");
  writePrivateFile(logPath(dir), `# Supertask log\n\n${desc}\n\n`);
  return { id, dir, meta };
}

export function readMeta(dir: string): SupertaskMeta {
  return JSON.parse(readFileSync(metaPath(dir), "utf-8"));
}

export function writeMeta(dir: string, m: SupertaskMeta): void {
  writePrivateFile(metaPath(dir), JSON.stringify(m, null, 2) + "\n");
}

export function readQueue(dir: string): SupertaskTask[] {
  let raw = "";
  try {
    raw = readFileSync(queuePath(dir), "utf-8");
  } catch {
    return [];
  }
  const tasks: SupertaskTask[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      tasks.push(JSON.parse(trimmed));
    } catch {
      // Skip malformed lines silently — the agent may have written a
      // partial JSON line; surfacing this as an error breaks /status.
    }
  }
  return tasks;
}

export function writeQueue(dir: string, tasks: SupertaskTask[]): void {
  const body = tasks.map((t) => JSON.stringify(t)).join("\n");
  writePrivateFile(queuePath(dir), body ? body + "\n" : "");
}

export function appendLog(dir: string, entry: string): void {
  const text = entry.endsWith("\n") ? entry : entry + "\n";
  appendPrivateFile(logPath(dir), text);
}

/** Return the last N non-empty lines of the log (whole log if smaller). */
export function readLogTail(dir: string, n: number): string {
  let raw = "";
  try {
    raw = readFileSync(logPath(dir), "utf-8");
  } catch {
    return "";
  }
  const lines = raw.split("\n");
  if (lines.length <= n) return raw;
  return lines.slice(-n).join("\n");
}

export function markDone(dir: string): void {
  writePrivateFile(donePath(dir), "");
  const meta = readMeta(dir);
  writeMeta(dir, { ...meta, status: "done" });
}

export function isDone(dir: string): boolean {
  return existsSync(donePath(dir));
}

/** Remove a supertask directory entirely. Idempotent. */
export function abort(cwd: string, id: string): void {
  rmSync(stateDir(cwd, id), { recursive: true, force: true });
}

/** All supertasks for this cwd, newest first. */
export function listSupertasks(cwd: string): SupertaskRef[] {
  const root = rootDir(cwd);
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  const refs: SupertaskRef[] = [];
  for (const id of entries) {
    const dir = join(root, id);
    try {
      if (!statSync(dir).isDirectory()) continue;
      const meta = readMeta(dir);
      refs.push({ id, dir, meta });
    } catch {
      // Skip half-broken entries rather than failing the whole list.
    }
  }
  // Newest first by created_at.
  refs.sort((a, b) => (a.meta.created_at < b.meta.created_at ? 1 : -1));
  return refs;
}

/** Most recent supertask whose run status is still "running" and which has
 *  no done.flag. Used to detect "you already have an actively-iterating one
 *  in flight"; does NOT include blocked / max_iter / failed runs. Prefer
 *  findResumable() unless you specifically need "is the runner alive". */
export function findUnfinished(cwd: string): SupertaskRef | null {
  for (const ref of listSupertasks(cwd)) {
    if (ref.meta.status === "running" && !isDone(ref.dir)) return ref;
  }
  return null;
}

/** Most recent supertask in any RESUMABLE_STATUSES state. Used by
 *  /supertask resume, /supertask abort, /supertask status, and the
 *  "you already have one — handle it first" check on /supertask <new>.
 *
 *  A blocked-from-429 run, a max_iter run, even a planner-failed run — all
 *  of these have meaningful state on disk and should be reachable, not
 *  silently orphaned. Previously findUnfinished() only matched "running",
 *  which left users with a blocked run unable to resume OR abort it through
 *  the CLI (had to rm -rf the state dir manually). That was the bug. */
export function findResumable(cwd: string): SupertaskRef | null {
  for (const ref of listSupertasks(cwd)) {
    if (RESUMABLE_STATUSES.has(ref.meta.status) && !isDone(ref.dir)) return ref;
  }
  return null;
}

/** Flip meta.status. Used by resume to mark a blocked/max_iter run as
 *  running again before respawning, and as a defensive helper for callers
 *  that need to transition status without rewriting the whole meta blob. */
export function setMetaStatus(dir: string, status: RunStatus): void {
  const meta = readMeta(dir);
  writeMeta(dir, { ...meta, status });
}

/** Convenience: pending + in_progress + blocked counts for /status output. */
export function queueSummary(dir: string): {
  pending: number;
  in_progress: number;
  done: number;
  failed: number;
  blocked: number;
  total: number;
} {
  const q = readQueue(dir);
  const summary = { pending: 0, in_progress: 0, done: 0, failed: 0, blocked: 0, total: q.length };
  for (const t of q) summary[t.status]++;
  return summary;
}

// ──────────────────────────────────────────────────────────────────────
// Ralph-style state (prd.json + progress.txt + runner.pid + iter.txt)
//
// These live alongside the legacy queue.jsonl/log.md set during the
// transition. New /supertask runs use the Ralph layout exclusively; the
// legacy helpers above are kept for tests + back-compat status reads.

export interface PrdStory {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  priority: number;
  passes: boolean;
  notes?: string;
}

export interface Prd {
  project: string;
  description: string;
  userStories: PrdStory[];
}

export function prdPath(dir: string): string {
  return join(dir, "prd.json");
}
export function progressPath(dir: string): string {
  return join(dir, "progress.txt");
}
function pidPath(dir: string): string {
  return join(dir, "runner.pid");
}
function iterPath(dir: string): string {
  return join(dir, "iter.txt");
}

/** Read prd.json; returns null if missing (planner hasn't run yet) or unparseable. */
export function readPrd(dir: string): Prd | null {
  try {
    const raw = readFileSync(prdPath(dir), "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.userStories)) return null;
    return parsed as Prd;
  } catch {
    return null;
  }
}

export function writePrd(dir: string, prd: Prd): void {
  writePrivateFile(prdPath(dir), JSON.stringify(prd, null, 2) + "\n");
}

/** Returns true only when every story has passes:true. Empty userStories →
 *  false (we treat "no plan yet" as not done; only the explicit COMPLETE
 *  sentinel from the runner flips meta.status to done). */
export function allPassed(prd: Prd): boolean {
  if (prd.userStories.length === 0) return false;
  return prd.userStories.every((s) => s.passes === true);
}

export function prdSummary(prd: Prd): { passed: number; remaining: number; total: number; next?: PrdStory } {
  const passed = prd.userStories.filter((s) => s.passes).length;
  const remaining = prd.userStories.length - passed;
  // Lowest-priority-number, unsorted-stable. Matches what the iter agent picks.
  const next = prd.userStories
    .filter((s) => !s.passes)
    .reduce<PrdStory | undefined>((acc, s) => (acc && acc.priority <= s.priority ? acc : s), undefined);
  return { passed, remaining, total: prd.userStories.length, next };
}

export function appendProgress(dir: string, text: string): void {
  const body = text.endsWith("\n") ? text : text + "\n";
  appendPrivateFile(progressPath(dir), body);
}

export function readProgressTail(dir: string, n: number): string {
  let raw = "";
  try {
    raw = readFileSync(progressPath(dir), "utf-8");
  } catch {
    return "";
  }
  const lines = raw.split("\n");
  if (lines.length <= n) return raw;
  return lines.slice(-n).join("\n");
}

/** Pid of the detached bash runner, or null if no pid file / unparseable. */
export function readRunnerPid(dir: string): number | null {
  try {
    const raw = readFileSync(pidPath(dir), "utf-8").trim();
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/** True iff the recorded pid is still a live process. signal 0 is the
 *  classic "just check existence" probe — throws ESRCH when the pid is gone
 *  or EPERM if we lack permission (treat both as "not ours / not alive"). */
export function isRunnerAlive(dir: string): boolean {
  const pid = readRunnerPid(dir);
  if (pid === null) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Current iteration number written by the bash loop. 0 if not yet running. */
export function readIter(dir: string): number {
  try {
    const raw = readFileSync(iterPath(dir), "utf-8").trim();
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

/** Clear stale pid file (e.g. before respawning after a crash). */
export function clearRunnerPid(dir: string): void {
  try { rmSync(pidPath(dir), { force: true }); } catch {}
}

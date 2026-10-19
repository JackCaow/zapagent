import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test"
import { chmodSync, mkdirSync, rmSync, writeFileSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  createSupertask,
  findUnfinished,
  findResumable,
  listSupertasks,
  readQueue,
  writeQueue,
  appendLog,
  readLogTail,
  markDone,
  isDone,
  abort,
  queueSummary,
  readMeta,
  writeMeta,
  setMetaStatus,
  rootDir,
  stateDir,
  readPrd,
  writePrd,
  allPassed,
  prdSummary,
  appendProgress,
  readProgressTail,
  readIter,
  isRunnerAlive,
  readRunnerPid,
  clearRunnerPid,
  prdPath,
  progressPath,
  RESUMABLE_STATUSES,
  type SupertaskTask,
  type Prd,
  type RunStatus,
} from "../../supertask/state.js"

// v2 (Ralph) stores state at <cwd>/.zapcode/supertasks/<id>/ — project-local,
// no environment shenanigans needed. Each test gets a fresh tmpdir as cwd.
let CWD = ""

beforeAll(() => {
  CWD = join(tmpdir(), `zapcode-supertask-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
})

afterAll(() => {
  rmSync(CWD, { recursive: true, force: true })
})

beforeEach(() => {
  // Wipe just this cwd's supertask root between tests so each test sees an empty list.
  rmSync(rootDir(CWD), { recursive: true, force: true })
})

describe("supertask/state", () => {
  it("createSupertask seeds a state directory with meta + empty queue + log header", () => {
    const ref = createSupertask(CWD, "refactor auth")
    expect(ref.id.length).toBeGreaterThan(0)
    expect(ref.dir).toBe(stateDir(CWD, ref.id))

    const meta = readMeta(ref.dir)
    expect(meta.desc).toBe("refactor auth")
    expect(meta.iteration_count).toBe(0)
    expect(meta.status).toBe("running")

    expect(readQueue(ref.dir)).toEqual([])
    expect(readLogTail(ref.dir, 100)).toContain("refactor auth")
    expect(isDone(ref.dir)).toBe(false)
  })

  it("creates supertask state files with owner-only permissions", () => {
    if (process.platform === "win32") return
    const ref = createSupertask(CWD, "private goal")

    expect(statSync(rootDir(CWD)).mode & 0o777).toBe(0o700)
    expect(statSync(ref.dir).mode & 0o777).toBe(0o700)
    expect(statSync(join(ref.dir, "meta.json")).mode & 0o777).toBe(0o600)
    expect(statSync(join(ref.dir, "queue.jsonl")).mode & 0o777).toBe(0o600)
    expect(statSync(join(ref.dir, "log.md")).mode & 0o777).toBe(0o600)
  })

  it("tightens broad permissions when rewriting or appending state files", () => {
    if (process.platform === "win32") return
    const ref = createSupertask(CWD, "private goal")
    const queue = join(ref.dir, "queue.jsonl")
    const log = join(ref.dir, "log.md")
    const prd = prdPath(ref.dir)
    const progress = progressPath(ref.dir)

    for (const path of [queue, log, prd, progress]) {
      writeFileSync(path, "old", { mode: 0o666 })
      chmodSync(path, 0o666)
    }

    writeQueue(ref.dir, [])
    appendLog(ref.dir, "log line")
    writePrd(ref.dir, { project: "p", description: "d", userStories: [] })
    appendProgress(ref.dir, "progress line")

    expect(statSync(queue).mode & 0o777).toBe(0o600)
    expect(statSync(log).mode & 0o777).toBe(0o600)
    expect(statSync(prd).mode & 0o777).toBe(0o600)
    expect(statSync(progress).mode & 0o777).toBe(0o600)
  })

  it("ids are unique across rapid creates", () => {
    const a = createSupertask(CWD, "a")
    const b = createSupertask(CWD, "b")
    expect(a.id).not.toBe(b.id)
  })

  it("queue round-trips through writeQueue / readQueue", () => {
    const ref = createSupertask(CWD, "x")
    const tasks: SupertaskTask[] = [
      { id: "t1", status: "pending", desc: "do thing", acceptance: "tests pass", deps: [], retry_count: 0 },
      { id: "t2", status: "in_progress", desc: "do other thing", acceptance: "lint clean", deps: ["t1"], retry_count: 1 },
    ]
    writeQueue(ref.dir, tasks)
    expect(readQueue(ref.dir)).toEqual(tasks)
  })

  it("readQueue ignores malformed JSON lines", () => {
    const ref = createSupertask(CWD, "x")
    writeFileSync(
      join(ref.dir, "queue.jsonl"),
      `{"id":"t1","status":"pending","desc":"ok","acceptance":"","deps":[],"retry_count":0}\nNOT JSON\n\n{"id":"t2","status":"done","desc":"ok2","acceptance":"","deps":[],"retry_count":0}\n`,
    )
    const q = readQueue(ref.dir)
    expect(q.map((t) => t.id)).toEqual(["t1", "t2"])
  })

  it("appendLog appends and readLogTail returns the last N lines", () => {
    const ref = createSupertask(CWD, "x")
    for (let i = 0; i < 10; i++) appendLog(ref.dir, `line ${i}`)
    const tail = readLogTail(ref.dir, 3)
    expect(tail).toContain("line 9")
    expect(tail).not.toContain("line 0")
  })

  it("markDone flips meta.status + writes done.flag", () => {
    const ref = createSupertask(CWD, "x")
    markDone(ref.dir)
    expect(isDone(ref.dir)).toBe(true)
    expect(readMeta(ref.dir).status).toBe("done")
  })

  it("abort removes the directory entirely", () => {
    const ref = createSupertask(CWD, "x")
    abort(CWD, ref.id)
    expect(listSupertasks(CWD)).toEqual([])
  })

  it("findUnfinished returns the most recent running supertask, ignores done ones", () => {
    const old = createSupertask(CWD, "old")
    markDone(old.dir)
    // Force a different timestamp on the new one (createdAt resolution is 1s).
    const newer = createSupertask(CWD, "newer")
    // Override created_at to make sort order deterministic in case the two
    // landed in the same second.
    const meta = readMeta(newer.dir)
    writeMeta(newer.dir, { ...meta, created_at: new Date(Date.now() + 1000).toISOString() })

    const u = findUnfinished(CWD)
    expect(u?.id).toBe(newer.id)
  })

  it("findUnfinished returns null when none are running", () => {
    const ref = createSupertask(CWD, "x")
    markDone(ref.dir)
    expect(findUnfinished(CWD)).toBeNull()
  })

  it("findUnfinished excludes blocked/max_iter/failed (strict 'running' filter)", () => {
    // These states would be returned by findResumable; findUnfinished is the
    // narrower "is the runner actively iterating" predicate.
    for (const status of ["blocked", "max_iter", "failed"] as const) {
      const ref = createSupertask(CWD, `t-${status}`)
      setMetaStatus(ref.dir, status)
      expect(findUnfinished(CWD)).toBeNull()
      abort(CWD, ref.id) // clean up for next iteration
    }
  })

  it("findResumable returns running tasks (back-compat with findUnfinished)", () => {
    const ref = createSupertask(CWD, "x")
    expect(findResumable(CWD)?.id).toBe(ref.id)
  })

  it("findResumable returns blocked / max_iter / failed tasks (this is the whole point)", () => {
    // Empirical regression: a kiro-pool 429 made the runner trip the STUCK
    // guard and flip meta.status to "blocked". The user had no way to /supertask
    // resume because findUnfinished only matched "running". findResumable fixes
    // exactly this case.
    for (const status of ["blocked", "max_iter", "failed"] as const) {
      const ref = createSupertask(CWD, `t-${status}`)
      setMetaStatus(ref.dir, status)
      const found = findResumable(CWD)
      expect(found?.id).toBe(ref.id)
      expect(found?.meta.status).toBe(status)
      abort(CWD, ref.id)
    }
  })

  it("findResumable excludes done and aborted (terminal states)", () => {
    // done: success — nothing to resume.
    const okay = createSupertask(CWD, "okay")
    markDone(okay.dir) // sets status=done AND writes done.flag
    expect(findResumable(CWD)).toBeNull()
    abort(CWD, okay.id)

    // aborted: user said no — respawning would be surprising.
    const killed = createSupertask(CWD, "killed")
    setMetaStatus(killed.dir, "aborted")
    expect(findResumable(CWD)).toBeNull()
  })

  it("findResumable picks the newest resumable task when several exist", () => {
    const old = createSupertask(CWD, "old")
    setMetaStatus(old.dir, "blocked")
    const newer = createSupertask(CWD, "newer")
    setMetaStatus(newer.dir, "max_iter")
    // Force a different timestamp on the newer one so the sort is deterministic.
    const meta = readMeta(newer.dir)
    writeMeta(newer.dir, { ...meta, created_at: new Date(Date.now() + 5000).toISOString() })
    expect(findResumable(CWD)?.id).toBe(newer.id)
  })

  it("RESUMABLE_STATUSES is exactly the set findResumable matches", () => {
    // Pin the contract: any change to RESUMABLE_STATUSES must be intentional.
    const all: RunStatus[] = ["running", "done", "aborted", "max_iter", "blocked", "failed"]
    for (const s of all) {
      const expected = !(s === "done" || s === "aborted")
      expect(RESUMABLE_STATUSES.has(s)).toBe(expected)
    }
  })

  it("setMetaStatus flips status while preserving every other meta field", () => {
    const ref = createSupertask(CWD, "preserve me")
    const before = readMeta(ref.dir)
    setMetaStatus(ref.dir, "blocked")
    const after = readMeta(ref.dir)
    expect(after.status).toBe("blocked")
    // Everything else must round-trip identically — desc, id, created_at, etc.
    expect(after.id).toBe(before.id)
    expect(after.desc).toBe(before.desc)
    expect(after.created_at).toBe(before.created_at)
    expect(after.iteration_count).toBe(before.iteration_count)
  })

  it("listSupertasks skips entries without a readable meta.json", () => {
    const ref = createSupertask(CWD, "ok")
    // Drop a broken sibling — no meta.json inside.
    mkdirSync(join(rootDir(CWD), "20000101-000000-deadbe"), { recursive: true })
    const refs = listSupertasks(CWD)
    expect(refs.map((r) => r.id)).toEqual([ref.id])
  })

  it("rootDir is project-local (.zapcode/supertasks under cwd)", () => {
    // v2 store lives inside the project — no flattening, no appdata path.
    // The inner `zap -p` invocations are reliably willing to write inside
    // their cwd; they resist absolute paths under unrelated trees, so we
    // put state right next to where they're working.
    expect(rootDir("/Users/foo/repo")).toBe(join("/Users/foo/repo", ".zapcode", "supertasks"))
  })

  it("queueSummary counts statuses correctly", () => {
    const ref = createSupertask(CWD, "x")
    writeQueue(ref.dir, [
      { id: "a", status: "pending", desc: "", acceptance: "", deps: [], retry_count: 0 },
      { id: "b", status: "pending", desc: "", acceptance: "", deps: [], retry_count: 0 },
      { id: "c", status: "in_progress", desc: "", acceptance: "", deps: [], retry_count: 0 },
      { id: "d", status: "done", desc: "", acceptance: "", deps: [], retry_count: 0 },
      { id: "e", status: "blocked", desc: "", acceptance: "", deps: [], retry_count: 3 },
    ])
    const s = queueSummary(ref.dir)
    expect(s).toEqual({ pending: 2, in_progress: 1, done: 1, failed: 0, blocked: 1, total: 5 })
  })
})

describe("supertask/state — Ralph helpers", () => {
  it("readPrd returns null when prd.json is missing", () => {
    const ref = createSupertask(CWD, "x")
    expect(readPrd(ref.dir)).toBeNull()
  })

  it("readPrd returns null when prd.json is malformed", () => {
    const ref = createSupertask(CWD, "x")
    writeFileSync(prdPath(ref.dir), "{not json")
    expect(readPrd(ref.dir)).toBeNull()
  })

  it("readPrd returns null when userStories is missing or not an array", () => {
    const ref = createSupertask(CWD, "x")
    writeFileSync(prdPath(ref.dir), JSON.stringify({ project: "p", description: "d" }))
    expect(readPrd(ref.dir)).toBeNull()
  })

  it("writePrd / readPrd round-trip", () => {
    const ref = createSupertask(CWD, "x")
    const prd: Prd = {
      project: "p",
      description: "x",
      userStories: [
        { id: "US-001", title: "t1", description: "d1", acceptanceCriteria: ["a1"], priority: 1, passes: false, notes: "" },
        { id: "US-002", title: "t2", description: "d2", acceptanceCriteria: ["a2", "a3"], priority: 2, passes: true, notes: "" },
      ],
    }
    writePrd(ref.dir, prd)
    expect(readPrd(ref.dir)).toEqual(prd)
  })

  it("allPassed: true only when every story passes", () => {
    expect(allPassed({ project: "p", description: "d", userStories: [] })).toBe(false)
    expect(allPassed({
      project: "p", description: "d",
      userStories: [
        { id: "1", title: "", description: "", acceptanceCriteria: [], priority: 1, passes: true },
        { id: "2", title: "", description: "", acceptanceCriteria: [], priority: 2, passes: false },
      ],
    })).toBe(false)
    expect(allPassed({
      project: "p", description: "d",
      userStories: [
        { id: "1", title: "", description: "", acceptanceCriteria: [], priority: 1, passes: true },
        { id: "2", title: "", description: "", acceptanceCriteria: [], priority: 2, passes: true },
      ],
    })).toBe(true)
  })

  it("prdSummary picks the lowest-priority pending story as next", () => {
    const prd: Prd = {
      project: "p", description: "d",
      userStories: [
        { id: "1", title: "first",  description: "", acceptanceCriteria: [], priority: 1, passes: true },
        { id: "2", title: "second", description: "", acceptanceCriteria: [], priority: 2, passes: false },
        { id: "3", title: "third",  description: "", acceptanceCriteria: [], priority: 3, passes: false },
      ],
    }
    const s = prdSummary(prd)
    expect(s).toEqual({ passed: 1, remaining: 2, total: 3, next: prd.userStories[1] })
  })

  it("prdSummary returns no next when everything passes", () => {
    const prd: Prd = {
      project: "p", description: "d",
      userStories: [
        { id: "1", title: "", description: "", acceptanceCriteria: [], priority: 1, passes: true },
      ],
    }
    expect(prdSummary(prd).next).toBeUndefined()
  })

  it("appendProgress appends, never rewrites", () => {
    const ref = createSupertask(CWD, "x")
    appendProgress(ref.dir, "line one")
    appendProgress(ref.dir, "line two")
    const raw = readFileSync(progressPath(ref.dir), "utf-8")
    expect(raw).toContain("line one")
    expect(raw).toContain("line two")
    expect(raw.indexOf("line one")).toBeLessThan(raw.indexOf("line two"))
  })

  it("readProgressTail returns the last N lines", () => {
    const ref = createSupertask(CWD, "x")
    for (let i = 0; i < 12; i++) appendProgress(ref.dir, `entry ${i}`)
    const tail = readProgressTail(ref.dir, 3)
    expect(tail).toContain("entry 11")
    expect(tail).not.toContain("entry 0")
  })

  it("readIter is 0 by default, parses iter.txt when present", () => {
    const ref = createSupertask(CWD, "x")
    expect(readIter(ref.dir)).toBe(0)
    writeFileSync(join(ref.dir, "iter.txt"), "7\n")
    expect(readIter(ref.dir)).toBe(7)
    // Garbage falls back to 0.
    writeFileSync(join(ref.dir, "iter.txt"), "not-a-number")
    expect(readIter(ref.dir)).toBe(0)
  })

  it("readRunnerPid returns null when pid file missing, parses when present", () => {
    const ref = createSupertask(CWD, "x")
    expect(readRunnerPid(ref.dir)).toBeNull()
    writeFileSync(join(ref.dir, "runner.pid"), "12345\n")
    expect(readRunnerPid(ref.dir)).toBe(12345)
  })

  it("isRunnerAlive returns true for self pid, false for impossible pid", () => {
    const ref = createSupertask(CWD, "x")
    // Our own pid IS alive.
    writeFileSync(join(ref.dir, "runner.pid"), String(process.pid))
    expect(isRunnerAlive(ref.dir)).toBe(true)
    // pid 2^22 is far above typical PID_MAX on macOS/Linux — guaranteed absent.
    writeFileSync(join(ref.dir, "runner.pid"), "4194303")
    expect(isRunnerAlive(ref.dir)).toBe(false)
    // No pid file at all.
    rmSync(join(ref.dir, "runner.pid"))
    expect(isRunnerAlive(ref.dir)).toBe(false)
  })

  it("clearRunnerPid is idempotent", () => {
    const ref = createSupertask(CWD, "x")
    writeFileSync(join(ref.dir, "runner.pid"), "1")
    clearRunnerPid(ref.dir)
    expect(readRunnerPid(ref.dir)).toBeNull()
    // Second call doesn't throw.
    clearRunnerPid(ref.dir)
  })
})

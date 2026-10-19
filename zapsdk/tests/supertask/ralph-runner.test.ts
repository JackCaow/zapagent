import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test"
import { rmSync, readFileSync, statSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  generateRalphArtifacts,
  shellQuote,
  RALPH_DEFAULT_MAX_ITER,
  RALPH_MAX_TURNS_PER_ITER,
} from "../../supertask/ralph-runner.js"

// Per-test tmpdir as scratch space — runner generation is filesystem-heavy
// but project-local in v2, so no ZAPCODE_DATA_DIR override needed.
let SCRATCH = ""
const CWD = "/some/fake/project"

beforeAll(() => {
  SCRATCH = join(tmpdir(), `zapcode-ralph-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(SCRATCH, { recursive: true })
})

afterAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true })
})

function makeStateDir(): string {
  const dir = join(SCRATCH, "state-" + Math.random().toString(36).slice(2))
  mkdirSync(dir, { recursive: true })
  return dir
}

describe("ralph-runner/shellQuote", () => {
  it("wraps plain strings in single quotes", () => {
    expect(shellQuote("hello")).toBe("'hello'")
  })

  it("escapes embedded single quotes via the POSIX dance", () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`)
  })

  it("preserves spaces and special chars inside the quotes", () => {
    expect(shellQuote("foo bar $baz `qux`")).toBe("'foo bar $baz `qux`'")
  })

  it("handles empty string", () => {
    expect(shellQuote("")).toBe("''")
  })
})

describe("ralph-runner/generateRalphArtifacts", () => {
  let stateDir = ""
  beforeEach(() => {
    stateDir = makeStateDir()
  })

  it("writes all three artifacts and reports correct paths", () => {
    const arts = generateRalphArtifacts({
      stateDir,
      projectDir: CWD,
      desc: "rebuild thing in rust",
      zapInterp: "/usr/local/bin/bun",
      zapScript: "/path/to/zapcode/src/index.tsx",
    })
    expect(arts.scriptPath).toBe(join(stateDir, "run.sh"))
    expect(arts.plannerBriefPath).toBe(join(stateDir, "PLANNER_BRIEF.md"))
    expect(arts.iterBriefPath).toBe(join(stateDir, "ITER_BRIEF.md"))
    expect(arts.logPath).toBe(join(stateDir, "runner.log"))
    expect(arts.maxIter).toBe(RALPH_DEFAULT_MAX_ITER)
    expect(arts.maxTurnsPerIter).toBe(RALPH_MAX_TURNS_PER_ITER)
    // Files actually exist on disk.
    expect(statSync(arts.scriptPath).isFile()).toBe(true)
    expect(statSync(arts.plannerBriefPath).isFile()).toBe(true)
    expect(statSync(arts.iterBriefPath).isFile()).toBe(true)
  })

  it("run.sh is executable", () => {
    const arts = generateRalphArtifacts({
      stateDir,
      projectDir: CWD,
      desc: "x",
      zapInterp: "/bun",
      zapScript: "/zap",
    })
    const mode = statSync(arts.scriptPath).mode
    // owner-execute bit (0o100) must be set after chmod 0700.
    expect(mode & 0o100).toBeGreaterThan(0)
  })

  it("writes generated runner artifacts with private permissions", () => {
    if (process.platform === "win32") return
    const arts = generateRalphArtifacts({
      stateDir,
      projectDir: CWD,
      desc: "private goal",
      zapInterp: "/bun",
      zapScript: "/zap",
    })

    expect(statSync(stateDir).mode & 0o777).toBe(0o700)
    expect(statSync(arts.plannerBriefPath).mode & 0o777).toBe(0o600)
    expect(statSync(arts.iterBriefPath).mode & 0o777).toBe(0o600)
    expect(statSync(arts.scriptPath).mode & 0o777).toBe(0o700)
  })

  it("planner brief mentions the goal and absolute prd.json path", () => {
    const arts = generateRalphArtifacts({
      stateDir,
      projectDir: CWD,
      desc: "GOAL-SENTINEL-XYZ",
      zapInterp: "/bun",
      zapScript: "/zap",
    })
    const body = readFileSync(arts.plannerBriefPath, "utf-8")
    expect(body).toContain("GOAL-SENTINEL-XYZ")
    expect(body).toContain(join(stateDir, "prd.json"))
    // Planner must NOT mention implementing — that's for iter brief.
    expect(body).toMatch(/Do NOT modify any project source files this turn/i)
  })

  it("iter brief mentions both state files and the COMPLETE sentinel", () => {
    const arts = generateRalphArtifacts({
      stateDir,
      projectDir: CWD,
      desc: "x",
      zapInterp: "/bun",
      zapScript: "/zap",
    })
    const body = readFileSync(arts.iterBriefPath, "utf-8")
    expect(body).toContain(join(stateDir, "prd.json"))
    expect(body).toContain(join(stateDir, "progress.txt"))
    expect(body).toContain("<promise>COMPLETE</promise>")
    expect(body).toContain(CWD)
    // The "ONE story per iteration" invariant must survive any refactor.
    expect(body).toMatch(/ONE story per iteration/i)
  })

  it("iter brief carries the hardened contract (non-interactive, git-log, timeout, PARTIAL, mandatory progress)", () => {
    // Empirical failure mode: the agent treated ITER_BRIEF as a conversation,
    // ended turn 1 with "What feature should I implement next?", and never
    // wrote to progress.txt. The next 3 iters re-discovered the same wall
    // ("Waiting for the build to complete.") and the STUCK guard tripped at
    // 0/15 passes. The hardened brief addresses each root cause; pin those
    // pieces so a future refactor doesn't soften them.
    const arts = generateRalphArtifacts({
      stateDir,
      projectDir: CWD,
      desc: "x",
      zapInterp: "/bun",
      zapScript: "/zap",
    })
    const body = readFileSync(arts.iterBriefPath, "utf-8")
    // 1. Non-interactive framing.
    expect(body).toMatch(/not in a conversation/i)
    expect(body).toMatch(/NEVER end your turn with a question/i)
    // 2. Git-log reconciliation step (handles "prior iter did the work but
    //    forgot to flip the flag" — common Ralph failure mode).
    expect(body).toMatch(/git[^\n]*log[^\n]*--oneline/i)
    expect(body).toMatch(/RECONCILE git vs PRD/i)
    // 3. 120s shell timeout discipline.
    expect(body).toContain("timeout 120")
    // 4. PARTIAL bucket exists — keeps long-build / missing-tool iters
    //    from collapsing into a misleading "FAIL".
    expect(body).toContain("PARTIAL")
    // 5. Mandatory progress.txt clause (mirrors the runner-side check).
    expect(body).toMatch(/MANDATORY/i)
    // 6. Greenfield rule — don't refuse to mark passes:true just because
    //    there's no test suite yet.
    expect(body).toMatch(/greenfield/i)
  })

  it("run.sh defines salvage_uncommitted and calls it from STUCK + max_iter exit paths", () => {
    // Empirical failure mode (round 3 of the idphoto-camera supertask):
    // agent finished US-015's work, hit max_turns waiting on a slow gradle
    // build, exited without committing. Next iter saw a dirty working tree
    // it couldn't attribute, and the work was an ill-timed git reset from
    // disappearing. Salvage commits any uncommitted work BEFORE the runner
    // dies on STUCK or max_iter, so resume has something concrete to read.
    const arts = generateRalphArtifacts({
      stateDir,
      projectDir: CWD,
      desc: "x",
      zapInterp: "/bun",
      zapScript: "/zap",
    })
    const script = readFileSync(arts.scriptPath, "utf-8")
    // Function defined.
    expect(script).toMatch(/^salvage_uncommitted\s*\(\)\s*\{/m)
    // Called from STUCK abort path (must come BEFORE set_meta_status blocked).
    const stuckBlock = script.slice(script.indexOf("⚠ stuck at"), script.indexOf("exit 3"))
    expect(stuckBlock).toContain('salvage_uncommitted "STUCK abort"')
    expect(stuckBlock.indexOf('salvage_uncommitted')).toBeLessThan(stuckBlock.indexOf("set_meta_status blocked"))
    // Called from max_iter path.
    const maxIterBlock = script.slice(script.indexOf("reached max_iter"))
    expect(maxIterBlock).toContain('salvage_uncommitted "max_iter"')
    expect(maxIterBlock.indexOf('salvage_uncommitted')).toBeLessThan(maxIterBlock.indexOf("set_meta_status max_iter"))
    // NOT called from the signal trap (intentional abort = user wants to
    // discard, not preserve).
    const trapLine = script.split("\n").find((l) => l.includes("trap '") && l.includes("INT TERM"))!
    expect(trapLine).not.toContain("salvage_uncommitted")
  })

  it("salvage commit message is intentionally UN-tagged with [US-XXX]", () => {
    // ITER_BRIEF's step-3 reconciliation auto-flips passes:true when it
    // sees a commit tagged [supertask] [US-XXX]. Salvage may span multiple
    // stories or be exploration cruft, so we deliberately omit the story
    // tag — next iter (or human) must inspect, not auto-claim.
    const arts = generateRalphArtifacts({
      stateDir,
      projectDir: CWD,
      desc: "x",
      zapInterp: "/bun",
      zapScript: "/zap",
    })
    const script = readFileSync(arts.scriptPath, "utf-8")
    // The salvage commit message string lives inline; match it and assert
    // no [US- substring within the commit message itself.
    const msgMatch = script.match(/git\s+-C\s+"\$PROJECT_DIR"\s+commit\s+-m\s+"([^"]*salvage[^"]*)"/)
    expect(msgMatch).not.toBeNull()
    expect(msgMatch![1]!).not.toMatch(/\[US-/)
  })

  it("salvage_uncommitted no-ops on non-git directories and clean working trees (defensive)", () => {
    // Grep for the three guard conditions inline. We don't run the script
    // here — these are static-structure assertions on the generated bash.
    const arts = generateRalphArtifacts({
      stateDir,
      projectDir: CWD,
      desc: "x",
      zapInterp: "/bun",
      zapScript: "/zap",
    })
    const script = readFileSync(arts.scriptPath, "utf-8")
    // git rev-parse --git-dir guard (not-a-repo).
    expect(script).toMatch(/rev-parse\s+--git-dir/)
    // diff --quiet + diff --cached --quiet + ls-files --others compound.
    expect(script).toContain("diff --quiet")
    expect(script).toContain("diff --cached --quiet")
    expect(script).toContain("ls-files --others --exclude-standard")
  })

  it("run.sh snapshots progress.txt size and logs a contract-violation warning when unchanged", () => {
    // The agent-side contract is "every iter appends to progress.txt".
    // The runner enforces visibility (not abort) by comparing wc -c
    // before/after. Use wc -c instead of stat because macOS \`stat -f%z\`
    // and Linux \`stat -c%s\` aren't interchangeable.
    const arts = generateRalphArtifacts({
      stateDir,
      projectDir: CWD,
      desc: "x",
      zapInterp: "/bun",
      zapScript: "/zap",
    })
    const script = readFileSync(arts.scriptPath, "utf-8")
    expect(script).toContain("PROGRESS_BYTES_BEFORE=$(wc -c")
    expect(script).toContain("PROGRESS_BYTES_AFTER=$(wc -c")
    expect(script).toMatch(/did NOT append to progress\.txt/)
    // Must NOT use the non-portable stat forms.
    expect(script).not.toMatch(/stat -f%z|stat -c%s/)
  })

  it("run.sh quotes paths safely (state dirs with spaces don't break the script)", () => {
    const spaced = join(SCRATCH, "dir with spaces " + Math.random())
    mkdirSync(spaced, { recursive: true })
    const arts = generateRalphArtifacts({
      stateDir: spaced,
      projectDir: "/proj with spaces",
      desc: "x",
      zapInterp: "/bun",
      zapScript: "/zap with spaces.tsx",
    })
    const script = readFileSync(arts.scriptPath, "utf-8")
    // Every path that appears as a shell variable must be single-quoted.
    expect(script).toContain(`STATE_DIR='${spaced}'`)
    expect(script).toContain(`PROJECT_DIR='/proj with spaces'`)
    expect(script).toContain(`ZAP_INTERP='/bun'`)
    expect(script).toContain(`ZAP_SCRIPT='/zap with spaces.tsx'`)
  })

  it("run.sh embeds the configured iteration cap", () => {
    const arts = generateRalphArtifacts({
      stateDir,
      projectDir: CWD,
      desc: "x",
      maxIter: 7,
      maxTurnsPerIter: 13,
      zapInterp: "/bun",
      zapScript: "/zap",
    })
    expect(arts.maxIter).toBe(7)
    expect(arts.maxTurnsPerIter).toBe(13)
    const script = readFileSync(arts.scriptPath, "utf-8")
    expect(script).toContain("MAX_ITER=7")
    expect(script).toContain("MAX_TURNS=13")
  })

  it("run.sh writes pid, traps signals, and clears pid on terminal states", () => {
    const arts = generateRalphArtifacts({
      stateDir,
      projectDir: CWD,
      desc: "x",
      zapInterp: "/bun",
      zapScript: "/zap",
    })
    const script = readFileSync(arts.scriptPath, "utf-8")
    // pid is written at start
    expect(script).toMatch(/echo \$\$\s*>\s*"\$STATE_DIR\/runner\.pid"/)
    // SIGINT/SIGTERM are trapped
    expect(script).toMatch(/trap [^\n]+ INT TERM/)
    // Any runner-created logs, pid files, iter outputs, and state rewrites
    // default to owner-only permissions.
    expect(script).toContain("umask 077")
    // done.flag is created on COMPLETE detection
    expect(script).toContain('touch "$STATE_DIR/done.flag"')
    // pid is cleaned up on exit paths (cleanup_pid function is called)
    expect(script).toMatch(/cleanup_pid/)
  })

  it("iter call omits --quiet so /supertask watch can stream activity", () => {
    // The planner phase keeps --quiet (single-shot, output piped straight to
    // runner.log; quiet keeps that log scannable). The iter phase must NOT
    // be quiet — its output goes to iter_NN.out which the watch dialog
    // tails for the "recent activity" pane. Lock this asymmetry in.
    const arts = generateRalphArtifacts({
      stateDir,
      projectDir: CWD,
      desc: "x",
      zapInterp: "/bun",
      zapScript: "/zap",
    })
    const script = readFileSync(arts.scriptPath, "utf-8")
    const plannerBlock = script.slice(script.indexOf("Phase 1"), script.indexOf("Phase 2"))
    const iterBlock = script.slice(script.indexOf("Phase 2"))
    expect(plannerBlock).toContain("--quiet")
    expect(iterBlock).not.toContain("--quiet")
  })

  it("run.sh survives bash 3.2 + set -u with empty MODEL_ARG (macOS regression)", () => {
    // macOS ships bash 3.2.57, which under `set -u` aborts on "${arr[@]}"
    // when the array is empty. The runner sets `MODEL_ARG=()` when no model
    // override is configured (the common case) and uses MODEL_ARG at the
    // bun-zap call site. Without the `${MODEL_ARG[@]:+...}` idiom the
    // planner phase crashed with "MODEL_ARG[@]: unbound variable" before
    // ever spawning zap. Lock the safe form in.
    const arts = generateRalphArtifacts({
      stateDir,
      projectDir: CWD,
      desc: "x",
      zapInterp: "/bun",
      zapScript: "/zap",
    })
    const script = readFileSync(arts.scriptPath, "utf-8")
    expect(script).not.toMatch(/"\$\{MODEL_ARG\[@\]\}"/)
    expect(script).toContain('"${MODEL_ARG[@]:+${MODEL_ARG[@]}}"')
  })

  it("run.sh detects COMPLETE sentinel via grep, sets meta.status=done", () => {
    const arts = generateRalphArtifacts({
      stateDir,
      projectDir: CWD,
      desc: "x",
      zapInterp: "/bun",
      zapScript: "/zap",
    })
    const script = readFileSync(arts.scriptPath, "utf-8")
    expect(script).toContain("<promise>COMPLETE</promise>")
    expect(script).toContain("set_meta_status done")
    expect(script).toContain("set_meta_status max_iter")
    expect(script).toContain("set_meta_status aborted")
  })

  it("throws when zapScript can't be resolved (defensive — should never happen in normal flow)", () => {
    // Force process.argv[1] to empty by overriding via explicit empty zapScript.
    expect(() => generateRalphArtifacts({
      stateDir,
      projectDir: CWD,
      desc: "x",
      zapInterp: "/bun",
      zapScript: "",
    })).toThrow(/zap entry script/i)
  })

  it("recursion guard: refuses to spawn when process.argv[1] doesn't look like zap", () => {
    // Simulate calling from a launcher script (where argv[1] is the launcher,
    // not zap itself). This is the fork-bomb scenario we hit during the first
    // smoke test — running run.sh with $ZAP_SCRIPT pointing back at the
    // caller would create infinite recursive supertasks.
    const fakeLauncher = join(SCRATCH, "fake-launcher.ts")
    require("node:fs").writeFileSync(fakeLauncher, "// nothing zap-y here\nconsole.log('hi')\n")
    const argvBackup = process.argv[1]
    try {
      process.argv[1] = fakeLauncher
      expect(() => generateRalphArtifacts({
        stateDir,
        projectDir: CWD,
        desc: "x",
        zapInterp: "/bun",
        // omit zapScript on purpose to trigger argv[1] fallback + guard
      })).toThrow(/does not look like zap's entry/i)
    } finally {
      process.argv[1] = argvBackup
    }
  })

  it("recursion guard: explicit zapScript bypasses the check (caller takes responsibility)", () => {
    // Test setup: write a file that doesn't look like zap, but pass it
    // explicitly. The guard only fires for the argv[1] fallback path —
    // explicit zapScript means the caller knows what they're doing.
    const arbitraryScript = join(SCRATCH, "explicitly-not-zap.ts")
    require("node:fs").writeFileSync(arbitraryScript, "console.log('not zap')\n")
    expect(() => generateRalphArtifacts({
      stateDir,
      projectDir: CWD,
      desc: "x",
      zapInterp: "/bun",
      zapScript: arbitraryScript,
    })).not.toThrow()
  })
})

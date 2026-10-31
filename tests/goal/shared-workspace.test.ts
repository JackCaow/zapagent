import { expect, it } from "bun:test"
import { spawn } from "node:child_process"
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile, open, realpath } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { createHash } from "node:crypto"
import { captureGoalEntries, GoalTurnHost, appendGoalObservation } from "../../src/goal-turn-host.js"
import { createCustomProvider, getDefaultConfig } from "../../src/config.js"
import { GoalStore } from "../../zapsdk/goal/store.js"
import { createPlatformSandbox } from "../../zapsdk/execution/sandbox.js"

const HAS_SANDBOX = createPlatformSandbox().status().available

it("captures only observed paths, preserving dangling/external links without traversing them", async () => {
  const root = await mkdtemp(join(tmpdir(), "goal-observed-"))
  try {
    await mkdir(join(root, "project"))
    await symlink("missing", join(root, "dangling"))
    await symlink("/external/not-present", join(root, "external"))
    const file = await open(join(root, "huge"), "w"); await file.truncate(100 * 1024 ** 3); await file.close()
    const entries = await captureGoalEntries(root, [".", "dangling", "external"])
    expect(entries.find(e => e.path === ".")?.entries).toEqual(["dangling", "external", "huge", "project"])
    expect(entries.find(e => e.path === "dangling")).toMatchObject({ kind: "link", target: "missing" })
    expect(entries.find(e => e.path === "external")).toMatchObject({ kind: "link", target: "/external/not-present" })
    expect(await readlink(join(root, "dangling"))).toBe("missing")
    expect((await captureGoalEntries(root, ["huge"]))[0]?.kind).toBe("unfrozen-file")
  } finally { await rm(root, { recursive: true, force: true }) }
})

it("does not follow symlink parents when freezing evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "goal-parent-link-"))
  try {
    await symlink("/etc", join(root, "alias"))
    expect((await captureGoalEntries(root, ["alias/passwd"]))[0]?.kind).toBe("unfrozen-link-parent")
    expect(await captureGoalEntries(root, ["../outside", "/etc/passwd", ".git/config"])).toEqual([])
  } finally { await rm(root, { recursive: true, force: true }) }
})

it("never replays interrupted effects in a shared workspace based on a stopped PID", async () => {
  const host = new GoalTurnHost("test")
  for (const phase of ["executing", "repairing", "integrating", "delivering"] as const) {
    const result = await host.reconcile({ inFlight: { phase, operationId: "op" } } as any)
    expect(result.kind).toBe("blocked")
    expect(result.reason).toContain("inspect current workspace")
  }
  expect(await host.reconcile({ inFlight: { phase: "planning", operationId: "op" } } as any)).toEqual({ kind: "retry" })
})

for (const mode of ["pass", "reject", "machine", "repair", "failed-needs-input", "contradictory-verdict", "verifier-shell", "verifier-shell-denied", "verifier-shell-steps", "verifier-shell-abbrev-denied"] as const) {
  const reject = ["reject", "failed-needs-input", "contradictory-verdict", "verifier-shell-denied", "verifier-shell-abbrev-denied"].includes(mode), machine = mode === "machine"
  // Machine checks and shell-based reviewers need an OS sandbox to run a shell without approval.
  const needsShell = machine || mode.startsWith("verifier-shell")
  const maybeIt = needsShell && !HAS_SANDBOX ? it.skip : it
  maybeIt(`ordinary Goal runs in place with shell, subagent capability and independent ${reject ? mode : machine ? "machine and semantic" : mode === "repair" ? "repairable unverified" : "passed"} acceptance`, async () => {
    const root = await mkdtemp(join(tmpdir(), "goal-shared-cli-")), cwd = join(root, "workspace"), data = join(root, "data")
    await mkdir(cwd); await mkdir(data); await mkdir(join(cwd, "alpha")); await mkdir(join(cwd, "beta"))
    await symlink("missing", join(cwd, "dangling")); await symlink("/not/present", join(cwd, "external"))
    if (machine) await writeFile(join(cwd, "generated.test.ts"), 'import { it } from "bun:test"; import { mkdirSync } from "node:fs"; it("creates ordinary generated output",()=>mkdirSync("coverage",{recursive:true}));')
    let workerTools: string[] = [], reviewTools: string[] = [], sawShell = false, verificationCalls = 0
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      const body = await request.json() as any
      const prompts = body.messages.filter((m: any) => m.role === "user").map((m: any) => String(m.content)).join("\n")
      let delta: object, finish = "stop"
      const call = (id: string, name: string, args: object) => { finish = "tool_calls"; return { tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }
      if (prompts.includes("Run the explicitly requested machine check")) {
        if (!body.messages.some((m: any) => m.role === "tool" && m.tool_call_id === "machine")) delta = call("machine", "bash", { command: "bun test" })
        else delta = { content: "Machine check executed." }
      } else if (prompts.includes("Plan the user's goal")) delta = { content: JSON.stringify({ tasks: [{ id: "one", description: "Count two project directories and write report.txt", acceptance: "report.txt contains two; use the real workspace", dependencies: [] }] }) }
      else if (prompts.includes("You are an independent verifier")) {
        reviewTools = body.tools.map((t: any) => t.function.name)
        const reviewed = body.messages.filter((m: any) => m.role === "tool")
        const priorVerdict = body.messages.find((m: any) => m.role === "assistant" && typeof m.content === "string" && m.content.includes('"status":'))
        const needsRepair = mode === "repair" && verificationCalls++ === 0
        if (mode.startsWith("verifier-shell") && reviewTools.includes("bash") && !reviewed.length) {
          delta = call("independent-check", "bash", mode === "verifier-shell-steps" ? { check_steps: ["pwd", "cat report.txt"] } : { command: mode === "verifier-shell-denied" ? "touch forbidden.txt" : mode === "verifier-shell-abbrev-denied" ? "sort --out=forbidden.txt report.txt" : "find . -maxdepth 1 -type d | wc -l" })
        } else if (mode.startsWith("verifier-shell") && priorVerdict) delta = { content: priorVerdict.content }
        else {
        if (mode === "verifier-shell" && reviewTools.includes("bash")) expect(String(reviewed[0]?.content).trim()).toContain("3")
        if (mode === "verifier-shell-steps" && reviewTools.includes("bash")) expect(String(reviewed[0]?.content)).toContain("two")
        if (mode === "verifier-shell-abbrev-denied" && reviewTools.includes("bash")) expect(String(reviewed[0]?.content)).toContain("bash blocked in read-only mode")
        delta = { content: JSON.stringify({ status: mode === "contradictory-verdict" ? "passed" : mode === "failed-needs-input" ? "failed" : reject || needsRepair ? "unverified" : "passed", detail: reject ? "Need external user input" : needsRepair ? "Read the actual report to supply the missing evidence" : "Observed report and two project directories verified", ...(reject || needsRepair ? { nextAction: needsRepair || mode === "contradictory-verdict" ? "repair" : "needs_input" } : {}) }) }
        }
      } else if (prompts.includes("Work on the user's goal")) {
        workerTools = body.tools.map((t: any) => t.function.name)
        const results = body.messages.filter((m: any) => m.role === "tool")
        if (mode === "repair" && prompts.includes("Independent verifier feedback")) {
          if (!results.some((m: any) => m.tool_call_id === "repair-read")) delta = call("repair-read", "read_file", { path: "report.txt" })
          else delta = { content: "Read and independently supported: two project directories." }
        } else {
          // Ordinary shell calls are auto-approved only inside an OS sandbox; without one the
          // headless worker (correctly) cannot get approval, so the fixture skips the shell step.
          const steps = HAS_SANDBOX ? ["tree", "shell", "write"] : ["tree", "write"]
          const step = steps[results.length]
          if (step === "tree") delta = call("tree", "list_tree", { path: ".", depth: 1, max_entries: 1000 })
          else if (step === "shell") delta = call("shell", "bash", { command: "printf goal-shell-ok" })
          else if (step === "write") { if (HAS_SANDBOX) sawShell = String(results[1].content).includes("goal-shell-ok"); delta = call("write", "write_file", { path: "report.txt", content: "two\n" }) }
          else delta = { content: "Two projects, alpha and beta. Links are entries and were not followed." }
        }
      } else delta = { content: "Two projects verified in the current workspace." }
      const frame = (d: object, f: string | null) => `data: ${JSON.stringify({ id: "shared", object: "chat.completion.chunk", model: "fixture", choices: [{ index: 0, delta: d, finish_reason: f }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\n`
      return new Response(frame(delta, null) + frame({}, finish) + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
    } })
    try {
      const provider = createCustomProvider({ name: "Fixture", baseURL: `http://127.0.0.1:${server.port}/v1`, apiKey: "fixture", models: ["fixture"], contextWindow: 128000 })
      await writeFile(join(data, "config.json"), JSON.stringify({ ...getDefaultConfig(), providers: [provider], active: { providerId: provider.id, model: "fixture" }, permissionMode: "acceptEdits" }))
      const child = spawn(process.execPath, [resolve("src/index.tsx"), "goal", "Count projects and write report", "--accept-edits", ...(machine ? ["--check=bun"] : [])], { cwd, env: { ...process.env, ZAPCODE_DATA_DIR: data, ZAP_DISABLE_UPDATE_CHECK: "1" }, stdio: ["ignore", "pipe", "pipe"] })
      let output = ""; child.stdout.on("data", b => output += b); child.stderr.on("data", b => output += b)
      await new Promise<void>((done, fail) => { child.once("error", fail); child.once("close", () => done()) })
      const store = new GoalStore(join(data, "goal", "goals.sqlite")), goal = store.list(await realpath(cwd))[0]!; store.close()
      if (!goal || goal.status !== (reject ? "awaiting_acceptance" : "completed")) throw new Error(output + JSON.stringify(goal))
      expect(goal.executionMode).toBe("session")
      expect(sawShell).toBe(HAS_SANDBOX)
      expect(workerTools).toContain("agent"); expect(workerTools).toContain("bash"); expect(workerTools).toContain("http_fetch")
      expect(reviewTools).not.toContain("write_file"); expect(reviewTools).not.toContain("agent")
      // A rejected candidate still exists in the actual source: no hidden copy
      // and no promise of rollback after an ordinary shared-workspace turn.
      expect(await readFile(join(cwd, "report.txt"), "utf8")).toBe("two\n")
      expect(await readlink(join(cwd, "dangling"))).toBe("missing")
      expect(await readlink(join(cwd, "external"))).toBe("/not/present")
      const home = join(data, "goal", "runs", createHash("sha256").update(goal.id).digest("hex"))
      expect((await readdir(home)).some(name => /workspace|candidate-|integration/.test(name) && name !== "workspace.json")).toBe(false)
      expect(output).toContain("running/executing"); expect(output).toContain("running/verifying")
      if (!reject) expect(goal.finalReceipt?.status).toBe("passed")
      if (mode === "pass") expect((goal.delivery as { text: string }).text).toContain("Two projects, alpha and beta.")
      if (machine) expect((await lstat(join(cwd, "coverage"))).isDirectory()).toBe(true)
      if (mode === "repair") expect(goal.tasks[0]?.attempt).toBe(2)
      if (mode === "verifier-shell-denied" || mode === "verifier-shell-abbrev-denied") await expect(lstat(join(cwd, "forbidden.txt"))).rejects.toThrow()
    } finally { server.stop(); await rm(root, { recursive: true, force: true }) }
  }, 30000)
}

it("detects symlink target content and directory entry type changes before delivery", async () => {
  const root = await mkdtemp(join(tmpdir(), "goal-dependency-change-"))
  try {
    await writeFile(join(root, "target.txt"), "verified")
    await symlink("target.txt", join(root, "alias.txt"))
    await mkdir(join(root, "project"))
    const before = await captureGoalEntries(root, ["alias.txt", "."])
    await writeFile(join(root, "target.txt"), "changed-after-verification")
    expect((await captureGoalEntries(root, ["alias.txt"]))[0]?.version).not.toBe(before.find(e => e.path === "alias.txt")?.version)
    await rm(join(root, "project"), { recursive: true }); await writeFile(join(root, "project"), "file")
    expect((await captureGoalEntries(root, ["."]))[0]?.version).not.toBe(before.find(e => e.path === ".")?.version)
  } finally { await rm(root, { recursive: true, force: true }) }
})

it("marks excess evidence as truncated instead of blocking an already completed ordinary turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "goal-evidence-bound-"))
  try {
    const paths = Array.from({ length: 129 }, (_, i) => `file-${i}.txt`)
    await Promise.all(paths.map(path => writeFile(join(root, path), "data")))
    const evidence = await captureGoalEntries(root, paths)
    expect(evidence.filter(e => e.kind === "file")).toHaveLength(128)
    expect(evidence.at(-1)?.kind).toBe("truncated")
  } finally { await rm(root, { recursive: true, force: true }) }
})

for (const repair of [false, true]) {
  it(`recovers a completed ${repair ? "repair" : "worker"} after evidence persistence fails without replaying its effects`, async () => {
    const root = await mkdtemp(join(tmpdir(), "goal-freeze-recovery-")), previousData = process.env.ZAPCODE_DATA_DIR
    const cwd = join(root, "project"); await mkdir(cwd)
    process.env.ZAPCODE_DATA_DIR = join(root, "data")
    let executions = 0
    try {
      const { GoalBudgetLedger } = await import("../../zapsdk/goal/budget.js")
      const { goalDatabasePath } = await import("../../src/goal-command.js")
      const store = new GoalStore(goalDatabasePath()), ledger = new GoalBudgetLedger(goalDatabasePath())
      const goal = store.create({ objective: "Do work once", cwd, executionMode: "session" }); ledger.create(goal.id, 0, { strict: false }); ledger.close(); store.close()
      await writeFile(join(cwd, "target.txt"), "original")
      await writeFile(join(cwd, "other.txt"), "other")
      await symlink("target.txt", join(cwd, "alias.txt"))
      const execute = async (input: import("../../src/goal-turn.js").GoalTurnInput) => {
        expect(input.prompt).toContain("verifier feedback identifies defects, it does not authorize new objectives")
        expect(input.prompt).toContain("runtime TMPDIR")
        executions++; await writeFile(join(cwd, "effect.txt"), String(executions))
        input.onEvent({ type: "content_final", kind: "tool_call", id: "read", step: 1, toolName: "read_file", arguments: { path: join(cwd, "alias.txt") } })
        input.onEvent({ type: "content_final", kind: "tool_result", id: "merge", step: 1, toolName: "merge_agent_artifacts", result: { success: true, output: "merged", meta: { changedPaths: ["effect.txt"] } } })
        return { text: "done", toolCalls: 1, outcome: { schema: "zap.outcome", schemaVersion: 1, threadId: "thread", turnId: "turn", runId: "attempt", attemptId: "attempt", startedAt: 1, endedAt: 2,
          execution: { attemptId: "attempt", status: "finished", stopReason: "end_turn", finalResponse: "done", unresolvedActions: [] },
          acceptance: { attemptId: "attempt", status: "unverified", code: "NO_ACCEPTANCE_SPEC", checks: [] },
          workflow: { attemptId: "attempt", status: "not_requested", controlRevision: 0, code: "WORKFLOW_NOT_CONFIGURED" } } } as import("../../src/goal-turn.js").GoalTurnResult
      }
      const host = new GoalTurnHost(goal.id, undefined, execute)
      await host.onClaim(goal)
      ;(host as any).freeze = () => { throw Error("simulated disk failure after execution") }
      const context = { goal, operationId: "original", signal: new AbortController().signal }
      const task = { id: "one", description: "Do work", acceptance: "done", dependencies: [], revision: 1, status: "running", attempt: 1 } as const
      const failed = repair ? { status: "failed", detail: "fix it" } as any : undefined
      await expect(host.execute(context, task as any, failed)).rejects.toThrow("simulated disk failure")
      const recovered = new GoalTurnHost(goal.id, undefined, execute)
      await recovered.onClaim(goal)
      expect(await recovered.reconcile({ ...goal, inFlight: { phase: repair ? "repairing" : "executing", operationId: "original" } })).toEqual({ kind: "retry" })
      const candidate = await recovered.execute({ ...context, operationId: "resumed" }, task as any, failed)
      expect(candidate.snapshotId).toBeTruthy()
      const { goalHome } = await import("../../src/goal-command.js")
      const evidence = JSON.parse(await readFile(join(goalHome(goal.id), `${candidate.candidateId}.json`), "utf8"))
      expect(evidence.entries.find((e: any) => e.path === "effect.txt")?.content).toBe("1")
      expect(evidence.paths).toContain("alias.txt")
      await rm(join(cwd, "alias.txt")); await symlink("other.txt", join(cwd, "alias.txt"))
      const receipt = await recovered.verify({ ...context, operationId: "00000000-0000-0000-0000-000000000001" }, task as any, candidate, false)
      expect(receipt.status).toBe("failed")
      expect(receipt.detail).toContain("GOAL_EVIDENCE_CHANGED")
      expect(executions).toBe(1)
      expect(await readFile(join(cwd, "effect.txt"), "utf8")).toBe("1")
    } finally {
      if (previousData === undefined) delete process.env.ZAPCODE_DATA_DIR; else process.env.ZAPCODE_DATA_DIR = previousData
      await rm(root, { recursive: true, force: true })
    }
  })
}

it("shares the evidence byte budget across multiple symlinks to file contents", async () => {
  const root = await mkdtemp(join(tmpdir(), "goal-link-evidence-budget-"))
  try {
    await writeFile(join(root, "target"), "a".repeat(64 * 1024))
    const paths = Array.from({ length: 20 }, (_, i) => `alias-${i}`)
    await Promise.all(paths.map(path => symlink("target", join(root, path))))
    const evidence = await captureGoalEntries(root, paths)
    expect(Buffer.byteLength(JSON.stringify(evidence))).toBeLessThan(150 * 1024)
    expect(evidence.some(e => e.targetEvidence?.kind === "unfrozen-file")).toBe(true)
  } finally { await rm(root, { recursive: true, force: true }) }
})

it("classifies an interactive ordinary turn's explicit Goal budget exhaustion without losing its settled outcome", async () => {
  const root = await mkdtemp(join(tmpdir(), "goal-tui-budget-")), previousData = process.env.ZAPCODE_DATA_DIR
  const cwd = join(root, "project"); await mkdir(cwd)
  process.env.ZAPCODE_DATA_DIR = join(root, "data")
  try {
    const { GoalController } = await import("../../zapsdk/goal/controller.js")
    const { GoalBudgetLedger } = await import("../../zapsdk/goal/budget.js")
    const { goalDatabasePath } = await import("../../src/goal-command.js")
    const store = new GoalStore(goalDatabasePath()), ledger = new GoalBudgetLedger(goalDatabasePath())
    const goal = store.create({ objective: "Do work", cwd, executionMode: "session" }); ledger.create(goal.id, 0, { strict: false }); ledger.close()
    try {
      const host = new GoalTurnHost(goal.id, undefined, async () => ({ text: "", toolCalls: 0, outcome: {
        schema: "zap.outcome", schemaVersion: 1, threadId: "thread", turnId: "turn", runId: "attempt", attemptId: "attempt", startedAt: 1, endedAt: 2,
        execution: { attemptId: "attempt", status: "failed", stopReason: "error", finalResponse: "", unresolvedActions: [], error: { code: "EXECUTION_FAILED", message: "Goal provider admission denied: budget_exhausted", retryable: false } },
        acceptance: { attemptId: "attempt", status: "unverified", code: "NO_ACCEPTANCE_SPEC", checks: [] },
        workflow: { attemptId: "attempt", status: "not_requested", controlRevision: 0, code: "WORKFLOW_NOT_CONFIGURED" },
      } }))
      host.plan = async () => ({ tasks: [{ id: "one", description: "Do work", acceptance: "done" }] })
      const result = await new GoalController(store, host, goal.id).run()
      expect(result.status).toBe("budget_limited")
      expect(result.failure?.code).toBe("GOAL_BUDGET_LIMITED")
      expect(await host.reconcile(result)).toEqual({ kind: "retry" })
    } finally { store.close() }
  } finally {
    if (previousData === undefined) delete process.env.ZAPCODE_DATA_DIR; else process.env.ZAPCODE_DATA_DIR = previousData
    await rm(root, { recursive: true, force: true })
  }
})

it("starts the original objective without a separate planner inventing stricter requirements", async () => {
  const objective = "盘点下项目"
  const host = new GoalTurnHost("original-objective")
  const plan = await host.plan({ goal: { objective, permissionMode: "default", cwd: "/unavailable/not-snapshotted" }, operationId: "plan", signal: new AbortController().signal } as any)
  expect(plan.tasks).toEqual([{ id: "objective", description: objective, acceptance: objective, dependencies: [] }])
})

it("retains recent corrective tool evidence instead of an early exploration prefix", () => {
  const observations: unknown[] = []
  expect(appendGoalObservation(observations, { output: "early exploration" }, 60)).toBe(false)
  expect(appendGoalObservation(observations, { output: "latest verified correction" }, 60)).toBe(true)
  expect(observations).toEqual([{ output: "latest verified correction" }])
})

it("clears the active-turn marker when the in-process turn throws, without allowing a replay", async () => {
  const root = await mkdtemp(join(tmpdir(), "goal-turn-throws-")), previousData = process.env.ZAPCODE_DATA_DIR
  const cwd = join(root, "project"); await mkdir(cwd)
  process.env.ZAPCODE_DATA_DIR = join(root, "data")
  try {
    const { GoalController } = await import("../../zapsdk/goal/controller.js")
    const { GoalBudgetLedger } = await import("../../zapsdk/goal/budget.js")
    const { goalDatabasePath } = await import("../../src/goal-command.js")
    const store = new GoalStore(goalDatabasePath()), ledger = new GoalBudgetLedger(goalDatabasePath())
    const goal = store.create({ objective: "Do work", cwd, executionMode: "session" }); ledger.create(goal.id, 0, { strict: false }); ledger.close()
    try {
      const host = new GoalTurnHost(goal.id, undefined, async () => { throw new Error("provider failed") })
      const result = await new GoalController(store, host, goal.id).run()
      expect(result.status).toBe("blocked")
      // The runtime is gone: sealing and a fresh claim must not stay wedged on a stale marker.
      await host.seal()
      const next = new GoalTurnHost(goal.id)
      await next.onClaim(store.get(goal.id)!)
      // Effects of the failed turn are unknown, so an executing phase still must not be replayed.
      const resolution = await next.reconcile(store.get(goal.id)!)
      expect(resolution.kind).toBe("blocked")
      expect((resolution as { reason?: string }).reason).toContain("inspect current workspace")
    } finally { store.close() }
  } finally {
    if (previousData === undefined) delete process.env.ZAPCODE_DATA_DIR; else process.env.ZAPCODE_DATA_DIR = previousData
    await rm(root, { recursive: true, force: true })
  }
})

import { expect, it } from "bun:test"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentEvent } from "../../zapsdk/agent/events.js"
import type { GoalCandidate, GoalOperationContext } from "../../zapsdk/goal/contracts.js"
import { GoalController } from "../../zapsdk/goal/controller.js"
import { GoalStore } from "../../zapsdk/goal/store.js"
import { GoalBudgetLedger } from "../../zapsdk/goal/budget.js"
import { GoalTurnHost } from "../../src/goal-turn-host.js"
import { goalDatabasePath, goalHome } from "../../src/goal-command.js"
import type { GoalTurnInput, GoalTurnResult } from "../../src/goal-turn.js"

function outcome(text: string): GoalTurnResult {
  return { text, toolCalls: 1, outcome: {
    schema: "zap.outcome", schemaVersion: 1, threadId: "thread", turnId: "turn", runId: "run", attemptId: "run", startedAt: 1, endedAt: 2,
    execution: { attemptId: "run", status: "finished", stopReason: "end_turn", finalResponse: text, unresolvedActions: [] },
    acceptance: { attemptId: "run", status: "unverified", code: "NO_ACCEPTANCE_SPEC", checks: [] },
    workflow: { attemptId: "run", status: "not_requested", controlRevision: 0, code: "WORKFLOW_NOT_CONFIGURED" },
  } }
}

for (const mode of ["same", "restart", "repair", "repair-twice", "different-criterion", "multi", "changed-result", "changed-file", "missing-receipt", "forged-receipt"] as const) {
  it(`reuses independent acceptance only for an unchanged complete objective: ${mode}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "goal-acceptance-reuse-")), oldData = process.env.ZAPCODE_DATA_DIR
    const cwd = join(root, "workspace"); await mkdir(cwd)
    process.env.ZAPCODE_DATA_DIR = join(root, "data")
    const repairs = mode === "repair-twice" ? 2 : mode === "repair" ? 1 : 0
    let store: GoalStore | undefined
    try {
      await writeFile(join(cwd, "report.txt"), "two projects")
      await writeFile(join(cwd, "fix.txt"), "targeted correction")
      store = new GoalStore(goalDatabasePath())
      const goal = store.create({ objective: "Inventory projects", cwd, executionMode: "session" })
      const ledger = new GoalBudgetLedger(goalDatabasePath()); ledger.create(goal.id, 0, { strict: false }); ledger.close()
      let reviews = 0, executions = 0
      const prompts: string[] = [], workerPrompts: string[] = []
      const host = new GoalTurnHost(goal.id, undefined, async (input: GoalTurnInput) => {
        executions++; workerPrompts.push(input.prompt)
        const id = `read-${executions}`
        input.onEvent({ type: "content_final", kind: "tool_call", id, step: 1, toolName: "read_file", arguments: { path: executions === 1 ? "report.txt" : "fix.txt" } })
        input.onEvent({ type: "content_final", kind: "tool_result", id, step: 1, toolName: "read_file", result: { success: true, output: executions === 1 ? "prior-inventory-observation" : "corrected-inventory-observation" } })
        return outcome(executions === 1 ? "Two projects" : "Corrected: two projects")
      })
      const internals = host as unknown as {
        turn(context: GoalOperationContext, role: GoalTurnInput["role"], prompt: string, observe?: (event: AgentEvent) => void): Promise<GoalTurnResult>
        freeze(context: GoalOperationContext, evidence: unknown): GoalCandidate
      }
      const originalTurn = internals.turn.bind(host)
      internals.turn = async (context, role, prompt, observe) => {
        if (role !== "verifier") return originalTurn(context, role, prompt, observe)
        reviews++; prompts.push(prompt)
        observe?.({ type: "content_final", kind: "tool_call", id: "review-read", step: 1, toolName: "read_file", arguments: { path: "report.txt" } })
        observe?.({ type: "content_final", kind: "tool_result", id: "review-read", step: 1, toolName: "read_file", result: { success: true, output: "independent-inventory-observation" } })
        return outcome(JSON.stringify(reviews <= repairs
          ? { status: "failed", nextAction: "repair", detail: "Correct the reported count only" }
          : { status: "passed", detail: "Independent check passed" }))
      }
      if (mode === "multi" || mode === "different-criterion") host.plan = async () => ({ tasks: mode === "multi"
        ? ["first", "second"].map(id => ({ id, description: "Inventory projects", acceptance: "Inventory projects", dependencies: [] }))
        : [{ id: "partial", description: "Inventory projects", acceptance: "Check only one directory", dependencies: [] }] })
      const snapshot = host.snapshotIntegration.bind(host)
      host.snapshotIntegration = async context => {
        const accepted = context.goal.tasks[0]!
        if (mode === "missing-receipt" || mode === "forged-receipt") {
          const id = (accepted.receipt!.evidence as { verificationId: string }).verificationId
          const path = join(goalHome(goal.id), "acceptance-attempts", `${id}.json`)
          if (mode === "missing-receipt") await rm(path)
          else await writeFile(path, JSON.stringify({ ...accepted.receipt, detail: "forged" }))
        }
        if (mode === "changed-file") await writeFile(join(cwd, "report.txt"), "three projects")
        const candidate = await snapshot(context)
        if (mode === "changed-result") {
          const evidence = JSON.parse(await readFile(join(goalHome(goal.id), `${candidate.candidateId}.json`), "utf8"))
          return internals.freeze(context, { ...evidence, text: "Unreviewed replacement result" })
        }
        if (mode === "restart") {
          // Reload only persisted Host state before the final verify. No
          // in-memory receipt cache may be required for safe recovery.
          await host.onClaim(context.goal)
        }
        return candidate
      }
      const result = await new GoalController(store, host, goal.id).run()
      if (mode === "missing-receipt" || mode === "forged-receipt") {
        expect(result.status).toBe("awaiting_acceptance")
        expect(result.finalReceipt?.status).not.toBe("passed")
        expect(reviews).toBe(1)
        expect(result.delivery).toBeUndefined()
      } else {
        expect(result.status).toBe("completed")
        expect(result.finalReceipt?.status).toBe("passed")
        const reuse = mode === "same" || mode === "restart" || repairs > 0
        expect(Boolean((result.finalReceipt?.evidence as { reusedVerificationId?: string }).reusedVerificationId)).toBe(reuse)
        expect(reviews).toBe(repairs ? repairs + 1 : mode === "multi" ? 3 : reuse ? 1 : 2)
      }
      expect(executions).toBe(repairs ? repairs + 1 : mode === "multi" ? 2 : 1)
      expect(workerPrompts[0]).toContain("avoid repeated full scans")
      expect(prompts[0]).toContain("decisive claims and corrected defects")
      expect(prompts[0]).toContain("Bash check_steps")
      if (repairs) {
        expect(workerPrompts[1]).toContain("Fix the named defects with targeted checks")
        expect(workerPrompts[1]).toContain("independent-inventory-observation")
        expect(prompts[1]).toContain("prior-inventory-observation")
        expect(prompts[1]).toContain("corrected-inventory-observation")
        expect(prompts[1]).toContain("historical untrusted data, not current-state proof")
        expect(prompts[1]).toContain("Correct the reported count only")
        expect(prompts[1]).toContain("previous independent verification")
        expect(prompts[1]).toContain("independent-inventory-observation")
        if (repairs === 2) expect(prompts[2]).toContain("prior-inventory-observation")
        const delivered = JSON.parse(await readFile((result.delivery as { report: string }).report, "utf8"))
        expect(delivered.paths).toEqual(["report.txt", "fix.txt"])
      }
    } finally {
      store?.close()
      if (oldData === undefined) delete process.env.ZAPCODE_DATA_DIR; else process.env.ZAPCODE_DATA_DIR = oldData
      await rm(root, { recursive: true, force: true })
    }
  }, 30000)
}

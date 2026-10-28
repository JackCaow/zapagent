import { expect, it } from "bun:test"
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { createCustomProvider, getDefaultConfig } from "../../src/config.js"
import { GoalStore } from "../../zapsdk/goal/store.js"
import { GoalBudgetLedger } from "../../zapsdk/goal/budget.js"

for (const mode of ["format", "resume-verifier", "explicit-limit"] as const) {
  it(`runs the real Goal continuation lifecycle: ${mode}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "zap-goal-continuation-")), data = join(root, "data"), cwd = join(root, "project")
    await mkdir(data); await mkdir(cwd)
    let planner = 0, workers = 0, verifier = 0, resume = false
    const model = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      const body = await request.json() as { messages: Array<{ role: string; content: unknown }> }
      const text = body.messages.filter(m => m.role === "user" && typeof m.content === "string").map(m => m.content).join("\n")
      let delta: object, finish = "stop"
      if (text.includes("Plan the user's goal")) {
        planner++
        const plan = { tasks: [{ id: "one", description: "Write report.txt", acceptance: "Report contains verified", dependencies: [] }] }
        delta = { content: mode === "format" && planner === 1 ? "I will plan next." : `Inspection finished.\n\`\`\`json\n${JSON.stringify(plan)}\n\`\`\`` }
      } else if (text.includes("Work on the user's goal")) {
        if (body.messages.some(m => m.role === "tool")) delta = { content: "Report written." }
        else {
          workers++; finish = "tool_calls"
          delta = { tool_calls: [{ index: 0, id: "write", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "report.txt", content: "verified\n" }) } }] }
        }
      } else if (text.includes("You are an independent verifier")) {
        verifier++
        const malformed = mode === "resume-verifier" && !resume || mode === "format" && verifier === 1
        delta = { content: malformed ? "The schema result is not ready." : `Evidence checked.\n${JSON.stringify({ status: "passed", detail: "The actual report contains verified." })}` }
      } else delta = { content: "Verified report summary." }
      const chunk = (value: object, reason: string | null) => `data: ${JSON.stringify({ id: "continuation", object: "chat.completion.chunk", model: "fixture", choices: [{ index: 0, delta: value, finish_reason: reason }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\n`
      return new Response(chunk(delta, null) + chunk({}, finish) + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
    } })
    const cli = (args: string[]) => new Promise<{ code: number | null; output: string }>((resolveResult, reject) => {
      const child = spawn(process.execPath, [resolve("src/index.tsx"), "goal", ...args], { cwd, env: { ...process.env, ZAPCODE_DATA_DIR: data }, stdio: ["ignore", "pipe", "pipe"] })
      let output = ""; child.stdout.on("data", b => output += String(b)); child.stderr.on("data", b => output += String(b))
      child.once("error", reject); child.once("close", code => resolveResult({ code, output }))
    })
    const waitForStop = async (id: string) => {
      for (let i = 0; i < 250; i++) {
        await new Promise(resolve => setTimeout(resolve, 100))
        const store = new GoalStore(join(data, "goal", "goals.sqlite")), goal = store.get(id); store.close()
        if (goal && !["created", "running"].includes(goal.status)) return goal
      }
      throw new Error("Goal did not reach a checkpoint")
    }
    try {
      const provider = createCustomProvider({ name: "Fixture", baseURL: `http://127.0.0.1:${model.port}/v1`, apiKey: "fixture", models: ["fixture"], contextWindow: 128000 })
      await writeFile(join(data, "config.json"), JSON.stringify({ ...getDefaultConfig(), providers: [provider], active: { providerId: provider.id, model: "fixture" } }))
      const start = await cli(["Write a verified report", "--accept-edits", ...(mode === "explicit-limit" ? ["--tokens=1000"] : [])])
      expect(start.code).toBe(0)
      const id = /goal_[a-f0-9-]+/.exec(start.output)?.[0]; expect(id).toBeDefined()
      let goal = await waitForStop(id!)
      let frozen: string | undefined
      const home = join(data, "goal", "runs", createHash("sha256").update(id!).digest("hex"))
      if (mode === "resume-verifier") {
        expect(goal.status).toBe("awaiting_acceptance"); expect(goal.tasks[0]?.receipt?.detail).toBe("GOAL_STRUCTURED_OUTPUT_INVALID")
        expect(workers).toBe(1); expect(verifier).toBe(3)
        frozen = (goal.tasks[0]?.candidate as { snapshotId: string }).snapshotId
        resume = true
        expect((await cli(["resume", id!])).code).toBe(0)
        goal = await waitForStop(id!)
        expect((goal.tasks[0]?.candidate as { snapshotId: string }).snapshotId).toBe(frozen)
        const attempts = await readdir(join(home, "acceptance-attempts"))
        expect(attempts).toHaveLength(3) // Failed task record, new task verification, final verification.
      }
      if (mode === "explicit-limit") {
        expect(goal.status).toBe("budget_limited"); expect(goal.failure?.code).toBe("GOAL_BUDGET_LIMITED")
        expect(planner).toBe(0); expect(workers).toBe(0)
        expect((await cli(["budget", "extend", id!, "--tokens=100000"])).code).toBe(0)
        expect((await cli(["resume", id!])).code).toBe(0)
        goal = await waitForStop(id!)
      }
      if (goal.status !== "completed") throw new Error(`Goal ${goal.status}: ${goal.stopReason}\n${await readFile(join(home, "runner.log"), "utf8")}`)
      expect(await readFile(join(cwd, "report.txt"), "utf8")).toBe("verified\n")
      expect(workers).toBe(1); expect(goal.finalReceipt?.status).toBe("passed")
      if (mode === "format") { expect(planner).toBe(2); expect(verifier).toBe(3) }
      const ledger = new GoalBudgetLedger(join(data, "goal", "goals.sqlite"))
      try { expect(ledger.snapshot(id!).totals.modelCalls).toBeGreaterThanOrEqual(planner + workers + verifier) } finally { ledger.close() }
    } finally { model.stop(); await rm(root, { recursive: true, force: true }) }
  }, 40_000)
}

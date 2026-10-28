import { expect, it } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createCustomProvider, getDefaultConfig } from "../../src/config.js"
import { runGoalPhase } from "../../src/headless/goalPhase.js"
import { GoalBudgetLedger } from "../../zapsdk/goal/budget.js"

it("enforces the Goal workspace boundary even with bypassPermissions", async () => {
  const root = await mkdtemp(join(tmpdir(), "goal-boundary-")), cwd = join(root, "work"), data = join(root, "data"), outside = join(root, "outside")
  await Promise.all([mkdir(cwd), mkdir(data), mkdir(outside)])
  await symlink(outside, join(cwd, "link"))
  let target = ""
  const model = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    const body = await request.json() as { messages: Array<{ role: string }> }
    const hasResult = body.messages.some(message => message.role === "tool")
    const delta = hasResult ? { content: "Done" } : { tool_calls: [{ index: 0, id: "outside-write", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: target, content: "escaped" }) } }] }
    const chunk = (d: object, finish_reason: string | null) => `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta: d, finish_reason }], usage: { prompt_tokens: 10, completion_tokens: 3 } })}\n\n`
    return new Response(chunk(delta, null) + chunk({}, hasResult ? "stop" : "tool_calls") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
  } })
  const oldData = process.env.ZAPCODE_DATA_DIR, oldBackend = process.env.ZAPCODE_EXECUTION
  try {
    process.env.ZAPCODE_DATA_DIR = data; process.env.ZAPCODE_EXECUTION = "local"
    const provider = createCustomProvider({ name: "Fixture", baseURL: `http://127.0.0.1:${model.port}/v1`, apiKey: "fixture", models: ["fixture"], contextWindow: 128000 })
    await writeFile(join(data, "config.json"), JSON.stringify({ ...getDefaultConfig(), executionBackend: "local", providers: [provider], active: { providerId: provider.id, model: "fixture" } }))
    const ledgerPath = join(data, "goals.sqlite"), ledger = new GoalBudgetLedger(ledgerPath)
    for (const [index, path] of [join(outside, "absolute"), "../outside/relative", "link/symlink"].entries()) {
      target = path; ledger.create(`goal-${index}`, 1, { maxTokens: 500_000, maxModelCalls: 10 })
      try { await runGoalPhase({ cwd, prompt: `Try outside ${index}`, goalId: `goal-${index}`, epoch: 1, role: "worker", ledgerPath, permissionMode: "bypassPermissions" }) } catch { /* denial is acceptable */ }
    }
    for (const name of ["absolute", "relative", "symlink"]) await expect(readFile(join(outside, name))).rejects.toThrow()
    ledger.close()
  } finally {
    if (oldData === undefined) delete process.env.ZAPCODE_DATA_DIR; else process.env.ZAPCODE_DATA_DIR = oldData
    if (oldBackend === undefined) delete process.env.ZAPCODE_EXECUTION; else process.env.ZAPCODE_EXECUTION = oldBackend
    model.stop(); await rm(root, { recursive: true, force: true })
  }
}, 30_000)

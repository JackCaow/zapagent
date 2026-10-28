import { expect, it } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createCustomProvider, getDefaultConfig } from "../../src/config.js"
import { runGoalPhase } from "../../src/headless/goalPhase.js"
import { GoalBudgetLedger } from "../../zapsdk/goal/budget.js"
import { GoalWorkspace } from "../../zapsdk/goal/workspace.js"
import { execFileSync } from "node:child_process"

it("meters and merges a child in a separate Goal workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "zap-goal-child-"))
  const cwd = join(root, "work"), data = join(root, "data"), runtime = join(root, "runtime")
  await mkdir(cwd); await mkdir(data); await mkdir(join(runtime, "images"), { recursive: true })
  await writeFile(join(runtime, "zapvm"), "#!/bin/sh\nexit 1\n", { mode: 0o755 })
  await writeFile(join(runtime, "images", "active.json"), "{}")
  await writeFile(join(runtime, "image-public.pem"), "fixture")
  let childSeen = false, mergeSeen = false, outsideAttempt = false
  const model = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    const body = await request.json() as { messages: Array<{ role: string; content: unknown }>; tools: Array<{ function: { name: string } }> }
    const tools = body.tools.map(tool => tool.function.name)
    const child = !tools.includes("agent")
    const result = body.messages.filter(message => message.role === "tool").at(-1)
    let delta: object, finish: string
    if (child) {
      childSeen = true
      if (!result) { delta = { tool_calls: [{ index: 0, id: "child-write", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: outsideAttempt ? join(root, "outside-child") : "child.txt", content: "from child\n" }) } }] }; finish = "tool_calls" }
      else { delta = { content: "Child completed." }; finish = "stop" }
    } else if (!result) {
      delta = { tool_calls: [{ index: 0, id: "spawn-child", type: "function", function: { name: "agent", arguments: JSON.stringify({ task: "Write child.txt", agent_type: "general" }) } }] }; finish = "tool_calls"
    } else {
      const artifact = /artifact_ids=\["([^"]+)"\]/.exec(String(result.content))?.[1]
      if (artifact && !mergeSeen) { mergeSeen = true; delta = { tool_calls: [{ index: 0, id: "merge-child", type: "function", function: { name: "merge_agent_artifacts", arguments: JSON.stringify({ artifact_ids: [artifact] }) } }] }; finish = "tool_calls" }
      else { delta = { content: "Completed." }; finish = "stop" }
    }
    const chunk = (part: object, reason: string | null) => `data: ${JSON.stringify({ id: "goal", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta: part, finish_reason: reason }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\n`
    return new Response(chunk(delta, null) + chunk({}, finish) + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
  } })
  const saved = { data: process.env.ZAPCODE_DATA_DIR, backend: process.env.ZAPCODE_EXECUTION, runtime: process.env.ZAPCODE_ZAPVM_RUNTIME_DIR }
  try {
    process.env.ZAPCODE_DATA_DIR = data; process.env.ZAPCODE_EXECUTION = "vm"; process.env.ZAPCODE_ZAPVM_RUNTIME_DIR = runtime
    const provider = createCustomProvider({ name: "Fixture", baseURL: `http://127.0.0.1:${model.port}/v1`, apiKey: "fixture", models: ["fixture"], contextWindow: 128000 })
    await writeFile(join(data, "config.json"), JSON.stringify({ ...getDefaultConfig(), executionBackend: "vm", providers: [provider], active: { providerId: provider.id, model: "fixture" } }))
    const ledgerPath = join(data, "goals.sqlite"), ledger = new GoalBudgetLedger(ledgerPath)
    ledger.create("child-test", 1, { maxTokens: 500_000, maxModelCalls: 20, maxToolCalls: 20, maxSpawns: 2 })
    const result = await runGoalPhase({ cwd, prompt: "Delegate this task", goalId: "child-test", epoch: 1, role: "worker", ledgerPath, permissionMode: "bypassPermissions" })
    expect(result.outcome.execution.status).toBe("finished")
    expect(childSeen).toBe(true); expect(mergeSeen).toBe(true)
    expect(await readFile(join(cwd, "child.txt"), "utf8")).toBe("from child\n")
    const totals = ledger.snapshot("child-test").totals
    expect(totals.spawns).toBe(1); expect(totals.modelCalls).toBeGreaterThanOrEqual(4)
    ledger.create("child-outside", 1, { maxTokens: 500_000, maxModelCalls: 20, maxToolCalls: 20, maxSpawns: 2 })
    childSeen = false; mergeSeen = false; outsideAttempt = true
    await expect(runGoalPhase({ cwd, prompt: "Delegate another task", goalId: "child-outside", epoch: 1, role: "worker", ledgerPath, permissionMode: "bypassPermissions" })).rejects.toThrow()
    expect(childSeen).toBe(true)
    await expect(readFile(join(root, "outside-child"))).rejects.toThrow()
    ledger.create("child-budget", 1, { maxTokens: 500_000, maxModelCalls: 20, maxToolCalls: 20, maxSpawns: 0 })
    childSeen = false; mergeSeen = false; outsideAttempt = false
    try { await runGoalPhase({ cwd, prompt: "Delegate without spawn budget", goalId: "child-budget", epoch: 1, role: "worker", ledgerPath, permissionMode: "bypassPermissions" }) } catch { /* budget denial is an expected incomplete phase */ }
    expect(childSeen).toBe(false)
    expect(ledger.snapshot("child-budget").totals.spawns).toBe(0)
    if (process.platform === "darwin") {
      const source = join(root, "git-source")
      await mkdir(source); await writeFile(join(source, "base.txt"), "base\n")
      execFileSync("git", ["init", source])
      execFileSync("git", ["-C", source, "add", "base.txt"])
      execFileSync("git", ["-C", source, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "base"])
      const goal = await GoalWorkspace.create(source, "child-git", join(root, "goal-host"))
      try {
        const worker = await goal.acquireWorker("parent")
        const binding = worker.lease.privateGit!
        execFileSync("git", ["-C", worker.lease.path, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "parent-private"])
        ledger.create("child-git", 1, { maxTokens: 500_000, maxModelCalls: 20, maxToolCalls: 20, maxSpawns: 2 })
        childSeen = false; mergeSeen = false; outsideAttempt = false
        await runGoalPhase({ cwd: worker.lease.path, prompt: "Delegate in private Git workspace", goalId: "child-git", epoch: 1, role: "worker", ledgerPath,
          permissionMode: "bypassPermissions", privateGit: binding, privateGitOwnerDirectory: goal.exportState().privateGit!.ownerDirectory })
        expect(childSeen).toBe(true); expect(mergeSeen).toBe(true)
        expect(await readFile(join(worker.lease.path, "child.txt"), "utf8")).toBe("from child\n")
        await expect(readFile(join(source, "child.txt"))).rejects.toThrow()
      } finally { await goal.cleanup() }
    }
    ledger.close()
  } finally {
    for (const [key, value] of [["ZAPCODE_DATA_DIR", saved.data], ["ZAPCODE_EXECUTION", saved.backend], ["ZAPCODE_ZAPVM_RUNTIME_DIR", saved.runtime]] as const) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    model.stop(); await rm(root, { recursive: true, force: true })
  }
}, 30_000)

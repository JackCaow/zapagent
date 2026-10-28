import { expect, it } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createCustomProvider, getDefaultConfig } from "../../src/config.js"
import { runGoalMachinePhase, runGoalPhase } from "../../src/headless/goalPhase.js"
import { GoalBudgetLedger } from "../../zapsdk/goal/budget.js"

it("runs each Goal phase in a fresh cwd, meters real provider/tool calls and restricts verifier tools", async () => {
  const root = await mkdtemp(join(tmpdir(), "zap-goal-phase-"))
  const data = join(root, "data"), worker = join(root, "worker"), verifier = join(root, "verifier")
  await Promise.all([mkdir(data), mkdir(worker), mkdir(verifier)])
  await writeFile(join(worker, "reference.txt"), "worker-context")
  await writeFile(join(verifier, "reference.txt"), "verifier-context")
  const requests: Array<{ tools: string[]; text: string }> = []
  let markWaiting: (() => void) | undefined
  const waiting = new Promise<void>(resolve => { markWaiting = resolve })
  const model = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    const body = await request.json() as { messages: Array<{ role: string; content: unknown }>; tools: Array<{ function: { name: string } }> }
    if (body.messages.some(message => message.role === "user" && typeof message.content === "string" && message.content.includes("Wait for abort"))) {
      markWaiting?.()
      await Promise.race([new Promise(resolve => request.signal.addEventListener("abort", resolve, { once: true })), new Promise(resolve => setTimeout(resolve, 5000))])
      return new Response("", { status: 499 })
    }
    const result = body.messages.find(message => message.role === "tool")
    requests.push({ tools: body.tools.map(tool => tool.function.name), text: String(result?.content ?? "") })
    const deniedEdit = body.messages.some(message => message.role === "user" && typeof message.content === "string" && message.content.includes("Denied edit"))
    const setsid = body.messages.some(message => message.role === "user" && typeof message.content === "string" && message.content.includes("Attempt setsid"))
    const fn = deniedEdit ? { name: "write_file", arguments: JSON.stringify({ path: "denied.txt", content: "not permitted" }) }
      : setsid ? { name: "bash", arguments: JSON.stringify({ command: "python3 -c 'import os; os.setsid()'" }) }
      : { name: "read_file", arguments: JSON.stringify({ path: "reference.txt" }) }
    const delta = result ? { content: "Checked the workspace." } : { tool_calls: [{ index: 0, id: "read-1", type: "function", function: fn }] }
    const chunk = (delta: object, finish: string | null) => `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 3 } })}\n\n`
    return new Response(chunk(delta, null) + chunk({}, result ? "stop" : "tool_calls") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
  } })
  const oldData = process.env.ZAPCODE_DATA_DIR
  try {
    process.env.ZAPCODE_DATA_DIR = data
    const provider = createCustomProvider({ name: "Fixture", baseURL: `http://127.0.0.1:${model.port}/v1`, apiKey: "fixture", models: ["fixture"], contextWindow: 128000 })
    await writeFile(join(data, "config.json"), JSON.stringify({ ...getDefaultConfig(), allowUnsandboxedCommands: true,
      sandboxExcludedCommands: ["printf*"], providers: [provider], active: { providerId: provider.id, model: "fixture" } }), { mode: 0o600 })
    const ledgerPath = join(data, "goals.sqlite"), ledger = new GoalBudgetLedger(ledgerPath)
    ledger.create("g", 1, { maxTokens: 500_000, maxModelCalls: 10, maxToolCalls: 10 })
    const lifecycle: string[] = []
    const first = await runGoalPhase({ cwd: worker, prompt: "Read reference.txt", goalId: "g", epoch: 1, role: "worker", ledgerPath,
      onSpawn(pid) { lifecycle.push(`spawn:${pid}`) }, onStopped(pid) { lifecycle.push(`stopped:${pid}`) } })
    expect(first.toolCalls).toBeGreaterThan(0)
    expect(lifecycle).toHaveLength(2)
    expect(lifecycle[0]!.replace("spawn:", "")).toBe(lifecycle[1]!.replace("stopped:", ""))
    expect(first.text).toContain("Checked")
    expect(first.outcome.execution.status).toBe("finished")
    let machineStarted = false
    await expect(runGoalMachinePhase({ cwd: verifier, prompt: "Run the authorized machine check", goalId: "g", epoch: 1,
      role: "verifier", ledgerPath, machineCheck: "bun", onSpawn() { machineStarted = true } })).rejects.toThrow("GOAL_VERIFIER_PROCESS_SEAL_UNSUPPORTED")
    expect(machineStarted).toBe(false)
    expect(requests.some(item => item.text.includes("worker-context"))).toBe(true)
    expect(requests[0]!.tools).toContain("write_file")
    expect(requests[0]!.tools).not.toContain("bash")
    expect(requests[0]!.tools).not.toContain("agent")
    const before = requests.length
    const second = await runGoalPhase({ cwd: verifier, prompt: "Read reference.txt", goalId: "g", epoch: 1, role: "verifier", ledgerPath })
    expect(second.outcome.execution.status).toBe("finished")
    expect(requests.slice(before).some(item => item.text.includes("verifier-context"))).toBe(true)
    expect(requests[before]!.tools).not.toContain("write_file")
    expect(requests[before]!.tools).not.toContain("search_files")
    expect(requests[before]!.tools).not.toContain("glob_files")
    // A relative PATH entry must not let a workspace supply the Git process
    // used by session initialization, even if it tries to escape the group.
    const marker = join(root, "escaped-git")
    await writeFile(join(verifier, "git"), `#!/usr/bin/python3\nimport os\nos.setsid()\nopen(${JSON.stringify(marker)}, "w").write("escaped")\n`)
    await chmod(join(verifier, "git"), 0o755)
    ledger.create("hostile-path", 1, { maxTokens: 500_000, maxModelCalls: 10, maxToolCalls: 10 })
    const oldPath = process.env.PATH
    process.env.PATH = `.:${oldPath ?? ""}`
    try {
      await runGoalPhase({ cwd: verifier, prompt: "Read reference.txt", goalId: "hostile-path", epoch: 1, role: "verifier", ledgerPath })
      await expect(readFile(marker, "utf8")).rejects.toThrow()
    } finally { if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath }
    const snapshot = ledger.snapshot("g")
    expect(snapshot.totals.modelCalls).toBeGreaterThanOrEqual(4)
    expect(snapshot.totals.toolCalls).toBe(2)
    expect(snapshot.reservations.every(item => item.scope?.modelId === "fixture")).toBe(true)
    // Read-only phases must start even when VM is explicitly selected, and
    // must not offer helpers that can launch a host-selected ripgrep binary.
    ledger.create("vm-planner", 1, { maxTokens: 500_000, maxModelCalls: 10, maxToolCalls: 10 })
    ledger.create("vm-worker", 1, { maxTokens: 500_000, maxModelCalls: 10, maxToolCalls: 10 })
    const oldBackend = process.env.ZAPCODE_EXECUTION
    process.env.ZAPCODE_EXECUTION = "vm"
    try {
      const vmStart = requests.length
      const planned = await runGoalPhase({ cwd: verifier, prompt: "Read reference.txt", goalId: "vm-planner", epoch: 1, role: "planner", ledgerPath })
      expect(planned.outcome.execution.status).toBe("finished")
      expect(requests[vmStart]!.tools).not.toContain("bash")
      expect(requests[vmStart]!.tools).not.toContain("search_files")
      expect(requests[vmStart]!.tools).not.toContain("glob_files")
      const worked = await runGoalPhase({ cwd: worker, prompt: "Read reference.txt", goalId: "vm-worker", epoch: 1, role: "worker", ledgerPath })
      expect(worked.outcome.execution.status).toBe("finished")
    } finally {
      if (oldBackend === undefined) delete process.env.ZAPCODE_EXECUTION
      else process.env.ZAPCODE_EXECUTION = oldBackend
    }
    expect(await readFile(join(worker, "reference.txt"), "utf8")).toBe("worker-context")
    ledger.create("observe", 1, { maxTokens: 500_000, maxModelCalls: 10, maxToolCalls: 10, strict: false })
    const observationStart = requests.length
    await runGoalPhase({ cwd: worker, prompt: "Read reference.txt", goalId: "observe", epoch: 1, role: "worker", ledgerPath, permissionMode: "bypassPermissions" })
    expect(requests[observationStart]!.tools).not.toContain("bash")
    expect(requests[observationStart]!.tools).not.toContain("agent")
    expect(requests[observationStart]!.tools).toContain("http_fetch")
    expect(requests[observationStart]!.tools).not.toContain("http_request")
    for (const blocked of ["cron_create", "cron_delete", "memory_save", "browser_screenshot", "task_stop", "delegate_agent", "monitor", "web_search"]) {
      expect(requests[observationStart]!.tools).not.toContain(blocked)
    }
    expect(ledger.snapshot("observe").totals.opaqueToolCalls).toBe(0)
    ledger.create("final", 1, { maxTokens: 500_000, maxModelCalls: 10, maxToolCalls: 10 })
    const finalStart = requests.length
    await runGoalPhase({ cwd: verifier, prompt: "Read reference.txt for final acceptance", goalId: "final", epoch: 1, role: "finalization", ledgerPath })
    expect(requests[finalStart]!.tools).toContain("read_file")
    expect(requests[finalStart]!.tools).not.toContain("write_file")
    expect(requests[finalStart]!.tools).not.toContain("bash")
    ledger.create("denied", 1, { maxTokens: 500_000, maxModelCalls: 10 })
    await expect(runGoalPhase({ cwd: worker, prompt: "Denied edit", goalId: "denied", epoch: 1, role: "worker", ledgerPath, permissionMode: "default" })).rejects.toThrow("GOAL_PHASE_PERMISSION_DENIED")
    await expect(readFile(join(worker, "denied.txt"), "utf8")).rejects.toThrow()
    ledger.create("escape", 1, { maxTokens: 500_000, maxModelCalls: 10, strict: false })
    await expect(runGoalPhase({ cwd: worker, prompt: "Attempt setsid", goalId: "escape", epoch: 1, role: "worker", ledgerPath, permissionMode: "bypassPermissions" })).rejects.toThrow("GOAL_UNMETERED_TOOL_UNAVAILABLE")
    ledger.create("abort", 1, { maxTokens: 500_000, maxModelCalls: 10, strict: false })
    const aborter = new AbortController(), cancelledLifecycle: string[] = []
    const cancelled = runGoalPhase({ cwd: worker, prompt: "Wait for abort", goalId: "abort", epoch: 1, role: "worker", ledgerPath,
      signal: aborter.signal, onSpawn(pid) { cancelledLifecycle.push(`spawn:${pid}`) }, onStopped(pid) { cancelledLifecycle.push(`stopped:${pid}`) } })
    await waiting
    aborter.abort()
    await expect(cancelled).rejects.toThrow("GOAL_PHASE_CANCELLED")
    // Native phases cannot launch shell, so their process group can be retired.
    expect(cancelledLifecycle).toHaveLength(2)
    expect(cancelledLifecycle[0]!.replace("spawn:", "")).toBe(cancelledLifecycle[1]!.replace("stopped:", ""))
    ledger.create("spawn-failure", 1, { maxTokens: 500_000 })
    const beforeFailure = requests.length, failureLifecycle: string[] = []
    await expect(runGoalPhase({ cwd: worker, prompt: "MUST_NOT_SEND", goalId: "spawn-failure", epoch: 1, role: "worker", ledgerPath,
      onSpawn() { failureLifecycle.push("record-attempt"); throw new Error("persist failed") }, onStopped() { failureLifecycle.push("stopped") } })).rejects.toThrow("persist failed")
    expect(failureLifecycle).toEqual(["record-attempt"])
    expect(requests.length).toBe(beforeFailure)
    ledger.close()
  } finally {
    if (oldData === undefined) delete process.env.ZAPCODE_DATA_DIR
    else process.env.ZAPCODE_DATA_DIR = oldData
    model.stop()
    await rm(root, { recursive: true, force: true })
  }
}, 60_000)

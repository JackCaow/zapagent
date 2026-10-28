import { expect, it } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createCustomProvider, getDefaultConfig } from "../../src/config.js"
import { runGoalPhase } from "../../src/headless/goalPhase.js"
import { GoalBudgetLedger } from "../../zapsdk/goal/budget.js"

it("prepares npm inputs for isolated worker and child before model access", async () => {
  const root = await mkdtemp(join(tmpdir(), "goal-npm-phase-"))
  const cwd = join(root, "work"), data = join(root, "data"), runtime = join(root, "runtime"), audit = join(root, "audit")
  await mkdir(cwd); await mkdir(data); await mkdir(join(runtime, "images"), { recursive: true })
  await writeFile(join(cwd, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0", private: true }))
  await writeFile(join(cwd, "package-lock.json"), JSON.stringify({ name: "fixture", version: "1.0.0", lockfileVersion: 3, packages: { "": { name: "fixture", version: "1.0.0" } } }))
  await writeFile(join(runtime, "images", "active.json"), "{}"); await writeFile(join(runtime, "image-public.pem"), "fixture")
  const binary = join(runtime, "zapvm")
  await writeFile(binary, ["#!/bin/sh", 'if [ "$1 $2" = "daemon status" ]; then echo \'{"degraded":false}\'; exit 0; fi',
    'if [ "$1" = "_fs-publish-directory" ]; then shift; source=; dest=; while [ "$#" -gt 0 ]; do case "$1" in --source) source="$2"; shift 2;; --destination) dest="$2"; shift 2;; *) exit 91;; esac; done; [ ! -e "$dest" ] || exit 92; /bin/mv "$source" "$dest"; exit $?; fi',
    'request=; session=; result=; work=; protected=; while [ "$#" -gt 0 ]; do case "$1" in --request-id) request="$2"; shift 2;; --session-id) session="$2"; shift 2;; --result-file) result="$2"; shift 2;; --workspace) work="$2"; shift 2;; --protect-workspace-path) protected="$protected:$2"; shift 2;; *) shift;; esac; done',
    'case "$protected" in *:package.json*:package-lock.json*) ;; *) exit 93;; esac',
    '/bin/mkdir -p "$work/node_modules/fixture"; printf "installed\\n" > "$work/node_modules/fixture/index.js"',
    `printf 'install\n' >> '${audit}'`,
    `if [ -f '${join(root, "drop-receipt")}' ]; then exit 0; fi`,
    'printf \'{"request_id":"%s","session_id":"%s","exit_code":0,"seal":{"mechanism":"cgroup-v2","state":"empty"}}\' "$request" "$session" > "$result"',
    'exit 0', ""].join("\n")); await chmod(binary, 0o755)
  let childSeen = false
  let drift: "none" | "worker-manifest" | "worker-lock" | "child-manifest" | "child-lock" = "none"
  const model = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    const body = await request.json() as { messages: Array<{ role: string; content: unknown }>; tools: Array<{ function: { name: string } }> }
    const child = !body.tools.some(tool => tool.function.name === "agent")
    const result = body.messages.filter(message => message.role === "tool").at(-1)
    let delta: object, finish: string
    if (child) {
      childSeen = true
      if (!result && drift.startsWith("child-")) { delta = { tool_calls: [{ index: 0, id: "child-write", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: drift === "child-lock" ? "package-lock.json" : "package.json", content: "{}" }) } }] }; finish = "tool_calls" }
      else if (!result) { delta = { tool_calls: [{ index: 0, id: "child-read", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "node_modules/fixture/index.js" }) } }] }; finish = "tool_calls" }
      else { delta = { content: String(result.content) }; finish = "stop" }
    } else if (!result && drift.startsWith("worker-")) {
      delta = { tool_calls: [{ index: 0, id: "worker-write", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: drift === "worker-lock" ? "package-lock.json" : "package.json", content: "{}" }) } }] }; finish = "tool_calls"
    } else if (!result) {
      delta = { tool_calls: [{ index: 0, id: "spawn-child", type: "function", function: { name: "agent", arguments: JSON.stringify({ task: "Read installed package", agent_type: "general" }) } }] }; finish = "tool_calls"
    } else { delta = { content: String(result.content) }; finish = "stop" }
    const chunk = (part: object, reason: string | null) => `data: ${JSON.stringify({ id: "goal", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta: part, finish_reason: reason }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\n`
    return new Response(chunk(delta, null) + chunk({}, finish) + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
  } })
  const saved = { data: process.env.ZAPCODE_DATA_DIR, backend: process.env.ZAPCODE_EXECUTION, runtime: process.env.ZAPCODE_ZAPVM_RUNTIME_DIR }
  try {
    process.env.ZAPCODE_DATA_DIR = data; process.env.ZAPCODE_EXECUTION = "vm"; process.env.ZAPCODE_ZAPVM_RUNTIME_DIR = runtime
    const provider = createCustomProvider({ name: "Fixture", baseURL: `http://127.0.0.1:${model.port}/v1`, apiKey: "fixture", models: ["fixture"], contextWindow: 128000 })
    await writeFile(join(data, "config.json"), JSON.stringify({ ...getDefaultConfig(), executionBackend: "vm", providers: [provider], active: { providerId: provider.id, model: "fixture" } }))
    const ledgerPath = join(data, "goals.sqlite"), ledger = new GoalBudgetLedger(ledgerPath)
    ledger.create("npm-child", 1, { maxTokens: 500_000, maxModelCalls: 20, maxToolCalls: 20, maxSpawns: 2 })
    const result = await runGoalPhase({ cwd, prompt: "Delegate the check", goalId: "npm-child", epoch: 1, role: "worker", ledgerPath, dependencyInstall: "npm", permissionMode: "bypassPermissions" })
    expect(result.outcome.execution.status).toBe("finished")
    expect(childSeen).toBe(true); expect(result.text).toContain("installed")
    expect(await readFile(join(cwd, "node_modules/fixture/index.js"), "utf8")).toBe("installed\n")
    expect((await readFile(audit, "utf8")).trim().split("\n")).toHaveLength(2)
    expect(ledger.snapshot("npm-child").totals.toolCalls).toBeGreaterThanOrEqual(4)
    for (const change of ["worker-manifest", "worker-lock", "child-manifest", "child-lock"] as const) {
      const isolated = join(root, change); await mkdir(isolated)
      await writeFile(join(isolated, "package.json"), await readFile(join(cwd, "package.json")))
      await writeFile(join(isolated, "package-lock.json"), await readFile(join(cwd, "package-lock.json")))
      ledger.create(change, 1, { maxTokens: 500_000, maxModelCalls: 20, maxToolCalls: 20, maxSpawns: 2 })
      drift = change
      let wasStopped = false
      await expect(runGoalPhase({ cwd: isolated, prompt: `Try ${change}`, goalId: change, epoch: 1, role: "worker", ledgerPath, dependencyInstall: "npm", permissionMode: "bypassPermissions", onStopped() { wasStopped = true } })).rejects.toThrow(change.startsWith("worker-") ? "GOAL_NPM_INPUTS_MODIFIED" : "GOAL_SEAL_UNCONFIRMED")
      expect(wasStopped).toBe(false)
    }
    drift = "none"
    // A budget denial after a sealed install has no live tools. Preserve the
    // limit error while allowing the Host to release this proven-stopped phase.
    ledger.create("model-limited", 1, { maxModelCalls: 0 })
    let safelyStopped = false
    await expect(runGoalPhase({ cwd, prompt: "Budget checkpoint", goalId: "model-limited", epoch: 1, role: "worker", ledgerPath, dependencyInstall: "npm", permissionMode: "bypassPermissions", onStopped() { safelyStopped = true } })).rejects.toThrow("GOAL_BUDGET_LIMITED")
    expect(safelyStopped).toBe(true)
    // Pre-existing user data must never be replaced, even when it differs
    // from a newly sealed installation.
    await writeFile(join(cwd, "node_modules/fixture/index.js"), "user data\n")
    ledger.create("npm-conflict", 1, { maxTokens: 500_000, maxModelCalls: 20, maxToolCalls: 20 })
    let stopped = false
    await expect(runGoalPhase({ cwd, prompt: "Do not overwrite", goalId: "npm-conflict", epoch: 1, role: "worker", ledgerPath, dependencyInstall: "npm", permissionMode: "bypassPermissions", onStopped() { stopped = true } })).rejects.toThrow("Existing node_modules differs")
    expect(stopped).toBe(false)
    expect(await readFile(join(cwd, "node_modules/fixture/index.js"), "utf8")).toBe("user data\n")
    const interrupted = join(root, "interrupted"); await mkdir(interrupted)
    await writeFile(join(interrupted, "package.json"), await readFile(join(cwd, "package.json")))
    await writeFile(join(interrupted, "package-lock.json"), await readFile(join(cwd, "package-lock.json")))
    await writeFile(join(root, "drop-receipt"), "yes")
    ledger.create("npm-unsealed", 1, { maxTokens: 500_000, maxModelCalls: 20, maxToolCalls: 20 })
    stopped = false
    await expect(runGoalPhase({ cwd: interrupted, prompt: "Wait for seal", goalId: "npm-unsealed", epoch: 1, role: "worker", ledgerPath, dependencyInstall: "npm", permissionMode: "bypassPermissions", onStopped() { stopped = true } })).rejects.toThrow("GOAL_NPM_SEAL_UNCONFIRMED")
    expect(stopped).toBe(false)
    await expect(readFile(join(interrupted, "node_modules/fixture/index.js"))).rejects.toThrow()
    ledger.close()
  } finally {
    for (const [key, value] of [["ZAPCODE_DATA_DIR", saved.data], ["ZAPCODE_EXECUTION", saved.backend], ["ZAPCODE_ZAPVM_RUNTIME_DIR", saved.runtime]] as const) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    model.stop(); await rm(root, { recursive: true, force: true })
  }
}, 30_000)

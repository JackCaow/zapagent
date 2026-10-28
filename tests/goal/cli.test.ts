import { expect, it } from "bun:test"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { execFileSync, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { createCustomProvider, getDefaultConfig } from "../../src/config.js"
import { GoalStore } from "../../zapsdk/goal/store.js"

const cli = resolve("src/index.tsx")
function processRun(cwd: string, env: Record<string, string>, args: string[]) {
  return new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] })
    let output = ""; child.stdout.on("data", v => { output += String(v) }); child.stderr.on("data", v => { output += String(v) })
    child.once("error", reject); child.once("close", code => resolve({ code, output }))
  })
}
for (const { git, machine, denied } of [{ git: false, machine: false, denied: false }, { git: true, machine: false, denied: false }, { git: false, machine: true, denied: false }, { git: false, machine: false, denied: true }]) {
  it(git ? "runs a Git Goal without changing source Git history or index" : `runs a non-Git Goal ${denied ? "with denied file edits" : machine ? "with unavailable machine checks" : "through independent checks and source delivery"}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "zap-goal-cli-")); const data = join(root, "data"), cwd = join(root, "project")
    await mkdir(data); await mkdir(cwd)
    await writeFile(join(cwd, "hello.test.ts"), 'import { it, expect } from "bun:test"; it("works", () => expect(1+1).toBe(2))\n')
    if (git) {
      const init = await processRun(cwd, {}, ["--version"]); expect(init.code).toBe(0)
      for (const args of [["init", "-q"], ["config", "user.name", "Goal Test"], ["config", "user.email", "goal@example.invalid"], ["add", "hello.test.ts"], ["commit", "-qm", "base"]]) {
        const code = await new Promise<number | null>((resolve, reject) => { const child = spawn("git", args, { cwd, stdio: "ignore" }); child.on("error", reject); child.on("close", resolve) }); expect(code).toBe(0)
      }
      await writeFile(join(cwd, "staged.txt"), "user-staged\n")
      execFileSync("git", ["-C", cwd, "add", "staged.txt"])
    }
    const sourceHead = git ? execFileSync("git", ["-C", cwd, "rev-parse", "HEAD"], { encoding: "utf8" }).trim() : ""
    const sourceIndex = git ? execFileSync("git", ["-C", cwd, "diff", "--cached", "--binary"]).toString() : ""
    const requests: string[] = []
    const model = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
      const body = await request.json() as { messages: Array<{ role: string; content: unknown }> }
      const userText = body.messages.filter(x => x.role === "user" && typeof x.content === "string").map(x => x.content).join("\n")
      let value: object, finish = "stop"
      if (userText.includes("Plan the user's goal")) { requests.push("plan"); value = { content: JSON.stringify({ tasks: [{ id: "one", description: "Write report.txt", acceptance: "The report says goal passed", dependencies: [] }] }) } }
      else if (userText.includes("Work on the user's goal")) {
        if (body.messages.some(x => x.role === "tool")) { requests.push("worker-result:" + String(body.messages.find(x => x.role === "tool")?.content)); value = { content: "Created the report." } }
        else { requests.push("worker-write"); finish = "tool_calls"; value = { tool_calls: [{ index: 0, id: "write-1", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "report.txt", content: "goal passed\n" }) } }] } }
      } else if (userText.includes("You are an independent verifier")) { requests.push(userText.includes("goal passed") ? "verify-evidence" : "verify-missing"); value = { content: JSON.stringify({ status: "passed", detail: "The report contains the required text." }) } }
      else if (userText.includes("Inspect the frozen final Goal")) { requests.push("finalization"); value = { content: "A report and a test." } }
      else { requests.push("other"); value = { content: "Finished." } }
      const chunk = (delta: object, reason: string | null) => `data: ${JSON.stringify({ id: "goal", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason: reason }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\n`
      return new Response(chunk(value, null) + chunk({}, finish) + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
    } })
    try {
      const provider = createCustomProvider({ name: "Fixture", baseURL: `http://127.0.0.1:${model.port}/v1`, apiKey: "fixture", models: ["fixture"], contextWindow: 128000 })
      await writeFile(join(data, "config.json"), JSON.stringify({ ...getDefaultConfig(), permissionMode: "acceptEdits", providers: [provider], active: { providerId: provider.id, model: "fixture" } }))
      const env = { ZAPCODE_DATA_DIR: data }
      const start = await processRun(cwd, env, ["goal", "write report and pass tests", ...(!denied ? ["--accept-edits"] : []), ...(git ? ["--strict"] : []), ...(machine ? ["--check=bun"] : [])])
      if (machine) {
        expect(start.code).toBe(1)
        expect(start.output).toContain("--check machine verification is currently unavailable")
        await expect(readFile(join(data, "goal", "goals.sqlite"))).rejects.toThrow()
        expect(requests).toEqual([])
        return
      }
      expect(start.code).toBe(0)
      const id = /goal_[a-f0-9-]+/.exec(start.output)?.[0]; expect(id).toBeDefined()
      const db = join(data, "goal", "goals.sqlite")
      let result: ReturnType<GoalStore["get"]>
      for (let i = 0; i < 200; i++) {
        await new Promise(resolve => setTimeout(resolve, 100))
        const store = new GoalStore(db); result = store.get(id!); store.close()
        if (result && ["completed", "blocked", "awaiting_acceptance", "failed", "ready_for_delivery"].includes(result.status)) break
      }
      if (git && process.platform !== "darwin") {
        expect(result?.status).toBe("blocked")
        expect(result?.stopReason).toContain("requires macOS Seatbelt")
        await expect(readFile(join(cwd, "report.txt"), "utf8")).rejects.toThrow()
        return
      }
      if (denied) {
        expect(result?.status).toBe("blocked")
        await expect(readFile(join(cwd, "report.txt"), "utf8")).rejects.toThrow()
        return
      }
      if (result?.status !== "completed") {
        const diagnostic = await processRun(cwd, env, ["goal", "status", id!])
        const logPath = join(data, "goal", "runs", createHash("sha256").update(id!).digest("hex"), "runner.log")
        const log = await readFile(logPath, "utf8").catch(() => "[no log]")
        throw new Error(`Goal ended ${result?.status}: ${result?.stopReason}\n${diagnostic.output}\n${log}`)
      }
      try { expect(await readFile(join(cwd, "report.txt"), "utf8")).toBe("goal passed\n") }
      catch (error) { throw new Error(`Missing report: ${JSON.stringify({ requests, status: result?.status, delivery: result?.delivery, error: String(error) })}`) }
      expect(requests.filter(x => x === "verify-evidence")).toHaveLength(2)
      expect(requests).toContain("finalization")
      if (git) {
        expect(execFileSync("git", ["-C", cwd, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()).toBe(sourceHead)
        expect(execFileSync("git", ["-C", cwd, "diff", "--cached", "--binary"]).toString()).toBe(sourceIndex)
      }
    } finally { model.stop(); await rm(root, { recursive: true, force: true }) }
  }, 30_000)
}

it("pauses a real Goal process, preserves budget and safely resumes its interrupted worker", async () => {
  const root = await mkdtemp(join(tmpdir(), "zap-goal-pause-")); const data = join(root, "data"), cwd = join(root, "project")
  await mkdir(data); await mkdir(cwd)
  let workerCalls = 0; let markWorker!: () => void
  const workerStarted = new Promise<void>(resolve => { markWorker = resolve })
  const model = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    const body = await request.json() as { messages: Array<{ role: string; content: unknown }> }
    const userText = body.messages.filter(x => x.role === "user" && typeof x.content === "string").map(x => x.content).join("\n")
    let value: object, finish = "stop"
    if (userText.includes("Plan the user's goal")) value = { content: JSON.stringify({ tasks: [{ id: "one", description: "Write result.txt", acceptance: "File contains completed", dependencies: [] }] }) }
    else if (userText.includes("Work on the user's goal")) {
      if (body.messages.some(x => x.role === "tool")) value = { content: "Created result." }
      else if (++workerCalls === 1) {
        markWorker()
        await Promise.race([new Promise(resolve => request.signal.addEventListener("abort", resolve, { once: true })), new Promise(resolve => setTimeout(resolve, 10_000))])
        return new Response("", { status: 499 })
      } else { finish = "tool_calls"; value = { tool_calls: [{ index: 0, id: "write-1", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "result.txt", content: "completed\n" }) } }] } }
    } else if (userText.includes("You are an independent verifier")) value = { content: JSON.stringify({ status: "passed", detail: "The file contains completed." }) }
    else value = { content: "Summary." }
    const chunk = (delta: object, reason: string | null) => `data: ${JSON.stringify({ id: "goal", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason: reason }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\n`
    return new Response(chunk(value, null) + chunk({}, finish) + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
  } })
  try {
    const provider = createCustomProvider({ name: "Fixture", baseURL: `http://127.0.0.1:${model.port}/v1`, apiKey: "fixture", models: ["fixture"], contextWindow: 128000 })
    await writeFile(join(data, "config.json"), JSON.stringify({ ...getDefaultConfig(), providers: [provider], active: { providerId: provider.id, model: "fixture" } }))
    const env = { ZAPCODE_DATA_DIR: data }; const db = join(data, "goal", "goals.sqlite")
    const start = await processRun(cwd, env, ["goal", "write result", "--accept-edits"])
    const id = /goal_[a-f0-9-]+/.exec(start.output)?.[0]; expect(id).toBeDefined()
    await workerStarted
    expect((await processRun(cwd, env, ["goal", "pause", id!])).code).toBe(0)
    let paused: ReturnType<GoalStore["get"]>
    for (let i = 0; i < 100; i++) { await new Promise(resolve => setTimeout(resolve, 100)); const store = new GoalStore(db); paused = store.get(id!); store.close(); if (paused?.status === "paused") break }
    expect(paused?.status).toBe("paused"); expect(paused?.inFlight?.phase).toBe("executing")
    const resume = await processRun(cwd, env, ["goal", "resume", id!]); expect(resume.code).toBe(0)
    let completed: ReturnType<GoalStore["get"]>
    for (let i = 0; i < 150; i++) { await new Promise(resolve => setTimeout(resolve, 100)); const store = new GoalStore(db); completed = store.get(id!); store.close(); if (completed && ["completed", "blocked"].includes(completed.status)) break }
    if (completed?.status !== "completed") throw new Error(`Resume: ${completed?.status} ${completed?.stopReason}`)
    expect(await readFile(join(cwd, "result.txt"), "utf8")).toBe("completed\n")
    expect(completed.ownerEpoch).toBeGreaterThan(1); expect(completed.tasks[0]?.attempt).toBe(2)
  } finally { model.stop(); await rm(root, { recursive: true, force: true }) }
}, 30_000)

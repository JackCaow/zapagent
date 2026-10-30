import { expect, it } from "bun:test"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createCustomProvider, getDefaultConfig } from "../../src/config.js"
import { GoalStore } from "../../zapsdk/goal/store.js"

it("retains the seal marker and blocks recovery when a real Goal phase is killed", async () => {
  if (process.platform === "win32") return
  const root = await mkdtemp(join(tmpdir(), "zap-goal-crash-"))
  const cwd = join(root, "project"), data = join(root, "data"), runtime = join(root, "runtime")
  await mkdir(cwd); await mkdir(data); await mkdir(join(runtime, "images"), { recursive: true })
  // Discovery fixture only: no VM command is executed by this test. It selects
  // the seal-capable broker, so a killed phase must retain its receipt marker.
  await writeFile(join(runtime, "zapvm"), "#!/bin/sh\nexit 1\n", { mode: 0o755 })
  await writeFile(join(runtime, "images", "active.json"), "{}")
  await writeFile(join(runtime, "image-public.pem"), "fixture")
  let started!: () => void
  const workerStarted = new Promise<void>(resolve => { started = resolve })
  const model = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    const body = await request.json() as { messages: Array<{ role: string; content: unknown }> }
    const text = body.messages.filter(x => x.role === "user" && typeof x.content === "string").map(x => x.content).join("\n")
    if (text.includes("Work on the user's goal")) {
      started()
      await new Promise(resolve => { const timer = setTimeout(resolve, 15_000); timer.unref(); request.signal.addEventListener("abort", () => { clearTimeout(timer); resolve(undefined) }, { once: true }) })
      return new Response("", { status: 499 })
    }
    const content = JSON.stringify({ tasks: [{ id: "one", description: "Write report.txt", acceptance: "Report exists", dependencies: [] }] })
    const chunk = (delta: object, finish_reason: string | null) => `data: ${JSON.stringify({ id: "goal", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\n`
    return new Response(chunk({ content }, null) + chunk({}, "stop") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
  } })
  const env = { ...process.env, ZAPCODE_DATA_DIR: data, ZAPCODE_EXECUTION: "vm", ZAPCODE_ZAPVM_RUNTIME_DIR: runtime, ZAPCODE_DISABLE_ZAPVM: "0" }
  function cli(args: string[]) {
    return new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [resolvePath, ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] })
      let output = ""; child.stdout.on("data", b => output += String(b)); child.stderr.on("data", b => output += String(b))
      child.once("error", reject); child.once("close", code => resolve({ code, output }))
    })
  }
  const resolvePath = resolve("src/index.tsx")
  let phasePid: number | undefined
  try {
    const provider = createCustomProvider({ name: "Fixture", baseURL: `http://127.0.0.1:${model.port}/v1`, apiKey: "fixture", models: ["fixture"], contextWindow: 128000 })
    await writeFile(join(data, "config.json"), JSON.stringify({ ...getDefaultConfig(), executionBackend: "vm", providers: [provider], active: { providerId: provider.id, model: "fixture" } }))
    const start = await cli(["goal", "write report", "--background", "--accept-edits"])
    expect(start.code).toBe(0)
    const id = /goal_[a-f0-9-]+/.exec(start.output)?.[0]; expect(id).toBeDefined()
    let startTimer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([workerStarted, new Promise((_, reject) => { startTimer = setTimeout(async () => reject(new Error("worker did not start: " + await readFile(join(data, "goal", "runs", createHash("sha256").update(id!).digest("hex"), "runner.log"), "utf8"))), 10_000) })])
    } finally { if (startTimer) clearTimeout(startTimer) }
    const metaPath = join(data, "goal", "runs", createHash("sha256").update(id!).digest("hex"), "workspace.json")
    const before = JSON.parse(await readFile(metaPath, "utf8")) as { phaseProcess?: { pid: number; operationId: string; requiresReceipt: boolean } }
    expect(before.phaseProcess?.requiresReceipt).toBe(true)
    phasePid = before.phaseProcess!.pid
    process.kill(phasePid, "SIGKILL")
    const db = join(data, "goal", "goals.sqlite")
    let goal: ReturnType<GoalStore["get"]>
    for (let i = 0; i < 100; i++) {
      await new Promise(resolve => setTimeout(resolve, 100))
      const store = new GoalStore(db); goal = store.get(id!); store.close()
      if (goal?.status === "blocked") break
    }
    expect(goal?.status).toBe("blocked")
    expect(goal?.inFlight?.phase).toBe("executing")
    expect(goal?.delivery).toBeUndefined()
    const after = JSON.parse(await readFile(metaPath, "utf8")) as typeof before
    expect(after.phaseProcess).toEqual(before.phaseProcess)
    expect((await cli(["goal", "resume", id!, "--background"])).code).toBe(0)
    let recovered: ReturnType<GoalStore["get"]>
    for (let i = 0; i < 100; i++) {
      await new Promise(resolve => setTimeout(resolve, 100))
      const store = new GoalStore(db); recovered = store.get(id!); store.close()
      if (recovered?.status === "blocked" && recovered.ownerEpoch > goal!.ownerEpoch) break
    }
    expect(recovered?.status).toBe("blocked")
    expect(recovered!.ownerEpoch).toBeGreaterThan(goal!.ownerEpoch)
    expect(recovered?.stopReason).toContain("seal receipt is missing")
    expect(recovered?.inFlight?.operationId).toBe(before.phaseProcess?.operationId)
    expect(recovered?.delivery).toBeUndefined()
    expect((JSON.parse(await readFile(metaPath, "utf8")) as typeof before).phaseProcess).toEqual(before.phaseProcess)
    await expect(readFile(join(cwd, "report.txt"))).rejects.toThrow()
  } finally {
    if (phasePid) try { process.kill(-phasePid, "SIGKILL") } catch { /* already gone */ }
    model.stop(); await rm(root, { recursive: true, force: true })
  }
}, 30_000)

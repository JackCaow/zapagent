import { expect, it } from "bun:test"
import { spawn } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { createCustomProvider, getDefaultConfig } from "../../src/config.js"
import { GoalStore } from "../../zapsdk/goal/store.js"
import { createHash } from "node:crypto"

for (const action of ["pause", "cancel", "background", "new-input", "close", "SIGTERM"] as const) {
  it(`foreground Goal ${action} respects the owned phase boundary`, async () => {
    const root = await mkdtemp(join(tmpdir(), "zap-goal-foreground-control-")), data = join(root, "data"), cwd = join(root, "workspace")
    await mkdir(data); await mkdir(cwd)
    let release!: () => void, planning!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const plannerSeen = new Promise<void>(resolve => { planning = resolve })
    let first = true
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      const body = await request.json() as any
      const prompt = body.messages.filter((m: any) => m.role === "user").map((m: any) => String(m.content)).join("\n")
      let delta: object, finish = "stop"
      if (prompt.includes("Plan the user's goal")) {
        delta = { content: JSON.stringify({ tasks: [{ id: "one", description: "Write result.txt", acceptance: "result.txt says verified", dependencies: [] }] }) }
      } else if (prompt.includes("Work on the user's goal") && !body.messages.some((m: any) => m.role === "tool")) {
        if (first) { first = false; planning(); await gate }
        finish = "tool_calls"
        delta = { tool_calls: [{ index: 0, id: "write", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "result.txt", content: "verified\n" }) } }] }
      } else if (prompt.includes("You are an independent verifier")) delta = { content: JSON.stringify({ status: "passed", detail: "Verified actual artifact." }) }
      else delta = { content: "Verified result." }
      const frame = (delta: object, reason: string | null) => `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "fixture", choices: [{ index: 0, delta, finish_reason: reason }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\n`
      return new Response(frame(delta, null) + frame({}, finish) + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
    } })
    let child: ReturnType<typeof spawn> | undefined
    try {
      const provider = createCustomProvider({ name: "Fixture", baseURL: `http://127.0.0.1:${server.port}/v1`, apiKey: "fixture", models: ["fixture"], contextWindow: 128000 })
      await writeFile(join(data, "config.json"), JSON.stringify({ ...getDefaultConfig(), providers: [provider], active: { providerId: provider.id, model: "fixture" } }))
      const script = `
        import { executeGoalCommand,closeForegroundGoals } from ${JSON.stringify(resolve("src/goal-session.ts"))};
        import { pauseGoalsForUserInput,goalDatabasePath } from ${JSON.stringify(resolve("src/goal-command.ts"))};
        import { GoalStore } from ${JSON.stringify(resolve("zapsdk/goal/store.ts"))};
        let id,control=Promise.resolve(); const emit=x=>process.stdout.write(JSON.stringify(x)+"\\n");
        const options={sessionId:"foreground-chat",onStart:g=>{id=g.id;emit({started:id})},onMessage:text=>emit({message:text}),onEvent() {}};
        const running=executeGoalCommand(["Write verified result", "--accept-edits"],process.cwd(),options);
        process.stdin.on("data",chunk=>{ const action=String(chunk).trim(); control=(async()=>{
          if(action==="new-input") pauseGoalsForUserInput(process.cwd(),"foreground-chat","Next user message");
          else if(action==="close") await closeForegroundGoals();
          else await executeGoalCommand([action,id],process.cwd(),options);
          emit({controlled:action});
        })(); });
        const code=await running; await control;
        const store=new GoalStore(goalDatabasePath());const goal=store.get(id);store.close();emit({done:true,code,goal});process.exit(0);
      `
      child = spawn(process.execPath, ["-e", script], { cwd, env: { ...process.env, ZAPCODE_DATA_DIR: data, ZAP_DISABLE_UPDATE_CHECK: "1" }, stdio: ["pipe", "pipe", "pipe"] })
      let output = "", stderr = ""
      child.stdout!.on("data", chunk => { output += chunk }); child.stderr!.on("data", chunk => { stderr += chunk })
      const completion = new Promise<number | null>((resolve, reject) => { child!.once("error", reject); child!.once("close", resolve) })
      await Promise.race([plannerSeen, new Promise((_, reject) => setTimeout(() => reject(Error("Planner did not start: " + stderr)), 12000))])
      const id = /goal_[a-f0-9-]+/.exec(output)?.[0]
      expect(id).toBeDefined()
      if (action === "SIGTERM") child.kill("SIGTERM")
      else child.stdin!.write(action + "\n")
      // Let control reach the active process before finishing the planner.
      for (let i = 0; i < 100; i++) {
        const store = new GoalStore(join(data, "goal", "goals.sqlite")), goal = store.get(id!); store.close()
        if (goal?.control || goal?.yieldRequested || goal?.status === "paused" || goal?.status === "cancelled") break
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      release()
      expect(await completion).toBe(0)
      const done = output.trim().split("\n").map(line => JSON.parse(line)).find(x => x.done)
      if (!done) throw Error(stderr + output)
      if (action === "background") {
        expect(output).toContain("now running in background")
        let completed = false
        for (let i = 0; i < 150; i++) {
          const store = new GoalStore(join(data, "goal", "goals.sqlite")), goal = store.get(id!); store.close()
          if (goal?.status === "completed") { completed = true; break }
          await new Promise(resolve => setTimeout(resolve, 100))
        }
        expect(completed).toBe(true)
        expect(await readFile(join(cwd, "result.txt"), "utf8")).toBe("verified\n")
      } else {
        expect(done.goal.status).toBe(action === "cancel" ? "cancelled" : "paused")
        expect(done.goal.owner).toBeUndefined()
        // Interrupted phases retain their durable intent for safe recovery.
        if (action === "new-input") expect(done.goal.inFlight).toBeUndefined()
      }
      const home = join(data, "goal", "runs", createHash("sha256").update(id!).digest("hex"))
      const metadata = JSON.parse(await readFile(join(home, "workspace.json"), "utf8"))
      expect(metadata.phaseProcess).toBeUndefined()
    } finally { release(); child?.kill("SIGKILL"); server.stop(); await rm(root, { recursive: true, force: true }) }
  }, 35000)
}

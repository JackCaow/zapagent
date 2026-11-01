import { expect, it } from "bun:test"
import { spawn } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createCustomProvider, getDefaultConfig } from "../../src/config.js"

it("delivers the accepted Markdown through the TUI result callback, with only a brief acceptance message", async () => {
  const root = await mkdtemp(join(tmpdir(), "zap-goal-output-session-")), cwd = join(root, "workspace"), data = join(root, "data")
  await mkdir(cwd); await mkdir(data)
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch() {
    const frame = (delta: object, finish_reason: string | null) => `data: ${JSON.stringify({ id: "review", object: "chat.completion.chunk", model: "fixture", choices: [{ index: 0, delta, finish_reason }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\n`
    return new Response(frame({ content: '{"status":"passed","detail":"PRIVATE_RECEIPT"}</｜｜DSML｜｜ calls>' }, null) + frame({}, "stop") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
  } })
  let child: ReturnType<typeof spawn> | undefined
  try {
    const provider = createCustomProvider({ name: "Fixture", baseURL: `http://127.0.0.1:${server.port}/v1`, apiKey: "fixture", models: ["fixture"], contextWindow: 128000 })
    await writeFile(join(data, "config.json"), JSON.stringify({ ...getDefaultConfig(), providers: [provider], active: { providerId: provider.id, model: "fixture" } }))
    const script = `
      import { executeGoalCommand } from ${JSON.stringify(resolve("src/goal-session.ts"))};
      const messages=[],results=[],events=[];
      const code=await executeGoalCommand(["Summarize the result"],process.cwd(),{
        onMessage:text=>messages.push(text),onResult:text=>results.push(text),onEvent:event=>events.push(event),
        runTurn:async()=>{
          const text="# Result\\n\\n**Done**</｜｜DSML｜｜ invoke>";
          return {text,toolCalls:0,outcome:{schema:"zap.outcome",schemaVersion:1,threadId:"thread",turnId:"turn",runId:"run",attemptId:"attempt",startedAt:1,endedAt:2,
            execution:{attemptId:"attempt",status:"finished",stopReason:"end_turn",finalResponse:text,unresolvedActions:[]},
            acceptance:{attemptId:"attempt",status:"unverified",code:"NO_ACCEPTANCE_SPEC",checks:[]},
            workflow:{attemptId:"attempt",status:"not_requested",controlRevision:0,code:"WORKFLOW_NOT_CONFIGURED"}}};
        }
      });
      process.stdout.write(JSON.stringify({code,messages,results,events}));
    `
    child = spawn(process.execPath, ["-e", script], { cwd, env: { ...process.env, ZAPCODE_DATA_DIR: data, ZAP_DISABLE_UPDATE_CHECK: "1" }, stdio: ["ignore", "pipe", "pipe"] })
    let output = "", stderr = ""
    child.stdout!.on("data", value => { output += value }); child.stderr!.on("data", value => { stderr += value })
    const code = await new Promise<number | null>((done, fail) => { child!.once("error", fail); child!.once("close", done) })
    if (code !== 0) throw Error(stderr + output)
    const result = JSON.parse(output)
    expect(result.code).toBe(0)
    expect(result.results).toEqual(["# Result\n\n**Done**"])
    expect(result.messages).toContain("Goal 验收通过。")
    const messages = result.messages.join("\n")
    for (const hidden of ["PRIVATE_RECEIPT", "DSML", "Goal delivery:", '"snapshotId":', "# Result"]) expect(messages).not.toContain(hidden)
    expect(result.events.filter((event: any) => ["content_delta", "content_final"].includes(event.type) && ["text", "thinking"].includes(event.kind))).toEqual([])
  } finally { child?.kill("SIGKILL"); server.stop(); await rm(root, { recursive: true, force: true }) }
}, 30000)

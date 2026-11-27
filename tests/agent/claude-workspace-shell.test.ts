import { expect, it } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promptClaudeCode } from "../../src/agent/claude-code.js"
import { claudeWorkspaceShell } from "../../src/agent/claude-workspace-shell.js"

it("only forwards foreground command arguments to the turn executor", async () => {
  const commands: string[] = []
  const server = claudeWorkspaceShell("fixture", async ({ command }) => {
    commands.push(command)
    return { success: false, output: "stdout", error: "command failed" }
  })
  const call = (args: unknown, signal = new AbortController().signal, name = "shell") => server.request({
    jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args },
  }, signal)
  expect(await call({ command: "npm test" })).toMatchObject({ result: { isError: true, content: [{ text: "stdout\ncommand failed" }] } })
  for (const args of [{ command: "test", cwd: ".." }, { command: "test", dangerouslyDisableSandbox: true }, { command: "" }]) {
    expect((await call(args)).error?.code).toBe(-32602)
  }
  expect((await call({ command: "test" }, undefined, "other")).error?.code).toBe(-32602)
  expect(await call({ command: "test" }, AbortSignal.abort())).toMatchObject({ result: { isError: true } })
  expect(commands).toEqual(["npm test"])
})

it("negotiates project commands before submission and propagates cancellation and native restrictions", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "zap-claude-project-shell-"))
  try {
    const cli = join(cwd, "fixture.cjs")
    await writeFile(cli, `
      const args = process.argv.slice(2)
      const project = args.includes("--mcp-config")
      const mode = args[0]
      const say = msg => console.log(JSON.stringify(msg))
      const control = (request_id, response) => say({type:"control_response",response:{subtype:"success",request_id,response}})
      const result = text => {
        say({type:"assistant",message:{content:[{type:"text",text}]}})
        say({type:"result",subtype:"success",result:text})
      }
      require("node:readline").createInterface({input:process.stdin}).on("line", line => {
        const msg = JSON.parse(line)
        if (msg.type==="control_request") {
          if (msg.request.subtype==="initialize") return control(msg.request_id,{})
          return control(msg.request_id,mode==="unknown" ? {} : {effective:mode==="deny" ? {permissions:{deny:["Bash(git push:*)"]}} : {}})
        }
        if (msg.type==="user") {
          if (!project) return result(args.includes("plan") ? "analysis" : "native")
          const name=Object.keys(JSON.parse(args[args.indexOf("--mcp-config")+1]).mcpServers)[0]
          const message={jsonrpc:"2.0",id:11,method:"tools/call",params:{name:"shell",arguments:{command:"npm test"}}}
          say({type:"control_request",request_id:"cmd",request:{subtype:"mcp_message",server_name:name,message}})
          say({type:"control_cancel_request",request_id:"cmd"})
        }
        if (msg.type==="control_response") result(msg.response.response.mcp_response.result.content[0].text)
      })
    `)
    const commands: string[] = []
    const run = (mode: string) => promptClaudeCode({
      command: process.execPath, args: [cli, mode], text: "task", cwd, plan: mode === "plan",
      onEvent() {}, signal: AbortSignal.timeout(5000),
      workspaceCommand: async ({ command }, signal) => {
        commands.push(command)
        await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }))
        return { success: false, output: "", error: "cancelled" }
      },
    })
    expect((await run("work")).report).toBe("cancelled")
    expect((await run("plan")).report).toBe("analysis")
    expect((await run("deny")).report).toBe("native")
    expect((await run("unknown")).report).toBe("native")
    expect(commands).toEqual(["npm test"])
  } finally { await rm(cwd, { recursive: true, force: true }) }
})

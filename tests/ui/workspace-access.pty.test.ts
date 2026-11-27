import { expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, readFileSync, readdirSync, existsSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { writeFileAtomic } from "../../src/utils/secure-write.js"
import { workspaceContext } from "../../zapsdk/workspace/context.js"

const ptyTest = process.env.RUN_TUI_PTY_TESTS === "1" ? it : it.skip
ptyTest("Auto works across turns, with project access and revocation managed in permissions", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "zap-work-pty-")))
  const cwd = join(root, "project")
  mkdirSync(cwd)
  const { workspaceTempRoot } = await workspaceContext(cwd)
  const todoExposure = new Map<string, { tool: boolean; instructions: boolean }>()
  let readOnlyPlanTool = false
  let escapeParameter = false
  let releaseChild!: () => void
  const childMayContinue = new Promise<void>(resolve => { releaseChild = resolve })
  let childWaiting = false
  const childRequests: unknown[] = []
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (request.method === "GET") return Response.json({ data: [{ id: "fixture" }] })
    const body = await request.json() as {
      messages: Array<{ role: string; content: unknown }>
      tools?: Array<{ function: { name: string; parameters?: unknown } }>
    }
    const task = body.messages.filter(message => message.role === "user").reverse()
      .map(message => typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? ""))
      .find(text => /<task-notification|LOCAL_SHELL|BACKGROUND_AUTO|REVOKE_BACKGROUND|START_REVOCATION_CHILD|REVOCATION_CHILD_PROBE|WRITE_/.test(text)) ?? ""
    const completion = task.includes("<task-notification")
    const background = !completion && task.includes("BACKGROUND_AUTO")
    const name = completion ? task.includes("REVOKE_BACKGROUND") ? "revoked-continuation" : "continued"
      : task.includes("LOCAL_SHELL") ? "shell"
      : background ? "background"
      : task.includes("REVOKE_BACKGROUND") ? "long-background"
      : task.includes("START_REVOCATION_CHILD") ? "child-parent"
      : task.includes("REVOCATION_CHILD_PROBE") ? "child"
      : task.match(/WRITE_(one|two|three|four|five|six)/)?.[1]
    if (name && !todoExposure.has(name)) {
      todoExposure.set(name, {
        tool: !!body.tools?.some(tool => tool.function.name === "todo_write"),
        instructions: body.messages.some(message => message.role === "system" && String(message.content).includes("completionEvidence")),
      })
    }
    escapeParameter ||= !!body.tools?.some(tool => tool.function.name === "bash" && JSON.stringify(tool.function.parameters ?? {}).includes("dangerouslyDisableSandbox"))
    if (name === "five") readOnlyPlanTool ||= !!body.tools?.some(tool => /^(enter|exit)_plan_mode$/.test(tool.function.name))
    const lastTool = body.messages.findLast(message => message.role === "tool")
    const childFollowUp = name === "child" && !!lastTool
    if (name === "child") childRequests.push(lastTool?.content)
    if (childFollowUp) {
      childWaiting = true
      await childMayContinue
    }
    const call = childFollowUp || (name && body.messages.at(-1)?.role !== "tool")
    const tool = name === "long-background"
      ? { name: "bash", arguments: JSON.stringify({
        command: "touch background-armed; until test -f unfreeze; do sleep 0.1; done; touch background-late",
        description: "REVOKE_BACKGROUND", run_in_background: true,
      }) }
      : name === "child-parent"
      ? { name: "agent", arguments: JSON.stringify({ task: "REVOCATION_CHILD_PROBE", agent_type: "general" }) }
      : name === "child"
      ? { name: "write_file", arguments: JSON.stringify({ path: childFollowUp ? "child-late" : "child-armed", content: "fixture" }) }
      : name === "shell"
      ? { name: "bash", arguments: JSON.stringify({ command: "printf local > shell-proof" }) }
      : background
      ? { name: "bash", arguments: JSON.stringify({ command: "printf 'test finished'", run_in_background: true }) }
      : { name: "write_file", arguments: JSON.stringify({ path: join(cwd, name ?? ""), content: name }) }
    const delta = call ? { role: "assistant", tool_calls: [{ index: 0, id: "fixture-" + name + (childFollowUp ? "-late" : ""), type: "function", function: tool }] }
      : { role: "assistant", content: "FINISHED_" + name }
    const event = (delta: unknown, finish_reason: string | null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`
    return new Response(event(delta, null) + event({}, call ? "tool_calls" : "stop") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
  } })
  writeFileAtomic(join(root, "config.json"), JSON.stringify({
    providers: [{ id: "fixture", name: "HarnessFixture", baseURL: `http://127.0.0.1:${server.port}/v1`, apiKey: "test-only", models: ["fixture"], protocol: "openai", contextWindow: 128000, contextWindowMode: "manual" }],
    active: { providerId: "fixture", model: "fixture" }, maxTokens: 1024, maxSteps: 6, mcpServers: [],
  }))
  const socket = `zap-work-${process.pid}-${Date.now()}`
  const tmux = (...args: string[]) => {
    const result = spawnSync("tmux", ["-L", socket, "-f", "/dev/null", ...args], { encoding: "utf8" })
    if (result.status !== 0) throw new Error(result.stderr || String(result.error))
    return result.stdout
  }
  const visible = async (value: string) => {
    let screen = ""
    for (let i = 0; i < 180; i++) {
      screen = tmux("capture-pane", "-p", "-t", "work")
      if (value.startsWith("FINISHED_") && screen.includes("Approve?")) throw new Error(`Unexpected approval while waiting for ${value}:\n${screen}`)
      if (screen.includes(value)) return
      await sleep(75)
    }
    throw new Error(`Missing ${value}:\n${screen}`)
  }
  const key = async (key: string) => { tmux("send-keys", "-t", "work", key); await sleep(200) }
  const submit = async (text: string) => {
    tmux("send-keys", "-t", "work", "-l", text)
    await visible(text); await sleep(180); await key("Enter")
  }
  const findChild = () => existsSync(workspaceTempRoot)
    ? readdirSync(workspaceTempRoot, { recursive: true }).find(path => basename(String(path)) === "child-armed")
    : undefined
  try {
    const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'"
    const entry = process.env.ZAP_TEST_COMPILED_BINARY ? quote(resolve(process.env.ZAP_TEST_COMPILED_BINARY)) : `${quote(process.execPath)} ${quote(resolve("src/index.tsx"))}`
    tmux("new-session", "-d", "-s", "work", "-x", "160", "-y", "45", "-c", cwd,
      `exec env ZAPCODE_DATA_DIR=${quote(root)} ZAP_DISABLE_UPDATE_CHECK=1 ${entry}`)
    await visible("HarnessFixture/fixture")
    await visible("Auto")
    await submit("/mode"); await visible("work in this project, ask when needed")
    expect(tmux("capture-pane", "-p", "-t", "work")).not.toContain("read-only research")
    await key("Escape")
    await submit("WRITE_one")
    await visible("FINISHED_one"); expect(readFileSync(join(cwd, "one"), "utf8")).toContain("one")
    await submit("WRITE_two"); await visible("FINISHED_two"); expect(existsSync(join(cwd, "two"))).toBe(true)
    await submit("LOCAL_SHELL")
    await visible("allow commands in this project")
    await visible("Commands run with your account")
    await key("2")
    await visible("FINISHED_shell")
    expect(readFileSync(join(cwd, "shell-proof"), "utf8")).toBe("local")
    expect(escapeParameter).toBe(false)
    await submit("BACKGROUND_AUTO"); await visible("FINISHED_continued"); expect(existsSync(join(cwd, "continued"))).toBe(true)
    for (const name of ["one", "two", "background", "continued"]) {
      expect(todoExposure.get(name)).toEqual({ tool: false, instructions: false })
    }
    await submit("/permissions"); await visible("p project access")
    await key("p"); await visible("Always allow work in this project"); await key("Enter")
    await submit("WRITE_three")
    await visible("FINISHED_three"); expect(existsSync(join(cwd, "three"))).toBe(true)
    expect(todoExposure.get("three")).toEqual({ tool: false, instructions: false })
    await submit("WRITE_four"); await visible("FINISHED_four"); expect(existsSync(join(cwd, "four"))).toBe(true)
    await submit("REVOKE_BACKGROUND"); await visible("FINISHED_long-background")
    for (let i = 0; i < 120 && !existsSync(join(cwd, "background-armed")); i++) await sleep(75)
    expect(existsSync(join(cwd, "background-armed"))).toBe(true)
    await submit("START_REVOCATION_CHILD")
    for (let i = 0; i < 120 && (!findChild() || !childWaiting); i++) await sleep(75)
    const childMarker = findChild()
    if (!childMarker || !childWaiting) throw new Error(`Child did not start (marker ${childMarker}, calls ${JSON.stringify(childRequests)}):\n${tmux("capture-pane", "-p", "-t", "work")}`)
    await submit("/permissions"); await visible("p project access")
    await key("p"); await visible("Forget project access")
    await key("Down"); await key("Down"); await key("Enter")
    await visible("Read only")
    writeFileSync(join(cwd, "unfreeze"), "")
    const childDir = dirname(join(workspaceTempRoot, String(childMarker)))
    releaseChild()
    await visible("FINISHED_revoked-continuation")
    expect(existsSync(join(cwd, "background-late"))).toBe(false)
    expect(existsSync(join(cwd, "revoked-continuation"))).toBe(false)
    expect(existsSync(join(childDir, "child-late"))).toBe(false)
    await submit("WRITE_five"); await visible("FINISHED_five"); expect(existsSync(join(cwd, "five"))).toBe(false)
    expect(readOnlyPlanTool).toBe(false)
    await submit("/mode auto"); await visible("Auto")
    await submit("WRITE_six"); await visible("FINISHED_six"); expect(existsSync(join(cwd, "six"))).toBe(true)
  } finally {
    releaseChild()
    spawnSync("tmux", ["-L", socket, "kill-server"])
    server.stop()
    rmSync(workspaceTempRoot, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  }
}, 90000)

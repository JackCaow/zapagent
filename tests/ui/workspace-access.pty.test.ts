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
  let declinedRequests = 0
  let published = 0
  let escapeParameter = false
  let releaseChild!: () => void
  const childMayContinue = new Promise<void>(resolve => { releaseChild = resolve })
  let childWaiting = false
  const childRequests: unknown[] = []
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (new URL(request.url).pathname === "/artifact") {
      if (request.method === "POST" && await request.text() === "fixture") published++
      return new Response("fixture accepted")
    }
    if (request.method === "GET") return Response.json({ data: [{ id: "fixture" }] })
    const body = await request.json() as {
      messages: Array<{ role: string; content: unknown }>
      tools?: Array<{ function: { name: string; parameters?: unknown } }>
    }
    const task = body.messages.filter(message => message.role === "user").reverse()
      .map(message => typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? ""))
      .find(text => /<task-notification|LOCAL_SHELL|OUTBOUND_SHELL|MANUAL_SHELL|BACKGROUND_AUTO|REVOKE_BACKGROUND|START_REVOCATION_CHILD|REVOCATION_CHILD_PROBE|WRITE_/.test(text)) ?? ""
    const completion = task.includes("<task-notification")
    const background = !completion && task.includes("BACKGROUND_AUTO")
    const name = completion ? task.includes("REVOKE_BACKGROUND") ? "revoked-continuation" : "continued"
      : task.includes("LOCAL_SHELL") ? "shell"
      : task.includes("OUTBOUND_SHELL") ? "outbound"
      : task.includes("MANUAL_SHELL") ? "manual-shell"
      : background ? "background"
      : task.includes("REVOKE_BACKGROUND") ? "long-background"
      : task.includes("START_REVOCATION_CHILD") ? "child-parent"
      : task.includes("REVOCATION_CHILD_PROBE") ? "child"
      : task.match(/WRITE_(one|two|three|four|five|six|declined|manual)/)?.[1]
    if (name && !todoExposure.has(name)) {
      todoExposure.set(name, {
        tool: !!body.tools?.some(tool => tool.function.name === "todo_write"),
        instructions: body.messages.some(message => message.role === "system" && String(message.content).includes("completionEvidence")),
      })
    }
    escapeParameter ||= !!body.tools?.some(tool => tool.function.name === "bash" && JSON.stringify(tool.function.parameters ?? {}).includes("dangerouslyDisableSandbox"))
    if (name === "five") readOnlyPlanTool ||= !!body.tools?.some(tool => /^(enter|exit)_plan_mode$/.test(tool.function.name))
    if (name === "declined") declinedRequests++
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
      : name === "outbound" ? { name: "bash", arguments: JSON.stringify({ command: "sh ./fixture.sh" }) }
      : name === "shell" || name === "manual-shell"
      ? { name: "bash", arguments: JSON.stringify({ command: `printf local > ${name}-proof` }) }
      : background
      ? { name: "bash", arguments: JSON.stringify({ command: "printf 'test finished'", run_in_background: true }) }
      : { name: "write_file", arguments: JSON.stringify({ path: join(cwd, name ?? ""), content: name }) }
    const delta = call ? { role: "assistant", tool_calls: [{ index: 0, id: "fixture-" + name + (childFollowUp ? "-late" : ""), type: "function", function: tool }] }
      : { role: "assistant", content: "FINISHED_" + name }
    const event = (delta: unknown, finish_reason: string | null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`
    return new Response(event(delta, null) + event({}, call ? "tool_calls" : "stop") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
  } })
  writeFileSync(join(cwd, "fixture.sh"), `curl -fsS --data fixture http://127.0.0.1:${server.port}/artifact\n`)
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
  const visible = async (value: string, target = "work") => {
    let screen = ""
    for (let i = 0; i < 180; i++) {
      screen = tmux("capture-pane", "-p", "-t", target)
      if (value.startsWith("FINISHED_") && screen.includes("Approve?")) throw new Error(`Unexpected approval while waiting for ${value}:\n${screen}`)
      if (screen.includes(value)) return
      await sleep(75)
    }
    throw new Error(`Missing ${value}:\n${screen}`)
  }
  const key = async (key: string, target = "work") => { tmux("send-keys", "-t", target, key); await sleep(200) }
  const submit = async (text: string, target = "work") => {
    tmux("send-keys", "-t", target, "-l", text)
    await visible(text, target); await sleep(180); await key("Enter", target)
  }
  const findChild = () => existsSync(workspaceTempRoot)
    ? readdirSync(workspaceTempRoot, { recursive: true }).find(path => basename(String(path)) === "child-armed")
    : undefined
  try {
    const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'"
    const entry = process.env.ZAP_TEST_COMPILED_BINARY ? quote(resolve(process.env.ZAP_TEST_COMPILED_BINARY)) : `${quote(process.execPath)} ${quote(resolve("src/index.tsx"))}`
    const command = `exec env ZAPCODE_DATA_DIR=${quote(root)} ZAP_DISABLE_UPDATE_CHECK=1 ${entry}`
    tmux("new-session", "-d", "-s", "work", "-x", "160", "-y", "45", "-c", cwd, command)
    tmux("new-session", "-d", "-s", "observer", "-x", "160", "-y", "45", "-c", cwd, command)
    await visible("HarnessFixture/fixture", "observer")
    await visible("HarnessFixture/fixture")
    await visible("Auto")
    await submit("/permissions"); await visible("[Workspace]")
    await visible("Project access is not saved")
    tmux("send-keys", "-t", "work", "-l", "\x1b[C\r")
    await visible("[Rules]")
    await key("Left"); await visible("Project access is not saved")
    await key("Right"); await visible("[Rules]")
    await key("Right"); await visible("[Recently blocked]")
    await visible("No blocked actions in this conversation.")
    await key("Left"); await visible("[Rules]")
    await key("Left"); await visible("[Workspace]")
    await key("Escape")
    await visible("Auto · Shift+Tab")
    await submit("/mode"); await visible("ask before edits and commands")
    await visible("Bypass")
    expect(tmux("capture-pane", "-p", "-t", "work")).not.toMatch(/Require project access|Allow edits|read-only research/)
    await key("Down"); await key("Down"); await key("Enter")
    await visible("Bypass · Shift+Tab")
    await submit("/mode"); await visible("skip routine approvals (current)")
    await key("Escape")
    await key("BTab"); await visible("Auto · Shift+Tab")
    await key("BTab"); await visible("Manual · Shift+Tab")
    await key("BTab"); await visible("Auto · Shift+Tab")
    await submit("WRITE_one")
    await visible("FINISHED_one"); expect(readFileSync(join(cwd, "one"), "utf8")).toContain("one")
    await submit("WRITE_two"); await visible("FINISHED_two"); expect(existsSync(join(cwd, "two"))).toBe(true)
    expect(tmux("capture-pane", "-p", "-S", "-200", "-t", "work")).not.toContain("结果尚未经过外部验收")
    await submit("LOCAL_SHELL")
    await visible("this project")
    await visible("Commands run with your account")
    await key("3")
    await visible("FINISHED_shell")
    expect(readFileSync(join(cwd, "shell-proof"), "utf8")).toBe("local")
    writeFileSync(join(cwd, "shell-proof"), "stale")
    await submit("LOCAL_SHELL")
    for (let i = 0; i < 80 && readFileSync(join(cwd, "shell-proof"), "utf8") !== "local"; i++) {
      expect(tmux("capture-pane", "-p", "-t", "work")).not.toContain("Approve?")
      await sleep(75)
    }
    expect(readFileSync(join(cwd, "shell-proof"), "utf8")).toBe("local")
    expect(escapeParameter).toBe(false)
    await submit("OUTBOUND_SHELL"); await visible("Approve?")
    expect(published).toBe(0)
    await key("Escape"); await visible("FINISHED_outbound")
    expect(published).toBe(0)
    await submit("OUTBOUND_SHELL"); await visible("Approve?")
    await key("1")
    for (let i = 0; i < 80 && published === 0; i++) await sleep(75)
    expect(published).toBe(1)
    await visible("FINISHED_outbound")
    await submit("BACKGROUND_AUTO"); await visible("Approve?"); await key("1")
    await visible("FINISHED_continued"); expect(existsSync(join(cwd, "continued"))).toBe(true)
    for (const name of ["one", "two", "background", "continued"]) {
      expect(todoExposure.get(name)).toEqual({ tool: false, instructions: false })
    }
    await submit("/permissions"); await visible("[Workspace]")
    await visible("Project access saved")
    await visible("Remember project access"); await key("Enter")
    await key("BTab"); await visible("Manual · Shift+Tab")
    await submit("WRITE_manual"); await visible("Approve?")
    expect(existsSync(join(cwd, "manual"))).toBe(false)
    await key("1"); await visible("FINISHED_manual")
    expect(existsSync(join(cwd, "manual"))).toBe(true)
    await submit("MANUAL_SHELL"); await visible("Approve?")
    expect(existsSync(join(cwd, "manual-shell-proof"))).toBe(false)
    await key("1"); await visible("FINISHED_manual-shell")
    expect(existsSync(join(cwd, "manual-shell-proof"))).toBe(true)
    await submit("WRITE_declined"); await visible("Approve?")
    await key("2"); await visible("FINISHED_declined")
    expect(existsSync(join(cwd, "declined"))).toBe(false)
    await submit("/permissions"); await visible("[Workspace]")
    await key("Left"); await visible("[Recently blocked]")
    await visible("Write(declined)")
    if (!tmux("capture-pane", "-p", "-t", "work").includes("Declined by you")) await key("Down")
    await visible("Declined by you")
    expect(declinedRequests).toBe(2)
    await key("Escape")
    await key("BTab"); await visible("Auto · Shift+Tab")
    await submit("WRITE_three")
    await visible("FINISHED_three"); expect(existsSync(join(cwd, "three"))).toBe(true)
    expect(todoExposure.get("three")).toEqual({ tool: false, instructions: false })
    await submit("WRITE_four"); await visible("FINISHED_four"); expect(existsSync(join(cwd, "four"))).toBe(true)
    await submit("REVOKE_BACKGROUND"); await visible("Approve?"); await key("1"); await visible("FINISHED_long-background")
    for (let i = 0; i < 120 && !existsSync(join(cwd, "background-armed")); i++) await sleep(75)
    expect(existsSync(join(cwd, "background-armed"))).toBe(true)
    await submit("START_REVOCATION_CHILD")
    for (let i = 0; i < 120 && (!findChild() || !childWaiting); i++) await sleep(75)
    const childMarker = findChild()
    if (!childMarker || !childWaiting) throw new Error(`Child did not start (marker ${childMarker}, calls ${JSON.stringify(childRequests)}):\n${tmux("capture-pane", "-p", "-t", "work")}`)
    await submit("/permissions", "observer"); await visible("[Workspace]", "observer")
    await visible("Project access saved", "observer")
    await visible("Forget project access", "observer")
    await key("Down", "observer"); await key("Down", "observer"); await key("Enter", "observer")
    await visible("Read only", "observer")
    await visible("Project access was revoked")
    writeFileSync(join(cwd, "unfreeze"), "")
    const childDir = dirname(join(workspaceTempRoot, String(childMarker)))
    releaseChild()
    await visible("FINISHED_revoked-continuation")
    expect(existsSync(join(cwd, "background-late"))).toBe(false)
    expect(existsSync(join(cwd, "revoked-continuation"))).toBe(false)
    expect(existsSync(join(childDir, "child-late"))).toBe(false)
    await submit("WRITE_five"); await visible("FINISHED_five"); expect(existsSync(join(cwd, "five"))).toBe(false)
    const readOnly = tmux("capture-pane", "-p", "-t", "work")
    expect(readOnly).toContain("This session is read-only")
    expect(readOnly).not.toContain("plan-mode")
    expect(readOnlyPlanTool).toBe(false)
    await submit("/permissions"); await visible("[Workspace]")
    await visible("Session is read-only")
    await key("Right"); await key("Right"); await visible("[Recently blocked]")
    await visible("Write(five)")
    await visible("Write(declined)")
    tmux("resize-window", "-t", "work", "-x", "34", "-y", "40")
    await visible("[Blocked]")
    await key("Left"); await visible("[Rules]")
    await key("Left"); await visible("[Work]")
    await key("Escape")
    tmux("resize-window", "-t", "work", "-x", "160", "-y", "45")
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

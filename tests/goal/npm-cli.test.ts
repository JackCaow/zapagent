import { expect, it } from "bun:test"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createCustomProvider, getDefaultConfig } from "../../src/config.js"
import { GoalStore } from "../../zapsdk/goal/store.js"

it("runs a Goal with managed npm dependencies for worker, child and final check", async () => {
  const root = await mkdtemp(join(tmpdir(), "goal-npm-cli-")), cwd = join(root, "project"), data = join(root, "data"), runtime = join(root, "runtime"), audit = join(root, "audit")
  await mkdir(cwd); await mkdir(data); await mkdir(join(runtime, "images"), { recursive: true })
  await writeFile(join(cwd, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0", private: true, scripts: { test: "node -e 'require(\"fixture\")'" } }))
  await writeFile(join(cwd, "package-lock.json"), JSON.stringify({ name: "fixture", version: "1.0.0", lockfileVersion: 3, packages: { "": { name: "fixture", version: "1.0.0" } } }))
  await writeFile(join(runtime, "images", "active.json"), "{}"); await writeFile(join(runtime, "image-public.pem"), "fixture")
  const binary = join(runtime, "zapvm")
  await writeFile(binary, ["#!/bin/sh", 'if [ "$1 $2" = "daemon status" ]; then echo \'{"degraded":false}\'; exit 0; fi',
    'if [ "$1" = "_fs-publish-directory" ]; then shift; source=; dest=; while [ "$#" -gt 0 ]; do case "$1" in --source) source="$2"; shift 2;; --destination) dest="$2"; shift 2;; *) exit 91;; esac; done; [ ! -e "$dest" ] || exit 92; /bin/mv "$source" "$dest"; exit $?; fi',
    'request=; session=; result=; work=; protected=; readonly=; while [ "$#" -gt 0 ]; do case "$1" in --request-id) request="$2"; shift 2;; --session-id) session="$2"; shift 2;; --result-file) result="$2"; shift 2;; --workspace) work="$2"; shift 2;; --workspace-read-only) readonly=yes; shift;; --protect-workspace-path) protected="$protected:$2"; shift 2;; *) shift;; esac; done',
    `if [ "$readonly" = yes ]; then [ -f "$work/node_modules/fixture/index.js" ] || exit 94; printf 'test\n' >> '${audit}'; else`,
    'case "$protected" in *:package.json*:package-lock.json*) ;; *) exit 93;; esac',
    `/bin/mkdir -p "$work/node_modules/fixture"; printf 'installed\n' > "$work/node_modules/fixture/index.js"; printf 'install\n' >> '${audit}'; fi`,
    'printf \'{"request_id":"%s","session_id":"%s","exit_code":0,"seal":{"mechanism":"cgroup-v2","state":"empty"}}\' "$request" "$session" > "$result"', 'exit 0', ""].join("\n")); await chmod(binary, 0o755)
  const model = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    const body = await request.json() as { messages: Array<{ role: string; content: unknown }>; tools?: Array<{ function: { name: string } }> }
    const user = body.messages.filter(message => message.role === "user" && typeof message.content === "string").map(message => message.content).join("\n")
    const toolResults = body.messages.filter(message => message.role === "tool")
    const latest = toolResults.at(-1); const tools = body.tools?.map(tool => tool.function.name) ?? []
    let delta: object, finish = "stop"
    const call = (id: string, name: string, args: object) => ({ tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }] })
    if (user.includes("Plan the user's goal")) delta = { content: JSON.stringify({ tasks: [{ id: "one", description: "Produce report", acceptance: "report.txt says complete", dependencies: [] }] }) }
    else if (user.includes("You are an independent verifier")) delta = { content: JSON.stringify({ status: "passed", detail: "Report says complete" }) }
    else if (user.includes("Inspect the frozen final Goal")) delta = { content: "Report created." }
    else if (tools.includes("agent")) {
      const artifact = /artifact_ids=\["([^"]+)"\]/.exec(String(latest?.content))?.[1]
      if (!latest) { delta = call("spawn-child", "agent", { task: "Write report using installed package", agent_type: "general" }); finish = "tool_calls" }
      else if (artifact) { delta = call("merge-child", "merge_agent_artifacts", { artifact_ids: [artifact] }); finish = "tool_calls" }
      else delta = { content: "Report complete." }
    } else if (!latest) { delta = call("read-dep", "read_file", { path: "node_modules/fixture/index.js" }); finish = "tool_calls" }
    else if (toolResults.length === 1) { delta = call("write-report", "write_file", { path: "report.txt", content: "complete\n" }); finish = "tool_calls" }
    else delta = { content: "Report created." }
    const chunk = (part: object, reason: string | null) => `data: ${JSON.stringify({ id: "goal", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta: part, finish_reason: reason }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\n`
    return new Response(chunk(delta, null) + chunk({}, finish) + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
  } })
  const env = { ...process.env, ZAPCODE_DATA_DIR: data, ZAPCODE_EXECUTION: "vm", ZAPCODE_ZAPVM_RUNTIME_DIR: runtime }
  const cli = (args: string[]) => new Promise<{ code: number | null; output: string }>((resolveResult, reject) => {
    const child = spawn(process.execPath, [resolve("src/index.tsx"), ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] })
    let output = ""; child.stdout.on("data", value => output += String(value)); child.stderr.on("data", value => output += String(value))
    child.once("error", reject); child.once("close", code => resolveResult({ code, output }))
  })
  try {
    const provider = createCustomProvider({ name: "Fixture", baseURL: `http://127.0.0.1:${model.port}/v1`, apiKey: "fixture", models: ["fixture"], contextWindow: 128000 })
    await writeFile(join(data, "config.json"), JSON.stringify({ ...getDefaultConfig(), executionBackend: "vm", permissionMode: "bypassPermissions", providers: [provider], active: { providerId: provider.id, model: "fixture" } }))
    const started = await cli(["goal", "make a report", "--artifact", "--background", "--install=npm", "--check=npm", "--permission-mode=bypassPermissions"])
    expect(started.code).toBe(0)
    const id = /goal_[a-f0-9-]+/.exec(started.output)?.[0]; expect(id).toBeDefined()
    const db = join(data, "goal", "goals.sqlite"); let result: ReturnType<GoalStore["get"]>
    for (let i = 0; i < 200; i++) { await new Promise(resolve => setTimeout(resolve, 100)); const store = new GoalStore(db); result = store.get(id!); store.close(); if (result && ["completed", "blocked", "awaiting_acceptance", "failed"].includes(result.status)) break }
    if (result?.status !== "completed") { const log = await readFile(join(data, "goal", "runs", createHash("sha256").update(id!).digest("hex"), "runner.log"), "utf8").catch(() => "missing log"); throw new Error(`Goal ended ${result?.status}: ${result?.stopReason}\n${log}`) }
    expect(await readFile(join((result!.delivery as { path: string }).path, "report.txt"), "utf8")).toBe("complete\n")
    await expect(readFile(join(cwd, "node_modules/fixture/index.js"))).rejects.toThrow()
    const events = (await readFile(audit, "utf8")).trim().split("\n")
    expect(events.filter(item => item === "install")).toHaveLength(3)
    expect(events.filter(item => item === "test")).toHaveLength(1)
  } finally { model.stop(); await rm(root, { recursive: true, force: true }) }
}, 45_000)

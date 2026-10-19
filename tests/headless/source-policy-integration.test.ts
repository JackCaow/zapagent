import { spawn } from "node:child_process"
import { expect, it } from "bun:test"
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { createCustomProvider, getDefaultConfig } from "../../src/config.js"

it("real headless CLI withholds a configured tool result before all model requests and persisted events", async () => {
  const root = await mkdtemp(join(tmpdir(), "zap-source-policy-cli-")), data = join(root, "data")
  await mkdir(data)
  const raw = "PRIVATE_REFERENCE_BODY https://example.test/excluded-corpus/source?token=private"
  let requests: any[] = []
  const model = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    const body = await request.json() as any; requests.push(body)
    const tool = body.messages.some((m: any) => m.role === "tool")
    const delta = tool ? { content: "Observed the result." } : { tool_calls: [{ index: 0, id: "source", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "ordinary-docs.txt" }) } }] }
    const chunk = (delta: object, finish: string | null) => `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 3 } })}\n\n`
    return new Response(chunk(delta, null) + chunk({}, tool ? "stop" : "tool_calls") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
  } })
  async function records(path: string): Promise<string> {
    let out = ""
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const file = join(path, entry.name)
      if (entry.isDirectory()) out += await records(file)
      else if (entry.name.endsWith(".jsonl")) out += await readFile(file, "utf8")
    }
    return out
  }
  try {
    const provider = createCustomProvider({ name: "Fixture", baseURL: `http://127.0.0.1:${model.port}/v1`, apiKey: "fixture", models: ["fixture"], contextWindow: 128000 })
    await writeFile(join(data, "config.json"), JSON.stringify({ ...getDefaultConfig(), providers: [provider], active: { providerId: provider.id, model: "fixture" } }), { mode: 0o600 })
    const policy = join(root, "policy.json")
    await writeFile(policy, JSON.stringify({ version: 1, tools: ["read_file"], denyUrlContains: [{ id: "restricted-sources", value: "/excluded-corpus/" }] }))
    for (const enabled of [false, true]) {
      requests = []
      const cwd = join(root, enabled ? "guarded" : "ordinary"); await mkdir(cwd)
      await writeFile(join(cwd, "ordinary-docs.txt"), raw)
      const child = spawn(process.execPath, [resolve("src/index.tsx"), "--print", "Read ordinary documentation, then report the observed status.", "--output-format", "stream-json", "--result-schema", "outcome-v1", "--permission-mode", "bypassPermissions", "--dangerously-disable-os-sandbox", "--continue-on-tool-denial", "--max-turns", "4", "--cwd", cwd, "--no-devtools", ...(enabled ? ["--result-source-policy", policy] : [])], {
        stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ZAPCODE_DATA_DIR: data, ZAPCODE_EXECUTION: "local", ZAPCODE_DEVTOOLS_PORT: "" },
      })
      let stdout = "", stderr = ""
      child.stdout!.on("data", d => stdout += String(d)); child.stderr!.on("data", d => stderr += String(d))
      const timer = setTimeout(() => child.kill("SIGKILL"), 20_000)
      let code: number | null
      try { code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve) }) }
      finally { clearTimeout(timer) }
      if (code !== 0) throw new Error(stderr + stdout)
      expect(requests.length).toBeGreaterThanOrEqual(2)
      const event = stdout.split("\n").filter(Boolean).map(line => JSON.parse(line)).find(e => e.type === "tool_result" && e.name === "read_file")
      expect(event).toBeDefined()
      if (enabled) {
        expect(JSON.stringify(requests)).not.toContain("PRIVATE_REFERENCE_BODY")
        expect(stdout).not.toContain("PRIVATE_REFERENCE_BODY")
        expect(event.ok).toBe(false)
        expect(event.resultSourcePolicy.decision).toBe("withheld")
        expect(typeof event.resultSourcePolicy.configuredFileSha256).toBe("string")
      } else {
        expect(JSON.stringify(requests)).toContain("PRIVATE_REFERENCE_BODY")
        expect(event.ok).toBe(true)
      }
    }
    // The unguarded control intentionally persisted its result. Inspect only
    // the guarded project's own journal/Runtime records for absence.
    const projects = join(data, "projects")
    const guarded = (await readdir(projects)).find(name => name.endsWith("-guarded"))
    expect(guarded).toBeDefined()
    expect(await records(join(projects, guarded!))).not.toContain("PRIVATE_REFERENCE_BODY")
  } finally { model.stop(); await rm(root, { recursive: true, force: true }) }
}, 60_000)

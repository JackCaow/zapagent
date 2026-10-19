// Local, credential-free Runtime backend for external ACP compatibility suites.
import { spawn } from "node:child_process"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createCustomProvider, getDefaultConfig } from "../../../src/config.js"

const data = await mkdtemp(join(tmpdir(), "zap-acp-tck-profile-"))
const model = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const body = await request.json() as { messages: Array<{ role: string; content: unknown }> }
  const prompt = JSON.stringify(body.messages.filter(item => item.role === "user").at(-1)?.content)
  if (prompt?.includes("ACP_CANCEL_TEST")) return new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode(": waiting\n\n"))
  } }), { headers: { "content-type": "text/event-stream" } })
  const chunk = { id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture" }
  return new Response(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: { content: "ACP fixture response" }, finish_reason: null }] })}\n\n`
    + `data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
  { headers: { "content-type": "text/event-stream" } })
} })
const provider = createCustomProvider({ name: "Fixture", baseURL: `http://127.0.0.1:${model.port}/v1`,
  apiKey: "fixture", models: ["fixture"], contextWindow: 128000 })
await writeFile(join(data, "config.json"), JSON.stringify({ ...getDefaultConfig(), providers: [provider],
  active: { providerId: provider.id, model: "fixture" } }), { mode: 0o600 })
const binary = process.argv[2]
const child = spawn(binary || process.execPath, binary ? ["acp"] : [resolve(import.meta.dir, "../../../src/index.tsx"), "acp"],
  { stdio: ["pipe", "inherit", "inherit"], env: { ...process.env, ZAPCODE_DATA_DIR: data } })
process.stdin.pipe(child.stdin)
child.stdin.on("error", () => {})
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => child.kill(signal))
child.once("close", async code => { model.stop(); await rm(data, { recursive: true, force: true }); process.exit(code ?? 1) })

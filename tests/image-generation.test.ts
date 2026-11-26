import { afterEach, beforeEach, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createElement } from "react"
import { renderToString } from "ink"
import { Resvg } from "@resvg/resvg-js"
import { cacheGeneratedImage } from "../zapsdk/utils/generated-image.js"
import { sessionLogsToMessages, sessionLogsToTurns, type SessionLog } from "../src/session.js"
import { createFormatter } from "../src/headless/formatter.js"
import { GeneratedImageResult } from "../src/ui/generated-image.js"
import { buildAgentObjects } from "../src/agent-factory.js"
import { connectCodexProvider } from "../src/codex-provider.js"
import { selectCatalogModel } from "../src/provider-catalog.js"
import { getDefaultConfig } from "../src/config.js"
import { generateImageTool } from "../zapsdk/builtin-tools/generate-image.js"
import { ToolExecutor } from "../zapsdk/tools/executor.js"
import { ToolRegistry } from "../zapsdk/tools/registry.js"
import { PermissionManager } from "../src/permissions.js"
import { evaluateApprovalPolicy } from "../src/permission-policy.js"
const png = new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="white"/><circle cx="32" cy="32" r="24" fill="blue"/></svg>', { font: { loadSystemFonts: false } }).render().asPng()
let root: string, previous: string | undefined
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "zap-image-integration-")); previous = process.env.ZAPCODE_DATA_DIR; process.env.ZAPCODE_DATA_DIR = root })
afterEach(() => { if (previous === undefined) delete process.env.ZAPCODE_DATA_DIR; else process.env.ZAPCODE_DATA_DIR = previous; rmSync(root, { recursive: true, force: true }) })

it("leaves subscription image generation to the native runtime in parent and child registries", () => {
  const connected = connectCodexProvider(getDefaultConfig())
  const config = selectCatalogModel(connected.config, connected.provider.id, { id: "account-model", source: "manual" })
  const objects = buildAgentObjects(config, undefined, undefined, undefined, undefined, undefined, root, "disabled")
  expect(objects.registry.has("generate_image")).toBe(false)
  const child = objects.createRegistryForCwd!(join(root, "child"))
  expect(child.has("generate_image")).toBe(false)
  config.providers[0].authMode = "none"
  expect(buildAgentObjects(config, undefined, undefined, undefined, undefined, undefined, root, "disabled").registry.has("generate_image")).toBe(false)
})

it("restores generated pixels only from digest-verified host cache, preserving image metadata and failure state", async () => {
  const artifact = await cacheGeneratedImage(join(root, "generated-images"), { bytes: png, width: 64, height: 64, requestBytes: 100, responseBytes: 1000 })
  artifact.filePath = join(root, "untrusted-image-location.png")
  const meta = { generatedImage: artifact }
  const logs: SessionLog[] = [{ type: "user", text: "Draw a circle" }, { type: "result", text: "saved", tool: {
    id: "image-call", name: "generate_image", arguments: { prompt: "circle", output_path: "circle.png" }, success: true, output: "Saved circle.png", meta } }]
  const message = sessionLogsToMessages(logs).find(message => message.role === "tool_result")!
  expect(message.contentBlocks?.[0]).toMatchObject({ type: "image", base64: png.toString("base64"), filePath: join(root, "generated-images", `${artifact.id}.png`) })
  writeFileSync(join(root, "generated-images", `${artifact.id}.png`), "corrupt cache")
  expect(sessionLogsToMessages(logs).find(message => message.role === "tool_result")?.contentBlocks).toBeUndefined()
  logs[1].tool!.success = false
  const restored = sessionLogsToTurns(logs).find(turn => turn.kind === "tool_turn")
  expect(restored?.kind === "tool_turn" && restored.calls[0].result.success).toBe(false)
})

it("renders a persisted thumbnail and exposes bounded artifact metadata in headless events", async () => {
  const artifact = await cacheGeneratedImage(join(root, "generated-images"), { bytes: png, width: 64, height: 64, requestBytes: 100, responseBytes: 1000 })
  artifact.filePath = join(root, "circle.png")
  const meta = { generatedImage: artifact }
  const rendered = renderToString(createElement(GeneratedImageResult, { meta }))
  expect(rendered).toContain("64×64"); expect(rendered).toContain("▀")
  expect(renderToString(createElement(GeneratedImageResult, { meta: { generatedImage: { id: "../../" } } }))).toBe("")
  let captured = ""
  const original = process.stdout.write
  process.stdout.write = ((chunk: any) => { captured += chunk.toString(); return true }) as typeof original
  try {
    const formatter = createFormatter("stream-json", false)
    formatter.onEvent({ type: "content_final", kind: "tool_result", id: "image-call", step: 1, toolName: "generate_image", result: { success: true, output: "saved", meta } })
  } finally { process.stdout.write = original }
  const event = JSON.parse(captured)
  expect(event.generatedImage).toMatchObject({ id: artifact.id, filePath: artifact.filePath, width: 64, height: 64, mediaType: "image/png" })
  expect(event.generatedImage.thumbnail).toBeUndefined()
  expect(captured).not.toContain(png.toString("base64"))
})

it("keeps paid image generation subject to approval in acceptEdits and denies it in plan mode", async () => {
  const manager = new PermissionManager(root), registry = new ToolRegistry()
  let calls = 0
  registry.register(generateImageTool({ defaultCwd: root, allowedPaths: [root], artifactDirectory: join(root, "generated-images"),
    generate: async () => { calls++; throw new Error("Generation must not start") } }))
  for (const mode of ["acceptEdits", "plan"] as const) {
    let decision = ""
    const executor = new ToolExecutor(registry, { cwd: root, onApproval: async (name, args, _signal, context) => {
      const evaluated = evaluateApprovalPolicy(manager, name, args, { cwd: root, mode, context })
      decision = evaluated.decision
      return decision === "allow"
    } })
    expect((await executor.execute("generate_image", { prompt: "draw", output_path: "image.png" })).success).toBe(false)
    expect(decision).toBe(mode === "plan" ? "deny" : "ask")
  }
  expect(calls).toBe(0)
})

it("bounds restored image history to the four most recent cached images", async () => {
  const logs: SessionLog[] = [{ type: "user", text: "Draw five images" }]
  for (let i = 0; i < 5; i++) {
    const bytes = new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="rgb(${i * 40},0,0)"/></svg>`, { font: { loadSystemFonts: false } }).render().asPng()
    const artifact = await cacheGeneratedImage(join(root, "generated-images"), { bytes, width: 2, height: 2, requestBytes: 1, responseBytes: 1 })
    logs.push({ type: "result", text: "saved", tool: { id: `image-${i}`, name: "generate_image", output: `saved ${i}.png`, success: true, meta: { generatedImage: artifact } } })
  }
  const images = sessionLogsToMessages(logs).filter(message => message.role === "tool_result")
  expect(images).toHaveLength(5)
  expect(images[0].contentBlocks).toBeUndefined()
  expect(images.slice(1).every(message => message.contentBlocks?.[0]?.type === "image")).toBe(true)
})


it("counts repeated references to the same image against the restore occurrence budget", async () => {
  const artifact = await cacheGeneratedImage(join(root, "generated-images"), { bytes: png, width: 64, height: 64, requestBytes: 1, responseBytes: 1 })
  const logs: SessionLog[] = [{ type: "user", text: "Several generations returned equal pixels" }]
  for (let i = 0; i < 12; i++) logs.push({ type: "result", text: "saved", tool: { id: `repeat-${i}`, name: "generate_image", output: "saved", success: true, meta: { generatedImage: artifact } } })
  const restored = sessionLogsToMessages(logs).filter(message => message.contentBlocks?.some(block => block.type === "image"))
  expect(restored.map(message => message.toolCallId)).toEqual(["repeat-8", "repeat-9", "repeat-10", "repeat-11"])
})

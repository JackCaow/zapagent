import { expect, it } from "bun:test"
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { artifactPreviewTool } from "../src/artifact-preview.js"
import { createNativePreview } from "../src/agent/native-preview.js"
import { evaluateApprovalPolicy } from "../src/permission-policy.js"
import { PermissionManager } from "../src/permissions.js"
import { ToolExecutor } from "../zapsdk/tools/executor.js"
import { ToolRegistry } from "../zapsdk/tools/registry.js"

it("opens a browser-safe preview in Manual and refuses an out-of-project symlink", async () => {
  const fixture = await realpath(await mkdtemp(join(tmpdir(), "zap-preview-test-")))
  const cwd = join(fixture, "workspace")
  const opened: string[] = []
  try {
    await mkdir(cwd)
    await writeFile(join(cwd, "page.html"), '<h1>Fixture preview</h1><script>alert("active script")</script><meta http-equiv="refresh" content="0; url=https://example.invalid/">')
    await writeFile(join(fixture, "outside.html"), "<h1>Outside project</h1>")
    await symlink(join(fixture, "outside.html"), join(cwd, "external.html"), "file")
    const registry = new ToolRegistry()
    registry.register(artifactPreviewTool(cwd, async path => { opened.push(path) }))
    const manager = new PermissionManager(cwd)
    const executor = new ToolExecutor(registry, {
      cwd,
      onApproval: async (name, args, _signal, context) => evaluateApprovalPolicy(manager, name, args, {
        mode: "default", cwd, context, hostCommands: "untrusted",
      }).decision === "allow",
    })
    const result = await executor.execute("preview_artifact", { path: "page.html" })
    expect(result.success).toBe(true)
    expect(opened).toHaveLength(1)
    const snapshot = await readFile(opened[0]!, "utf8")
    expect(snapshot).toContain("Fixture preview")
    expect(snapshot).toContain("sandbox")
    expect(snapshot).toContain("Content-Security-Policy")
    expect(snapshot).not.toMatch(/active script|http-equiv=&quot;refresh|example\.invalid/)
    expect((await executor.execute("preview_artifact", { path: "external.html" })).success).toBe(false)
    expect(opened).toHaveLength(1)
  } finally {
    await Promise.all([rm(fixture, { recursive: true, force: true }), ...opened.map(path => rm(dirname(path), { recursive: true, force: true }))])
  }
})

it("allows requests only during a live native preview turn", async () => {
  const first = createNativePreview()
  if (!first) throw new Error("could not bind preview test receiver")
  const second = createNativePreview()!
  const signal = new AbortController()
  let calls = 0
  const invoke = async (session: typeof first) => {
    const response = await fetch(session.url, {
      method: "POST",
      headers: { authorization: session.authorization, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "preview_artifact", arguments: { path: "page.html" } } }),
    })
    return { status: response.status, body: await response.text() }
  }
  try {
    const release = first.bind(async () => { calls++; return { success: true, output: "current preview" } }, signal.signal)
    expect((await invoke(first)).body).toContain("current preview")
    expect((await invoke(second)).body).toContain("Preview turn ended")
    release()
    expect((await invoke(first)).body).toContain("Preview turn ended")
    first.close()
    expect((await invoke(first)).status).toBe(401)
    expect(calls).toBe(1)
  } finally {
    first.close()
    second.close()
  }
})

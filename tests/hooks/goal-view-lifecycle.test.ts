import { expect, it } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"

it("wires Goal polling, safe diagnostics and cancellation through the actual hook", async () => {
  const root = await mkdtemp(join(tmpdir(), "goal-view-lifecycle-"))
  try {
    // The fixture mocks the ledger reader and timer queue. A child process
    // keeps those mocks out of other Hook/SQLite tests in the full suite.
    const child = Bun.spawn([process.execPath, fileURLToPath(new URL("../fixtures/goal-view-polling.ts", import.meta.url))], {
      env: { ...process.env, ZAPCODE_DATA_DIR: root },
      stdout: "pipe", stderr: "pipe",
    })
    const timer = setTimeout(() => child.kill(), 15_000)
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" })
      expect(stdout).toContain("Goal polling lifecycle passed")
    } finally { clearTimeout(timer) }
  } finally { await rm(root, { recursive: true, force: true }) }
}, 20_000)

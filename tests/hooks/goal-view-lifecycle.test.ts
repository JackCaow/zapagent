import { expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"

it("wires Goal polling, safe diagnostics and cancellation through the actual hook", async () => {
  const root = await mkdtemp(join(tmpdir(), "goal-view-lifecycle-"))
  try {
    // The fixture mocks the ledger reader and timer queue. A child process
    // keeps those mocks out of other Hook/SQLite tests in the full suite.
    const child = spawnSync(process.execPath, [fileURLToPath(new URL("../fixtures/goal-view-polling.ts", import.meta.url))], {
      env: { ...process.env, ZAPCODE_DATA_DIR: root },
      encoding: "utf8", timeout: 15_000,
    })
    expect({ code: child.status, error: child.error?.message, stderr: child.stderr }).toEqual({ code: 0, error: undefined, stderr: "" })
    expect(child.stdout).toContain("Goal polling lifecycle passed")
  } finally { await rm(root, { recursive: true, force: true }) }
}, 20_000)

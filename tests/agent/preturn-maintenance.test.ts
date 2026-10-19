import { spawn } from "node:child_process"
import { expect, it } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

for (const mode of ["pre-turn", "manual"]) for (const failedWrite of [false, true]) {
  it(`preserves a successful ${mode} summary and reports usage (journal failure=${failedWrite})`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "zap-preturn-meter-"))
    try {
      const child = spawn(process.execPath, [resolve("tests/fixtures/preturn-maintenance.ts")], {
        env: { ...process.env, ZAPCODE_DATA_DIR: dir, ZAPCODE_DEVTOOLS_PORT: "", FAIL_USAGE_WRITE: failedWrite ? "1" : "0", COMPACT_MODE: mode },
        stdio: ["ignore", "pipe", "pipe"],
      })
      const timer = setTimeout(() => child.kill(), 10000)
      let code: number | null, stdout = "", stderr = ""
      child.stdout!.on("data", data => { stdout += String(data) })
      child.stderr!.on("data", data => { stderr += String(data) })
      try { code = await new Promise<number | null>((resolve, reject) => { child.once("close", resolve); child.once("error", reject) }) }
      finally { clearTimeout(timer) }
      if (code !== 0) throw new Error(stderr + stdout)
      const result = JSON.parse(stdout.trim())
      expect(result.calls).toBe(1)
      expect(result.compactCompleted).toBe(true)
      expect(result.after).toBeLessThan(result.before)
      expect(result.journalRows).toBe(failedWrite ? 0 : 1)
      expect(JSON.stringify(result.warnings)).not.toContain('"compact_failed"')
      if (failedWrite) expect(JSON.stringify([result.stateUpdates, result.logs])).toContain("fixture journal unavailable")
    } finally { await rm(dir, { recursive: true, force: true }) }
  }, 15000)
}

it("keeps maintenance usage out of the actual hook's main cache history", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zap-maintenance-ui-"))
  try {
    const child = spawn(process.execPath, [resolve("tests/fixtures/maintenance-usage-ui.ts")], {
      env: { ...process.env, ZAPCODE_DATA_DIR: dir, ZAPCODE_DEVTOOLS_PORT: "", FAIL_USAGE_WRITE: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = "", stderr = ""
    child.stdout!.on("data", data => { stdout += String(data) })
    child.stderr!.on("data", data => { stderr += String(data) })
    const timer = setTimeout(() => child.kill(), 10000)
    let code: number | null
    try { code = await new Promise<number | null>((resolve, reject) => { child.once("close", resolve); child.once("error", reject) }) }
    finally { clearTimeout(timer) }
    if (code !== 0) throw new Error(stderr + stdout)
    const result = JSON.parse(stdout.trim())
    expect(result.journalRows).toBe(2)
    expect(result.uiSnapshots[0].updates.find((value: any) => value?.i === 500)).toMatchObject({ i: 500, o: 10 })
    expect(result.uiSnapshots[1]).toMatchObject({ purpose: "maintenance", functionalUpdates: 0 })
    expect(result.uiSnapshots[1].updates.filter((value: any) => value && ("i" in value || "o" in value))).toEqual([])
  } finally { await rm(dir, { recursive: true, force: true }) }
}, 15000)

import { afterEach, beforeEach, expect, it } from "bun:test"
import { execFile, execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import { loadResultSourceGuard } from "../../src/headless/resultSourcePolicy.js"
import { parseHeadlessArgs } from "../../src/headless/args.js"
let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "zap-result-source-policy-")) })
afterEach(() => rmSync(root, { recursive: true, force: true }))
it("requires one explicit policy path and preserves the default absence", () => {
  const absent = parseHeadlessArgs(["--print", "test"])
  expect(absent.ok).toBe(true)
  if (absent.ok) expect(absent.args.resultSourcePolicy).toBeUndefined()
  const selected = parseHeadlessArgs(["--print", "test", "--result-source-policy", "policy.json"])
  expect(selected.ok).toBe(true)
  if (selected.ok) expect(selected.args.resultSourcePolicy).toBe("policy.json")
  expect(parseHeadlessArgs(["--print", "test", "--result-source-policy", "a", "--result-source-policy", "b"]).ok).toBe(false)
})
it("loads an immutable snapshot before execution and rejects malformed/large policies", async () => {
  const path = join(root, "policy.json")
  writeFileSync(path, JSON.stringify({ version: 1, tools: ["web_search"], denyUrlContains: [{ id: "restricted", value: "/excluded-corpus/" }] }))
  const guard = await loadResultSourceGuard("policy.json", root)
  writeFileSync(path, "{}")
  expect(guard("web_search", {}, { success: true, output: "https://example.test/excluded-corpus/body" }).success).toBe(false)
  await expect(loadResultSourceGuard(path, root)).rejects.toThrow("invalid schema")
  writeFileSync(path, "{")
  await expect(loadResultSourceGuard(path, root)).rejects.toThrow("valid JSON")
  writeFileSync(path, " ".repeat(65537))
  await expect(loadResultSourceGuard(path, root)).rejects.toThrow("64 KiB")
})
const posixTest = process.platform === "win32" ? it.skip : it
posixTest("does not follow a policy symlink", async () => {
  writeFileSync(join(root, "actual"), "{}")
  symlinkSync(join(root, "actual"), join(root, "policy"))
  await expect(loadResultSourceGuard("policy", root)).rejects.toThrow()
})
posixTest("rejects a policy FIFO without waiting for a writer before run admission", async () => {
  const path = join(root, "policy-fifo")
  execFileSync("mkfifo", [path])
  // A separate process bounds the regression even if open() blocks before fstat.
  const script = `import { loadResultSourceGuard } from ${JSON.stringify(resolve("src/headless/resultSourcePolicy.ts"))};
    try { await loadResultSourceGuard(process.argv[1], process.cwd()); process.exitCode = 1 }
    catch (error) { console.log(error.message) }`
  const result = await promisify(execFile)(process.execPath, ["-e", script, path], { timeout: 3000 })
  expect(result.stdout).toContain("regular JSON file")
})

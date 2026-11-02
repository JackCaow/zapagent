import { afterAll, describe, expect, it } from "bun:test"
import { spawn } from "node:child_process"
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const root = resolve(import.meta.dir, "../..")
const work = realpathSync(mkdtempSync(join(tmpdir(), "zap-cwd-cli-")))
const first = join(work, "first")
const last = join(work, "last")
mkdirSync(first)
mkdirSync(last)
const preload = join(work, "preload.ts")
// Keep the actual entrypoint, Watch argument stripping, headless parser, stdin
// handling and chdir. Replace only the runtime, so no provider/state is loaded.
writeFileSync(preload, `import { mock } from "bun:test";
mock.module(${JSON.stringify(join(root, "src/headless/runHeadless.ts"))}, () => ({
  runHeadless: async (args) => {
    console.log(JSON.stringify({ cwd: process.cwd(), parsedCwd: args.cwd, prompt: args.prompt }));
    return 0;
  }
}));`)
afterAll(() => rmSync(work, { recursive: true, force: true }))

async function run(argv: string[], stdin = "") {
  const child = spawn(process.execPath, ["--preload", preload, join(root, "src/index.tsx"), ...argv], {
    cwd: work,
    env: { ...process.env, ZAPCODE_DATA_DIR: join(work, "data") },
    stdio: ["pipe", "pipe", "pipe"],
  })
  let stdout = "", stderr = ""
  child.stdout.on("data", chunk => { stdout += String(chunk) })
  child.stderr.on("data", chunk => { stderr += String(chunk) })
  const finished = new Promise<number | null>((resolve, reject) => {
    child.once("close", resolve)
    child.once("error", reject)
  })
  child.stdin.end(stdin)
  const timer = setTimeout(() => child.kill("SIGKILL"), 10000)
  let code: number | null
  try { code = await finished } finally { clearTimeout(timer) }
  return { code, stdout, stderr }
}

describe("headless CLI cwd dispatch", () => {
  it("applies the last --cwd once before loading the runtime", async () => {
    const result = await run(["-p", "inspect", "--cwd", first, "--cwd", last])
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ cwd: last, parsedCwd: last, prompt: "inspect" })
  })

  it("resolves the final relative cwd against the invocation directory", async () => {
    const result = await run(["--cwd", first, "--cwd", "last", "-p", "inspect"])
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout).cwd).toBe(last)
  })

  it("does not chdir to an overridden nonexistent cwd", async () => {
    const result = await run(["--cwd", join(work, "missing"), "--cwd", last, "-p", "inspect"])
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout).cwd).toBe(last)
  })

  it("applies cwd for a piped prompt and preserves single-value behavior", async () => {
    const result = await run(["--cwd", first], "inspect stdin")
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ cwd: first, parsedCwd: first, prompt: "inspect stdin" })
  })

  it("preserves the invocation cwd when no override is given", async () => {
    const result = await run(["-p", "inspect"])
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout).cwd).toBe(work)
  })

  it("rejects missing repeated cwd values without entering the runtime", async () => {
    for (const argv of [
      ["-p", "inspect", "--cwd"],
      ["-p", "inspect", "--cwd", first, "--cwd"],
      ["--cwd", "--quiet", "-p", "inspect"],
    ]) {
      const result = await run(argv)
      expect(result.code).toBe(2)
      expect(result.stderr).toContain("--cwd requires a value")
      expect(result.stdout).toBe("")
    }
  })

  it("retains rejection of unsupported equals syntax", async () => {
    const result = await run(["-p", "inspect", `--cwd=${last}`])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain("unknown flag: --cwd=")
    expect(result.stdout).toBe("")
  })

  it("rejects a nonexistent final cwd without entering the runtime", async () => {
    const result = await run(["-p", "inspect", "--cwd", first, "--cwd", join(work, "missing")])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain("bad --cwd:")
    expect(result.stdout).toBe("")
  })
})

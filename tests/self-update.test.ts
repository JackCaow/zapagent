import { afterEach, expect, it } from "bun:test"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { installSelfUpdate, planSelfUpdate, requestUpdateRestart, runUpdateProcess, takeUpdateRestart, type UpdatePlan } from "../src/self-update.js"
import { VERSION } from "../src/version.js"
import { parseCommand } from "../src/commands.js"

const roots: string[] = []
const savedLauncher = process.env.ZAPAGENT_NPM_LAUNCHER
const savedRuntime = process.env.ZAPAGENT_NPM_RUNTIME
afterEach(async () => {
  if (savedLauncher === undefined) delete process.env.ZAPAGENT_NPM_LAUNCHER
  else process.env.ZAPAGENT_NPM_LAUNCHER = savedLauncher
  if (savedRuntime === undefined) delete process.env.ZAPAGENT_NPM_RUNTIME
  else process.env.ZAPAGENT_NPM_RUNTIME = savedRuntime
  takeUpdateRestart()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "zap-self-update-")); roots.push(root)
  const binary = join(root, "downloaded"), destination = join(root, "zap")
  await writeFile(binary, "new executable")
  await writeFile(destination, "old executable")
  return { root, binary, destination }
}
it("/update opens confirmation rather than installing", () => {
  expect(parseCommand("/update")).toEqual({ type: "open_update" })
  expect(takeUpdateRestart()).toBeNull()
})
it("rejects malformed or non-newer versions before installation detection", async () => {
  for (const version of [VERSION, "0.0.1", "9.0.0; touch /tmp/unsafe", "9.0.0\n"]) {
    await expect(planSelfUpdate(version)).rejects.toThrow()
  }
})
it("detects the same global npm prefix without modifying it", async () => {
  if (process.platform === "win32") return
  const { root } = await fixture()
  const packageRoot = join(root, "lib/node_modules/zapagent")
  await mkdir(join(packageRoot, "npm"), { recursive: true })
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "zapagent", version: VERSION }))
  process.env.ZAPAGENT_NPM_LAUNCHER = join(packageRoot, "npm/cli.cjs")
  process.env.ZAPAGENT_NPM_RUNTIME = process.execPath
  const plan = await planSelfUpdate("999.0.0")
  expect(plan.kind).toBe("npm")
  expect(plan.prefix).toBe(root)
  expect(JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")).version).toBe(VERSION)
})
it("refuses to rewrite a local project dependency", async () => {
  const { root } = await fixture()
  const packageRoot = join(root, "node_modules/zapagent")
  await mkdir(join(packageRoot, "npm"), { recursive: true })
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "zapagent", version: VERSION }))
  process.env.ZAPAGENT_NPM_LAUNCHER = join(packageRoot, "npm/cli.cjs")
  process.env.ZAPAGENT_NPM_RUNTIME = process.execPath
  await expect(planSelfUpdate("999.0.0")).rejects.toThrow("package manager")
})
it("a failed verified download leaves the current binary untouched and never requests restart", async () => {
  const { destination } = await fixture()
  await expect(installSelfUpdate({ kind: "binary", version: "999.0.0", destination }, "session", {
    download: async () => { throw new Error("Checksum verification failed") }, run: async () => { throw new Error("must not run") },
  })).rejects.toThrow("Checksum")
  expect(await readFile(destination, "utf8")).toBe("old executable")
  expect(takeUpdateRestart()).toBeNull()
})
it("atomically replaces a native install and returns a restart preserving the session", async () => {
  const { binary, destination } = await fixture()
  const restart = await installSelfUpdate({ kind: "binary", version: "999.0.0", destination }, "session-123", {
    download: async () => binary, run: async () => { throw new Error("must not run") },
  })
  expect(await readFile(destination, "utf8")).toBe("new executable")
  expect(restart).toEqual({ command: destination, args: process.argv.slice(2), sessionId: "session-123" })
  expect(takeUpdateRestart()).toBeNull() // Installation alone never exits/restarts the UI.
  requestUpdateRestart(restart)
  expect(takeUpdateRestart()).toEqual(restart)
  expect(takeUpdateRestart()).toBeNull()
})
it("npm failure retains the running process and uses an exact version and original prefix", async () => {
  const { binary, root, destination } = await fixture()
  const plan: UpdatePlan = { kind: "npm", version: "999.0.0", destination, prefix: root, runtime: process.execPath, npmCLI: "npm-cli.js" }
  let args: string[] = []
  await expect(installSelfUpdate(plan, "session", { download: async () => binary, run: async (_command, argv) => {
    args = argv; throw new Error("npm failed")
  } })).rejects.toThrow("npm failed")
  expect(args).toEqual(["npm-cli.js", "install", "--global", "--prefix", root, "zapagent@999.0.0", "--no-audit", "--no-fund"])
  expect(takeUpdateRestart()).toBeNull()
  expect(await readFile(destination, "utf8")).toBe("old executable")
})
it("does not restart when npm reports success without installing the requested version", async () => {
  const { binary, root } = await fixture()
  await mkdir(join(root, "npm"))
  await writeFile(join(root, "package.json"), JSON.stringify({ version: VERSION }))
  await expect(installSelfUpdate({ kind: "npm", version: "999.0.0", destination: join(root, "npm/cli.cjs"), runtime: process.execPath, npmCLI: "npm-cli.js", prefix: root }, "session", {
    download: async () => binary, run: async () => {},
  })).rejects.toThrow("requested version")
  expect(takeUpdateRestart()).toBeNull()
})
it("propagates real updater process failure", async () => {
  await expect(runUpdateProcess(process.execPath, ["-e", "process.exit(17)"])).rejects.toThrow("17")
  await expect(runUpdateProcess("/nonexistent/zap-npm", [])).rejects.toThrow()
})

it("successful npm update restarts the verified binary without nesting another npm launcher", async () => {
  const { binary, root } = await fixture()
  await mkdir(join(root, "npm"))
  await writeFile(join(root, "package.json"), JSON.stringify({ version: VERSION }))
  const result = await installSelfUpdate({ kind: "npm", version: "999.0.0", destination: join(root, "npm/cli.cjs"), runtime: process.execPath, npmCLI: "npm-cli.js", prefix: root }, "session", {
    download: async () => binary,
    run: async () => { await writeFile(join(root, "package.json"), JSON.stringify({ version: "999.0.0" })) },
  })
  expect(result.command).toBe(binary)
  expect(result.sessionId).toBe("session")
})

import { spawn } from "node:child_process"
import { access, chmod, copyFile, readFile, realpath, rename, rm } from "node:fs/promises"
import { constants } from "node:fs"
import { delimiter, dirname, join, resolve } from "node:path"
import { isNewerRelease } from "./update-check.js"
import { VERSION } from "./version.js"
// Reuse the release downloader: versioned cache, SHA-256 verification, atomic writes.
import { ensureBinary } from "../npm/install.cjs"

export interface UpdatePlan {
  version: string
  kind: "npm" | "binary"
  destination: string
  runtime?: string
  npmCLI?: string
  prefix?: string
}
export interface RestartRequest { command: string; args: string[]; sessionId: string }
let restartRequest: RestartRequest | null = null
export function requestUpdateRestart(request: RestartRequest): void { restartRequest = request }
export function takeUpdateRestart(): RestartRequest | null {
  const result = restartRequest
  restartRequest = null
  return result
}

async function findNpmCLI(runtime: string): Promise<string> {
  const candidates = [join(dirname(runtime), "node_modules/npm/bin/npm-cli.js"),
    join(dirname(runtime), "../lib/node_modules/npm/bin/npm-cli.js")]
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    try {
      const executable = await realpath(join(dir, process.platform === "win32" ? "npm.cmd" : "npm"))
      if (executable.endsWith("npm-cli.js")) candidates.push(executable)
      candidates.push(join(dirname(executable), "node_modules/npm/bin/npm-cli.js"))
    } catch { /* Try the next PATH entry. */ }
  }
  for (const candidate of candidates) {
    try { await access(candidate); return resolve(candidate) } catch { /* Not this installation. */ }
  }
  throw new Error("npm was not found. Install npm or update zapagent using your package manager.")
}

export async function planSelfUpdate(version: string): Promise<UpdatePlan> {
  if (!isNewerRelease(version, VERSION)) throw new Error("Invalid or non-newer release version")
  const launcher = process.env.ZAPAGENT_NPM_LAUNCHER
  const runtime = process.env.ZAPAGENT_NPM_RUNTIME
  if (launcher && runtime) {
    const root = dirname(launcher)
    const pkg = JSON.parse(await readFile(join(root, "../package.json"), "utf8"))
    if (pkg.name !== "zapagent" || pkg.version !== VERSION) throw new Error("Unrecognized npm installation")
    const packageRoot = dirname(root)
    const modules = dirname(packageRoot)
    // Global npm layout only. Local project dependencies and Bun/Homebrew installs
    // belong to their package manager and must not be silently rewritten.
    if (dirname(modules).endsWith(`${process.platform === "win32" ? "\\" : "/"}lib`)) {
      const prefix = dirname(dirname(modules))
      return { version, kind: "npm", destination: launcher, runtime, prefix, npmCLI: await findNpmCLI(runtime) }
    }
    if (process.platform === "win32" && modules.toLowerCase() === join(process.env.APPDATA ?? "", "npm", "node_modules").toLowerCase()) {
      return { version, kind: "npm", destination: launcher, runtime, prefix: dirname(modules), npmCLI: await findNpmCLI(runtime) }
    }
    throw new Error("Use your package manager to update this local or Bun-managed installation.")
  }
  const destination = await realpath(process.execPath)
  if (!process.versions.bun || /(?:^|[/\\])bun(?:\.exe)?$/.test(destination)) throw new Error("Source builds must be updated from Git.")
  if (process.platform === "win32") throw new Error("For automatic updates on Windows, install with npm install -g zapagent.")
  if (destination.includes("/Cellar/") || destination.includes("/nix/store/")) throw new Error("Update this installation using its package manager.")
  await access(dirname(destination), constants.W_OK)
  return { version, kind: "binary", destination }
}

export async function runUpdateProcess(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true })
    // Consume output without exposing registry credentials or disturbing the TUI.
    child.stderr?.resume()
    const timer = setTimeout(() => { child.kill(); reject(new Error("Update command timed out. Current session is still running.")) }, 300_000)
    child.once("error", error => { clearTimeout(timer); reject(error) })
    child.once("exit", (code, signal) => { clearTimeout(timer); code === 0 ? resolvePromise() : reject(new Error(`Update command failed (${signal ?? code}). Current session is still running.`)) })
  })
}

export async function installSelfUpdate(
  plan: UpdatePlan,
  sessionId: string,
  deps = { download: ensureBinary, run: runUpdateProcess },
): Promise<RestartRequest> {
  if (!isNewerRelease(plan.version, VERSION)) throw new Error("Invalid update version")
  // Download and verify before modifying the installation. No network work is
  // performed by planSelfUpdate; this function is called only after confirmation.
  const binary: string = await deps.download({ version: plan.version })
  if (plan.kind === "npm") {
    if (!plan.runtime || !plan.npmCLI || !plan.prefix) throw new Error("Incomplete npm update plan")
    await deps.run(plan.runtime, [plan.npmCLI, "install", "--global", "--prefix", plan.prefix, `zapagent@${plan.version}`, "--no-audit", "--no-fund"])
    const pkg = JSON.parse(await readFile(join(dirname(plan.destination), "../package.json"), "utf8"))
    if (pkg.version !== plan.version) throw new Error("npm did not install the requested version")
    return { command: binary, args: process.argv.slice(2), sessionId }
  }
  const pending = `${plan.destination}.${process.pid}.update`
  try {
    await copyFile(binary, pending, constants.COPYFILE_EXCL)
    await chmod(pending, 0o755)
    await rename(pending, plan.destination)
  } finally { await rm(pending, { force: true }) }
  return { command: plan.destination, args: process.argv.slice(2), sessionId }
}

import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { spawnSync } from "node:child_process"

export function vmHostBinaryNames(goos: string): string[] {
  if (!["darwin", "linux", "windows"].includes(goos)) {
    throw new Error(`Unsupported VM Host target: ${goos}`)
  }
  return ["zapvm", "zapvm-image"].map(name => name + (goos === "windows" ? ".exe" : ""))
}

if (import.meta.main) {
  const root = join(import.meta.dir, "..")
  const goos = process.env.GOOS ?? (process.platform === "win32" ? "windows" : process.platform)
  const names = vmHostBinaryNames(goos)
  const output = join(root, "dist", "zapvm-host")
  mkdirSync(output, { recursive: true })
  for (const [index, command] of ["zapvm", "zapvm-image"].entries()) {
    const result = spawnSync("go", ["build", "-trimpath", "-o", join(output, names[index]!), `./cmd/${command}`], {
      cwd: join(root, "zapvm"), stdio: "inherit",
    })
    if (result.error) throw result.error
    if (result.status !== 0) process.exit(result.status ?? 1)
  }
}

import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

/** Isolated command fixture. Its sibling files stand in for native CLI state. */
export function installCodexFixture(root: string) {
  let cli = join(root, "codex")
  if (process.platform === "win32") {
    const pkg = join(root, "global", "5", "node_modules", "@openai", "codex")
    mkdirSync(pkg, { recursive: true })
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@openai/codex", bin: { codex: "codex.cjs" } }))
    cli = join(pkg, "codex.cjs")
    writeFileSync(join(root, "codex.cmd"), '@node "%~dp0global\\5\\node_modules\\@openai\\codex\\codex.cjs" %*')
  }
  writeFileSync(cli, `#!${process.execPath}
const fs = require("node:fs"), path = require("node:path")
const file = name => path.join(${JSON.stringify(root)}, name)
const command = process.argv.slice(2).join(" ")
fs.appendFileSync(file("calls"), command + "\\n")
if (command === "login" && fs.existsSync(file("wait-login.cjs"))) {
  require("node:child_process").spawn(process.execPath, [file("wait-login.cjs")], {stdio:"inherit"})
} else if (command === "debug models" && fs.existsSync(file("models")) && !fs.existsSync(file("offline"))) {
  process.stdout.write(fs.readFileSync(file("models")))
} else if (command === "login" || command === "login --device-auth") {
  fs.writeFileSync(file("login"), "1")
} else if (command === "login status" && fs.existsSync(file("login"))) {
  console.error("Logged in using ChatGPT")
} else if (command === "logout") {
  fs.rmSync(file("login"), { force: true })
} else { console.error("Codex unavailable"); process.exitCode = 1 }
`, { mode: 0o700 })
}

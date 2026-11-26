import { writeFileSync } from "node:fs"
import { join } from "node:path"

/** Isolated command fixture. Its sibling files stand in for native CLI state. */
export function installCodexFixture(root: string) {
  writeFileSync(join(root, "codex"), `#!${process.execPath}
const fs = require("node:fs"), path = require("node:path")
const file = name => path.join(path.dirname(process.argv[1]), name)
const command = process.argv.slice(2).join(" ")
fs.appendFileSync(file("calls"), command + "\\n")
if (command === "debug models" && fs.existsSync(file("models")) && !fs.existsSync(file("offline"))) {
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

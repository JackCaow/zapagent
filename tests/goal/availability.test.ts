import { afterAll, expect, it } from "bun:test"
import { mkdtempSync, rmSync, existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { goalCommand, goalDatabasePath } from "../../src/goal-command.js"

const root = mkdtempSync(join(tmpdir(), "zap-goal-availability-"))
const previous = process.env.ZAPCODE_DATA_DIR
process.env.ZAPCODE_DATA_DIR = root
afterAll(() => { if (previous === undefined) delete process.env.ZAPCODE_DATA_DIR; else process.env.ZAPCODE_DATA_DIR = previous; rmSync(root, { recursive: true, force: true }) })
it("rejects Windows Goal creation before creating state or starting a runner", () => {
  expect(() => goalCommand(["Create a report"], root, "default", "win32")).toThrow("not yet supported on Windows")
  expect(existsSync(goalDatabasePath())).toBe(false)
})

it("rejects Windows resume before accessing state", () => {
  expect(() => goalCommand(["resume"], root, "default", "win32")).toThrow("not yet supported on Windows")
  expect(existsSync(goalDatabasePath())).toBe(false)
})
it("rejects unsupported machine checks before creating a Goal or ledger", () => {
  expect(() => goalCommand(["Create a report", "--check=bun"], root)).toThrow("--check machine verification is currently unavailable")
  expect(() => goalCommand(["Create a report", "--check"], root)).toThrow("--check machine verification is currently unavailable")
  expect(existsSync(goalDatabasePath())).toBe(false)
})
it("help clearly identifies unavailable Goal capabilities", () => {
  const usage = goalCommand(["help"], root)
  expect(usage).toContain("--check requires a VM backend with verified process sealing")
  expect(usage).toContain("not yet supported on Windows")
  expect(usage).toContain("--install=npm")
  expect(usage).toContain("lifecycle scripts disabled")
  expect(usage).toContain("does not authorize shell commands or artifact merges")
})

it("rejects unsupported npm installation and conflicting approval modes before creating state", () => {
  expect(() => goalCommand(["Create a report", "--install=npm"], root)).toThrow("requires a VM backend")
  expect(() => goalCommand(["Create a report", "--install=other"], root)).toThrow("Invalid Goal dependency installation")
  expect(() => goalCommand(["Create a report", "--accept-edits", "--permission-mode=bypassPermissions"], root)).toThrow("Invalid Goal permission mode")
  expect(() => goalCommand(["Create a report", "--permission-mode=unknown"], root)).toThrow("Invalid Goal permission mode")
  expect(existsSync(goalDatabasePath())).toBe(false)
})


it("offers Goal in the slash palette and completes to its existing command", async () => {
  const { filterCommands } = await import("../../src/ui/slash-palette.js")
  const { parseCommand } = await import("../../src/commands.js")
  expect(filterCommands("/").some(entry => entry.name === "/goal")).toBe(true)
  const entry = filterCommands("/go")[0]
  expect(entry?.name).toBe("/goal")
  expect(parseCommand(`${entry!.name} help`)).toEqual({ type: "goal", value: "help" })
})

it("rejects invalid or duplicate explicit limits before creating state", () => {
  for (const flag of ["--tokens=0", "--tokens=abc", "--minutes=9999999999999999999", "--tool-calls=-1"]) {
    expect(() => goalCommand(["Report", flag], root)).toThrow("Invalid explicit Goal limit")
  }
  expect(() => goalCommand(["Report", "--tokens=10", "--tokens=20"], root)).toThrow("Invalid explicit Goal limit")
  expect(existsSync(goalDatabasePath())).toBe(false)
})


it("selects the current chat's Goal instead of a newer Goal from another chat", async () => {
  const { GoalStore } = await import("../../zapsdk/goal/store.js")
  const { GoalBudgetLedger } = await import("../../zapsdk/goal/budget.js")
  const store = new GoalStore(goalDatabasePath()), ledger = new GoalBudgetLedger(goalDatabasePath())
  try {
    const mine = store.create({ objective: "My report", cwd: root, sessionId: "mine" })
    const other = store.create({ objective: "Other report", cwd: root, sessionId: "other" })
    ledger.create(mine.id, 0, { strict: false }); ledger.create(other.id, 0, { strict: false })
    const status = goalCommand(["status"], root, "default", process.platform, "mine")
    expect(status).toContain(mine.id); expect(status).not.toContain(other.id)
  } finally { ledger.close(); store.close() }
})

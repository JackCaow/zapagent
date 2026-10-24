import { expect, it } from "bun:test"
import { runUpdateCommand } from "../src/update-cli.js"
declare const Bun: { spawn(command: string[], options: { stdin: "ignore"; stdout: "pipe"; stderr: "pipe" }): { stdout: ReadableStream<Uint8Array>; stderr: ReadableStream<Uint8Array>; exited: Promise<number> } }
import { VERSION } from "../src/version.js"
import type { UpdatePlan } from "../src/self-update.js"

function fixture() {
  const events: string[] = []
  const plan: UpdatePlan = { kind: "binary", version: "999.0.0", destination: "/fixture/zap" }
  const deps = {
    latest: async () => "999.0.0",
    confirm: async () => { events.push("confirm"); return false },
    plan: async () => { events.push("plan"); return plan },
    install: async () => { events.push("install"); return { command: "/fixture/zap", args: [], sessionId: "" } },
    write: (message: string) => { events.push(message) },
  }
  return { events, deps }
}
it("zap update cancellation performs no download or installation", async () => {
  const { events, deps } = fixture()
  expect(await runUpdateCommand([], deps)).toBe(0)
  expect(events).toContain("confirm")
  expect(events).not.toContain("install")
  expect(events).toContain("Update cancelled.")
})
it("installs only after an affirmative answer", async () => {
  const { events, deps } = fixture()
  deps.confirm = async () => { events.push("confirm"); return true }
  expect(await runUpdateCommand([], deps)).toBe(0)
  expect(events.indexOf("confirm")).toBeLessThan(events.indexOf("install"))
  expect(events.at(-1)).toContain("Run zap")
})
it("--yes explicitly authorizes unattended installation", async () => {
  for (const flag of ["--yes", "-y"]) {
    const { events, deps } = fixture()
    expect(await runUpdateCommand([flag], deps)).toBe(0)
    expect(events).not.toContain("confirm")
    expect(events).toContain("install")
  }
})
it("up-to-date versions never request confirmation or install", async () => {
  const { events, deps } = fixture()
  deps.latest = async () => VERSION
  expect(await runUpdateCommand([], deps)).toBe(0)
  expect(events).not.toContain("confirm")
  expect(events).not.toContain("install")
})
it("network and installation failures return failure rather than claiming success", async () => {
  for (const stage of ["latest", "install"] as const) {
    const { events, deps } = fixture()
    deps[stage] = async () => { throw new Error("offline") }
    expect(await runUpdateCommand(["--yes"], deps)).toBe(1)
    expect(events.at(-1)).toBe("Update failed: offline")
  }
})
it("unknown options fail before making a request", async () => {
  const { events, deps } = fixture()
  deps.latest = async () => { throw new Error("must not request") }
  expect(await runUpdateCommand(["--bad"], deps)).toBe(2)
  expect(events).toEqual(["Usage: zap update [--yes|-y]"])
})

it("default confirmation refuses a non-TTY without --yes", async () => {
  const entry = new URL("../src/update-cli.ts", import.meta.url).href
  const script = `import {runUpdateCommand} from ${JSON.stringify(entry)};
    const code = await runUpdateCommand([], {
      latest: async () => "999.0.0",
      plan: async () => ({kind:"binary",version:"999.0.0",destination:"/unused"}),
      install: async () => { console.log("INSTALL_MUST_NOT_RUN"); throw new Error("unexpected install") }
    }); process.exit(code);`
  const child = Bun.spawn([process.execPath, "-e", script], { stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const output = await new Response(child.stdout).text()
  expect(await child.exited).toBe(1)
  expect(output).toContain("Confirmation requires a terminal")
  expect(output).not.toContain("INSTALL_MUST_NOT_RUN")
})

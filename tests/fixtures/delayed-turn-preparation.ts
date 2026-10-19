// Preload only in the PTY test: hold a real App turn before SDK acceptance.
import { mock } from "bun:test"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"

const modulePath = resolve(import.meta.dir, "../../src/agent/repoMap.ts")
const repoMap = await import(modulePath)
const buildRepoMapAttachment = repoMap.buildRepoMapAttachment
mock.module(modulePath, () => ({ ...repoMap,
  buildRepoMapAttachment: async (...args: Parameters<typeof buildRepoMapAttachment>) => {
    const gate = process.env.ZAP_TEST_PREPARATION_GATE
    const deadline = Date.now() + 15000
    while (gate && !existsSync(gate)) {
      if (Date.now() > deadline) throw new Error("fixture preparation gate timed out")
      await sleep(20)
    }
    return buildRepoMapAttachment(...args)
  },
}))

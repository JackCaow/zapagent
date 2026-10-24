import { expect, it } from "bun:test"
import { prepareUpdateRestart, restoreAfterUpdate } from "../src/update-lifecycle.js"

it("keeps restoration paused through slow preparation and commit", async () => {
  const events: string[] = []
  let resolve!: (value: string) => void
  const result = restoreAfterUpdate({
    load: () => new Promise<string>(done => { resolve = done }),
    commit: value => { events.push(value) },
    failed: () => events.push("failed"), finished: () => events.push("unpause"),
  })
  await Promise.resolve()
  expect(events).toEqual([])
  resolve("commit")
  await result
  expect(events).toEqual(["commit", "unpause"])
})
it("catches durable commit failure and releases the composer without an unhandled rejection", async () => {
  const events: string[] = []
  await restoreAfterUpdate({ load: async () => "prepared", commit: () => { throw new Error("writer failed") },
    failed: () => events.push("failed"), finished: () => events.push("unpause") })
  expect(events).toEqual(["failed", "unpause"])
})
it("load failure releases restoration without committing", async () => {
  const events: string[] = []
  await restoreAfterUpdate({ load: async () => { throw new Error("unreadable") }, commit: () => events.push("commit"),
    failed: () => events.push("failed"), finished: () => events.push("unpause") })
  expect(events).toEqual(["failed", "unpause"])
})
it("stops watch, host and old runtime before starting the replacement", async () => {
  const events: string[] = []
  await prepareUpdateRestart({ stopWatch: async () => { events.push("watch") }, stopHost: async () => { events.push("host") }, stopRuntime: () => { events.push("cron+tasks") } })
  events.push("replacement")
  expect(events).toEqual(["watch", "host", "cron+tasks", "replacement"])
})

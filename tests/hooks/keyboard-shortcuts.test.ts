import { describe, expect, test } from "bun:test"
import {
  ESC_INTERRUPT_CONFIRM_MS,
  isConfirmedInterruptEscape,
  resolveEscapeAction,
} from "../../src/hooks/useKeyboardShortcuts.js"

describe("keyboard interrupt confirmation", () => {
  test("requires a previous Esc press", () => {
    expect(isConfirmedInterruptEscape(0, 1000)).toBe(false)
  })

  test("accepts a second Esc inside the confirmation window", () => {
    expect(isConfirmedInterruptEscape(1000, 1000 + ESC_INTERRUPT_CONFIRM_MS)).toBe(true)
  })

  test("rejects a second Esc after the confirmation window", () => {
    expect(isConfirmedInterruptEscape(1000, 1001 + ESC_INTERRUPT_CONFIRM_MS)).toBe(false)
  })

  test("rejects a clock value older than the first press", () => {
    expect(isConfirmedInterruptEscape(1000, 999)).toBe(false)
  })
})

describe("resolveEscapeAction", () => {
  const idle = { dialogActive: false, fileOpen: false, slashOpen: false, queueLength: 0, pendingImages: 0, isRunning: false }

  test("running agent keeps Esc as interrupt even with queued entries", () => {
    expect(resolveEscapeAction({ ...idle, isRunning: true, queueLength: 3 })).toBe("interrupt")
  })

  test("idle Esc opens the queue manager when entries exist", () => {
    expect(resolveEscapeAction({ ...idle, queueLength: 1 })).toBe("open-queue")
  })

  test("palettes dismiss before anything else, running or not", () => {
    expect(resolveEscapeAction({ ...idle, isRunning: true, queueLength: 1, fileOpen: true })).toBe("dismiss-file")
    expect(resolveEscapeAction({ ...idle, isRunning: true, queueLength: 1, slashOpen: true })).toBe("dismiss-slash")
  })

  test("dialogs own Esc", () => {
    expect(resolveEscapeAction({ ...idle, dialogActive: true, isRunning: true, queueLength: 2 })).toBe("none")
  })

  test("attachments clear before interrupt, and idle Esc with nothing to do is a no-op", () => {
    expect(resolveEscapeAction({ ...idle, isRunning: true, pendingImages: 1 })).toBe("clear-attachments")
    expect(resolveEscapeAction(idle)).toBe("none")
  })
})

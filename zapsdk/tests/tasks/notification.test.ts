import { describe, it, expect } from "bun:test"
import { buildTaskNotificationXml, classifyTaskExit } from "../../tasks/notification.js"
import type { TaskSnapshot } from "../../tasks/types.js"

function makeSnap(overrides: Partial<TaskSnapshot> = {}): TaskSnapshot {
  return {
    taskId: "abc12345",
    kind: "shell",
    command: "echo hi",
    description: "echo hi",
    outputFile: "/tmp/tasks/abc12345.log",
    pid: 1234,
    startedAt: 1700000000000,
    ...overrides,
  }
}

describe("buildTaskNotificationXml", () => {
  it("emits the canonical envelope with task-id / task-type / status / summary / output-file", () => {
    const xml = buildTaskNotificationXml({
      task: makeSnap(),
      status: "completed",
      outputBytes: 12,
    })
    expect(xml).toContain("<task-notification>")
    expect(xml).toContain("<task-id>abc12345</task-id>")
    expect(xml).toContain("<task-type>shell</task-type>")
    expect(xml).toContain("<status>completed</status>")
    expect(xml).toContain("<summary>echo hi</summary>")
    expect(xml).toContain("<output-file>/tmp/tasks/abc12345.log</output-file>")
    expect(xml).toContain("<output-bytes>12</output-bytes>")
    expect(xml).toMatch(/<\/task-notification>$/)
  })

  it("includes exit-code when set on the task", () => {
    const xml = buildTaskNotificationXml({
      task: makeSnap({ exitCode: 0 }),
      status: "completed",
    })
    expect(xml).toContain("<exit-code>0</exit-code>")
  })

  it("includes signal when the task was killed", () => {
    const xml = buildTaskNotificationXml({
      task: makeSnap({ signal: "SIGKILL" }),
      status: "killed",
    })
    expect(xml).toContain("<signal>SIGKILL</signal>")
    expect(xml).toContain("<status>killed</status>")
  })

  it("escapes XML special characters in description and outputFile", () => {
    const xml = buildTaskNotificationXml({
      task: makeSnap({
        description: `download <foo> & "bar"`,
        outputFile: "/tmp/<weird>.log",
      }),
      status: "completed",
    })
    expect(xml).toContain("download &lt;foo&gt; &amp; &quot;bar&quot;")
    expect(xml).toContain("/tmp/&lt;weird&gt;.log")
    // Sanity: no literal angle brackets escaped through into the payload
    // text of the affected fields.
    expect(xml).not.toContain("<foo>")
  })

  it("omits output-bytes when not provided", () => {
    const xml = buildTaskNotificationXml({
      task: makeSnap(),
      status: "completed",
    })
    expect(xml).not.toContain("<output-bytes>")
  })
})

describe("classifyTaskExit", () => {
  it("returns 'killed' when a signal is present", () => {
    expect(classifyTaskExit(null, "SIGTERM")).toBe("killed")
    expect(classifyTaskExit(0, "SIGKILL")).toBe("killed")
  })

  it("returns 'failed' on non-zero exit without signal", () => {
    expect(classifyTaskExit(1, null)).toBe("failed")
    expect(classifyTaskExit(127, null)).toBe("failed")
  })

  it("does not promote unknown exit status to success", () => {
    expect(classifyTaskExit(0, null)).toBe("completed")
    expect(classifyTaskExit(null, null)).toBe("unknown")
  })
})

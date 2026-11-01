import { expect, it } from "bun:test"
import { createGoalContentFilter, goalAcceptanceSummary, goalDeliveryMarkdown, stripGoalProtocolTags } from "../../src/goal-output.js"
import { createRunHandlers } from "../../src/agent/wireRunHandlers.js"
import { getDefaultConfig } from "../../src/config.js"
import { AgentEventEmitter, type AgentEvent } from "../../zapsdk/agent/events.js"
import type { GoalRecord } from "../../zapsdk/goal/contracts.js"

const tag = "</｜｜DSML｜｜ parameter>"
const text = (value: string, type: "content_delta" | "content_final" = "content_delta", path?: string[]): AgentEvent => ({ type, kind: "text", id: "answer", text: value, path })

it("hides verifier/planner prose before streaming, but retains tool progress and immutable raw events", () => {
  const filter = createGoalContentFilter(true)
  const raw = { status: "passed", detail: "PRIVATE_RECEIPT" }
  for (const type of ["content_delta", "content_final"] as const) {
    expect(filter(text(JSON.stringify(raw) + tag, type))).toBeUndefined()
    expect(filter({ type, kind: "thinking", id: "reason", text: "PRIVATE_VERIFIER_REASONING" })).toBeUndefined()
  }
  const call: AgentEvent = { type: "content_final", kind: "tool_call", id: "read", step: 1, toolName: "read_file", arguments: { path: "report.md" } }
  const result: AgentEvent = { type: "content_final", kind: "tool_result", id: "read", step: 1, toolName: "read_file", result: { success: true, output: '{"normal":"file contents"}' } }
  expect(filter(call)).toBe(call)
  expect(filter(result)).toBe(result)
  expect(filter({ type: "status", status: "tool" })).toEqual({ type: "status", status: "tool" })
  expect(raw).toEqual({ status: "passed", detail: "PRIVATE_RECEIPT" })
})

it("strips DSML tags split at any character boundary without leaking partial tags", () => {
  const raw = `# Result\n${tag}**354 GiB**<｜｜DSML｜｜ calls></|DSML|invoke></||DSML||calls>`
  for (let cut = 0; cut <= raw.length; cut++) {
    const filter = createGoalContentFilter()
    const chunks = [raw.slice(0, cut), raw.slice(cut)]
    const visible = chunks.map(chunk => filter(text(chunk))).filter(Boolean).map(event => (event as { text: string }).text).join("")
    expect(visible).toBe("# Result\n**354 GiB**")
    expect(filter(text(raw, "content_final"))).toMatchObject({ text: "# Result\n**354 GiB**" })
  }
})

it("preserves Markdown, ordinary JSON, HTML, comparisons and distinct child content streams", () => {
  const content = '# Report\n\n| Key | Value |\n|---|---|\n| count | 2 |\n\n```json\n{"status":"passed","userRequested":true}\n```\n<details>HTML</details>\na < b'
  expect(stripGoalProtocolTags(content)).toBe(content)
  const filter = createGoalContentFilter()
  expect(filter(text("parent </｜｜DSM"))).toMatchObject({ text: "parent " })
  expect(filter(text("child", "content_delta", ["child"]))).toMatchObject({ text: "child" })
  expect(filter(text("L｜｜ invoke>done"))).toMatchObject({ text: "done" })
  expect(filter(text(`parent ${tag}done`, "content_final"))).toMatchObject({ text: "parent done" })
  expect(filter(text("fresh"))).toMatchObject({ text: "fresh" })
  expect(stripGoalProtocolTags("a <")).toBe("a <")
  expect(stripGoalProtocolTags("result </｜｜DSML｜｜" + "x".repeat(200_000))).toBe("result ")
})

it("projects Goal delivery as Markdown without exposing receipt/report metadata or mutating it", () => {
  const delivery = { mode: "session", text: `# Disk\n\n**354 GiB**${tag}`, report: "/private/receipt.json", snapshotId: "INTERNAL_HASH" }
  expect(goalDeliveryMarkdown(delivery)).toBe("# Disk\n\n**354 GiB**")
  expect(delivery.text).toContain(tag)
  expect(goalDeliveryMarkdown({ text: "    indented code\n" })).toBe("    indented code\n")
  expect(goalDeliveryMarkdown({ path: "/artifacts/result", snapshotId: "INTERNAL_HASH" })).toBe("Goal 产物目录：/artifacts/result")
  for (const invalid of [undefined, null, "text", {}, { text: 123 }, { text: tag }]) expect(goalDeliveryMarkdown(invalid)).toBeUndefined()
})

it("summarizes host acceptance without echoing JSON or confusing blocked delivery with success", () => {
  const goal = (status: GoalRecord["status"], receiptStatus: NonNullable<GoalRecord["finalReceipt"]>["status"]): GoalRecord => ({
    id: "goal", objective: "Report", cwd: "/workspace", deliveryPolicy: "workspace", permissionMode: "default", status,
    tasks: [], stateRevision: 1, specRevision: 1, planRevision: 1, ownerEpoch: 1, createdAt: 1, updatedAt: 1,
    finalReceipt: { status: receiptStatus, candidateId: "candidate", snapshotId: "snapshot", specDigest: "spec", taskId: "one", attempt: 1, evidence: {}, detail: "PRIVATE_RECEIPT" },
  })
  expect(goalAcceptanceSummary(goal("completed", "passed"))).toBe("Goal 验收通过。")
  expect(goalAcceptanceSummary(goal("ready_for_delivery", "passed"))).toContain("等待交付授权")
  expect(goalAcceptanceSummary(goal("blocked", "passed"))).not.toContain("验收通过")
  expect(goalAcceptanceSummary(goal("awaiting_acceptance", "failed"))).toBe("Goal 验收未通过。")
  expect(goalAcceptanceSummary(goal("awaiting_acceptance", "unverified"))).toContain("尚未确认")
  expect(goalAcceptanceSummary(goal("blocked", "error"))).toContain("检查执行失败")
  expect(goalAcceptanceSummary({ ...goal("paused", "passed"), finalReceipt: undefined })).toBeUndefined()
})

it("applies the Goal content projection to ordinary TUI handlers while normal turns remain unchanged", () => {
  for (const goal of [true, false]) {
    const emitter = new AgentEventEmitter(), deltas: string[] = [], finals: string[] = [], thinking: string[] = []
    createRunHandlers({ currentConfig: getDefaultConfig(), controller: new AbortController(),
      presentContent: goal ? createGoalContentFilter() : undefined,
      preview: { onTextDelta(_id: string, value: string) { deltas.push(value) }, onTextFinal(_id: string, value: string) { finals.push(value) },
        onThinkingDelta() {}, onThinkingFinal() { return { thinkingMs: 0 } } } as any,
      setStatus() {}, setStep() {}, setActiveTool() {}, setActiveToolBytes() {}, setContextTokens() {}, setContextPending() {}, compactLogs() {},
      addLog(type, value) { if (type === "thinking") thinking.push(value) }, replaceLog() {}, peekNextLogId: () => 0,
    }).wire(emitter)
    emitter.emit(text("# Report</｜｜DSM")); emitter.emit(text("L｜｜ calls>\nDone")); emitter.emit(text(`# Report${tag}\nDone`, "content_final"))
    emitter.emit({ type: "content_final", kind: "thinking", id: "reason", text: `checking${tag}` })
    expect(deltas.join("")).toBe(goal ? "# Report\nDone" : "# Report</｜｜DSML｜｜ calls>\nDone")
    expect(finals[0]).toBe(goal ? "# Report\nDone" : `# Report${tag}\nDone`)
    expect(thinking[0]).toBe(goal ? "checking" : `checking${tag}`)
  }
})

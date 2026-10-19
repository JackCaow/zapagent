import { describe, it, expect, beforeEach } from "bun:test"
import { enterPlanModeTool, exitPlanModeTool, type PlanModeCallbacks } from "../../builtin-tools/plan-mode.js"

function makeCallbacks(initial: boolean = false): PlanModeCallbacks & {
  calls: { enter: number; exits: Array<{ plan: string }> }
  setApproval: (v: { approved: boolean; reason?: string }) => void
  setActive: (v: boolean) => void
} {
  let active = initial
  let approvalValue: { approved: boolean; reason?: string } = { approved: true }
  const calls = { enter: 0, exits: [] as Array<{ plan: string }> }
  return {
    calls,
    setApproval: (v) => { approvalValue = v },
    setActive: (v) => { active = v },
    isActive: () => active,
    enter: () => { active = true; calls.enter++ },
    requestExit: async (plan) => { calls.exits.push({ plan }); return approvalValue },
  }
}

describe("enter_plan_mode", () => {
  let cb: ReturnType<typeof makeCallbacks>
  let tool: ReturnType<typeof enterPlanModeTool>

  beforeEach(() => {
    cb = makeCallbacks(false)
    tool = enterPlanModeTool({ callbacks: cb })
  })

  it("enters plan mode and reports the mode switch", async () => {
    const r = await tool.handler({})
    expect(r.success).toBe(true)
    expect(cb.calls.enter).toBe(1)
    expect(cb.isActive()).toBe(true)
    expect(r.output).toMatch(/plan mode/)
  })

  it("is a no-op when already in plan mode", async () => {
    cb.setActive(true)
    const r = await tool.handler({})
    expect(r.success).toBe(true)
    expect(cb.calls.enter).toBe(0)
    expect(r.output).toMatch(/Already in plan mode/)
  })
})

describe("exit_plan_mode", () => {
  let cb: ReturnType<typeof makeCallbacks>
  let tool: ReturnType<typeof exitPlanModeTool>

  beforeEach(() => {
    cb = makeCallbacks(true)
    tool = exitPlanModeTool({ callbacks: cb })
  })

  it("fails when not in plan mode", async () => {
    cb.setActive(false)
    const r = await tool.handler({ plan: "do X" })
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/Not in plan mode/)
    expect(cb.calls.exits).toHaveLength(0)
  })

  it("returns success when user approves", async () => {
    cb.setApproval({ approved: true })
    const r = await tool.handler({ plan: "1. read files\n2. edit x\n3. run tests" })
    expect(r.success).toBe(true)
    expect(r.output).toMatch(/approved/i)
    expect(cb.calls.exits[0].plan).toContain("read files")
  })

  it("returns actionable failure when user rejects with a reason", async () => {
    cb.setApproval({ approved: false, reason: "too broad, split into two PRs" })
    const r = await tool.handler({ plan: "refactor everything" })
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/rejected/i)
    expect(r.error).toContain("split into two PRs")
  })

  it("handles rejection without a reason", async () => {
    cb.setApproval({ approved: false })
    const r = await tool.handler({ plan: "..." })
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/rejected/i)
  })

  it("surfaces external force-cancel via resolver({approved:false, reason}) to the model", async () => {
    // Models the "user hit Ctrl+C mid-approval" path: the tool awaits
    // requestExit; the app layer resolves with approved:false + a reason
    // (see closePendingPlanApproval in App.tsx). The tool must surface
    // the reason in the error so the model knows what happened, not a
    // generic "rejected".
    let captured: ((d: { approved: boolean; reason?: string }) => void) | null = null
    const cb: PlanModeCallbacks = {
      isActive: () => true,
      enter: () => {},
      requestExit: () => new Promise((resolve) => { captured = resolve }),
    }
    const tool = exitPlanModeTool({ callbacks: cb })
    const handlerP = tool.handler({ plan: "draft plan body" })
    // Spin microtasks so the Promise executor runs and captured is set.
    await Promise.resolve()
    captured!({ approved: false, reason: "cancelled before decision" })
    const r = await handlerP
    expect(r.success).toBe(false)
    expect(r.error).toContain("cancelled before decision")
  })
})

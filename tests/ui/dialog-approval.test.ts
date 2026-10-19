import { describe, expect, it } from "bun:test"
import { approvalChoiceForInput } from "../../src/ui/dialog-approval.js"
import { planIdleActionForInput } from "../../src/ui/dialog-plan-approval.js"

describe("approvalChoiceForInput", () => {
  it("uses the selected row for a bare return", () => {
    expect(approvalChoiceForInput("\r", {}, 0)).toBe("once")
    expect(approvalChoiceForInput("", { return: true }, 2)).toBe("forever")
  })

  it("honors coalesced numeric shortcuts before raw return", () => {
    expect(approvalChoiceForInput("2\r", {}, 0)).toBe("always")
    expect(approvalChoiceForInput("4\r", {}, 0)).toBe("deny")
  })

  it("limits dangerous or explicit-ask prompts to once and deny", () => {
    expect(approvalChoiceForInput("2\r", {}, 0, false)).toBe("deny")
    expect(approvalChoiceForInput("3", {}, 0, false)).toBeNull()
    expect(approvalChoiceForInput("4", {}, 0, false)).toBeNull()
    expect(approvalChoiceForInput("", { return: true }, 1, false)).toBe("deny")
    expect(approvalChoiceForInput("", { escape: true }, 0, false)).toBe("deny")
  })

  it("treats escape as deny", () => {
    expect(approvalChoiceForInput("", { escape: true }, 0)).toBe("deny")
  })
})

describe("planIdleActionForInput", () => {
  it("approves on bare return", () => {
    expect(planIdleActionForInput("\r", {})).toEqual({ kind: "approve" })
    expect(planIdleActionForInput("", { return: true })).toEqual({ kind: "approve" })
  })

  it("honors coalesced shortcuts before raw return", () => {
    expect(planIdleActionForInput("n\r", {})).toEqual({ kind: "reject" })
    expect(planIdleActionForInput("2\r", {})).toEqual({ kind: "reject" })
    expect(planIdleActionForInput("r\r", {})).toEqual({ kind: "start_reason" })
  })

  it("keeps normal one-key shortcuts", () => {
    expect(planIdleActionForInput("y", {})).toEqual({ kind: "approve" })
    expect(planIdleActionForInput("n", {})).toEqual({ kind: "reject" })
    expect(planIdleActionForInput("r", {})).toEqual({ kind: "start_reason" })
  })
})

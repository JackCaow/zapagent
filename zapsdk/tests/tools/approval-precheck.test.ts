import { describe, expect, it } from "bun:test"
import { z } from "zod"
import { emptyToolEffects } from "../../tools/effects.js"
import { ToolExecutor, type ApprovalCallback, type ApprovalResponse } from "../../tools/executor.js"
import { ToolRegistry } from "../../tools/registry.js"

function registry(): ToolRegistry {
  const tools = new ToolRegistry()
  for (const name of ["prompted", "settled", "refused"]) {
    tools.register({
      definition: { name, description: "fixture", permission: "confirm", parameters: z.object({}), resolveEffects: () => emptyToolEffects() },
      handler: async () => ({ success: true, output: name }),
    })
  }
  return tools
}

/** `prompted` waits for a human; the others are settled by policy. */
function approval(withPrecheck: boolean) {
  let answer!: (value: ApprovalResponse) => void
  const human = new Promise<ApprovalResponse>(resolve => { answer = resolve })
  const decide = (name: string): ApprovalResponse | undefined =>
    name === "settled" ? true : name === "refused" ? { approved: false, source: "policy", reason: "fixture deny" } : undefined
  const callback: ApprovalCallback = Object.assign(async (name: string) => decide(name) ?? human,
    withPrecheck ? { precheck: (name: string) => decide(name) } : {})
  return { callback, answer }
}

describe("approval precheck", () => {
  it("lets settled calls pass while a prompt is open", async () => {
    const { callback, answer } = approval(true)
    const executor = new ToolExecutor(registry(), { onApproval: callback })
    const prompted = executor.execute("prompted", {})
    const settled = await executor.execute("settled", {})
    expect(settled).toMatchObject({ success: true, output: "settled" })
    const refused = await executor.execute("refused", {})
    expect(refused).toMatchObject({ success: false, error: 'Tool "refused" denied: fixture deny', failure: { code: "POLICY_DENIED" } })
    answer(true)
    expect(await prompted).toMatchObject({ success: true, output: "prompted" })
  })

  it("never prechecks a cancelled call", async () => {
    let prechecked = 0
    const callback: ApprovalCallback = Object.assign(async () => true as ApprovalResponse, { precheck: () => { prechecked++; return true as ApprovalResponse } })
    const controller = new AbortController()
    // Cancelled while the request is being announced, just before the precheck.
    const executor = new ToolExecutor(registry(), { onApproval: callback,
      onApprovalLifecycle: event => { if (event.status === "requested") controller.abort() } })
    const result = await executor.execute("settled", {}, controller.signal)
    expect(result.success).toBe(false)
    expect(prechecked).toBe(0)
  })

  it("keeps the queued order for callbacks without a precheck", async () => {
    const { callback, answer } = approval(false)
    const executor = new ToolExecutor(registry(), { onApproval: callback })
    const prompted = executor.execute("prompted", {})
    let settledDone = false
    const settled = executor.execute("settled", {}).then(result => { settledDone = true; return result })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(settledDone).toBe(false)
    answer(true)
    await prompted
    expect(await settled).toMatchObject({ success: true })
  })
})

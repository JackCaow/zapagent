import type { AgentEvent } from "../zapsdk/agent/events.js"
import type { GoalRecord } from "../zapsdk/goal/contracts.js"

const dsmlPrefixes = ["｜｜DSML｜｜", "|DSML|", "||DSML||"].flatMap(marker => [`<${marker}`, `</${marker}`])

/** Presentation only: keep incomplete protocol tags out of streamed output,
 * without buffering whole replies or stripping ordinary HTML/JSON/code. */
function dsmlStream() {
  let pending = "", insideTag = false
  return {
    push(chunk: string): string {
      const input = pending + chunk
      pending = ""
      let output = "", offset = 0
      while (offset < input.length) {
        if (insideTag) {
          const end = input.indexOf(">", offset)
          if (end < 0) return output
          insideTag = false; offset = end + 1
          continue
        }
        const start = input.indexOf("<", offset)
        if (start < 0) return output + input.slice(offset)
        output += input.slice(offset, start)
        const tail = input.slice(start)
        if (dsmlPrefixes.some(prefix => tail.startsWith(prefix))) {
          insideTag = true; offset = start
        } else if (dsmlPrefixes.some(prefix => prefix.startsWith(tail))) {
          pending = tail
          return output
        } else {
          output += "<"; offset = start + 1
        }
      }
      return output
    },
    finish(): string {
      const tail = /^<\/?[｜|]/.test(pending) ? "" : pending
      pending = ""; insideTag = false
      return tail
    },
  }
}

export function stripGoalProtocolTags(text: string): string {
  const stream = dsmlStream()
  return stream.push(text) + stream.finish()
}

/** Raw events still feed persistence and acceptance. Only their UI projection
 * suppresses planner/verifier protocol prose; tool and lifecycle events remain. */
export function createGoalContentFilter(structured = false) {
  const streams = new Map<string, ReturnType<typeof dsmlStream>>()
  return (event: AgentEvent): AgentEvent | undefined => {
    if ((event.type !== "content_delta" && event.type !== "content_final") || (event.kind !== "text" && event.kind !== "thinking")) return event
    if (structured) return undefined
    const key = JSON.stringify([event.path ?? [], event.kind, event.id])
    if (event.type === "content_final") {
      streams.delete(key)
      return { ...event, text: stripGoalProtocolTags(event.text) }
    }
    let stream = streams.get(key)
    if (!stream) { stream = dsmlStream(); streams.set(key, stream) }
    const text = stream.push(event.text)
    return text ? { ...event, text } : undefined
  }
}

export function goalAcceptanceSummary(goal: GoalRecord): string | undefined {
  const receipt = goal.finalReceipt ?? goal.tasks.find(task => task.receipt && task.receipt.status !== "passed")?.receipt
  if (!receipt) return undefined
  if (receipt.status === "passed") {
    if (goal.status === "ready_for_delivery") return "Goal 验收通过，等待交付授权。"
    return goal.status === "completed" ? "Goal 验收通过。" : "Goal 尚未完成最终验收和交付。"
  }
  if (receipt.status === "failed") return "Goal 验收未通过。"
  if (receipt.status === "error") return "Goal 验收未完成：检查执行失败。"
  return "Goal 验收尚未确认，需要补充信息或授权。"
}

export function goalDeliveryMarkdown(delivery: unknown): string | undefined {
  if (!delivery || typeof delivery !== "object") return undefined
  const value = delivery as { text?: unknown; path?: unknown }
  if (typeof value.text === "string") {
    const text = stripGoalProtocolTags(value.text)
    return text.trim() ? text : undefined
  }
  if (typeof value.path === "string") return `Goal 产物目录：${value.path}`
  return undefined
}

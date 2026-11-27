import type { ProviderRequestEvent } from "../../zapsdk/core/llm.js"

export interface OutputThroughputSample {
  tokensPerSecond: number
  estimated: boolean
  /** Output tokens over the full prompt turn, including tools and first-token latency. */
  turnAverage?: boolean
}

/** Latest root request's decode throughput, excluding TTFT and tool time.
 * Streaming telemetry has character counts, not tokenizer counts. Only a
 * matching completed request with provider usage can remove the ~ marker. */
export class OutputThroughput {
  private request?: { step: number; event: ProviderRequestEvent }
  private sample?: OutputThroughputSample
  private completed = new Set<string>()

  reset(): void { this.request = undefined; this.sample = undefined; this.completed.clear() }

  observe(step: number, event: ProviderRequestEvent, requestId?: string): OutputThroughputSample | undefined {
    if (this.request && this.request.step !== step) this.reset()
    if (event.phase === "completed") this.completed.add(`${requestId ?? ""}:${event.startedAt}:${event.attempt}`)
    this.request = { step, event }
    this.sample = undefined
    if (event.phase !== "streaming" && event.phase !== "completed") return
    const output = event.output
    if (!output) return
    const chars = output.thinkingChars + output.textChars + output.toolArgumentChars
    this.sample = this.calculate(chars / 4, true)
    return this.sample
  }

  usage(step: number, tokens: number, reported?: boolean): OutputThroughputSample | undefined {
    // Run-wide usageIncomplete may describe an earlier failed attempt; this
    // sample uses only the successful request's provider-reported output.
    if (this.request?.step === step && this.request.event.phase === "completed" && reported !== false && this.completed.size === 1) {
      this.sample = this.calculate(tokens, false)
    }
    return this.sample
  }

  private calculate(tokens: number, estimated: boolean): OutputThroughputSample | undefined {
    const event = this.request?.event
    if (!event?.output || !Number.isFinite(tokens) || tokens <= 0) return
    const first = [event.output.firstThinkingMs, event.output.firstTextMs, event.output.firstToolCallMs]
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0)
    if (!first.length) return
    const duration = event.elapsedMs - Math.min(...first)
    // A single buffered chunk has no useful generation window.
    if (!Number.isFinite(duration) || duration < 250) return
    const tokensPerSecond = tokens * 1000 / duration
    if (!Number.isFinite(tokensPerSecond)) return
    return { tokensPerSecond, estimated }
  }
}

/** ACP exposes message chunks and turn totals, but no per-request decode clock. */
export class AgentOutputThroughput {
  private segment?: { id: string; firstAt: number; charsAfterFirst: number }
  private latest?: OutputThroughputSample

  chunk(id: string, text: string, now: number): OutputThroughputSample | undefined {
    if (!text) return
    if (this.segment?.id !== id) {
      this.segment = { id, firstAt: now, charsAfterFirst: 0 }
      return
    }
    this.segment.charsAfterFirst += text.length
    const elapsed = now - this.segment.firstAt
    if (elapsed < 250) return
    this.latest = { tokensPerSecond: this.segment.charsAfterFirst * 250 / elapsed, estimated: true }
    return this.latest
  }

  finish(outputTokens: number | undefined, elapsedMs: number): OutputThroughputSample | undefined {
    if (this.latest) return this.latest
    if (!outputTokens || outputTokens <= 0 || !Number.isFinite(outputTokens) || elapsedMs <= 0) return
    return { tokensPerSecond: outputTokens * 1000 / elapsedMs, estimated: false, turnAverage: true }
  }
}

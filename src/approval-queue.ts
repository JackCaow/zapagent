import { randomUUID } from "node:crypto"
import type { ApprovalResponse } from "../zapsdk/tools/executor.js"

type Work = (signal: AbortSignal, id: string) => Promise<ApprovalResponse>
interface Entry {
  sessionId: string
  controller: AbortController
  start: () => void
  cancel: () => void
}

/** All host approval callers share this queue, including non-executor MCP sampling. */
export class ApprovalQueue {
  private entries: Entry[] = []
  private active?: Entry
  private draining = false
  constructor(private readonly getSessionId: () => string) {}

  enqueue(work: Work, signal?: AbortSignal): Promise<ApprovalResponse> {
    const sessionId = this.getSessionId()
    return new Promise((resolve, reject) => {
      let done = false
      const controller = new AbortController()
      const finish = (value: ApprovalResponse, error?: unknown) => {
        if (done) return
        done = true
        signal?.removeEventListener("abort", cancel)
        this.entries = this.entries.filter(value => value !== entry)
        if (this.active === entry) this.active = undefined
        if (error) reject(error)
        else resolve(value)
        this.pump()
      }
      const cancel = () => { controller.abort(); finish(false) }
      const entry: Entry = { sessionId, controller, cancel, start: () => {
        if (signal?.aborted || sessionId !== this.getSessionId()) { cancel(); return }
        try { work(controller.signal, randomUUID()).then(value => finish(value), error => finish(false, error)) }
        catch (error) { finish(false, error) }
      } }
      this.entries.push(entry)
      signal?.addEventListener("abort", cancel, { once: true })
      if (signal?.aborted) cancel()
      else this.pump()
    })
  }

  cancelStale(): void {
    for (const entry of [...this.entries]) if (entry.sessionId !== this.getSessionId()) entry.cancel()
  }
  cancelAll(): void {
    this.draining = true
    try { for (const entry of [...this.entries]) entry.cancel() }
    finally { this.draining = false }
  }
  private pump(): void {
    if (this.active || this.draining) return
    const next = this.entries[0]
    if (!next) return
    this.active = next
    next.start()
  }
}

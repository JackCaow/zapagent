import { OutcomeProtocolError } from "./outcome.js";

export type SealingStage = "background_settle" | "state_flush" | "state_load"
  | "outcome_save" | "event_flush" | "terminal_append" | "publication_ack" | "ownership_release";

export interface SealingProgress {
  threadId: string;
  turnId: string;
  attemptId: string;
  stage: SealingStage;
  status: "started" | "completed" | "failed" | "timeout";
  at: number;
  elapsedMs: number;
  totalElapsedMs: number;
}

/** Bounds the caller's wait, never abandons an in-flight write or its lease. */
export class RuntimeSealing {
  readonly expired: Promise<never>;
  private reject!: (error: Error) => void;
  private timer?: ReturnType<typeof setTimeout>;
  private startedAt?: number;
  private stageStartedAt = 0;
  private stage: SealingStage = "background_settle";
  private timedOut = false;
  private identity?: Pick<SealingProgress, "threadId" | "turnId" | "attemptId">;

  constructor(private readonly timeoutMs: number, private readonly observe?: (progress: SealingProgress) => void) {
    this.expired = new Promise<never>((_, reject) => { this.reject = reject; });
  }

  start(identity: NonNullable<RuntimeSealing["identity"]>): void {
    if (this.startedAt !== undefined) return;
    this.identity = identity;
    this.startedAt = performance.now();
    this.stageStartedAt = this.startedAt;
    this.timer = setTimeout(() => this.expire(), this.timeoutMs);
  }

  async measure<T>(stage: SealingStage, operation: () => Promise<T>): Promise<T> {
    // Ownership release also runs on setup/legacy failures, outside sealing.
    if (this.startedAt === undefined) return operation();
    this.stage = stage;
    this.stageStartedAt = performance.now();
    this.emit("started");
    try {
      const value = await operation();
      // Synchronous storage can delay timer delivery. Never report an on-time
      // completion merely because the event loop could not run the timer.
      if (performance.now() - this.startedAt >= this.timeoutMs) this.expire();
      this.emit("completed");
      return value;
    } catch (error) {
      this.emit("failed");
      throw error;
    }
  }

  close(): void {
    if (this.startedAt !== undefined && performance.now() - this.startedAt >= this.timeoutMs) this.expire();
    clearTimeout(this.timer);
  }

  private expire(): void {
    if (this.timedOut) return;
    this.timedOut = true;
    this.emit("timeout");
    this.reject(new OutcomeProtocolError("OUTCOME_SEALING_TIMEOUT",
      `Outcome sealing exceeded ${this.timeoutMs}ms during ${this.stage}; persistence may still be pending. Recover this thread before retrying.`));
  }

  private emit(status: SealingProgress["status"]): void {
    if (!this.identity || this.startedAt === undefined) return;
    const now = performance.now();
    try {
      this.observe?.({ ...this.identity, stage: this.stage, status, at: Date.now(),
        elapsedMs: now - this.stageStartedAt, totalElapsedMs: now - this.startedAt });
    } catch { /* Diagnostics cannot change terminal persistence. */ }
  }
}

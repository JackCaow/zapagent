import { isDeepStrictEqual } from "node:util";
import { OutcomeProtocolError, validateOutcome, type AgentOutcomeV1 } from "./outcome.js";
import type { LegacyTerminalPayload, RuntimeEventV3 } from "./types.js";
import type { RuntimeStateStore } from "./state-store.js";
import { RuntimeStateRevisionConflictError } from "./state-store.js";
import type { RuntimeStateSnapshot } from "./state-types.js";
import type { RuntimeEventStore } from "./event-store.js";
import type { RuntimeSealing } from "./sealing.js";

export interface PersistedAttemptOutcome {
  outcome: AgentOutcomeV1;
  legacyTerminal: LegacyTerminalPayload;
  terminalEventId: string;
  terminalEventSequence: number;
  terminalEvent: RuntimeEventV3;
  publication: "pending" | "published";
}

export function validPersistedAttemptOutcome(value: unknown): value is PersistedAttemptOutcome {
  try {
    if (!value || typeof value !== "object") return false;
    const entry = value as PersistedAttemptOutcome;
    validateOutcome(entry.outcome);
    const terminal = entry.legacyTerminal;
    if (!terminal || !["turn_completed", "turn_incomplete", "turn_failed"].includes(terminal.type)
      || terminal.thread?.threadId !== entry.outcome.threadId
      || terminal.turn?.turnId !== entry.outcome.turnId
      || terminal.run?.runId !== entry.outcome.runId
      || terminal.item?.threadId !== entry.outcome.threadId
      || terminal.item?.turnId !== entry.outcome.turnId
      || terminal.item?.runId !== entry.outcome.runId) return false;
    if (terminal.type === "turn_failed") {
      if (terminal.item.type !== "error" || typeof terminal.item.error !== "string" || typeof terminal.interrupted !== "boolean") return false;
    } else if (terminal.item.type !== "message" || typeof terminal.item.text !== "string"
      || typeof terminal.result?.text !== "string" || typeof terminal.result.steps !== "number"
      || !["completed", "incomplete"].includes(terminal.result.completion?.status)) return false;
    const event = entry.terminalEvent;
    return (entry.publication === "pending" || entry.publication === "published")
      && typeof entry.terminalEventId === "string" && Number.isSafeInteger(entry.terminalEventSequence)
      && entry.terminalEventSequence > 0 && event?.schemaVersion === 3
      && event.eventId === entry.terminalEventId && event.sequence === entry.terminalEventSequence
      && event.threadId === entry.outcome.threadId && event.turnId === entry.outcome.turnId
      && event.runId === entry.outcome.runId && event.payload.type === "attempt_ended"
      && isDeepStrictEqual(event.payload.outcome, entry.outcome)
      && isDeepStrictEqual(event.payload.legacyTerminal, terminal);
  } catch { return false; }
}

async function updateAttempt(store: RuntimeStateStore, threadId: string, change: (state: RuntimeStateSnapshot) => void): Promise<void> {
  for (let retry = 0; retry < 8; retry++) {
    const current = await store.load(threadId);
    if (!current) throw new Error(`Missing runtime state for ${threadId}`);
    try {
      await store.update(threadId, (state) => {
        if (!state) throw new Error(`Missing runtime state for ${threadId}`);
        change(state);
        return state;
      }, { expectedRevision: current.revision });
      return;
    } catch (error) {
      if (!(error instanceof RuntimeStateRevisionConflictError) || retry === 7) throw error;
    }
  }
}

export async function saveAttempt(store: RuntimeStateStore, entry: PersistedAttemptOutcome): Promise<void> {
  if (!validPersistedAttemptOutcome(entry)) throw new Error("Invalid attempt terminal record");
  await updateAttempt(store, entry.outcome.threadId, (state) => {
    const existing = state.attemptOutcomes[entry.outcome.attemptId];
    if (existing) {
      if (!isDeepStrictEqual(existing.outcome, entry.outcome) || existing.terminalEventId !== entry.terminalEventId) throw new Error("Attempt already has an immutable terminal outcome");
      return;
    }
    state.attemptOutcomes[entry.outcome.attemptId] = structuredClone(entry);
    const terminal = entry.legacyTerminal;
    state.thread = { ...terminal.thread };
    state.turns[terminal.turn.turnId] = { ...terminal.turn };
    const { task, ...run } = terminal.run;
    state.runs[run.runId] = { ...run, taskPreview: task.slice(0, 1000) };
    state.updatedAt = entry.outcome.endedAt;
  });
}

export async function publishAttempt(store: RuntimeStateStore, eventStore: RuntimeEventStore, entry: PersistedAttemptOutcome, sealing?: RuntimeSealing): Promise<void> {
  try {
    const append = () => eventStore.append(entry.terminalEvent);
    await (sealing ? sealing.measure("terminal_append", append) : append());
    const acknowledge = () => updateAttempt(store, entry.outcome.threadId, (state) => {
      const saved = state.attemptOutcomes[entry.outcome.attemptId];
      if (!saved || saved.terminalEventId !== entry.terminalEventId) throw new Error("Terminal outbox identity conflict");
      saved.publication = "published";
    });
    await (sealing ? sealing.measure("publication_ack", acknowledge) : acknowledge());
  } catch (error) {
    throw new OutcomeProtocolError("TERMINAL_PUBLICATION_FAILED", `Terminal outcome saved; publication failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

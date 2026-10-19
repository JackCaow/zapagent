/**
 * Runtime-event inbox. Append-only buffer for asynchronous events the
 * model needs to observe — today: background-task completion; tomorrow:
 * cron firings, monitor events, delegate-agent completions, etc.
 *
 * Deliberately separate from the user input queue (`inputQueue.ts`):
 *   - System events MUST NOT appear in the UI queue preview where the
 *     user could see them as "their" pending message.
 *   - System events MUST NOT be poppable to the input box via Esc, where
 *     the user could edit or accidentally discard them.
 *   - Entries carry runtime delivery metadata — no
 *     `displayForm`, `images`, or anything that would let a consumer
 *     accidentally render a system event as a user bubble.
 *
 * The dispatcher (`useTurnDispatcher`) drains BOTH this inbox and the
 * user input queue at every turn boundary; system events are delivered
 * after pending human steering, filtering observations already delivered.
 */

/** Currently only one kind. Open union so new producers (cron, monitor,
 *  delegate-done, …) can add their own without changing the dispatcher. */
export type SystemEventKind = "task-notification"

export type SystemEvent = {
  kind: SystemEventKind
  /** Text payload delivered to the model (e.g. the `<task-notification>` XML). */
  payload: string
  /** Producer timestamp (ms since epoch). FIFO order is by push order, not ts. */
  ts: number
  /** Host-owned delivery metadata; never supplied by model text. */
  id?: string
  sessionId?: string
  taskId?: string
  isObsolete?: () => boolean
  onDelivered?: () => void
  /** A failed unaccepted delivery waits for human steering before retry. */
  held?: boolean
}

const inbox: SystemEvent[] = []
const subscribers = new Set<() => void>()

function notify(): void {
  for (const fn of subscribers) fn()
}

export function pushSystemEvent(event: SystemEvent): void {
  if (event.isObsolete?.() || (event.id && inbox.some(item => item.id === event.id))) return
  inbox.push(event)
  notify()
}

/** Atomically claim eligible events in FIFO order. Held events remain queued;
 * obsolete observations are removed without launching another model turn. */
export function drainSystemInbox(options?: { sessionId?: string; eligible?: (event: SystemEvent) => boolean }): SystemEvent[] {
  if (inbox.length === 0) return []
  const out: SystemEvent[] = []
  const retained: SystemEvent[] = []
  for (const event of inbox) {
    if (event.isObsolete?.()) continue
    if (event.held || (options?.sessionId && event.sessionId && event.sessionId !== options.sessionId) || options?.eligible?.(event) === false) {
      retained.push(event)
    } else out.push(event)
  }
  const changed = retained.length !== inbox.length
  inbox.splice(0, inbox.length, ...retained)
  if (changed) notify()
  return out
}

/** Return unaccepted events after a dispatch failure without losing ordering. */
export function restoreSystemEvents(events: SystemEvent[], hold = false): void {
  const pending = events.filter(event => !event.isObsolete?.() && (!event.id || !inbox.some(item => item.id === event.id)))
  if (!pending.length) return
  inbox.unshift(...pending.map(event => hold ? { ...event, held: true } : event))
  notify()
}

export function retrySystemEvents(sessionId?: string): void {
  let changed = false
  for (const event of inbox) {
    if (event.held && (!sessionId || !event.sessionId || event.sessionId === sessionId)) {
      event.held = false
      changed = true
    }
  }
  if (changed) notify()
}

export function clearSystemInbox(): void {
  if (inbox.length === 0) return
  inbox.length = 0
  notify()
}

export function getSystemInboxLength(): number {
  return inbox.length
}

export function subscribeToSystemInbox(cb: () => void): () => void {
  subscribers.add(cb)
  return () => { subscribers.delete(cb) }
}

/** Reset to a fresh state. Tests only — do not call from app code. */
export function _resetForTest(): void {
  inbox.length = 0
  subscribers.clear()
}

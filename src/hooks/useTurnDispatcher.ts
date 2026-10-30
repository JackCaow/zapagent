import { isGoalSessionControl } from "../goal-session.js"
import { pauseGoalsForUserInput } from "../goal-command.js"
import { useCallback, useEffect, useRef } from "react"
import {
  enqueue as enqueueCommand,
  getQueueLength,
  getQueueSnapshot,
  getMessageQueue,
  type QueuedCommand,
} from "../queue/inputQueue.js"
import type { FollowUpMode } from "../queue/messageQueue.js"
import { deliverNextMessage } from "../queue/delivery.js"
import {
  drainSystemInbox,
  restoreSystemEvents,
  retrySystemEvents,
  getSystemInboxLength,
} from "../queue/systemInbox.js"
import type { Todo } from "../../zapsdk/builtin-tools/todo.js"
import { canResumeForTaskEvent } from "../queue/task-resumption.js"
import { pushHistory } from "../ui/prompt.js"
import type { PendingImage } from "../queue/inputQueue.js"
import type { ImageContent } from "../../zapsdk/core/types.js"
import type { LogType, ToolCallInfo, UserImageRef, LogEntry } from "../ui/types.js"
import type { SlashEntry } from "../ui/slash-palette.js"
import { parseCommand } from "../commands.js"
import type { SlashCommandDispatchMeta } from "../commands/dispatcher.js"
import {
  isSupportedImage,
  loadImageFromFile,
} from "../../zapsdk/utils/image.js"
import {
  resolveAtPathReferences,
  resolveMCPReferences,
  parseMCPPromptInvocation,
  buildSubmittedTextParts,
  buildModelText,
  stripImagePlaceholders,
  stripDropPathQuoting,
  looksLikeDroppedFilePath,
} from "../commands/submit.js"
import { getMCPManager } from "../singletons.js"
import { countCodePoints, sliceHeadCodePoints } from "../utils/logicalLines.js"
import { hasPendingManualCompact, isManualCompactCommand } from "../queue/pending-compact.js"

const PASTED_PLACEHOLDER_RE = /\[Pasted #([1-9]\d*) · \d+ lines · \d+ chars\]/g
const UNAVAILABLE_PASTED_HISTORY_RE = /\[Pasted #(\d+) unavailable in history; paste again to resend full text\]/g
const IMAGE_PLACEHOLDER_RE = /\[Image #([1-9]\d*)\]/g
const UNKNOWN_COMMAND_PREVIEW_CHARS = 160
const DROPPED_COMMAND_PREVIEW_CHARS = 80

type AddLog = (
  type: LogType,
  text: string,
  tool?: ToolCallInfo,
  images?: UserImageRef[],
  agentPath?: string[],
  extra?: Partial<LogEntry>,
) => void

export interface ToastOptions {
  variant?: "success" | "warning" | "error"
  duration?: number
}

export { isManualCompactCommand }

export interface UseTurnDispatcherOptions {
  isRunning: boolean
  /** A recovery dialog owns conversation/file state while open. */
  paused?: boolean
  /** Live snapshot of the user input queue from useSyncExternalStore in App.
   *  Drives the drain effect — when length flips non-zero while idle, we
   *  dispatch. */
  inputQueue: ReadonlyArray<QueuedCommand>
  /** Live count of the system event inbox. Drain effect also triggers when
   *  this flips non-zero — e.g. a background task completes while the agent
   *  is idle and no user input is pending. */
  systemInboxSize: number
  followUpMode?: FollowUpMode
  editingMessageId?: string | null
  onEditCommitted?: () => void
  openQueue?: () => void
  getInputValue?: () => string
  queueError?: string
  getTodos?: () => Todo[]
  getSessionId?: () => string
  addLog: AddLog
  addToast: (text: string, options?: ToastOptions) => void

  /** Pre-built in App.tsx so both this hook AND the slash-command dispatcher
   *  (which calls it for /review, /commit, /run_skill, /init_project) can
   *  share a single instance. Wraps log + runAgent. */
  dispatchUserTurn: (
    text: string,
    systemPrompt?: string,
    images?: ImageContent[],
    displayText?: string,
    silent?: boolean,
    restoreText?: string,
    memoryQueryText?: string,
    onAccepted?: () => void,
  ) => Promise<unknown>

  /** Slash-command dispatcher pre-bound with its own deps by the App. Called
   *  inside `dispatchTurn` when a queued command starts with `/`. Returns
   *  true if the input was recognized as a command. */
  dispatchCommand: (
    input: string,
    meta?: SlashCommandDispatchMeta & { onAccepted?: () => void },
  ) => boolean | Promise<boolean>

  /** Unavailable providers leave the message in a failed, editable state. */
  precheckProvider: () => boolean

  /** Slash palette state — used by handleSubmit to expand the highlighted
   *  entry's name when the user hits Enter on a typed `/foo` prefix. */
  slashOpen: boolean
  slashEntries: SlashEntry[]
  slashIdx: number

  /** Owned by usePasteHandler — shared so handleSubmit can build the history
   *  snapshot and reset on consume. */
  expandPastes: (input: string) => string
  pasteStoreRef: React.MutableRefObject<Map<number, string>>
  pasteCounterRef: React.MutableRefObject<number>
  imageCounterRef: React.MutableRefObject<number>
  attachImageWithPlaceholder: (img: ImageContent) => void

  /** Live input state — submit reads, clears, writes (for drag-drop image
   *  path replacement). */
  setInputValue: (next: string | ((prev: string) => string)) => void

  /** Pending image attachments for the next turn. Submit reads + clears. */
  pendingImages: PendingImage[]
  setPendingImages: (
    next: PendingImage[] | ((prev: PendingImage[]) => PendingImage[]),
  ) => void
}

export interface UseTurnDispatcherResult {
  handleSubmit: (rawValue: string) => Promise<void>
}

export function mergeQueuedCommandText(batch: ReadonlyArray<QueuedCommand>): string {
  return batch.map((c) => c.text).join("\n\n")
}

export function mergeQueuedCommandDisplayText(batch: ReadonlyArray<QueuedCommand>): string {
  return batch.map((c) => c.displayForm).join("\n\n")
}

export function mergeQueuedCommandRestoreText(batch: ReadonlyArray<QueuedCommand>): string | undefined {
  let hasRestoreText = false
  const merged = batch.map((c) => {
    if (c.restoreText === undefined) return c.displayForm
    hasRestoreText = true
    return c.restoreText
  }).join("\n\n")
  if (!hasRestoreText) return undefined
  const display = mergeQueuedCommandDisplayText(batch)
  return merged === display ? undefined : merged
}

export function mergeQueuedCommandMemoryQueryText(batch: ReadonlyArray<QueuedCommand>): string {
  return mergeQueuedCommandDisplayText(batch)
}

export function compactQueuedCommandPreview(
  cmd: Pick<QueuedCommand, "text" | "displayForm">,
  maxChars = UNKNOWN_COMMAND_PREVIEW_CHARS,
): string {
  const compact = (cmd.displayForm || cmd.text).replace(/\s+/g, " ").trim()
  if (countCodePoints(compact) <= maxChars) return compact
  return `${sliceHeadCodePoints(compact, Math.max(0, maxChars - 3))}...`
}

export function unknownCommandPreview(cmd: Pick<QueuedCommand, "text" | "displayForm">): string {
  return compactQueuedCommandPreview(cmd)
}

export function buildDispatchText(rawText: string, hasImages: boolean): string {
  if (rawText.trim().length > 0) return rawText
  return hasImages ? "(image attached)" : rawText
}

export function buildSubmitInputText(
  value: string,
  modelInput: string,
  commandLike: boolean,
  expandPastes: (input: string) => string,
): string {
  return commandLike ? expandPastes(value) : modelInput
}

export function parseMCPPromptSubmitInvocation(
  value: string,
  modelInput: string,
  expandPastes: (input: string) => string,
) {
  const displayInvocation = parseMCPPromptInvocation(value)
  if (displayInvocation) {
    return {
      ...displayInvocation,
      args: Object.fromEntries(
        Object.entries(displayInvocation.args).map(([key, argValue]) => [key, expandPastes(argValue)]),
      ),
    }
  }
  return parseMCPPromptInvocation(buildSubmitInputText(value, modelInput, true, expandPastes))
}

export function buildMCPPromptQueuedCommand(
  renderedText: string,
  displayForm: string,
  expandedInvocation: string,
  options: {
    pastedContents?: Record<string, string>
    images?: PendingImage[]
  } = {},
): QueuedCommand {
  const restoreText = buildMCPPromptRestoreText(
    displayForm,
    expandedInvocation,
    options.pastedContents,
  )
  return {
    text: renderedText,
    displayForm,
    ...(restoreText !== undefined ? { restoreText } : {}),
    ...(options.pastedContents && Object.keys(options.pastedContents).length > 0
      ? { pastedContents: options.pastedContents }
      : {}),
    ...(options.images && options.images.length > 0
      ? { images: options.images }
      : {}),
  }
}

function buildMCPPromptRestoreText(
  displayForm: string,
  expandedInvocation: string,
  pastedContents: Record<string, string> | undefined,
): string | undefined {
  if (expandedInvocation === displayForm || expandedInvocation.trim().length === 0) return undefined

  const displayInvocation = parseMCPPromptInvocation(displayForm)
  if (displayInvocation && pastedContents && Object.keys(pastedContents).length > 0) {
    return renderMCPPromptInvocation({
      ...displayInvocation,
      args: Object.fromEntries(
        Object.entries(displayInvocation.args).map(([key, value]) => [
          key,
          expandPastedContentsFromSnapshot(value, pastedContents),
        ]),
      ),
    })
  }

  const parsedExpanded = parseMCPPromptInvocation(expandedInvocation)
  return parsedExpanded ? renderMCPPromptInvocation(parsedExpanded) : expandedInvocation
}

function expandPastedContentsFromSnapshot(
  value: string,
  pastedContents: Record<string, string>,
): string {
  return value.replace(PASTED_PLACEHOLDER_RE, (placeholder, id) =>
    pastedContents[id] ?? placeholder)
}

function renderMCPPromptInvocation(invocation: {
  server: string
  name: string
  args: Record<string, string>
}): string {
  const args = Object.entries(invocation.args)
    .map(([key, value]) => `${key}=${quoteMCPPromptArgValue(value)}`)
  return [`/mcp.${invocation.server}.${invocation.name}`, ...args].join(" ")
}

function quoteMCPPromptArgValue(value: string): string {
  if (/^[^\s"'\\]+$/.test(value)) return value
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
}

export function buildPromptHistorySnapshot(
  pasteStoreRef: React.MutableRefObject<Map<number, string>>,
  pendingImages: PendingImage[],
  submittedValue?: string,
): {
  pastedContentsSnapshot: Record<string, string>
  imageRefs: Record<string, string>
} {
  const referencedPasteIds = submittedValue === undefined
    ? undefined
    : new Set([...submittedValue.matchAll(PASTED_PLACEHOLDER_RE)].map((match) => match[1]))
  const pastedContentsSnapshot: Record<string, string> = {}
  for (const [id, content] of pasteStoreRef.current) {
    if (referencedPasteIds && !referencedPasteIds.has(String(id))) continue
    pastedContentsSnapshot[String(id)] = content
  }
  const imageRefs: Record<string, string> = {}
  for (const p of filterPendingImagesForSubmit(pendingImages, submittedValue)) {
    if (p.content.filePath) imageRefs[String(p.id)] = p.content.filePath
  }
  return { pastedContentsSnapshot, imageRefs }
}

export function filterPendingImagesForSubmit(
  pendingImages: PendingImage[],
  submittedValue?: string,
): PendingImage[] {
  if (submittedValue === undefined) return pendingImages
  const referencedImageIds = new Set(
    [...submittedValue.matchAll(IMAGE_PLACEHOLDER_RE)].map((match) => Number(match[1])),
  )
  if (referencedImageIds.size === 0) return []
  return pendingImages.filter((image) => referencedImageIds.has(image.id))
}

export function missingPastedPlaceholderIds(
  submittedValue: string,
  pasteStore: ReadonlyMap<number, string>,
): number[] {
  const missing: number[] = []
  const seen = new Set<number>()
  for (const match of submittedValue.matchAll(PASTED_PLACEHOLDER_RE)) {
    const id = Number(match[1])
    if (!Number.isSafeInteger(id) || seen.has(id)) continue
    seen.add(id)
    if (!pasteStore.has(id)) missing.push(id)
  }
  return missing
}

export function unavailablePastedHistoryLabels(submittedValue: string): string[] {
  const labels: string[] = []
  const seen = new Set<string>()
  for (const match of submittedValue.matchAll(UNAVAILABLE_PASTED_HISTORY_RE)) {
    const id = match[1]
    if (!id || seen.has(id)) continue
    seen.add(id)
    labels.push(`#${id}`)
  }
  return labels
}

export function blockedPastedInputLabels(
  submittedValue: string,
  pasteStore: ReadonlyMap<number, string>,
): string[] {
  const labels: string[] = []
  const seen = new Set<string>()
  const add = (label: string) => {
    if (seen.has(label)) return
    seen.add(label)
    labels.push(label)
  }
  for (const id of missingPastedPlaceholderIds(submittedValue, pasteStore)) {
    add(`#${id}`)
  }
  for (const label of unavailablePastedHistoryLabels(submittedValue)) {
    add(label)
  }
  return labels
}

export function resolveSlashSubmitValue(
  value: string,
  selectedName: string | undefined,
): string {
  if (!selectedName) return value
  if (value === selectedName || value.startsWith(selectedName + " ")) return value
  const spaceIdx = value.indexOf(" ")
  const args = spaceIdx === -1 ? "" : value.slice(spaceIdx)
  return selectedName + args
}

export function clearConsumedInputArtifacts(
  pasteStoreRef: React.MutableRefObject<Map<number, string>>,
  pasteCounterRef: React.MutableRefObject<number>,
  setPendingImages: (
    next: PendingImage[] | ((prev: PendingImage[]) => PendingImage[]),
  ) => void,
): void {
  pasteStoreRef.current.clear()
  pasteCounterRef.current = 0
  setPendingImages([])
}

/**
 * Owns the unified turn pipeline: handleSubmit → enqueue → dispatchTurn →
 * runAgent, plus the queue drain effect that fires the dispatcher when the
 * agent goes idle.
 *
 * Each queue entry owns one turn and its attachments. Claims are removed only
 * on canonical-input receipts. A failed head blocks automatic continuation;
 * the user can explicitly edit/delete/reorder/retry it through /queue.
 */
export function useTurnDispatcher(
  opts: UseTurnDispatcherOptions,
): UseTurnDispatcherResult {
  const {
    isRunning,
    inputQueue,
    systemInboxSize,
    addLog,
    addToast,
    dispatchUserTurn,
    dispatchCommand,
    precheckProvider,
    slashOpen,
    slashEntries,
    slashIdx,
    expandPastes,
    pasteStoreRef,
    pasteCounterRef,
    imageCounterRef,
    attachImageWithPlaceholder,
    setInputValue,
    pendingImages,
    setPendingImages,
  } = opts

  /** True while a `dispatchTurn` invocation is in flight. Prevents the drain
   *  effect from launching a second concurrent dispatch when isRunning
   *  briefly flips to false between batches inside a single dispatchTurn. */
  const isDispatchingRef = useRef(false)
  const submissionInFlightRef = useRef(false)
  /** Claimed synchronously when manual compaction enters the queue and held
   * through completion. Unlike React status state, this ref is visible to the
   * very next terminal input event, so repeated /compact submissions can be
   * rejected before they enter the queue or transcript. */
  const manualCompactInFlightRef = useRef(false)

  const pausedRef = useRef(opts.paused)
  pausedRef.current = opts.paused
  const getTodosRef = useRef(opts.getTodos)
  getTodosRef.current = opts.getTodos

  const dispatchTurn = useCallback(async () => {
    if (isDispatchingRef.current || opts.queueError || pausedRef.current) return
    isDispatchingRef.current = true
    try {
      while (true) {
        if (pausedRef.current) break
        let openedRewind = false
        if (opts.getSessionId && getMessageQueue().getSessionId() !== opts.getSessionId()) break
        // Human steering takes precedence. Never discard events when the provider is unavailable.
        const humanPending = getQueueSnapshot().some(entry => entry.state !== "accepted")
        const events = !humanPending && precheckProvider() ? drainSystemInbox({
          sessionId: opts.getSessionId?.(),
          eligible: event => canResumeForTaskEvent(getTodosRef.current?.() ?? [], event.taskId),
        }) : []
        let deliveredEvents = false
        if (events.length) {
          const text = events.map(event => event.payload).join("\n\n")
          let accepted = false
          try {
            const result = await dispatchUserTurn(text, undefined, undefined, text, true, undefined, text, () => {
              accepted = true
              deliveredEvents = true
              for (const event of events) event.onDelivered?.()
            })
            if (!result || (typeof result === "object" && "stopped" in result && result.stopped !== "end_turn")) break
          } finally {
            if (!accepted) restoreSystemEvents(events, true)
          }
        }
        const delivered = await deliverNextMessage(getMessageQueue(), {
          providerReady: precheckProvider,
          dispatch: (entry, accepted) => {
            const images = entry.images?.map(image => image.content)
            // Recovery reloads image bytes from disk; one that could not be
            // read must stop the message, not go out without its image.
            const unreadable = images?.filter(image => image.base64 === undefined).map(image => image.filePath)
            if (unreadable?.length) throw new Error(`Queued image is no longer readable: ${unreadable.join(", ")}`)
            return dispatchUserTurn(buildDispatchText(entry.text, !!images?.length), undefined,
              images, entry.displayForm, false, entry.restoreText, entry.displayForm, accepted)
          },
          command: async (entry, accepted) => {
            addLog("user", entry.displayForm, undefined, undefined, undefined, {
              restore: false, ...(entry.restoreText !== undefined ? { restoreText: entry.restoreText } : {}),
            })
            openedRewind = parseCommand(entry.text)?.type === "open_rewind"
            const compact = isManualCompactCommand(entry.text)
            let inputRequired = false, result: unknown
            if (compact) manualCompactInFlightRef.current = true
            try {
              if (!await dispatchCommand(entry.text, { displayText: entry.displayForm, restoreText: entry.restoreText, onAccepted: accepted,
                onInputRequired: () => { inputRequired = true }, onRunResult: value => { result = value } })) {
                addLog("system", `Unknown command: ${unknownCommandPreview(entry)}`)
              }
              return { inputRequired, result }
            } finally { if (compact) manualCompactInFlightRef.current = false }
          },
          onError: error => addLog("error", `Queue: ${error}`),
        })
        if (delivered) retrySystemEvents(opts.getSessionId?.())
        if (openedRewind || (!delivered && !deliveredEvents)) break
      }
    } catch (error) {
      addLog("error", `Queue dispatch failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally { isDispatchingRef.current = false }
  }, [addLog, dispatchCommand, dispatchUserTurn, precheckProvider, opts.queueError, opts.getSessionId])

  const compactPending = () => manualCompactInFlightRef.current
    || hasPendingManualCompact(getQueueSnapshot(), opts.editingMessageId)

  const submitCommand = (command: QueuedCommand, editVersion?: string): boolean => {
    const interrupted = pauseGoalsForUserInput(process.cwd(), getMessageQueue().getSessionId(), command.text)
    if (interrupted.length) addToast("Goal will pause at the next safe boundary · /goal resume to continue", { duration: 3500 })
    if (opts.editingMessageId) {
      if (!getMessageQueue().replace(opts.editingMessageId, command, editVersion)) {
        addLog("error", "Queued message changed while editing; draft was kept.")
        return false
      }
      opts.onEditCommitted?.()
    } else {
      // A failed message at the head stops delivery. Say so, or typing looks dead.
      const wasPaused = getMessageQueue().isPaused()
      enqueueCommand(command, opts.followUpMode)
      if (wasPaused) {
        addToast("Queue paused by a failed message — this one waits. Ctrl+Q: r retry, x delete, c clear failed.", {
          variant: "warning", duration: 8000,
        })
      }
    }
    return true
  }

  const handleSubmitInternal = useCallback(
    // Async because MCP @-references require fetching server-side content
    // before we can assemble the user message. Input panel callers don't
    // need to await this — fire-and-forget is correct for the UI flow,
    // errors surface through addLog the same as file resolution failures.
    async (rawValue: string) => {
      const submitSessionId = getMessageQueue().getSessionId()
      const draftAtSubmit = opts.getInputValue?.() ?? rawValue
      const editVersionAtSubmit = getQueueSnapshot().find(entry => entry.id === opts.editingMessageId)?.editVersion
      const submittedPasteStore = { current: new Map(pasteStoreRef.current) }
      const expandPastes = createSubmittedPasteExpander(submittedPasteStore.current)
      // Keep a normalized control/display form for routing + transcript
      // hygiene, but do not trim the placeholder-expanded model input later:
      // copied code/config can depend on leading/trailing whitespace.
      let { value, displayForm, modelInput } = buildSubmittedTextParts(rawValue, expandPastes)
      let pasteExpansionSource = rawValue
      if (!value && pendingImages.length === 0) return

      // If the slash palette is open, Enter dispatches the highlighted
      // command directly — substituting the full command name for the typed
      // prefix while preserving any args the user already typed after a
      // space. (Tab still does pure expand-without-dispatch via useInput in
      // useKeyboardShortcuts.)
      if (slashOpen) {
        const sel = slashEntries[slashIdx]
        const resolved = resolveSlashSubmitValue(value, sel?.name)
        if (resolved !== value) {
          value = resolved
          displayForm = value.trim()
          modelInput = expandPastes(value)
          pasteExpansionSource = value
        }
      }

      if (value === "/queue" && opts.openQueue) {
        opts.openQueue()
        setInputValue("")
        return
      }
      const blockedPasteLabels = blockedPastedInputLabels(value, submittedPasteStore.current)
      if (blockedPasteLabels.length > 0) {
        addLog(
          "error",
          `Pasted text ${formatBlockedPasteLabels(blockedPasteLabels)} is no longer available; paste the original text again before sending.`,
        )
        return
      }
      // Provider repair is a local control action, not a follow-up task. It
      // must remain reachable behind a failed head, without reviving that head.
      if (isGoalSessionControl(value)) {
        pushHistory(value)
        addLog("user", displayForm, undefined, undefined, undefined, { restore: false })
        await dispatchCommand(expandPastes(value), { displayText: displayForm })
        setInputValue(current => current === draftAtSubmit ? "" : current)
        return
      }
      const control = parseCommand(value)
      if (!isRunning && !isDispatchingRef.current && !opts.editingMessageId
        && control && ["open_connect", "open_model_picker", "set_model"].includes(control.type)) {
        const images = filterPendingImagesForSubmit(pendingImages, value)
        const { pastedContentsSnapshot, imageRefs } = buildPromptHistorySnapshot(submittedPasteStore, images, value)
        const commandText = expandPastes(stripImagePlaceholders(value, images.map(image => image.id)))
        const restoreText = commandText !== displayForm ? commandText : undefined
        pushHistory(value, pastedContentsSnapshot, imageRefs)
        addLog("user", displayForm, undefined, undefined, undefined, { restore: false, restoreText })
        await dispatchCommand(commandText, { displayText: displayForm, restoreText })
        const liveDraft = opts.getInputValue?.() ?? draftAtSubmit
        setInputValue(current => current === draftAtSubmit ? "" : current)
        consumeSubmittedArtifacts(pasteStoreRef, setPendingImages, pastedContentsSnapshot, images,
          liveDraft !== draftAtSubmit ? liveDraft : "")
        return
      }
      if (opts.queueError) { addLog("error", opts.queueError); return }
      if (compactPending() && isManualCompactCommand(value)) {
        setInputValue("")
        addToast("Compact already in progress", {
          variant: "warning",
          duration: 1500,
        })
        return
      }

      // Resolve @path references. Validation runs BEFORE pushHistory so a
      // typo'd path doesn't pollute history.jsonl, and BEFORE setInputValue
      // below so the input is preserved on abort and the user can fix it.
      const fileBlocks = resolveAtPathReferences(value, addLog)
      if (fileBlocks === null) return

      // Resolve `@<server>:<uri>` MCP resource references. Awaiting before
      // history push keeps the same "fail before pollution" guarantee.
      const mcpBlocks = await resolveMCPReferences(value, getMCPManager(), addLog)
      if (mcpBlocks === null) return
      if (getMessageQueue().getSessionId() !== submitSessionId) {
        addToast("Session changed; input was not queued", { variant: "warning" })
        return
      }
      const activePendingImages = filterPendingImagesForSubmit(pendingImages, value)

      // `/mcp.<server>.<prompt> args` → fetch the rendered prompt and use
      // it as the model-facing text. Falls through to normal handling if
      // the line doesn't parse as a prompt invocation.
      const promptInv = parseMCPPromptSubmitInvocation(value, modelInput, expandPastes)
      if (promptInv) {
        const mgr = getMCPManager()
        if (!mgr) { addLog("error", "MCP subsystem unavailable"); return }
        try {
          const messages = await mgr.renderPrompt(promptInv.server, promptInv.name, promptInv.args)
          const renderedText = messages.map((m) => m.content).filter(Boolean).join("\n\n")
          if (!renderedText.trim()) { addLog("error", "MCP prompt returned empty content"); return }
          const { pastedContentsSnapshot, imageRefs } = buildPromptHistorySnapshot(submittedPasteStore, activePendingImages, value)
          if (value.trim()) {
            pushHistory(value, pastedContentsSnapshot, imageRefs)
          }
          if (getMessageQueue().getSessionId() !== submitSessionId) {
            addToast("Session changed; input was not queued", { variant: "warning" })
            return
          }
          if (!submitCommand(buildMCPPromptQueuedCommand(renderedText, value, modelInput, {
            pastedContents: pastedContentsSnapshot,
            images: activePendingImages,
          }), editVersionAtSubmit)) return
          const liveDraft = opts.getInputValue?.() ?? draftAtSubmit
          if (!opts.editingMessageId) setInputValue(current => current === draftAtSubmit ? "" : current)
          consumeSubmittedArtifacts(pasteStoreRef, setPendingImages, pastedContentsSnapshot, activePendingImages,
            !opts.editingMessageId && liveDraft !== draftAtSubmit ? liveDraft : "")
          return
        } catch (err) {
          addLog("error", `MCP prompt failed: ${err instanceof Error ? err.message : String(err)}`)
          return
        }
      }

      // History push: persist the placeholder form (compact display) + the
      // paste store snapshot so ↑ recall can re-expand on submit. Has to
      // happen BEFORE clearing the store below.
      const { pastedContentsSnapshot, imageRefs } = buildPromptHistorySnapshot(submittedPasteStore, activePendingImages, value)
      if (value.trim()) {
        pushHistory(value, pastedContentsSnapshot, imageRefs)
      }
      // Expand placeholders into their stored original text before dispatch.
      if (!modelInput.trim() && activePendingImages.length === 0 && fileBlocks.length === 0 && mcpBlocks.length === 0) return

      // Drag-drop image: replace typed-out path with the placeholder so the
      // user can keep typing accompanying text.
      const droppedPath = stripDropPathQuoting(modelInput)
      if (isSupportedImage(droppedPath)) {
        try {
          const img = loadImageFromFile(droppedPath)
          attachImageWithPlaceholder(img)
          setInputValue(`[Image #${imageCounterRef.current}]`)
          pasteStoreRef.current.clear()
          pasteCounterRef.current = 0
          return
        } catch {
          // fall through — user will see "Unknown command" or text turn
        }
      }

      const commandLike = value.startsWith("/") && !looksLikeDroppedFilePath(value)
      const activeImageIds = activePendingImages.map((image) => image.id)
      const compactValueWithoutImageMarkers = stripImagePlaceholders(value, activeImageIds)
      const pasteSourceWithoutImageMarkers = stripImagePlaceholders(pasteExpansionSource, activeImageIds)
      const modelInputWithoutImageMarkers = expandPastes(pasteSourceWithoutImageMarkers)
      const submitInputText = buildSubmitInputText(
        compactValueWithoutImageMarkers,
        modelInputWithoutImageMarkers,
        commandLike,
        expandPastes,
      )
      const userVisibleModelText = buildModelText(submitInputText, [], { stripImagePlaceholders: false })
      const modelText = buildModelText(
        submitInputText,
        commandLike ? [] : [...fileBlocks, ...mcpBlocks],
        { stripImagePlaceholders: false },
      )
      if (!modelText.trim() && activePendingImages.length === 0 && fileBlocks.length === 0 && mcpBlocks.length === 0) return

      const cmd: QueuedCommand = {
        text: modelText,
        displayForm,
        restoreText: userVisibleModelText !== displayForm && userVisibleModelText.trim().length > 0
          ? userVisibleModelText
          : undefined,
        pastedContents: Object.keys(pastedContentsSnapshot).length > 0
          ? pastedContentsSnapshot
          : undefined,
        images: activePendingImages.length > 0 ? activePendingImages : undefined,
      }
      // handleSubmit awaits MCP reference resolution above. Two rapid Enter
      // events can therefore both pass the early duplicate check before the
      // first one reaches enqueue. Re-check and claim at the synchronous
      // enqueue boundary so only one manual compact can be pending/running.
      const manualCompact = isManualCompactCommand(value)
      if (compactPending() && manualCompact) {
        setInputValue("")
        addToast("Compact already in progress", {
          variant: "warning",
          duration: 1500,
        })
        return
      }
      // Clear the live stores after consuming this turn — placeholders and
      // pending images from prior turns can't be referenced anymore (input is
      // empty); history.jsonl and the queued command already captured what's
      // needed for ↑ replay / queued dispatch. imageCounterRef intentionally is
      // not reset: it bridges [Image #N] placeholders to cached file paths.
      try {
        if (!submitCommand(cmd, editVersionAtSubmit)) return
      } catch (error) {
        addLog("error", `Cannot save queued message: ${error instanceof Error ? error.message : String(error)}`)
        return
      }
      const liveDraft = opts.getInputValue?.() ?? draftAtSubmit
      if (!opts.editingMessageId) setInputValue(current => current === draftAtSubmit ? "" : current)
      consumeSubmittedArtifacts(pasteStoreRef, setPendingImages, pastedContentsSnapshot, activePendingImages,
        !opts.editingMessageId && liveDraft !== draftAtSubmit ? liveDraft : "")

      if (isRunning || isDispatchingRef.current) {
        const steering = getQueueSnapshot().some(entry => entry.mode === "steer" && entry.state === "queued")
        addToast(steering ? "Steer pending · next safe boundary" : `Queued (${getQueueLength()})`, { duration: 1500 })
        return
      }
      void dispatchTurn()
    },
    [
      addLog,
      addToast,
      attachImageWithPlaceholder,
      dispatchTurn,
      expandPastes,
      imageCounterRef,
      isRunning,
      pasteCounterRef,
      pasteStoreRef,
      pendingImages,
      setInputValue,
      setPendingImages,
      slashEntries,
      slashIdx,
      slashOpen,
      opts.followUpMode,
      opts.editingMessageId,
      opts.onEditCommitted,
      opts.openQueue,
      opts.getInputValue,
      opts.queueError,
    ],
  )

  // Serial resolution preserves submission order and prevents a second Enter
  // from racing an asynchronous MCP render against the same editable input.
  const handleSubmit = useCallback(async (value: string) => {
    if (submissionInFlightRef.current) {
      addToast("Message is still resolving; the current draft is kept.", { variant: "warning" })
      return
    }
    submissionInFlightRef.current = true
    try { await handleSubmitInternal(value) }
    finally { submissionInFlightRef.current = false }
  }, [handleSubmitInternal, addToast])

  // Drain both sources when the agent goes idle. The dispatcher itself
  // claims everything in one atomic shot — this effect just fires it.
  // Race-free against the dispatchTurn tail-loop and against parallel
  // re-runs of this effect (guarded by isDispatchingRef).
  useEffect(() => {
    if (isRunning || opts.queueError || opts.paused) return
    if (isDispatchingRef.current) return
    const first = getQueueSnapshot().find(entry => entry.state !== "accepted")
    if (first?.state !== "queued" && systemInboxSize === 0) return
    void dispatchTurn()
  }, [isRunning, inputQueue, systemInboxSize, dispatchTurn, opts.queueError, opts.paused])

  return { handleSubmit }
}

/** Capture payloads before awaiting MCP or file resolution. Live placeholder
 * storage may be edited, consumed or replaced by another draft meanwhile. */
export function createSubmittedPasteExpander(store: Map<number, string>): (input: string) => string {
  const snapshot = new Map(store)
  return input => input.replace(PASTED_PLACEHOLDER_RE, (label, id) => snapshot.get(Number(id)) ?? label)
}

/** Remove only the submitted artifacts. A user may have started a new draft
 * while asynchronous MCP resolution was still in flight. */
export function consumeSubmittedArtifacts(pasteStore: React.MutableRefObject<Map<number, string>>,
  setImages: UseTurnDispatcherOptions["setPendingImages"], contents: Record<string, string>, images: PendingImage[], liveDraft = ""): void {
  const retainedPastes = new Set([...liveDraft.matchAll(PASTED_PLACEHOLDER_RE)].map(match => match[1]))
  const retainedImages = new Set([...liveDraft.matchAll(IMAGE_PLACEHOLDER_RE)].map(match => Number(match[1])))
  for (const [key, text] of Object.entries(contents)) {
    if (!retainedPastes.has(key) && pasteStore.current.get(Number(key)) === text) pasteStore.current.delete(Number(key))
  }
  const ids = new Set(images.map(image => image.id))
  setImages(current => current.filter(image => !ids.has(image.id) || retainedImages.has(image.id)))
}

function formatBlockedPasteLabels(labels: string[]): string {
  return labels.join(", ")
}

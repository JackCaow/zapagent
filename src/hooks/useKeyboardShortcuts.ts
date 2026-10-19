import { useEffect, useRef } from "react"
import { useInput } from "ink"
import {
  popAllForEditing as popQueueForEditing,
  type PendingImage,
  type QueuedCommand,
} from "../queue/inputQueue.js"
import {
  pasteImageFromClipboard,
} from "../../zapsdk/utils/clipboard-image.js"
import { loadImageFromFile } from "../../zapsdk/utils/image.js"
import type { Todo, ImageContent } from "../../zapsdk/index.js"
import type { LogEntry } from "../ui/types.js"
import type { SlashEntry } from "../ui/slash-palette.js"
import type { ApprovalChoice } from "../ui/dialog-approval.js"
import { isReturnInput, textBeforeReturn } from "../ui/controlled-input.js"
import { replaceAtToken } from "../utils/file-completer.js"
import type { DialogId } from "../commands/dispatcher.js"
import { resolveSlashSubmitValue } from "./useTurnDispatcher.js"

interface PendingApproval {
  name: string
  args: Record<string, unknown>
  resolve: (choice: ApprovalChoice) => void
}
interface PendingPlan {
  plan: string
  resolve: (choice: { kind: "approve" } | { kind: "reject"; reason?: string }) => void
}

export interface ToastOptions {
  variant?: "success" | "warning" | "error"
  duration?: number
}

export interface UseKeyboardShortcutsOptions {
  // ── Palettes ──
  fileOpen: boolean
  fileEntries: string[]
  fileIdx: number
  setFileIdx: (idx: number | ((prev: number) => number)) => void
  slashOpen: boolean
  slashEntries: SlashEntry[]
  slashIdx: number
  setSlashIdx: (idx: number | ((prev: number) => number)) => void

  // ── Modal state ──
  dialog: DialogId
  pendingApproval: PendingApproval | null
  pendingPlan: PendingPlan | null
  /** An ask_user_question bar is open and owns the keyboard. */
  questionOpen?: boolean

  // ── Queue / images ──
  inputQueue: ReadonlyArray<QueuedCommand>
  openQueue?: () => void
  openRewind?: () => void
  saveDraftToHistory?: (value: string) => void
  editingMessageId?: string | null
  cancelQueueEdit?: () => void
  pendingImages: PendingImage[]
  setPendingImages: (next: PendingImage[] | ((prev: PendingImage[]) => PendingImage[])) => void
  restorePastedContents: (pastedContents: Record<string, string>) => void

  // ── Agent runtime ──
  isRunning: boolean
  abortRef: React.MutableRefObject<AbortController | null>
  setStatus: (s: string) => void

  // ── Input ──
  inputValue: string
  setInputValue: (next: string | ((prev: string) => string)) => void
  bumpInputEpoch: () => void
  submitInput: (value: string) => void

  // ── Misc ──
  addToast: (text: string, options?: ToastOptions) => void
  /** /clear-style reset hook called on Ctrl+L. Mirrors the dispatchSlashCommand
   *  "clear" branch — wipes scrollback + state + bumps transcript. */
  onClearScreen: () => void
  /** Ink-clean exit (from useApp().exit). Used by the Ctrl+C double-press
   *  exit path. Passed in instead of calling useApp() here so App.tsx owns
   *  the Ink lifecycle and the same `exit` ref can flow into the slash
   *  command dispatcher's `/exit` branch. */
  exit: () => void

  // ── Paste / image handler bridge ──
  lastAttachAtRef: React.MutableRefObject<number>
  absorbVUntilRef: React.MutableRefObject<number>
  ATTACH_DEDUP_MS: number
  attachImageWithPlaceholder: (img: ImageContent) => void
}

export const ESC_INTERRUPT_CONFIRM_MS = 2000

export function isConfirmedInterruptEscape(previousAt: number, now: number): boolean {
  return previousAt > 0 && now >= previousAt && now - previousAt <= ESC_INTERRUPT_CONFIRM_MS
}

export type EscapeAction =
  | "none" | "dismiss-file" | "dismiss-slash" | "open-queue" | "clear-attachments" | "interrupt"

/**
 * Esc routing, most specific first. While the agent runs, Esc must keep its
 * interrupt meaning: the queue manager opens only when idle (Ctrl+Q and
 * /queue always work), otherwise a leftover failed/recovered queue entry would
 * swallow every Esc and the agent could only be stopped with Ctrl+C.
 */
export function resolveEscapeAction(state: {
  dialogActive: boolean
  fileOpen: boolean
  slashOpen: boolean
  queueLength: number
  pendingImages: number
  isRunning: boolean
}): EscapeAction {
  if (state.dialogActive) return "none"
  if (state.fileOpen) return "dismiss-file"
  if (state.slashOpen) return "dismiss-slash"
  if (state.queueLength > 0 && !state.isRunning) return "open-queue"
  if (state.pendingImages > 0) return "clear-attachments"
  if (state.isRunning) return "interrupt"
  return "none"
}

/**
 * Wires the global useInput callback. Priority (top to bottom):
 *
 *   1. Ctrl+Q / Esc edit cancellation, before composer palette handlers
 *   2. @ file / slash palette nav, only while the composer owns focus
 *   3. Esc — context-sensitive (see resolveEscapeAction): dismiss palette →
 *      open queue (idle only) → clear attachments → interrupt agent
 *   4. Ctrl+V — clipboard image probe + stray-`v` absorb arming
 *   5. Ctrl+C — first press cancels running agent, second exits within 1.5s
 *   6. Ctrl+L — wipe-and-reset (same as /clear)
 *
 * Ink fans key events out to all useInput listeners (no propagation control),
 * so each branch must early-return after handling to avoid leaking into
 * Prompt's own listeners.
 */
export function useKeyboardShortcuts(opts: UseKeyboardShortcutsOptions): void {
  const lastCtrlCRef = useRef<number>(0)
  const lastInterruptEscRef = useRef<number>(0)
  const lastIdleEscRef = useRef<number>(0)

  useEffect(() => {
    if (!opts.isRunning) lastInterruptEscRef.current = 0
  }, [opts.isRunning])

  useEffect(() => { lastIdleEscRef.current = 0 }, [opts.dialog, opts.isRunning, opts.pendingApproval, opts.pendingPlan, opts.questionOpen])

  useInput((rawInput, key) => {
    const ownsComposer = opts.dialog === null && !opts.pendingApproval && !opts.pendingPlan && !opts.questionOpen
    if (key.ctrl && rawInput === "q" && opts.dialog === null && !opts.pendingApproval && !opts.pendingPlan && !opts.questionOpen) {
      opts.openQueue?.()
      return
    }
    // @ file palette nav — must run BEFORE slash palette block (and before
    // Prompt's history nav). Tab/Enter both insert + clear (Enter is
    // suppressed from submit by blockSubmit={fileOpen} on Prompt). fileOpen
    // and slashOpen are mutually exclusive (extractAtQuery only fires when
    // !slashOpen).
    if (ownsComposer && key.escape && opts.editingMessageId && opts.cancelQueueEdit) {
      opts.cancelQueueEdit()
      return
    }
    if (ownsComposer && opts.fileOpen) {
      if (key.upArrow) {
        opts.setFileIdx((i) => (i - 1 + opts.fileEntries.length) % opts.fileEntries.length)
        return
      }
      if (key.downArrow) {
        opts.setFileIdx((i) => (i + 1) % opts.fileEntries.length)
        return
      }
      if (key.tab || isReturnInput(rawInput, key)) {
        const sel = opts.fileEntries[opts.fileIdx]
        const deferredValue = filePaletteReturnPrefixValue(opts.inputValue, rawInput, key)
        if (deferredValue !== null) {
          opts.setInputValue(deferredValue)
          opts.bumpInputEpoch()
          return
        }
        if (sel) {
          opts.setInputValue(replaceAtToken(opts.inputValue, sel))
          opts.bumpInputEpoch()
        }
        return
      }
    }
    // Slash palette nav — intercepts ↑/↓/Tab/Enter BEFORE Prompt's history
    // nav / submit. Ink fans key events out to every listener, so App also
    // blocks Prompt submit while the slash palette is open; this handler owns
    // the Enter path.
    if (ownsComposer && opts.slashOpen) {
      if (key.upArrow) {
        opts.setSlashIdx(
          (i) => (i - 1 + opts.slashEntries.length) % opts.slashEntries.length,
        )
        return
      }
      if (key.downArrow) {
        opts.setSlashIdx((i) => (i + 1) % opts.slashEntries.length)
        return
      }
      if (key.tab) {
        const sel = opts.slashEntries[opts.slashIdx]
        if (sel) opts.setInputValue(sel.name + " ")
        return
      }
      if (isReturnInput(rawInput, key)) {
        const sel = opts.slashEntries[opts.slashIdx]
        opts.submitInput(resolveSlashSubmitValue(inputWithReturnPrefix(opts.inputValue, rawInput, key), sel?.name))
        return
      }
    }

    // Esc — context-sensitive dismissal. Skip when a dialog / approval /
    // plan-approval is open; those own Esc for their own semantics, and
    // Ink fans the event out to all useInput listeners, so stacking
    // actions would mean "close dialog AND kill agent" on a single press.
    if (key.escape) {
      if (ownsComposer && !opts.isRunning && !opts.fileOpen && !opts.slashOpen && !opts.pendingImages.length && !opts.editingMessageId && opts.inputQueue.length === 0) {
        const now = Date.now();
        if (isConfirmedInterruptEscape(lastIdleEscRef.current, now)) {
          lastIdleEscRef.current = 0;
          if (opts.inputValue.length) {
            opts.saveDraftToHistory?.(opts.inputValue);
            opts.setInputValue("");
            opts.bumpInputEpoch();
          } else opts.openRewind?.();
          return;
        }
        lastIdleEscRef.current = now;
      }
      const action = resolveEscapeAction({
        dialogActive: opts.dialog !== null || opts.pendingApproval !== null || opts.pendingPlan !== null || opts.questionOpen === true,
        fileOpen: opts.fileOpen,
        slashOpen: opts.slashOpen,
        queueLength: opts.inputQueue.length,
        pendingImages: opts.pendingImages.length,
        isRunning: opts.isRunning,
      })
      if (action === "none") return
      if (action === "dismiss-file") {
        // Dismiss file palette by stripping the trailing `@<query>` token;
        // rest of the user's typed text stays. fileOpen is derived from
        // inputValue, so this flips it false.
        opts.setInputValue((v) => v.replace(/(?:^|\s)@\S*$/, (m) => (m.startsWith("@") ? "" : m[0])))
        opts.bumpInputEpoch()
        return
      }
      if (action === "dismiss-slash") {
        // Slash palette has no useInput of its own; closing means emptying
        // the input so the derived `slashOpen` flips false.
        opts.setInputValue("")
        return
      }
      if (action === "open-queue") {
        if (opts.openQueue) { opts.openQueue(); return }
        // Pop queued messages back into the input box for editing instead
        // of silently discarding them. Queued text goes BEFORE any current
        // input (separated by a newline) so the user sees the queue first
        // when they start editing. Images get appended to whatever they
        // have currently attached so the [Image #N] markers in the popped
        // text resolve to actual bytes.
        const queuedCount = opts.inputQueue.length
        const popped = popQueueForEditing({
          nextPasteId: maxPastedPlaceholderId(opts.inputValue) + 1,
          nextImageId: nextImagePlaceholderId(opts.inputValue, opts.pendingImages),
        })
        if (popped) {
          opts.setInputValue((prev) => popped.text + (prev ? "\n" + prev : ""))
          if (popped.images.length > 0) {
            opts.setPendingImages((prev) => [...prev, ...popped.images])
          }
          opts.restorePastedContents(popped.pastedContents)
          opts.bumpInputEpoch()
          opts.addToast(
            `Pulled ${queuedCount} queued message${queuedCount === 1 ? "" : "s"} back to input`,
          )
          return
        }
        return
      }
      if (action === "clear-attachments") {
        // No queue — fall back to the original "Esc clears attachments"
        // behavior so users can drop a stray paste without abandoning the
        // agent.
        opts.setPendingImages([])
        opts.addToast("Cleared pending attachments")
        return
      }
      // action === "interrupt"
      const now = Date.now()
      if (!isConfirmedInterruptEscape(lastInterruptEscRef.current, now)) {
        lastInterruptEscRef.current = now
        opts.addToast("Press Esc again within 2s to interrupt", {
          variant: "warning",
          duration: ESC_INTERRUPT_CONFIRM_MS,
        })
        return
      }
      lastInterruptEscRef.current = 0
      opts.abortRef.current?.abort()
      opts.setStatus("cancelled")
      opts.addToast("Agent interrupted")
      return
    }

    // Ctrl+V image fallback. macOS Cmd+V is intercepted by the OS terminal
    // and translated to bracketed paste (handled by Ink's usePaste). But on
    // Linux / Windows / in terminals where Cmd+V doesn't trigger paste
    // protocol when the clipboard has image-only content, Ctrl+V reaches us
    // as a key event — probe the clipboard directly here.
    if (key.ctrl && rawInput === "v") {
      if (Date.now() - opts.lastAttachAtRef.current >= opts.ATTACH_DEDUP_MS) {
        try {
          const imgPath = pasteImageFromClipboard()
          if (imgPath) {
            opts.attachImageWithPlaceholder(loadImageFromFile(imgPath))
          }
        } catch {
          // attach failed; user sees the lack of placeholder as feedback
        }
      }
      // Always swallow the `v` keystroke after Ctrl+V regardless of
      // outcome — user pressed Ctrl+V to paste, not to type a literal `v`.
      // ink-text-input has already started inserting `v` on this same
      // keystroke; arm the absorb window + remount so the next render
      // syncs back to the pre-keystroke value (or the new placeholder if
      // attach succeeded).
      opts.absorbVUntilRef.current = Date.now() + 250
      opts.bumpInputEpoch()
      return
    }

    if (key.ctrl && rawInput === "c") {
      const now = Date.now()
      if (opts.isRunning) {
        opts.abortRef.current?.abort()
        // useAgentRunner's finally{} resets to "ready" on abort; setting
        // "cancelled" here gives the LiveActivity / Footer a single frame
        // to show the cancel state before that runs.
        opts.setStatus("cancelled")
        opts.addToast("Agent cancelled")
        lastCtrlCRef.current = now
        return
      }
      if (now - lastCtrlCRef.current < 1500) {
        opts.exit()
        return
      }
      opts.addToast("Press Ctrl+C again to exit")
      lastCtrlCRef.current = now
    }
    if (key.ctrl && rawInput === "l") {
      // Same as /clear — let App's onClearScreen own the full reset.
      opts.onClearScreen()
    }
  })
}

function maxPastedPlaceholderId(text: string): number {
  let max = 0
  for (const match of text.matchAll(/\[Pasted #([1-9]\d*) · \d+ lines · \d+ chars\]/g)) {
    const id = Number(match[1])
    if (Number.isFinite(id)) max = Math.max(max, id)
  }
  return max
}

function nextImagePlaceholderId(text: string, pendingImages: PendingImage[]): number {
  let max = 0
  for (const match of text.matchAll(/\[Image #([1-9]\d*)\]/g)) {
    const id = Number(match[1])
    if (Number.isFinite(id)) max = Math.max(max, id)
  }
  for (const image of pendingImages) {
    if (Number.isFinite(image.id)) max = Math.max(max, image.id)
  }
  return max + 1
}

export function inputWithReturnPrefix(
  value: string,
  rawInput: string,
  key: { return?: boolean },
): string {
  if (!isReturnInput(rawInput, key)) return value
  const prefix = textBeforeReturn(rawInput).replace(/[\r\n]/g, "")
  return prefix ? value + prefix : value
}

export function filePaletteReturnPrefixValue(
  value: string,
  rawInput: string,
  key: { return?: boolean },
): string | null {
  const withPrefix = inputWithReturnPrefix(value, rawInput, key)
  return isReturnInput(rawInput, key) && withPrefix !== value ? withPrefix : null
}

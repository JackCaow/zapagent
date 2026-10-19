import type { ProviderRequestEvent } from "../../zapsdk/core/llm.js"

export type ActivityProgressKind = "none" | "reasoning" | "tool-args"

export interface ActivityProgress {
  kind: ActivityProgressKind
  value: number
}

export interface LiveActivityCopyInput {
  primaryLabel: string
  elapsedSeconds: number
  isThinking: boolean
  thinkingChars: number
  activeToolBytes: number
  progressIdleSeconds: number
  providerRequest?: ProviderRequestEvent
}

export interface LiveActivityCopy {
  primaryLabel: string
  elapsed: string
  progress: string
  mayBeStalled: boolean
}

const ACTIVE_PROGRESS_GRACE_SECONDS = 5
const SILENT_PROGRESS_NOTICE_SECONDS = 20
const SILENT_PROGRESS_WARNING_SECONDS = 60

export function activityProgress(
  isThinking: boolean,
  thinkingChars: number,
  activeToolBytes: number,
): ActivityProgress {
  if (activeToolBytes > 0) return { kind: "tool-args", value: activeToolBytes }
  if (isThinking && thinkingChars > 0) return { kind: "reasoning", value: thinkingChars }
  return { kind: "none", value: 0 }
}

export function formatActivityDuration(seconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(seconds))
  if (safeSeconds < 60) return `${safeSeconds}s`
  const minutes = Math.floor(safeSeconds / 60)
  const remainder = safeSeconds % 60
  return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`
}

export function formatActivityChars(chars: number): string {
  if (chars < 1000) return `${chars} chars`
  if (chars < 10000) return `${(chars / 1000).toFixed(1)}K chars`
  return `${Math.round(chars / 1000)}K chars`
}

export function formatActivityBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`
  if (bytes < 10000) return `${(bytes / 1000).toFixed(1)} KB`
  return `${Math.round(bytes / 1000)} KB`
}

export function buildLiveActivityCopy(input: LiveActivityCopyInput): LiveActivityCopy {
  const elapsed = formatActivityDuration(input.elapsedSeconds)
  const idleSeconds = Math.max(0, Math.floor(input.progressIdleSeconds))
  const request = input.providerRequest
  if (request && ["requesting", "waiting_output", "retrying"].includes(request.phase)) {
    const attempt = request.maxAttempts > 1 ? ` · attempt ${request.attempt}/${request.maxAttempts}` : ""
    return {
      primaryLabel: request.phase === "retrying" ? "Retrying provider" : "Waiting for provider",
      elapsed: formatActivityDuration((Date.now() - request.startedAt) / 1000),
      progress: request.phase === "requesting" ? `waiting for HTTP response${attempt}`
        : request.phase === "waiting_output" ? `response received · waiting for first model output${attempt}`
          : `${request.reason ?? "TRANSIENT_ERROR"} · backoff ${formatActivityDuration((request.delayMs ?? 0) / 1000)}${attempt}`,
      mayBeStalled: false,
    }
  }

  if (input.activeToolBytes > 0) {
    const size = formatActivityBytes(input.activeToolBytes)
    if (idleSeconds < ACTIVE_PROGRESS_GRACE_SECONDS) {
      return {
        primaryLabel: input.primaryLabel,
        elapsed,
        progress: `generating tool input · ${size}`,
        mayBeStalled: false,
      }
    }
    return {
      primaryLabel: idleSeconds >= SILENT_PROGRESS_WARNING_SECONDS
        ? "Waiting for model"
        : input.primaryLabel,
      elapsed,
      progress: `tool input unchanged for ${formatActivityDuration(idleSeconds)} · ${size}`,
      mayBeStalled: idleSeconds >= SILENT_PROGRESS_WARNING_SECONDS,
    }
  }

  if (input.isThinking && input.thinkingChars > 0) {
    const size = formatActivityChars(input.thinkingChars)
    if (idleSeconds < ACTIVE_PROGRESS_GRACE_SECONDS) {
      return {
        primaryLabel: input.primaryLabel,
        elapsed,
        progress: `receiving reasoning · ${size}`,
        mayBeStalled: false,
      }
    }
    if (idleSeconds < SILENT_PROGRESS_NOTICE_SECONDS) {
      return {
        primaryLabel: input.primaryLabel,
        elapsed,
        progress: `waiting for more reasoning · ${size}`,
        mayBeStalled: false,
      }
    }
    return {
      primaryLabel: idleSeconds >= SILENT_PROGRESS_WARNING_SECONDS
        ? "Waiting for model"
        : input.primaryLabel,
      elapsed,
      progress: `no new reasoning for ${formatActivityDuration(idleSeconds)} · ${size}`,
      mayBeStalled: idleSeconds >= SILENT_PROGRESS_WARNING_SECONDS,
    }
  }

  return {
    primaryLabel: input.primaryLabel,
    elapsed,
    progress: "",
    mayBeStalled: false,
  }
}

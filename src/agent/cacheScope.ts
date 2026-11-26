import { conversationAgentId, type AppConfig } from "../config.js"
import { countCodePoints, sliceHeadCodePoints } from "../utils/logicalLines.js"

export interface PromptCacheScope {
  providerId: string
  model: string
}

const MAX_PROVIDER_ID_CHARS = 256
const MAX_MODEL_ID_CHARS = 512

export function makePromptCacheScope(
  providerId: unknown,
  model: unknown,
): PromptCacheScope | undefined {
  const safeProviderId = boundedText(providerId, MAX_PROVIDER_ID_CHARS)
  const safeModel = boundedText(model, MAX_MODEL_ID_CHARS)
  if (!safeProviderId || !safeModel) return undefined
  return { providerId: safeProviderId, model: safeModel }
}

export function conversationCacheScope(config: AppConfig): PromptCacheScope | undefined {
  const agent = conversationAgentId(config)
  if (agent) {
    const model = agent === "codex" && config.providers.some(p => p.id === config.active.providerId && p.authMode === "codex-oauth")
      ? config.active.model : undefined
    return makePromptCacheScope(`agent:${agent}`, model || "default")
  }
  return makePromptCacheScope(config.active.providerId, config.active.model)
}

export function sanitizePromptCacheScope(value: unknown): PromptCacheScope | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  return makePromptCacheScope(record.providerId, record.model)
}

export function samePromptCacheScope(
  left: PromptCacheScope | undefined,
  right: PromptCacheScope | undefined,
): boolean {
  return !!left && !!right && left.providerId === right.providerId && left.model === right.model
}

function boundedText(value: unknown, maxChars: number): string {
  if (typeof value !== "string") return ""
  const trimmed = value.trim()
  if (countCodePoints(trimmed) <= maxChars) return trimmed
  return sliceHeadCodePoints(trimmed, maxChars)
}

import type { DevtoolsHttpRecord } from "./protocol.js"
import { REDACTED, redactTextSecrets } from "../utils/redact.js"

const DEFAULT_MAX_STRING_CHARS = 20_000
const DEFAULT_MAX_HTTP_BODY_CHARS = 64_000
const SECRET_KEY_RE = /^(authorization|proxy-authorization|x-api-key|api-key|apikey|api_key|token|access_token|accessToken|refresh_token|refreshToken|secret|client_secret|clientSecret|password|cookie|set-cookie)$/i
const SECRET_QUERY_RE = /^(key|api_key|apikey|token|access_token|accessToken|refresh_token|refreshToken|client_secret|clientSecret|password)$/i

export function redactDevtoolsValue(value: unknown, maxStringChars = DEFAULT_MAX_STRING_CHARS): unknown {
  return redactValue(value, new WeakSet<object>(), maxStringChars)
}

export function redactDevtoolsHttpRecord(record: DevtoolsHttpRecord): DevtoolsHttpRecord {
  const fullRequestBody = record.requestBody
    ? redactBody(record.requestBody, Number.MAX_SAFE_INTEGER)
    : undefined
  const requestBody = record.requestBody
    ? redactBody(record.requestBody, DEFAULT_MAX_HTTP_BODY_CHARS)
    : undefined
  return {
    ...record,
    url: redactUrl(record.url),
    requestHeaders: record.requestHeaders ? redactHeaders(record.requestHeaders) : undefined,
    responseHeaders: record.responseHeaders ? redactHeaders(record.responseHeaders) : undefined,
    requestBody,
    requestBodyTruncated: requestBody !== undefined
      ? requestBody.length < (fullRequestBody?.length ?? 0)
      : record.requestBodyTruncated,
    requestBodyOriginalChars: requestBody !== undefined && record.requestBody
      ? fullRequestBody?.length
      : record.requestBodyOriginalChars,
  }
}

export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    out[key] = SECRET_KEY_RE.test(key) ? REDACTED : value
  }
  return out
}

export function redactBody(body: string, maxChars = DEFAULT_MAX_HTTP_BODY_CHARS): string {
  const trimmed = body.trim()
  if (!trimmed) return truncateString(body, maxChars)
  let redacted: string
  if (trimmed[0] === "{" || trimmed[0] === "[") {
    try {
      redacted = JSON.stringify(redactDevtoolsValue(JSON.parse(body), maxChars))
      return truncateString(redacted, maxChars)
    } catch {
      redacted = redactTextSecrets(body)
      return truncateString(redacted, maxChars)
    }
  }
  const form = redactFormBody(body)
  redacted = form ?? redactTextSecrets(body)
  return truncateString(redacted, maxChars)
}

function redactFormBody(body: string): string | null {
  if (!looksLikeFormBody(body)) return null
  try {
    const params = new URLSearchParams(body)
    let changed = false
    for (const key of Array.from(params.keys())) {
      if (!SECRET_QUERY_RE.test(key)) continue
      params.set(key, REDACTED)
      changed = true
    }
    return changed ? params.toString() : null
  } catch {
    return null
  }
}

export function redactUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl)
    for (const key of Array.from(url.searchParams.keys())) {
      if (SECRET_QUERY_RE.test(key)) url.searchParams.set(key, REDACTED)
    }
    return url.toString()
  } catch {
    return rawUrl
  }
}

function redactValue(value: unknown, seen: WeakSet<object>, maxStringChars: number): unknown {
  if (typeof value === "string") return truncateString(redactTextSecrets(value), maxStringChars)
  if (Array.isArray(value)) return value.map((item) => redactValue(item, seen, maxStringChars))
  if (!value || typeof value !== "object") return value
  if (seen.has(value)) return "[Circular]"
  seen.add(value)

  const out: Record<string, unknown> = {}
  for (const [key, inner] of Object.entries(value)) {
    out[key] = SECRET_KEY_RE.test(key) ? REDACTED : redactValue(inner, seen, maxStringChars)
  }
  return out
}

function looksLikeFormBody(body: string): boolean {
  if (!body.includes("=")) return false
  if (/[\r\n{}[\]]/.test(body)) return false
  return body.split("&").every((part) => /^[^=&]+=[\s\S]*$/.test(part))
}

function truncateString(value: string, maxChars: number): string {
  if (!Number.isFinite(maxChars) || maxChars <= 0 || value.length <= maxChars) return value
  const marker = "\n...[truncated by devtools]...\n"
  const available = Math.max(0, maxChars - marker.length)
  const head = Math.ceil(available / 2)
  const tail = Math.floor(available / 2)
  return `${value.slice(0, head)}${marker}${tail > 0 ? value.slice(-tail) : ""}`
}

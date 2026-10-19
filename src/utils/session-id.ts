const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/
const WINDOWS_DEVICE_RE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i

/**
 * Session ids are storage keys, never paths. Keep the accepted legacy shape
 * broad enough for UUIDs and older `session-*` ids while rejecting separators,
 * traversal segments, control characters, and unbounded input.
 */
export function isValidSessionId(value: string): boolean {
  return SESSION_ID_RE.test(value)
    && !value.endsWith(".")
    && !WINDOWS_DEVICE_RE.test(value)
}

export const REDACTED = "[REDACTED]";

const CREDENTIAL_KEY_PATTERN = "api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|secret|token";
const CREDENTIAL_KEY_RE = new RegExp(`^(?:${CREDENTIAL_KEY_PATTERN})$`, "i");
const TOKEN_ASSIGNMENT_RE = new RegExp(String.raw`(["']?)(${CREDENTIAL_KEY_PATTERN})\1(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s&;,}]+)`, "gi");
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+\/=-]+/gi;
const BASIC_RE = /\bBasic\s+[A-Za-z0-9._~+\/=-]+/gi;
const API_KEY_VALUE_RE = /\b(sk-(?:proj-)?[A-Za-z0-9_-]{12,}|sk-ant-[A-Za-z0-9_-]{12,})\b/g;

/** Redact credentials in arbitrary plain text before storing or exposing it.
 *  Kept deliberately conservative: it targets explicit credential shapes
 *  instead of every high-entropy string, so compact summaries keep useful
 *  IDs, paths, hashes, and command output while dropping common secrets. */
export function redactTextSecrets(text: string): string {
  return text
    .replace(BEARER_RE, `Bearer ${REDACTED}`)
    .replace(BASIC_RE, `Basic ${REDACTED}`)
    .replace(API_KEY_VALUE_RE, REDACTED)
    .replace(TOKEN_ASSIGNMENT_RE, (_match, keyQuote: string, key: string, separator: string, value: string) => {
      const quote = value.startsWith("\"") ? "\"" : value.startsWith("'") ? "'" : "";
      return `${keyQuote}${key}${keyQuote}${separator}${quote}${REDACTED}${quote}`;
    });
}

/** JSON.stringify replacer: redact whole credential values and plain-text
 * strings before JSON escaping can hide their boundaries from text matching. */
export function redactJsonSecrets(key: string, value: unknown): unknown {
  if (CREDENTIAL_KEY_RE.test(key)) return REDACTED;
  return typeof value === "string" ? redactTextSecrets(value) : value;
}

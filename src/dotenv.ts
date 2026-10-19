import { readFileSync } from "node:fs"

export type EnvTarget = Record<string, string | undefined>

export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#")) continue

    const body = line.startsWith("export ") ? line.slice("export ".length).trimStart() : line
    const eq = body.indexOf("=")
    if (eq <= 0) continue

    const key = body.slice(0, eq).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue

    out[key] = parseDotEnvValue(body.slice(eq + 1))
  }
  return out
}

export function applyDotEnv(text: string, env: EnvTarget = process.env): Record<string, string> {
  const parsed = parseDotEnv(text)
  const applied: Record<string, string> = {}
  for (const [key, value] of Object.entries(parsed)) {
    if (env[key] !== undefined) continue
    env[key] = value
    applied[key] = value
  }
  return applied
}

export function loadDotEnvFile(path: string, env: EnvTarget = process.env): Record<string, string> {
  return applyDotEnv(readFileSync(path, "utf-8"), env)
}

function parseDotEnvValue(raw: string): string {
  const value = raw.trimStart()
  if (value.startsWith("\"")) return parseQuotedValue(value, "\"")
  if (value.startsWith("'")) return parseQuotedValue(value, "'")
  return stripInlineComment(value).trim()
}

function parseQuotedValue(value: string, quote: "\"" | "'"): string {
  let out = ""
  let escaped = false
  for (let i = 1; i < value.length; i++) {
    const ch = value[i]
    if (quote === "\"" && escaped) {
      out += unescapeDoubleQuotedChar(ch)
      escaped = false
      continue
    }
    if (quote === "\"" && ch === "\\") {
      escaped = true
      continue
    }
    if (ch === quote) return out
    out += ch
  }
  return out
}

function unescapeDoubleQuotedChar(ch: string): string {
  switch (ch) {
    case "n": return "\n"
    case "r": return "\r"
    case "t": return "\t"
    case "\\": return "\\"
    case "\"": return "\""
    default: return ch
  }
}

function stripInlineComment(value: string): string {
  for (let i = 0; i < value.length; i++) {
    if (value[i] !== "#") continue
    if (i === 0 || /\s/.test(value[i - 1] ?? "")) return value.slice(0, i)
  }
  return value
}

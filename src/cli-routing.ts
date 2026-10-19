export function isHeadlessInvocation(
  argv: readonly string[],
  stdinIsTTY: boolean | undefined,
): boolean {
  if (argv.includes("--help-headless")) return true
  if (argv.includes("-p") || argv.includes("--print")) return true
  if (argv.includes("-c") || argv.includes("--continue")) return true
  if (argv.includes("--session-id")) return true
  if (!stdinIsTTY) return true
  // First non-flag arg is a positional prompt.
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--dev") {
      if (argv[i + 1] && /^\d+$/.test(argv[i + 1])) i++
      continue
    }
    if (isValueFlag(a)) {
      i++
      continue
    }
    if (a.startsWith("-")) continue
    return true
  }
  return false
}

export function devtoolsPortFromArgs(argv: readonly string[]): string | null {
  const devIdx = argv.findIndex(a => a === "--dev")
  if (devIdx < 0) return null
  const maybePort = argv[devIdx + 1]
  return maybePort && /^\d+$/.test(maybePort) ? maybePort : "9229"
}

export type HeadlessCwdArg =
  | { ok: true; cwd?: string }
  | { ok: false; message: string }

export function headlessCwdFromArgs(argv: readonly string[]): HeadlessCwdArg {
  const cwdIdx = argv.findIndex(a => a === "--cwd")
  if (cwdIdx < 0) return { ok: true }
  const value = argv[cwdIdx + 1]
  if (value === undefined || (value.startsWith("-") && !/^-?\d/.test(value))) {
    return { ok: false, message: "--cwd requires a value" }
  }
  return { ok: true, cwd: value }
}

function isValueFlag(flag: string): boolean {
  return flag === "--cwd" ||
    flag === "--public-checks" ||
    flag === "--model" ||
    flag === "--session-id" ||
    flag === "--permission-mode" ||
    flag === "--output-format" ||
    flag === "--max-turns" ||
    flag === "--system-prompt-append" ||
    flag === "--allowed-tools" ||
    flag === "--disallowed-tools"
}

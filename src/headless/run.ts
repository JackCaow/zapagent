// Headless entry shim. Imported lazily from index.tsx only when the parsed
// CLI args indicate non-interactive mode, so the Ink + opentui import graph
// stays out of the headless code path entirely.

import { parseHeadlessArgs, readStdinIfPiped, HEADLESS_HELP } from "./args.js"

const EXIT_BAD_ARGS = 2

async function runParsedHeadless(args: import("./args.js").HeadlessArgs, watch?: import("../watch/args.js").WatchOptions): Promise<number> {
  const viewer = watch?.enabled ? await import("../watch/integration.js") : undefined
  if (viewer) {
    try { await viewer.startWatch(watch!) }
    catch { process.stderr.write("[watch] Could not start the local viewer; no Agent run started.\n"); return EXIT_BAD_ARGS }
  }
  try {
    const { runHeadless } = await import("./runHeadless.js")
    return await runHeadless(args)
  } finally { await viewer?.stopWatch(watch?.linger) }
}

export async function runHeadlessFromArgv(argv: readonly string[], watch?: import("../watch/args.js").WatchOptions): Promise<number> {
  if (argv.includes("--help-headless")) {
    process.stdout.write(HEADLESS_HELP + "\n")
    return 0
  }
  const parsedPre = parseHeadlessArgs(argv)
  // First parse pass might fail because the prompt is supposed to come from
  // stdin. Re-run after reading stdin if we have one queued up.
  let piped = ""
  try {
    piped = await readStdinIfPiped()
  } catch (err) {
    process.stderr.write(`error reading stdin: ${err instanceof Error ? err.message : String(err)}\n`)
    return EXIT_BAD_ARGS
  }
  if (piped) {
    if (parsedPre.ok) {
      // Append piped content to the explicit prompt as context.
      parsedPre.args.prompt = `${parsedPre.args.prompt}\n\n${piped.trim()}`
    } else {
      // No prompt was given on CLI; use the piped content as the prompt.
      const retry = parseHeadlessArgs([...argv, "-p", piped.trim()])
      if (!retry.ok) {
        process.stderr.write(`error: ${retry.message}\n\n${HEADLESS_HELP}\n`)
        return EXIT_BAD_ARGS
      }
      return runParsedHeadless(retry.args, watch)
    }
  }
  if (!parsedPre.ok) {
    process.stderr.write(`error: ${parsedPre.message}\n\n${HEADLESS_HELP}\n`)
    return EXIT_BAD_ARGS
  }
  return runParsedHeadless(parsedPre.args, watch)
}

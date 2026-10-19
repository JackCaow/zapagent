#!/usr/bin/env bun
/** @jsxImportSource react */
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { spawn } from "node:child_process"
import { parseWatchArgs } from "./watch/args.js";
import { VERSION } from "./version.js"
import { loadDotEnvFile } from "./dotenv.js"
import { devtoolsPortFromArgs, headlessCwdFromArgs, isHeadlessInvocation } from "./cli-routing.js"

// --help / --version before anything else (no TUI needed)
let args = process.argv.slice(2)
if (args.includes("--help") || args.includes("-h")) {
  console.log(`
zapAgent v${VERSION} — Code flows.

Usage:
  zapAgent [options]

Options:
  -h, --help        Show this help message
  -v, --version     Show version
  --dev [port]      Start DevTools server + open browser (default port 9229)
  --watch           Open a read-only live runtime graph in a local browser
  --watch-port <n>  Use an explicit local port (default: system-assigned)
  --watch-no-open   Print the Watch URL without opening a browser
  --watch-linger <s> Keep the headless viewer available after a run (0..300)
  --help-headless   Show non-interactive (headless) mode flags
  acp              Serve Agent Client Protocol v1 over stdio (no TUI)
  workflow         Inspect, wait for or cancel a persisted workflow (--db required)

Non-interactive mode (no TUI):
  zapAgent -p "<prompt>" [--output-format json|stream-json] [--permission-mode acceptEdits]
  echo "<prompt>" | zapAgent
  zapAgent "<prompt>"          # positional prompt

Slash commands (inside TUI):
  /connect          Connect an AI provider (Anthropic, OpenAI, etc.)
  /config           Open configuration
  /clear            Clear the current conversation
  /compact          Summarize and compact conversation history
  /mem              Browse memory (list / show / forget)
  /shell            Toggle shell mode (run commands directly)
  /help             Show in-app help
  /quit             Exit zapAgent

Keys:
  Enter             Send message
  Shift+Enter       New line  (most modern terminals)
  \\ + Enter        New line  (universal, incl. Apple Terminal)
  Ctrl+C            Cancel running agent / exit
  Ctrl+L            Clear screen
  Ctrl+Q            Manage queued follow-up messages (also /queue)
  ↑ / ↓             Walk prompt history (zsh-style: prefix-filtered,
  Ctrl+P / Ctrl+N   per-project, edge-aware in multi-line buffers)
`.trim())
  process.exit(0)
}
if (args.includes("--version") || args.includes("-v")) {
  console.log(`zapAgent v${VERSION}`)
  process.exit(0)
}

let watchOptions: import("./watch/args.js").WatchOptions;
try {
  const parsed = parseWatchArgs(args);
  args = parsed.args;
  watchOptions = parsed.watch;
  if (watchOptions.lingerSpecified && !isHeadlessInvocation(args, process.stdin.isTTY)) {
    throw new Error("--watch-linger requires headless mode");
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "Invalid Watch arguments"}\n`);
  process.exit(2);
}
if (watchOptions.enabled) {
  if (process.env.ZAPCODE_DEVTOOLS_PORT) process.stderr.write("[watch] Inherited DevTools collection disabled for this process.\n");
  delete process.env.ZAPCODE_DEVTOOLS_PORT;
}

if (args[0] === "workflow") {
  const { runWorkflowCommand } = await import("./headless/workflow.js")
  process.exit(await runWorkflowCommand(args.slice(1)))
}

// Protocol dispatch must precede piped-stdin/headless detection and all Ink
// imports: stdout is exclusively ACP JSON-RPC, never a terminal renderer.
if (args[0] === "acp" || args[0] === "--acp") {
  if (args.length !== 1) { process.stderr.write("usage: zap acp\n"); process.exit(2) }
  const { serveAcp } = await import("./acp/stdio.js")
  await serveAcp()
  process.exit(0)
}
if (args[0] === "--acp-worker") {
  const { runAcpWorker } = await import("./acp/worker.js")
  process.exit(await runAcpWorker())
}

const isHeadless = isHeadlessInvocation(args, process.stdin.isTTY)

// --no-devtools — explicit escape hatch when ZAPCODE_DEVTOOLS_PORT leaked
// from a parent shell. Runs before headless dispatch so the devtools-start
// branch in singletons.ts (gated on the env var) is suppressed cleanly.
if (args.includes("--no-devtools")) {
  delete process.env.ZAPCODE_DEVTOOLS_PORT
}

// --dev [port] — shortcut for ZAPCODE_DEVTOOLS_PORT=<port> + auto-open browser.
// TUI-only: in headless mode `--dev` is not a supported flag, so do not open a
// browser before the headless parser reports the bad argument.
const devPort = !isHeadless && !args.includes("--no-devtools")
  ? devtoolsPortFromArgs(args)
  : null
if (devPort) {
  process.env.ZAPCODE_DEVTOOLS_PORT = devPort
}

// ── Headless / non-interactive mode ────────────────────────────────────
// Triggers (any one):
//   1. -p / --print <text>           explicit prompt flag
//   2. -c / --continue               resume last session (must be paired with a prompt)
//   3. --session-id <id>             explicit session resume
//   4. positional argument           `zapcode "fix this"` (when no other flag claims it)
//   5. stdin is piped (non-TTY)      `echo ... | zapcode`
// In any of these, we dynamic-import the headless entry and skip the entire
// Ink graph below — no TTY ops, no stdin patch, no devtools (unless user
// explicitly set ZAPCODE_DEVTOOLS_PORT before invocation).
if (isHeadless) {
  // --cwd must be applied BEFORE singletons.ts is imported. singletons
  // constructs autoMemory + mdStore against process.cwd() at module load,
  // so a later process.chdir() leaves memory pointed at the original dir
  // (silent split between tools-see-new-cwd / memory-sees-old-cwd).
  const cwdArg = headlessCwdFromArgs(args)
  if (!cwdArg.ok) {
    process.stderr.write(`${cwdArg.message}\n`)
    process.exit(2)
  }
  if (cwdArg.cwd) {
    try { process.chdir(cwdArg.cwd) }
    catch (err) {
      process.stderr.write(`bad --cwd: ${err instanceof Error ? err.message : String(err)}\n`)
      process.exit(2)
    }
  }
  const { runHeadlessFromArgv } = await import("./headless/run.js")
  const code = await runHeadlessFromArgv(args, watchOptions)
  process.exit(code)
}

function openBrowser(url: string): void {
  const platform = process.platform
  const cmd = platform === "darwin" ? "open"
    : platform === "win32" ? "cmd"
    : "xdg-open"
  const cmdArgs = platform === "win32" ? ["/c", "start", "", url] : [url]
  try {
    spawn(cmd, cmdArgs, { stdio: "ignore", detached: true }).unref()
  } catch {
    // User can still open the URL manually from the banner.
  }
}

// Load .env
try {
  const envPath = resolve(fileURLToPath(new URL(".", import.meta.url)), "../.env")
  loadDotEnvFile(envPath)
} catch {}
if (watchOptions.enabled) delete process.env.ZAPCODE_DEVTOOLS_PORT

const [
  { render },
  { App },
  { startDevToolsIfEnabled },
  { startHostProtocolServerIfEnabled, stopHostProtocolServer },
] = await Promise.all([
  import("ink"),
  import("./App.js"),
  import("./devtools-integration.js"),
  import("./agent/hostProtocol.js"),
])

// Wipe the terminal at startup so prior shell output / a previous zap session
// in scrollback don't sit above the Welcome banner. \x1b[2J clears the visible
// viewport, \x1b[3J clears the scrollback (xterm extension; supported by
// iTerm2 / kitty / WezTerm; Apple Terminal silently ignores it but the 2J
// still wipes the viewport so the worst-case is "old stuff scrollable above"
// rather than "old stuff visible".
if (process.stdout.isTTY) {
  process.stdout.write("\x1b[H\x1b[2J\x1b[3J")
}

// Devtools server: opt-in via ZAPCODE_DEVTOOLS_PORT. Start after the startup
// clear so the tokenized URL remains visible above the Ink UI.
if (watchOptions.enabled) {
  try { await (await import("./watch/integration.js")).startWatch(watchOptions); }
  catch { process.stderr.write("[watch] Could not start the local viewer; no Agent run started.\n"); process.exit(2); }
}
const devtoolsHandle = startDevToolsIfEnabled()
if (devPort && devtoolsHandle) {
  queueMicrotask(() => openBrowser(devtoolsHandle.url))
}
const hostProtocolEndpoint = await startHostProtocolServerIfEnabled().catch((error) => {
  process.stderr.write(`[zapcode] host protocol unavailable: ${error instanceof Error ? error.message : String(error)}\n`)
  return undefined
})
if (hostProtocolEndpoint) {
  process.stderr.write(`⚡ host protocol → ${hostProtocolEndpoint.origin} token=${hostProtocolEndpoint.token}\n`)
}

// ── stdin transport decoder ─────────────────────────────────────────────
// Two responsibilities, both handled by a stateful Transform before Ink:
//
// 1. Shift+Enter encoding. Modern terminals disagree:
//      • xterm modifyOtherKeys=2 (Ghostty, foot, recent xterm): ESC [ 27 ; 2 ; 13 ~
//      • CSI u / kitty kbd protocol (kitty, WezTerm with flag):  ESC [ 13 ; 2 u
//      • Legacy meta+enter (iTerm2 default, tmux passthrough):   ESC \r
//    Rewrite all → `\n`.
//
// 2. Window focus reporting. After we send DEC 1004 below, supporting
//    terminals emit ESC[I on focus-in / ESC[O on focus-out. Strip those
//    sequences and forward the state to `terminal-focus` so the prompt
//    can hide its cursor while the window is unfocused. tmux passes 1004
//    through only when `set -g focus-events on`.
//
// Raw mode does not guarantee chunk boundaries. The decoder retains partial
// control sequences across chunks and treats bytes between bracketed-paste
// markers as opaque, so pasted terminal logs cannot be rewritten as focus or
// Shift+Enter events.
//
// The controlled input then treats `\n` as "insert newline at cursor"
// instead of stripping it. Ctrl+J (raw `\n`) gets the same effect, which
// matches most editor conventions.
let inkStdin: NodeJS.ReadStream = process.stdin
if (process.stdin.isTTY) {
  const { setTerminalFocus } = await import("./ui/terminal-focus.js")
  const { createTerminalInputStream } = await import("./ui/terminal-input.js")
  const stdin = process.stdin as NodeJS.ReadStream
  inkStdin = createTerminalInputStream(stdin, setTerminalFocus)

  // Enable focus reporting + disable on exit. Terminals that don't support
  // 1004 just never send focus-out, so we stay in the safe-default
  // focused=true state.
  //
  // setRawMode(true) FIRST: when ?1004h is sent in cooked mode, the
  // terminal's focus-in response (ESC [ I) is echoed back to the screen
  // by the line discipline as `^[[I`, sitting visibly at row 0 col 0
  // until something overwrites it. Raw mode disables that echo. Ink
  // will also set raw mode inside its useEffect on mount; multiple
  // setRawMode(true) calls on the same TTY stream are idempotent.
  if (process.stdout.isTTY) {
    try { stdin.setRawMode(true) } catch {}
    process.stdout.write("\x1b[?1004h")
    process.on("exit", () => { try { process.stdout.write("\x1b[?1004l") } catch {} })
  }
}

// Forward-declared so App can call inst.clear() for /new etc. without going
// through props. Set immediately after render() returns.
declare global { var __zapInkClear: undefined | (() => void) }

// ── Patch presence sentinel ────────────────────────────────────────────
// bun's patchedDependencies keys on the EXACT resolved version. If
// package.json drifts (e.g. ^7.0.2 → 7.0.3) while patches/ink@7.0.2.patch
// stays put, bun silently skips the patch — no error, no warning. Result:
// Apple Terminal auto-mark `[…]` returns, streaming-tail ghost returns,
// scroll-up gets yanked back to tail. Stderr-warn on TTY only so the
// regression is loud at startup; never throw, the app still functions.
if (process.stdout.isTTY) {
  void (async () => {
    const { readFileSync } = await import("node:fs")
    const { dirname, join } = await import("node:path")
    const { createRequire } = await import("node:module")
    const req = createRequire(import.meta.url)
    // ink/package.json is exported (build/*.js isn't), so resolve via that
    // and compute the build dir from its location.
    let buildDir: string
    try { buildDir = join(dirname(req.resolve("ink/package.json")), "build") }
    catch { return } // ink not installed — render() will fail with a real error
    const checks: Array<[string, string]> = [
      ["cursor-helpers.js", "Apple Terminal auto-mark fix"],
      ["ink.js",            "zapcode patch"],
      ["log-update.js",     "pure-append fast path"],
    ]
    const missing: string[] = []
    for (const [file, marker] of checks) {
      try {
        if (!readFileSync(join(buildDir, file), "utf8").includes(marker)) missing.push(file)
      } catch { missing.push(file) }
    }
    if (missing.length > 0) {
      process.stderr.write(
        `\x1b[33m[zapcode] ink patches NOT applied to: ${missing.join(", ")}\n` +
        `          Likely cause: package.json ink version != patches/ink@<version>.patch key.\n` +
        `          Run: rm -rf node_modules/ink && bun install  (and verify versions match)\x1b[0m\n`,
      )
    }
  })()
}

// Ink renders the React tree top-down with log-update style overwrites — no
// alt-screen, no fixed footer band. New output flows below the latest frame
// and the terminal handles scroll natively. The split-footer/capture-stdout
// machinery (and all its Apple Terminal Auto-Mark / scrollback ghost / IME
// race quirks) is gone with the framework swap.
const inst = render(<App />, {
  stdin: inkStdin,
  exitOnCtrlC: false,  // App owns Ctrl+C (cancel running agent → exit)
  // Ink 7 defaults to 30fps (~34ms write windows), which is visible as a
  // delayed prompt/palette update even when React finishes quickly. Streaming
  // is independently coalesced to 20fps and its dynamic tail is bounded, so
  // a 60fps ceiling improves keyboard latency without restoring token-driven
  // render storms.
  maxFps: 60,
  // Diff-based render: only rewrite rows that actually changed each frame
  // instead of "erase whole frame + write whole frame". With the default
  // (false), even DEC-2026-wrapped output keeps the terminal's viewport
  // tracker in "active output" state, which on most terminals (Ghostty,
  // Apple Terminal, conhost) yanks the scrollback viewport back to the
  // bottom every render — making it impossible to scroll up while the
  // agent streams. With incremental on, an unchanged frame emits zero
  // bytes; a frame with one new line emits ~one cursor-move + one row
  // of content. Same observed effect as Claude Code's smooth scroll.
  incrementalRendering: true,
})

globalThis.__zapInkClear = () => inst.clear()

// A frozen main thread cannot explain itself (#1): a sidecar process records a
// stack sample if the heartbeat stops. Diagnostics only, it never kills anything.
void (async () => {
  const [{ startFreezeWatchdog }, { getAppDataDir }, { appLogger }] = await Promise.all([
    import("./watchdog.js"), import("../zapsdk/utils/platform.js"), import("./singletons.js"),
  ])
  const directory = join(getAppDataDir(), "diagnostics")
  startFreezeWatchdog({
    directory,
    onStall: (stalledMs) => appLogger.warn("main_thread_stalled", { stalledMs, diagnostics: directory }),
  })
})().catch(() => {})

// ── Resize ghost cleanup ───────────────────────────────────────────────
// Steady-state ghost prevention (CJK long lines, Static-commit residue)
// is handled in the Ink patch by PRE-WRAPPING the rendered output to
// `termWidth` before handing it to log-update — once logical lines ==
// visual rows, all of log-update's cursorUp / eraseLines math is correct
// by construction.
//
// Resize is the one case the pre-wrap can't fix: when the terminal width
// changes the OS reflows already-printed bytes on screen WITHOUT
// re-running our render. log-update's `previousLines.length` still
// reflects the OLD width's wrap, so its eraseLines undershoots the new
// (taller) visual frame and the top of the old wrap survives.
//
// Fix: detect a width change at clear time. If width changed since the
// last write, redo the erase using visual-row counts at the NEW width —
// including the no-active-cursor state seen while a user drags an unfocused
// terminal window — walk to the old frame's first physical row and erase to
// the end of the viewport. Otherwise — every other clear() call, including every
// Static-commit — delegate to log-update's own clear, which now operates
// on pre-wrapped state and is correct on its own.
if (process.stdout.isTTY) {
  try {
    const { createRequire } = await import("node:module")
    const req = createRequire(import.meta.url)
    const inkMainPath = req.resolve("ink")
    const { dirname, resolve: pathResolve } = await import("node:path")
    const instancesPath = pathResolve(dirname(inkMainPath), "instances.js")
    const instancesMod = await import(instancesPath)
    const inkInstancesMap = instancesMod.default as WeakMap<
      NodeJS.WriteStream,
      { log: import("./ui/resize-log.js").FrameLog }
    >
    const ink = inkInstancesMap.get(process.stdout)
    if (ink?.log) {
      const { createResizeAwareLog } = await import("./ui/resize-log.js")
      ink.log = createResizeAwareLog(ink.log, process.stdout)
    }
  } catch {
    // Ink internals moved or import failed — fall through.
  }
}

// Auto-copy text selection to clipboard isn't a thing under Ink — terminal-
// native selection works directly (no mouse-reporting in Ink mode), so the
// system clipboard captures whatever the user drag-selects without any
// app-side hooks. macOS Cmd-C / pbpaste continue to work as expected.

await inst.waitUntilExit()
await (await import("./watch/integration.js")).stopWatch()
await stopHostProtocolServer()
process.exit(0)

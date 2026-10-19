import { spawn } from "node:child_process"
import { mkdirSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { join } from "node:path"

// Freeze watchdog (#1). A stuck JS main thread cannot report on itself, so a
// separate shell process watches a heartbeat file the main thread touches every
// couple of seconds. When the file goes stale it records `ps`, `lsof` and, where
// available, a native stack `sample` of the stuck process, then keeps watching.
// It only ever writes diagnostics under <data dir>/diagnostics; it never signals
// or kills the process.

export interface FreezeWatchdogOptions {
  /** Where heartbeat and diagnostics go (normally `<data dir>/diagnostics`). */
  directory: string
  /** Stall length that counts as a freeze. */
  thresholdMs?: number
  /** Heartbeat period. */
  intervalMs?: number
  /** Called from the main thread when it notices it was stalled and recovered. */
  onStall?: (stalledMs: number) => void
  pid?: number
}

const KEEP_DIAGNOSTICS = 10

// Argument order: pid, heartbeat file, output prefix, threshold seconds.
const MONITOR = `
# GNU stat first: BSD stat rejects -c, but GNU stat accepts -f (as "filesystem") and prints junk.
mtime() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null; }
stale() { m=$(mtime "$2"); [ -n "$m" ] && [ $(( $(date +%s) - m )) -ge "$1" ]; }
while kill -0 "$1" 2>/dev/null; do
  if stale "$4" "$2"; then
    out="$3-$(date +%Y%m%dT%H%M%S)"
    {
      echo "zap main thread stalled for at least $4s (pid $1)"
      ps -o pid,pcpu,pmem,etime,stat,command -p "$1"
      echo; echo "--- lsof ---"; lsof -p "$1" 2>&1 | head -60
      echo; echo "--- children ---"; pgrep -P "$1" -l 2>&1
    } > "$out.txt" 2>&1
    if command -v sample >/dev/null 2>&1; then sample "$1" 5 -file "$out.sample" >/dev/null 2>&1
    elif command -v eu-stack >/dev/null 2>&1; then eu-stack -p "$1" > "$out.stack" 2>&1
    elif command -v pstack >/dev/null 2>&1; then pstack "$1" > "$out.stack" 2>&1; fi
    while kill -0 "$1" 2>/dev/null && stale "$4" "$2"; do sleep 5; done
  fi
  sleep 2
done
rm -f "$2"
`

/** Returns a stop function. A no-op where the monitor cannot run. */
export function startFreezeWatchdog(options: FreezeWatchdogOptions): () => void {
  if (process.platform === "win32" || process.env.ZAPCODE_NO_WATCHDOG === "1") return () => {}
  const pid = options.pid ?? process.pid
  const thresholdMs = options.thresholdMs ?? 30_000
  const intervalMs = options.intervalMs ?? 2_000
  const heartbeat = join(options.directory, `heartbeat-${pid}`)
  try {
    mkdirSync(options.directory, { recursive: true })
    writeFileSync(heartbeat, "")
    pruneDiagnostics(options.directory)
  } catch {
    return () => {}
  }

  try {
    const monitor = spawn("/bin/sh", ["-c", MONITOR, "zap-watchdog", String(pid), heartbeat,
      join(options.directory, "freeze"), String(Math.max(1, Math.round(thresholdMs / 1000)))],
    { stdio: "ignore", detached: true })
    monitor.on("error", () => {})
    monitor.unref()
  } catch {
    return () => {}
  }

  let last = Date.now()
  const timer = setInterval(() => {
    const now = Date.now()
    const gap = now - last
    last = now
    try { const t = new Date(now); utimesSync(heartbeat, t, t) } catch { /* directory removed */ }
    if (gap >= thresholdMs) options.onStall?.(gap)
  }, intervalMs)
  timer.unref()

  const stop = () => {
    clearInterval(timer)
    try { rmSync(heartbeat, { force: true }) } catch { /* best effort */ }
  }
  process.once("exit", stop)
  return stop
}

function pruneDiagnostics(directory: string): void {
  const groups = new Map<string, number>()
  for (const name of readdirSync(directory)) {
    const match = /^(freeze-\d{8}T\d{6})\./.exec(name)
    if (match) groups.set(match[1]!, Math.max(groups.get(match[1]!) ?? 0, statSync(join(directory, name)).mtimeMs))
  }
  const stale = [...groups.entries()].sort((a, b) => b[1] - a[1]).slice(KEEP_DIAGNOSTICS).map(([prefix]) => prefix)
  for (const name of readdirSync(directory)) {
    if (stale.some(prefix => name.startsWith(`${prefix}.`))) rmSync(join(directory, name), { force: true })
    // Heartbeats left by a crashed process.
    else if (/^heartbeat-\d+$/.test(name) && Date.now() - statSync(join(directory, name)).mtimeMs > 24 * 60 * 60 * 1000) rmSync(join(directory, name), { force: true })
  }
}

import { useState, useEffect, useRef } from "react"
import { appLogger } from "../singletons.js"

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
const DIAG = process.env.ZAPCODE_DIAG === "1"

export function useSpinner(status: string) {
  const [spinIdx, setSpinIdx] = useState(0)
  const [elapsed, setElapsed] = useState(0)
  // Per-second tick counter — when CPU spikes we want log evidence of how
  // many frames the spinner is forcing through React per second. Reset on
  // each second boundary; emit only when DIAG is on so prod logs stay clean.
  const tickStatsRef = useRef({ ticks: 0, windowStart: Date.now() })

  useEffect(() => {
    if (DIAG) appLogger.debug("spinner_status", { status })
    if (status === "ready" || status === "cancelled") {
      setElapsed(0)
      return
    }
    const start = Date.now()
    const timer = setInterval(() => {
      setSpinIdx(i => (i + 1) % SPINNER_FRAMES.length)
      setElapsed(Math.floor((Date.now() - start) / 1000))
      if (DIAG) {
        const stats = tickStatsRef.current
        stats.ticks++
        const now = Date.now()
        if (now - stats.windowStart >= 1000) {
          appLogger.debug("spinner_tick_rate", { ticksPerSec: stats.ticks, status })
          stats.ticks = 0
          stats.windowStart = now
        }
      }
    }, 150)
    return () => clearInterval(timer)
  }, [status])

  return { spinIdx, elapsed, spinnerFrames: SPINNER_FRAMES }
}

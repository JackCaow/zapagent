/**
 * Terminal window focus tracking via DEC 1004 focus reporting.
 *
 * When enabled (sent on startup via index.tsx), supporting terminals emit:
 *   - ESC [ I  → window gained focus
 *   - ESC [ O  → window lost focus
 *
 * The stateful stdin decoder strips these out and calls `setTerminalFocus`.
 * Components subscribe via `useTerminalFocus()` to react to focus changes.
 *
 * Default state is `true` — terminals without 1004 support never send the
 * out-of-focus signal, so we'd rather show the cursor than hide it forever.
 * tmux passes 1004 through only when `set -g focus-events on` is set.
 */
import { useEffect, useState } from "react"

let focused = true
const listeners = new Set<(focused: boolean) => void>()

export function setTerminalFocus(value: boolean): void {
  if (focused === value) return
  focused = value
  for (const l of listeners) l(focused)
}

export function getTerminalFocus(): boolean {
  return focused
}

export function useTerminalFocus(): boolean {
  const [state, setState] = useState(focused)
  useEffect(() => {
    const cb = (v: boolean) => setState(v)
    listeners.add(cb)
    return () => { listeners.delete(cb) }
  }, [])
  return state
}

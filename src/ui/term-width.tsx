/** @jsxImportSource react */
// Live terminal width as React state. Ink's own resize handler relayouts
// Yoga and re-emits output but does NOT trigger a React re-render, so
// components that read `process.stdout.columns` during render keep the
// pre-resize value — Boxes set with `width={termWidth - ...}` stay narrow
// when the terminal widens (e.g. dragging a tmux/iTerm split-pane border).
//
// Provider lives in App.tsx so the resize subscription mounts once and the
// state value also feeds LiveActivity / Footer's `termWidth` prop directly.
// Consumers inside memoized Transcript rows (IndentedRow, DiffRow, markdown
// list rows) read via useTermWidth() — Context invalidation re-renders
// individual consumers even when their memoized parent rows would otherwise
// skip on unchanged log identity.

import { createContext, useContext } from "react"

export const TermWidthContext = createContext<number>(80)

export function useTermWidth(): number {
  return useContext(TermWidthContext)
}

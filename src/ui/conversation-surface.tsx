/** @jsxImportSource react */
import type { ReactNode } from "react"
import { Box } from "ink"

// Static history is printed outside Ink's dynamic Yoga layout. A viewport-
// sized dynamic frame (or a growing spacer) would scroll that history offscreen
// even for a short conversation. Use natural height in native scrollback mode;
// flex only distributes the available width, not an additional screen of rows.
export function ConversationSurface({
  children,
}: {
  children?: ReactNode
}) {
  return (
    <Box flexDirection="column" width="100%" flexShrink={0}>
      {children}
    </Box>
  )
}

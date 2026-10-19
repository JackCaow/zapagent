/** @jsxImportSource react */
import { memo } from "react"
import { Box, Text } from "ink"
import type { Toast } from "./types.js"
import { c } from "./theme.js"

const VARIANT_COLOR: Record<NonNullable<Toast["variant"]>, string> = {
  info:    c.info,
  success: c.success,
  warning: c.warning,
  error:   c.error,
}

export const ToastContainer = memo(function ToastContainer({ toasts }: { toasts: Toast[] }) {
  if (toasts.length === 0) return null
  const latest = toasts[toasts.length - 1]
  const fg = latest.variant ? VARIANT_COLOR[latest.variant] : c.text.muted
  return (
    <Box paddingX={1}>
      <Text color={fg}>{latest.text}</Text>
    </Box>
  )
})

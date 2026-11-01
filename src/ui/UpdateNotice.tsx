/** @jsxImportSource react */
import { Box, Text } from "ink"
import { c } from "./theme.js"
import { VERSION } from "../version.js"
import type { UpdateCheckState } from "../update-check.js"

export function UpdateNotice({ state }: { state: UpdateCheckState }) {
  const message = state.status === "available"
    ? `Update available: v${VERSION} → v${state.version} · /update to download, install and restart`
    : state.status === "checking" ? "Checking for zapAgent updates…"
    : state.status === "current" ? `zapAgent v${VERSION} is up to date.`
    : state.status === "disabled" ? "Automatic update checks disabled · /update to check manually"
    : "Could not check for updates · /update to retry"
  return <Box paddingX={1}><Text color={c.info}>{message}</Text></Box>
}

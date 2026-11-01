/** @jsxImportSource react */
import { Box, Text } from "ink"
import { c } from "./theme.js"
import { VERSION } from "../version.js"
import type { UpdateCheckState } from "../update-check.js"

export function UpdateNotice({ state }: { state: UpdateCheckState }) {
  if (state.status !== "available") return null
  const message = `Update available: v${VERSION} → v${state.version} · /update to download, install and restart`
  return <Box paddingX={1}><Text color={c.info}>{message}</Text></Box>
}

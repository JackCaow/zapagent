/** @jsxImportSource react */
import { Box, Text } from "ink"
import { c } from "./theme.js"
import { VERSION } from "../version.js"

export function UpdateNotice({ version }: { version: string | null }) {
  if (!version) return null
  return <Box paddingX={1}><Text color={c.info}>
    {`Update available: v${VERSION} → v${version} · /update to download, install and restart`}
  </Text></Box>
}

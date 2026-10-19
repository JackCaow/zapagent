/** @jsxImportSource react */
// Welcome banner — sits at the top of the conversation surface and stays
// in scrollback through the session.
//
// Layout: ZAP logo, motto, version·cwd subtitle, and (only when no API
// key is configured) a first-run /connect hint. Provider/model/context
// info lives in the Footer, not here.

import { Box, Text } from "ink"
import { LOGO_LINES } from "./logo.js"
import { c } from "./theme.js"
import { VERSION } from "../version.js"

// Heights below which the full ASCII logo eats too much vertical real
// estate. Compact mode drops the block letters in favor of a single
// accent row.
const COMPACT_ROWS_THRESHOLD = 20

interface WelcomeProps {
  /** When false, render a "type /connect" callout to nudge first-run users. */
  hasApiKey?: boolean
}

function CompactLogo() {
  return (
    <Text color={c.accent} bold>{"⚡  ZAP"}</Text>
  )
}

function FullLogo() {
  return (
    <Box flexDirection="column">
      {LOGO_LINES.map((line, i) => (
        <Text key={i} color={c.accent}>{line}</Text>
      ))}
    </Box>
  )
}

function FirstRunHint() {
  return (
    <Box marginTop={1}>
      <Text color={c.warning} bold>{"▸ "}</Text>
      <Text color={c.warning}>start by typing </Text>
      <Text color={c.accent} bold>/connect</Text>
    </Box>
  )
}

export function Welcome({ hasApiKey = true }: WelcomeProps) {
  const rows = process.stdout.rows ?? 24
  const compactLogo = rows < COMPACT_ROWS_THRESHOLD

  return (
    <Box flexDirection="column" marginY={1} paddingLeft={2}>
      {compactLogo ? <CompactLogo /> : <FullLogo />}
      <Box marginTop={compactLogo ? 0 : 1}>
        <Text color={c.text.ghost} italic>zapAgent. Code flows.</Text>
      </Box>
      <Box>
        <Text color={c.text.faint}>{`v${VERSION}`}</Text>
      </Box>
      {!hasApiKey && <FirstRunHint />}
      {/* Tail padding — Ink Static can eat the very last visible row
          on certain terminals when the dynamic frame writes right
          after the static commit. A trailing blank Box absorbs the
          cut without losing content. */}
      <Box height={1} />
    </Box>
  )
}

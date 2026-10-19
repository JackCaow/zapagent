#!/usr/bin/env bun
// Manual repro for the Shift+Enter regression in tmux.
//
// Uses the same stateful transport decoder as src/index.tsx. Prints every raw
// stdin chunk and the bytes released by the decoder so split escape sequences
// and bracketed-paste framing remain observable. Ctrl+C to exit.

import { TerminalInputDecoder } from "../../src/ui/terminal-input.js"

const stdin = process.stdin
if (!stdin.isTTY) {
  console.error("attach a TTY (run from a terminal, not piped)")
  process.exit(2)
}

stdin.setRawMode(true)
stdin.setEncoding("utf8")
stdin.resume()

const decoder = new TerminalInputDecoder(() => {})

const hex = (s: string): string =>
  [...s].map(ch => ch.charCodeAt(0).toString(16).padStart(2, "0")).join(" ")

process.stdout.write(
  "Press keys. Shift+Enter is the one we care about. Ctrl+C to exit.\r\n" +
  "format: HEX  |  raw  |  after-normalize\r\n" +
  "------------------------------------------------\r\n"
)

stdin.on("data", (chunk: string) => {
  const raw = chunk
  if (raw === "\x03") { process.stdout.write("\r\n(Ctrl+C) bye\r\n"); process.exit(0) }
  const after = decoder.push(raw)
  const matched = after !== raw
  process.stdout.write(
    `${hex(raw).padEnd(40)} | ${JSON.stringify(raw).padEnd(30)} | ${matched ? "MATCHED → \\n" : JSON.stringify(after)}\r\n`
  )
})

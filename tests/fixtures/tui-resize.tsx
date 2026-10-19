/** @jsxImportSource react */
// Deterministic interactive fixture: real transcript/input components, no LLM.
import { useEffect, useState } from "react"
import { Box, Text, render, useInput } from "ink"
import { createRequire } from "node:module"
import { dirname, resolve } from "node:path"
import { ConversationSurface } from "../../src/ui/conversation-surface.js"
import { Transcript } from "../../src/ui/Transcript.js"
import { Prompt } from "../../src/ui/prompt.js"
import { TermWidthContext } from "../../src/ui/term-width.js"
import { setTerminalFocus } from "../../src/ui/terminal-focus.js"
import { createResizeAwareLog, type FrameLog } from "../../src/ui/resize-log.js"
import type { AppConfig } from "../../src/config.js"
import type { LogEntry } from "../../src/ui/types.js"

function Fixture() {
  const [width, setWidth] = useState(process.stdout.columns)
  const [value, setValue] = useState("")
  const [epoch, setEpoch] = useState(0)
  const [dialog, setDialog] = useState(false)
  const [focused, setFocused] = useState(true)
  const [streaming, setStreaming] = useState(false)
  const [tail, setTail] = useState("")
  const [logs, setLogs] = useState<LogEntry[]>([
    { id: 1, type: "user", text: "USER_VISIBLE" },
    { id: 2, type: "agent", text: "ASSISTANT_VISIBLE" },
  ])
  useEffect(() => {
    const resize = () => setWidth(process.stdout.columns)
    process.stdout.on("resize", resize)
    return () => { process.stdout.off("resize", resize) }
  }, [])
  useEffect(() => {
    if (!streaming) return
    let count = 0
    const timer = setInterval(() => {
      count++
      setTail(`STREAM_VISIBLE ${"streaming text ".repeat(count)}`)
    }, 100)
    return () => clearInterval(timer)
  }, [streaming])
  useInput((input, key) => {
    if (!key.ctrl) return
    if (input === "o") setDialog(current => !current)
    if (input === "g") {
      setFocused(current => !current)
      setTerminalFocus(!focused)
    }
    if (input === "s") { setStreaming(current => !current); setTail("") }
  })
  return <TermWidthContext.Provider value={width}>
    <ConversationSurface>
      <Transcript logs={logs} header={<Text>HEADER_VISIBLE</Text>} streamingTail={tail} />
      {dialog ? <Box borderStyle="round"><Text>DIALOG_VISIBLE</Text></Box> : <Prompt
        config={{} as AppConfig} providerLabel="fixture" hasActiveKey inputTokens={0} outputTokens={0}
        focused={!dialog} isRunning={false} inputEpoch={epoch}
        inputValue={value} onInput={setValue}
        onSubmit={text => {
          setLogs(current => [...current, { id: current.length + 1, type: "user", text }])
          setValue(""); setEpoch(current => current + 1)
        }}
      />}
      <Text>FOOTER_READY</Text>
    </ConversationSurface>
  </TermWidthContext.Provider>
}

const instance = render(<Fixture />, { exitOnCtrlC: true, incrementalRendering: true, maxFps: 60 })
const req = createRequire(import.meta.url)
const { default: instances } = await import(resolve(dirname(req.resolve("ink")), "instances.js"))
const ink = (instances as WeakMap<NodeJS.WriteStream, { log: FrameLog }>).get(process.stdout)!
ink.log = createResizeAwareLog(ink.log, process.stdout)
await instance.waitUntilExit()

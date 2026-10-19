/** @jsxImportSource react */
import { useRef, useState } from "react"
import { Box, Text, useInput } from "ink"
import { buildToolGrantRules, EDIT_GRANT_TOOLS, READ_GRANT_TOOLS, type ToolGrantRequest } from "../tool-grants.js"
import { ControlledInput, commandInput, isReturnInput } from "./controlled-input.js"
import { c } from "./theme.js"
import { useHideNativeCursor } from "./dialog-frame.js"

interface Props {
  availableTools: string[]
  initialTools?: string[]
  initialPattern?: string
  onSave: (request: ToolGrantRequest) => string | void
  onCancel: () => void
}

export function ToolGrantDialog({ availableTools, initialTools = [], initialPattern = "", onSave, onCancel }: Props) {
  useHideNativeCursor()
  // Freeze the reviewed registry snapshot: later MCP registrations cannot join it.
  const [tools] = useState(() => [...new Set(availableTools)].filter(name => name !== "delegate_agent").sort())
  const [selected, setSelected] = useState(() => initialTools.filter(name => tools.includes(name)))
  const [step, setStep] = useState(0)
  const [index, setIndex] = useState(0)
  const [pattern, setPattern] = useState(initialPattern)
  const [cursor, setCursor] = useState(initialPattern.length)
  const [resource, setResource] = useState<ToolGrantRequest["resource"]>({ kind: "all" })
  const [lifetime, setLifetime] = useState<ToolGrantRequest["lifetime"]>("session")
  const [error, setError] = useState("")
  const request: ToolGrantRequest = { tools: selected, resource, lifetime }
  const live = useRef({ step, index, selected, pattern, request, onSave, onCancel })
  live.current = { step, index, selected, pattern, request, onSave, onCancel }
  const checkPattern = () => {
    const value = live.current.pattern
    try {
      buildToolGrantRules({ ...live.current.request, resource: { kind: "pattern", value } }, tools)
      setResource({ kind: "pattern", value }); setStep(3); setError("")
    } catch (failure) { setError(String(failure)) }
  }
  useInput((input, key) => {
    const current = live.current
    const cmd = commandInput(input, key)
    if (key.escape) {
      if (current.step === 0) current.onCancel()
      else { setStep(current.step === 4 ? 3 : 0); setError(""); setIndex(0) }
      return
    }
    if (current.step === 2) return // ControlledInput owns text and Return.
    setError("")
    if (current.step === 0) {
      if (key.upArrow) { setIndex(value => Math.max(0, value - 1)); return }
      if (key.downArrow) { setIndex(value => Math.min(tools.length - 1, value + 1)); return }
      if (input === " ") {
        const tool = tools[current.index]
        if (tool) setSelected(values => values.includes(tool) ? values.filter(value => value !== tool) : [...values, tool])
        return
      }
      if (cmd === "r" || cmd === "w" || cmd === "a") {
        const group = cmd === "r" ? READ_GRANT_TOOLS : cmd === "w" ? EDIT_GRANT_TOOLS : tools
        setSelected(tools.filter(tool => group.includes(tool))); return
      }
      if (cmd === "n") { setSelected([]); return }
      if (isReturnInput(input, key)) {
        if (!current.selected.length) { setError("Select at least one tool"); return }
        setStep(1); setIndex(0)
      }
    } else if (current.step === 1) {
      if (cmd === "1") { setResource({ kind: "all" }); setStep(3) }
      if (cmd === "2") setStep(2)
    } else if (current.step === 3) {
      if (cmd === "1" || cmd === "2") { setLifetime(cmd === "1" ? "session" : "project"); setStep(4); setIndex(0) }
    } else if (current.step === 4) {
      if (key.upArrow) { setIndex(value => Math.max(0, value - 1)); return }
      if (key.downArrow) { setIndex(value => Math.min(current.selected.length - 1, value + 1)); return }
      if (isReturnInput(input, key)) {
        const failure = current.onSave(current.request)
        if (failure) setError(failure)
      }
    }
  })
  const start = Math.max(0, Math.min(index - 4, tools.length - 8))
  let preview: string[] = []
  if (step === 4) {
    try { preview = buildToolGrantRules(request, tools).map(rule => rule.pattern) } catch (failure) { preview = [String(failure)] }
  }
  return <Box flexDirection="column" paddingX={1} marginTop={1}>
    <Text bold color={c.text.primary}>Tool authorization — {["select tools", "resource scope", "resource filter", "lifetime", "review authorization"][step]}</Text>
    {step === 0 && <>
      <Text color={c.text.muted}>{selected.length} selected · {tools.length} available · delegate_agent requires scoped approval</Text>
      {tools.slice(start, start + 8).map((tool, offset) => <Text key={tool} color={index === start + offset ? c.accent : c.text.primary}>{index === start + offset ? "›" : " "} [{selected.includes(tool) ? "x" : " "}] {tool}</Text>)}
      <Text color={c.text.muted}>↑↓ navigate · space select · r read · w edit · a all · n none · Enter next · Esc cancel</Text>
    </>}
    {step === 1 && <>
      <Text>1. Entire selected tools (all arguments)</Text>
      <Text>2. Project path glob or Bash command pattern</Text>
      <Text color={c.text.muted}>Tool grants do not authorize sandbox escape. Esc back</Text>
    </>}
    {step === 2 && <>
      <Text color={c.text.muted}>Project-relative path glob, e.g. src/**; Bash alone, e.g. git log:* · Enter next · Esc back</Text>
      <ControlledInput value={pattern} cursorOffset={cursor} onValueChange={value => { setPattern(value.value); setCursor(value.cursorOffset) }} onSubmit={checkPattern} />
    </>}
    {step === 3 && <>
      <Text>1. This session — cleared by /new or session restore</Text>
      <Text>2. This project — persists across restarts in user data</Text>
      <Text color={c.text.muted}>Esc back</Text>
    </>}
    {step === 4 && <>
      <Text color={c.warning}>{lifetime} allow · {selected.length} exact tools · {resource.kind === "all" ? "all arguments" : resource.value}</Text>
      {preview.slice(Math.max(0, index - 4), Math.max(0, index - 4) + 8).map(value => <Text key={value}>allow {value}</Text>)}
      <Text color={c.text.muted}>Deny/ask and execution restrictions still apply. Sandbox escape is separate.</Text>
      <Text color={c.text.muted}>↑↓ review {Math.min(index + 1, selected.length)}/{selected.length} · Enter save authorization · Esc back</Text>
    </>}
    {!!error && <Text color={c.error}>{error}</Text>}
  </Box>
}

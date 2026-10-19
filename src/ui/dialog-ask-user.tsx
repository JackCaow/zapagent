/** @jsxImportSource react */
// ask_user_question bar — one question at a time, numbered options, arrow keys
// + Enter, the last row lets the user type their own answer. Esc dismisses the
// whole set. Multi-select questions toggle with space/Enter and confirm on the
// "Done" row.
import { useState } from "react"
import { Box, Text, useInput } from "ink"
import type { AskUserAnswer, AskUserQuestion } from "../../zapsdk/index.js"
import { DialogFrame } from "./dialog-frame.js"
import { c } from "./theme.js"
import { commandInput, isReturnInput, textBeforeReturn } from "./controlled-input.js"

interface Props {
  questions: AskUserQuestion[]
  onDone: (answers: AskUserAnswer[] | null) => void
}

export function AskUserBar({ questions, onDone }: Props) {
  const [qIndex, setQIndex] = useState(0)
  const [answers, setAnswers] = useState<AskUserAnswer[]>([])
  const [idx, setIdx] = useState(0)
  const [picked, setPicked] = useState<Set<number>>(new Set())
  const [typing, setTyping] = useState<string | null>(null)

  const q = questions[qIndex]!
  const multi = q.multiSelect === true
  // Rows: the options, then "Other…", then (multi only) "Done".
  const rows = [...q.options.map(o => o.label), "Other (type your own answer)", ...(multi ? ["Done"] : [])]
  const otherRow = q.options.length
  const doneRow = multi ? otherRow + 1 : -1

  const finish = (answer: AskUserAnswer) => {
    const next = [...answers, answer]
    if (qIndex + 1 >= questions.length) { onDone(next); return }
    setAnswers(next); setQIndex(qIndex + 1); setIdx(0); setPicked(new Set()); setTyping(null)
  }

  const choose = (row: number) => {
    if (row === otherRow) { setTyping(""); return }
    if (multi) {
      if (row === doneRow) {
        finish({ question: q.question, answers: [...picked].sort().map(i => q.options[i]!.label) })
        return
      }
      setPicked(prev => { const next = new Set(prev); next.has(row) ? next.delete(row) : next.add(row); return next })
      return
    }
    finish({ question: q.question, answers: [q.options[row]!.label] })
  }

  useInput((input, key) => {
    if (typing !== null) {
      if (key.escape) { setTyping(null); return }
      if (isReturnInput(input, key)) {
        const text = `${typing}${textBeforeReturn(input).replace(/[\r\n]/g, "")}`.trim()
        if (text) finish({ question: q.question, answers: [text], custom: true })
        return
      }
      if (key.backspace || key.delete) { setTyping(typing.slice(0, -1)); return }
      if (key.ctrl || key.meta) return
      const printable = input.replace(/[\r\n]/g, "")
      if (printable) setTyping(typing + printable)
      return
    }
    if (key.escape) { onDone(null); return }
    if (key.upArrow) { setIdx(i => (i - 1 + rows.length) % rows.length); return }
    if (key.downArrow) { setIdx(i => (i + 1) % rows.length); return }
    const digit = commandInput(input, key)
    if (digit !== null && /^[1-9]$/.test(digit) && Number(digit) <= rows.length) { choose(Number(digit) - 1); return }
    if (multi && input === " ") { choose(idx); return }
    if (isReturnInput(input, key)) choose(idx)
  })

  const title = `${q.header ? `${q.header} · ` : ""}${questions.length > 1 ? `${qIndex + 1}/${questions.length}` : "Question"}`
  if (typing !== null) {
    return (
      <DialogFrame title={title} hint="⏎ send  esc back" accentColor={c.accent}>
        <Text color={c.text.primary}>{q.question}</Text>
        <Box>
          <Text color={c.accent}>{"❯ "}</Text>
          <Text color={c.text.primary}>{typing}</Text>
        </Box>
      </DialogFrame>
    )
  }
  return (
    <DialogFrame title={title} hint={multi ? "↑/↓ move  space toggle  ⏎ select  esc dismiss" : "↑/↓ move  ⏎ select  esc dismiss"} accentColor={c.accent}>
      <Text color={c.text.primary}>{q.question}</Text>
      {rows.map((label, i) => {
        const active = i === idx
        const mark = multi && i < q.options.length ? (picked.has(i) ? "[x] " : "[ ] ") : ""
        const description = q.options[i]?.description
        return (
          <Box key={`${qIndex}-${i}`} flexDirection="column">
            <Box>
              <Text color={active ? c.accent : c.text.muted}>{`${i + 1}. `}</Text>
              <Text color={active ? c.text.primary : c.text.muted} bold={active}>{`${mark}${label}`}</Text>
            </Box>
            {active && description ? <Text color={c.text.faint}>{`   ${description}`}</Text> : null}
          </Box>
        )
      })}
    </DialogFrame>
  )
}

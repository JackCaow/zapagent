/** @jsxImportSource react */
// Tmux-driven repro for the "ApprovalBar leaks into scrollback" bug.
//
// Run via approval-scrollback-verify.sh — it spawns a 120x30 tmux pane,
// runs this harness, captures the full pane buffer (visible + scrollback),
// and greps for dialog body text. The dialog text should NOT exist in the
// captured buffer once the harness has dismissed the dialog.
//
// What this exercises (mirrors the real app's bug conditions):
//   - A pre-seeded transcript that fills most of the 30-row viewport.
//   - Static-committed log lines (one every 150ms) simulating streaming
//     chunks / other parallel tool output landing while the dialog is up.
//   - ApprovalBar with bash-tool props matching production.
//   - At 1.5s, the dialog is programmatically dismissed (onChoose called
//     directly — equivalent to the user pressing "1", but doesn't require
//     raw-mode stdin injection).
//   - The harness uses the real useLogs hook + setStaticCommitFrozen so
//     the freeze-during-dialog behavior is the production path, not a
//     handwritten reduction.
//   - Continues streaming for ~1s after dismiss to confirm the buffered
//     entries flush cleanly into Static without leaking the dialog body.
import React, { useEffect, useRef, useState } from "react"
import { Box, Text, Static, render } from "ink"
import { ApprovalBar, type ApprovalChoice } from "../../src/ui/dialog-approval.js"
import { useLogs } from "../../src/hooks/useLogs.js"

function Harness() {
  const { logs, addLog, setStaticCommitFrozen } = useLogs()
  const [showDialog, setShowDialog] = useState(true)
  const counterRef = useRef(0)
  const seededRef = useRef(false)

  // Pre-seed transcript with 40 lines so the dynamic frame mounts at
  // viewport bottom — bug needs that proximity to manifest.
  useEffect(() => {
    if (seededRef.current) return
    seededRef.current = true
    for (let i = 1; i <= 40; i++) addLog("system", `transcript-line-${i}`)
  }, [addLog])

  // Freeze Static commits while the dialog is up. Mirrors how App.tsx
  // ties freeze to pendingApproval !== null. Set `FREEZE=0` in the env
  // to disable — used by the verify script for negative-control runs.
  useEffect(() => {
    if (process.env.FREEZE === "0") return
    setStaticCommitFrozen(showDialog)
  }, [showDialog, setStaticCommitFrozen])

  // Stream pressure: addLog every 150ms.
  useEffect(() => {
    const id = setInterval(() => {
      counterRef.current++
      addLog("system", `streaming-chunk-${counterRef.current}`)
    }, 150)
    return () => clearInterval(id)
  }, [addLog])

  // Programmatic dismiss at 1.5s — same end state as the user pressing 1.
  useEffect(() => {
    const id = setTimeout(() => {
      setShowDialog(false)
      addLog("system", "post-dismiss-marker")
    }, 1500)
    return () => clearTimeout(id)
  }, [addLog])

  // Exit ~1s after dismiss so tmux capture has a deterministic end. Also
  // gives the post-dismiss Static flush + a few more streaming chunks a
  // chance to commit cleanly.
  useEffect(() => {
    if (showDialog) return
    const id = setTimeout(() => process.exit(0), 1200)
    return () => clearTimeout(id)
  }, [showDialog])

  const noopChoose = (_choice: ApprovalChoice) => { /* see useEffect above */ }

  return (
    <Box flexDirection="column">
      <Static items={logs}>
        {(log) => <Text key={log.id} color="gray">{`· ${log.text}`}</Text>}
      </Static>
      <Box>
        <Text color="green">live-activity-line</Text>
      </Box>
      {showDialog && (
        <ApprovalBar
          toolName="bash"
          args={{ command: "cd /Users/example/Desktop/workspace && git status" }}
          onChoose={noopChoose}
          rulePreview="Bash(git status:*)"
        />
      )}
    </Box>
  )
}

render(<Harness />)

/** @jsxImportSource react */
import { useEffect, useMemo, useRef, useState } from "react"
import { Box, Text, useInput } from "ink"
import stripAnsi from "strip-ansi"
import { permissionManager, appLogger } from "../singletons.js"
import { SANDBOX_ESCAPE_RULE, type AnnotatedRuleGroup, type RuleRemovalScope } from "../permissions.js"
import type { WorkspaceChoice } from "../workspace-access.js"
import { DialogFrame } from "./dialog-frame.js"
import { c } from "./theme.js"
import { truncateToWidth } from "./truncate.js"
import { ToolGrantDialog } from "./dialog-tool-grant.js"
import { buildToolGrantRules } from "../tool-grants.js"
import { commandInput, isReturnInput } from "./controlled-input.js"
import { describeCapabilityPatterns } from "../capabilities.js"
import { useTermWidth } from "./term-width.js"
import { readCurrentSessionLogs, type SessionLog } from "../session.js"
import type { LogEntry } from "./types.js"

interface Props {
  cwd: string
  remembered: boolean
  readOnly: boolean
  logs: readonly LogEntry[]
  availableTools: string[]
  onWorkspaceChoice: (choice: WorkspaceChoice) => void
  onCancel: () => void
}

const tabs = ["Workspace", "Rules", "Recently blocked"] as const
const filters = ["all", "allow", "ask", "deny"] as const
const filterLabels = ["All rules", "Allow", "Ask", "Deny"] as const
const pageSize = 6

function scopeOf(group: AnnotatedRuleGroup): RuleRemovalScope {
  if (group.label === "project grants") return "project-grants"
  return group.label === "personal" ? "local" : group.label === "session" ? "session" : group.label === "global" ? "global" : "project"
}

function recentBlocks(logs: readonly SessionLog[]) {
  const blocks: Array<{ id: number; action: string; reason: string }> = []
  for (let i = logs.length - 1; i >= 0 && blocks.length < 20; i--) {
    const log = logs[i]
    if (log.type !== "system") continue
    if (log.permissionBlock) {
      blocks.push({ id: i, ...log.permissionBlock })
      continue
    }
    // Restored transcripts already contain these notices, including older sessions.
    const denied = /^Permission: denied (.+?) — (.+)/s.exec(log.text)
    const declined = /^Permission: user denied (.+)/s.exec(log.text)
    if (denied) blocks.push({ id: i, action: denied[1], reason: denied[2] })
    else if (declined) blocks.push({ id: i, action: declined[1], reason: "Declined by you" })
  }
  return blocks
}

export function PermissionsDialog({ cwd, remembered, readOnly, logs, availableTools, onWorkspaceChoice, onCancel }: Props) {
  const width = Math.max(8, useTermWidth() - 2)
  const [cursor, setCursor] = useState({ tabIndex: 0, filterIndex: 0, selected: 0 })
  const nextCursor = useRef(cursor)
  nextCursor.current = cursor
  const [revision, setRevision] = useState(0)
  const [confirming, setConfirming] = useState<"delete" | "clear">()
  const [grantOpen, setGrantOpen] = useState(false)
  const [error, setError] = useState("")
  const { tabIndex, filterIndex, selected } = cursor
  const tab = tabs[tabIndex]
  const filter = filters[filterIndex]

  const workspaceOptions: Array<{ id: WorkspaceChoice; text: string }> = [
    { id: "project", text: "Remember project access" },
    { id: "analyze", text: "Keep this session read-only" },
  ]
  if (remembered) workspaceOptions.push({ id: "revoke", text: "Forget project access" })

  const rules = useMemo(() => permissionManager.getSummaryAnnotated().flatMap(group => group.rules
    .filter(({ rule }) => rule.pattern !== SANDBOX_ESCAPE_RULE)
    .map(annotated => ({ group, ...annotated }))), [revision])
  const filteredRules = filter === "all" ? rules : rules.filter(({ rule }) => rule.type === filter)
  const [journalBlocks, setJournalBlocks] = useState<ReturnType<typeof recentBlocks>>([])
  const latestBlock = tab === "Recently blocked" ? logs.findLast(log => log.permissionBlock) : undefined
  useEffect(() => {
    // The transcript can be cleared during compaction. Reread the same session
    // journal on arrival and when the visible transcript receives a new denial.
    if (tab === "Recently blocked") setJournalBlocks(recentBlocks(readCurrentSessionLogs()))
  }, [tab, latestBlock])
  const blocked = tab === "Recently blocked" && !journalBlocks.length ? recentBlocks(logs) : journalBlocks
  const total = tab === "Workspace" ? workspaceOptions.length : tab === "Rules" ? filteredRules.length : blocked.length
  const index = Math.max(0, Math.min(selected, total - 1))
  const start = Math.max(0, Math.min(index - Math.floor(pageSize / 2), total - pageSize))
  const selectedBlock = blocked[index]

  const removeRule = ({ group, rule }: typeof rules[number]) => {
    try { permissionManager.removeRule(rule.pattern, rule.type, scopeOf(group), rule.canonicalPath === true) }
    catch (failure) { setError(String(failure)) }
  }

  const moveCursor = (next: typeof cursor) => {
    nextCursor.current = next
    setCursor(next)
    setConfirming(undefined)
  }

  useInput((input, key) => {
    const cmd = commandInput(input, key)
    const next = nextCursor.current
    if (key.escape) {
      if (confirming) setConfirming(undefined)
      else onCancel()
      return
    }
    if (key.leftArrow || key.rightArrow || cmd === "p") {
      moveCursor({ ...next, tabIndex: cmd === "p" ? 0 : (next.tabIndex + (key.leftArrow ? -1 : 1) + tabs.length) % tabs.length, selected: 0 })
      setError("")
      return
    }
    if (key.upArrow || key.downArrow) {
      if (total && next.tabIndex === tabIndex && next.filterIndex === filterIndex) {
        const selected = (Math.min(next.selected, total - 1) + (key.upArrow ? -1 : 1) + total) % total
        moveCursor({ ...next, selected })
      }
      return
    }
    // Ink can deliver navigation and confirmation in one input batch.
    // Act only on a selection the dialog has rendered.
    if (next !== cursor) return
    if (tab === "Workspace" && isReturnInput(input, key)) {
      onWorkspaceChoice(workspaceOptions[index].id)
      return
    }
    if (cmd === "a") {
      moveCursor({ tabIndex: 1, filterIndex: 0, selected: 0 })
      setGrantOpen(true)
      return
    }
    if (tab !== "Rules") return
    if (cmd === "f") {
      moveCursor({ ...cursor, filterIndex: (filterIndex + 1) % filters.length, selected: 0 })
      return
    }
    const rule = filteredRules[index]
    if (cmd === "d" && rule) {
      if (confirming !== "delete") { setConfirming("delete"); return }
      removeRule(rule)
      try { appLogger.info(`permission_remove pattern=${rule.rule.pattern} type=${rule.rule.type}`) } catch {}
    } else if (cmd === "c" && rules.some(({ group }) => group.label !== "session")) {
      if (confirming !== "clear") { setConfirming("clear"); return }
      rules.filter(({ group }) => group.label !== "session").forEach(removeRule)
      try { appLogger.info("permission_clear_all") } catch {}
    } else return
    setConfirming(undefined)
    setRevision(value => value + 1)
  }, { isActive: !grantOpen })

  if (grantOpen) return <ToolGrantDialog availableTools={availableTools} onCancel={() => setGrantOpen(false)} onSave={(request, reviewedRules) => {
    try {
      permissionManager.addToolRules(buildToolGrantRules(request, availableTools, cwd, reviewedRules), request.lifetime)
      setGrantOpen(false)
      setRevision(value => value + 1)
    } catch (failure) { return String(failure) }
  }} />

  const labels = width >= 37 ? tabs : ["Work", "Rules", "Blocked"]
  const hint = tab === "Workspace" ? "←→ tabs · ↑↓ select · enter confirm · esc close"
    : tab === "Rules" ? "←→ tabs · ↑↓ select · f filter · a add · d delete · c clear all · esc close"
    : "←→ tabs · ↑↓ select · esc close"
  const row = (text: string, active: boolean) => <Text color={active ? c.accent : c.text.primary} bold={active}>
    {active ? "› " : "  "}{truncateToWidth(stripAnsi(text), width - 2)}
  </Text>

  return <DialogFrame title="Permissions" hint={hint}>
    <Text wrap="truncate-end">
      {width < 22 ? <Text bold color={c.accent}>{`[${truncateToWidth(tab, width - 2)}]`}</Text>
      : labels.map((label, i) => <Text key={tabs[i]} bold={i === tabIndex} color={i === tabIndex ? c.accent : c.text.muted}>
        {i ? "  " : ""}{i === tabIndex ? `[${label}]` : label}
      </Text>)}
    </Text>
    <Box flexDirection="column" marginTop={1}>
      {tab === "Workspace" && <>
        <Text color={c.text.muted} wrap="truncate-middle">{`Project · ${cwd}`}</Text>
        <Text color={c.text.secondary}>{remembered ? "Project access saved" : "Project access is not saved"}</Text>
        {readOnly && <Text color={c.warning}>Session is read-only</Text>}
        <Box flexDirection="column" marginTop={1}>
          {workspaceOptions.map((option, i) => <Box key={option.id}>{row(option.text, i === index)}</Box>)}
        </Box>
      </>}
      {tab === "Rules" && <>
        <Text color={c.text.muted}>{`${filterLabels[filterIndex]} · ${filteredRules.length}`}</Text>
        {!total && <Text color={c.text.muted}>{filter === "all" ? "No permission rules active." : "No matching permission rules."}</Text>}
        {filteredRules.slice(start, start + pageSize).map(({ group, rule, shadowedBy }, offset) => {
          const i = start + offset
          const capability = describeCapabilityPatterns([rule.pattern])
          return <Box key={i} flexDirection="column">
            {(offset === 0 || filteredRules[i - 1].group !== group) &&
              <Text color={c.text.faint} wrap="truncate-middle">{`${group.label} · ${group.source}`}</Text>}
            {row(`${rule.type} ${rule.pattern}${rule.canonicalPath ? " (fixed folder target)" : ""}${capability ? ` — ${capability}` : ""}`, i === index)}
            {i === index && shadowedBy && <Text color={c.text.faint} wrap="truncate-end">{`  Shadowed by ${shadowedBy.rule.type} ${shadowedBy.rule.pattern} (${shadowedBy.scope})`}</Text>}
          </Box>
        })}
        {confirming === "clear" && <Text color={c.error}>Press c again to clear all persisted rules.</Text>}
        {confirming === "delete" && <Text color={c.error}>Press d again to delete this rule.</Text>}
        {!!error && <Text color={c.error}>{error}</Text>}
      </>}
      {tab === "Recently blocked" && <>
        <Text color={c.text.muted}>{total ? "Blocked in this conversation" : "No blocked actions in this conversation."}</Text>
        {blocked.slice(start, start + pageSize).map((block, offset) => <Box key={block.id}>{row(block.action, index === start + offset)}</Box>)}
        {selectedBlock && <Box marginTop={1}><Text color={c.text.secondary}>{stripAnsi(selectedBlock.reason)}</Text></Box>}
      </>}
      {total > pageSize && <Text color={c.text.faint}>{`${index + 1}/${total}`}</Text>}
    </Box>
  </DialogFrame>
}

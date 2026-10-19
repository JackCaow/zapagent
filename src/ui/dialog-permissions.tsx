/** @jsxImportSource react */
// /permissions — list every active permission rule (across all four
// scopes: session / local / project / global) with shadow markers,
// allow per-rule deletion (`d` then `d` again to confirm) and a full
// clear (`c` then `c` again) for persisted rules.
//
// Layout matches the opentui-era dialog so users get the same visual:
//
//   global (~/.zapcode/settings.json)  (Global)
//   ❯ allow Bash(pwd:*)
//     allow Bash(printf:*)              ⤴ shadowed by allow Bash(*) (project)
//     ...
//
//   ┌──────────────────────────────────────┐
//   │ ↑↓ navigate · d delete · c clear all │
//   └──────────────────────────────────────┘
import { useMemo, useState } from "react"
import { Box, Text, useInput } from "ink"
import { permissionManager, appLogger } from "../singletons.js"
import type { AnnotatedRuleGroup, RuleRemovalScope } from "../permissions.js"
import { useHideNativeCursor } from "./dialog-frame.js"
import { c } from "./theme.js"
import { truncateToWidth } from "./truncate.js"
import { ToolGrantDialog } from "./dialog-tool-grant.js"
import { buildToolGrantRules } from "../tool-grants.js"
import { commandInput } from "./controlled-input.js"

interface Props { onCancel: () => void; availableTools: string[] }

function scopeOf(group: AnnotatedRuleGroup): RuleRemovalScope {
  if (group.label === "project grants") return "project-grants"
  return group.label === "personal" ? "local" : group.label === "session" ? "session" : group.label === "global" ? "global" : "project"
}

interface FlatRule {
  group: AnnotatedRuleGroup
  groupIdx: number
  ruleIdx: number
  flatIdx: number
}

function flattenRules(groups: AnnotatedRuleGroup[]): FlatRule[] {
  const out: FlatRule[] = []
  let flat = 0
  groups.forEach((group, groupIdx) => {
    group.rules.forEach((_rule, ruleIdx) => {
      out.push({ group, groupIdx, ruleIdx, flatIdx: flat++ })
    })
  })
  return out
}

export function PermissionsDialog({ onCancel, availableTools }: Props) {
  useHideNativeCursor()
  const [tick, setTick] = useState(0)
  const [grantOpen, setGrantOpen] = useState(false)
  const [error, setError] = useState("")
  const groups = useMemo(() => permissionManager.getSummaryAnnotated(), [tick])
  const flatRules = useMemo(() => flattenRules(groups), [groups])
  const total = flatRules.length

  const [selectedIdx, setSelectedIdx] = useState(0)
  const [confirmingDeleteIdx, setConfirmingDeleteIdx] = useState(-1)
  const [confirmingClear, setConfirmingClear] = useState(false)

  // Keep selection in range as rules are deleted.
  const safeIdx = total === 0 ? -1 : Math.min(selectedIdx, total - 1)

  useInput((input, key) => {
    const cmd = commandInput(input, key)
    if (key.escape) {
      if (confirmingDeleteIdx >= 0) { setConfirmingDeleteIdx(-1); return }
      if (confirmingClear)          { setConfirmingClear(false);  return }
      onCancel(); return
    }
    if (cmd === "a") { setGrantOpen(true); return }
    if (total === 0) return

    if (key.upArrow) {
      setSelectedIdx(i => (i - 1 + total) % total)
      setConfirmingDeleteIdx(-1)
      setConfirmingClear(false)
      return
    }
    if (key.downArrow) {
      setSelectedIdx(i => (i + 1) % total)
      setConfirmingDeleteIdx(-1)
      setConfirmingClear(false)
      return
    }

    // Two-press delete: first `d` arms, second `d` commits.
    if (cmd === "d") {
      if (confirmingDeleteIdx === safeIdx) {
        const flat = flatRules[safeIdx]
        if (flat) {
          const rule = flat.group.rules[flat.ruleIdx]
          if (rule) {
            try {
              permissionManager.removeRule(rule.rule.pattern, rule.rule.type, scopeOf(flat.group))
              try { appLogger.info(`permission_remove pattern=${rule.rule.pattern} type=${rule.rule.type}`) } catch {}
            } catch (failure) { setError(String(failure)) }
          }
        }
        setConfirmingDeleteIdx(-1)
        setTick(t => t + 1)
        return
      }
      setConfirmingDeleteIdx(safeIdx)
      setConfirmingClear(false)
      return
    }

    // Two-press clear-all: first `c` arms, second `c` commits.
    if (cmd === "c") {
      if (confirmingClear) {
        // Drop every rule in every persisted scope. Session rules are
        // not touched (those die when the process exits anyway).
        for (const g of groups) {
          if (g.label === "session") continue
          for (const r of g.rules) {
            try { permissionManager.removeRule(r.rule.pattern, r.rule.type, scopeOf(g)) } catch (failure) { setError(String(failure)) }
          }
        }
        try { appLogger.info("permission_clear_all") } catch {}
        setConfirmingClear(false)
        setConfirmingDeleteIdx(-1)
        setTick(t => t + 1)
        return
      }
      setConfirmingClear(true)
      setConfirmingDeleteIdx(-1)
      return
    }
  }, { isActive: !grantOpen })

  if (grantOpen) return <ToolGrantDialog availableTools={availableTools} onCancel={() => setGrantOpen(false)} onSave={request => {
    try {
      permissionManager.addToolRules(buildToolGrantRules(request, availableTools), request.lifetime)
      setGrantOpen(false); setTick(value => value + 1)
    } catch (failure) { return String(failure) }
  }} />

  if (total === 0) {
    return (
      <Box flexDirection="column" paddingX={1} marginTop={1}>
        <Text color={c.text.muted}>No permission rules active.</Text>
        {!!error && <Text color={c.error}>{error}</Text>}
        <Text color={c.text.ghost}>Press a to add tool authorization.</Text>
        <Box paddingX={1} marginTop={1}>
          <Text color={c.text.faint}>a add authorization · esc close</Text>
        </Box>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box flexDirection="column" paddingX={1}>
        {groups.map((group) => (
          <Box key={group.source} flexDirection="column" marginBottom={1}>
            <Text color={c.text.ghost}>{`${group.source}  (${group.label})`}</Text>
            {group.rules.map((annotated, ruleIdx) => {
              const flatIdx = flatRules.findIndex(
                f => f.group === group && f.ruleIdx === ruleIdx,
              )
              const isSelected   = flatIdx === safeIdx
              const isConfirming = flatIdx === confirmingDeleteIdx
              const { rule, shadowedBy } = annotated
              return (
                <Box
                  key={`${group.label}::${rule.type}::${rule.pattern}`}
                  flexDirection="column"
                >
                  <Box flexDirection="row">
                    <Box width={6}>
                      <Text color={isSelected ? c.text.primary : c.text.muted} bold={isSelected}>
                        {rule.type}
                      </Text>
                    </Box>
                    <Text color={isSelected ? c.text.primary : c.text.muted} wrap="truncate-end">
                      {truncateToWidth(rule.pattern, 60)}
                    </Text>
                    {shadowedBy && (
                      <Text color={c.text.ghost} wrap="truncate-end">
                        {truncateToWidth(`  ⤴ shadowed by ${shadowedBy.rule.type} ${shadowedBy.rule.pattern} (${shadowedBy.scope})`, 70)}
                      </Text>
                    )}
                  </Box>
                  {isConfirming && (
                    <Box paddingLeft={4}>
                      <Text color={c.error}>Press d again to delete this rule</Text>
                    </Box>
                  )}
                </Box>
              )
            })}
          </Box>
        ))}
      </Box>
      {!!error && <Text color={c.error}>{error}</Text>}
      <Box paddingX={1} marginTop={1} flexDirection="column">
        {confirmingClear ? (
          <Text color={c.error}>Press c again to remove ALL persisted rules (session rules untouched)</Text>
        ) : (
          <Text color={c.text.faint}>↑↓ navigate  ·  d delete  ·  c clear all  ·  a add authorization · esc close</Text>
        )}
      </Box>
    </Box>
  )
}

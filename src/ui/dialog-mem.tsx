/** @jsxImportSource react */
// /mem — browse the markdown memory store. Two-pane state:
//   1. list of all memory records (PickerDialog)
//   2. detail view of one record (Markdown body) — esc returns to list,
//      'd' deletes after a confirmation row
import { useMemo, useState } from "react"
import { Box, Text, useInput } from "ink"
import { globalMdStore, mdStore } from "../singletons.js"
import { DialogFrame } from "./dialog-frame.js"
import { PickerDialog, type PickerOption } from "./dialog-picker.js"
import { Markdown } from "./markdown.js"
import { c } from "./theme.js"
import { commandInput } from "./controlled-input.js"
import {
  deleteScopedMemoryRecord,
  findScopedMemoryRecord,
  formatScopedMemoryMeta,
  formatScopedMemoryReviewNotices,
  formatScopedMemorySuggestionNotices,
  formatScopedMemoryTitle,
  listScopedMemoryRecords,
  type ScopedMemoryRecord,
} from "./mem-dialog-model.js"

interface Props { onCancel: () => void }

export function MemDialog({ onCancel }: Props) {
  const [openName, setOpenName] = useState<string | null>(null)
  const [refreshTick, setRefreshTick] = useState(0)
  const records = useMemo(() => listScopedMemoryRecords({
    projectStore: mdStore,
    globalStore: globalMdStore,
  }), [refreshTick])

  if (openName) {
    const rec = findScopedMemoryRecord(records, openName)
    if (!rec) { setOpenName(null); return null }
    return (
      <MemDetail
        rec={rec}
        onBack={() => setOpenName(null)}
        onDelete={() => {
          deleteScopedMemoryRecord(rec)
          setOpenName(null)
          setRefreshTick(t => t + 1)
        }}
      />
    )
  }

  const options: PickerOption[] = records.length > 0
    ? records.map(r => ({
        id: r.id,
        label: r.record.frontmatter.name,
        meta: formatScopedMemoryMeta(r),
      }))
    : [{ id: "__none", label: "No memories saved", disabled: true }]

  return (
    <PickerDialog
      title="Memory"
      options={options}
      onCancel={onCancel}
      hint="↑/↓ select  ⏎ open  esc cancel"
      onSelect={(id) => {
        if (id === "__none") { onCancel(); return }
        setOpenName(id)
      }}
    />
  )
}

function MemDetail({
  rec,
  onBack,
  onDelete,
}: {
  rec: ScopedMemoryRecord
  onBack: () => void
  onDelete: () => void
}) {
  const [confirming, setConfirming] = useState(false)
  const reviewNotices = formatScopedMemoryReviewNotices(rec)
  const suggestionNotices = formatScopedMemorySuggestionNotices(rec)

  useInput((input, key) => {
    const cmd = commandInput(input, key)
    if (key.escape) {
      if (confirming) { setConfirming(false); return }
      onBack()
      return
    }
    if (cmd === "d" && !confirming) { setConfirming(true); return }
    if (cmd === "y" && confirming) { onDelete(); return }
    if (cmd === "n" && confirming) { setConfirming(false); return }
  })

  const hint = confirming
    ? "Delete this memory? y / n"
    : "d delete  esc back"

  return (
    <DialogFrame
      title={formatScopedMemoryTitle(rec)}
      hint={hint}
      accentColor={confirming ? c.warning : undefined}
    >
      <Box flexDirection="column">
        {reviewNotices.length > 0 && (
          <Box flexDirection="column" marginBottom={1}>
            {reviewNotices.map((notice) => (
              <Text key={notice} color={c.warning}>{notice}</Text>
            ))}
          </Box>
        )}
        {suggestionNotices.length > 0 && (
          <Box flexDirection="column" marginBottom={1}>
            {suggestionNotices.map((notice) => (
              <Text key={notice} color={c.info}>{notice}</Text>
            ))}
          </Box>
        )}
        <Text color={c.text.muted}>{rec.record.frontmatter.description}</Text>
        <Box marginTop={1} flexDirection="column">
          <Markdown source={rec.record.body} />
        </Box>
      </Box>
    </DialogFrame>
  )
}

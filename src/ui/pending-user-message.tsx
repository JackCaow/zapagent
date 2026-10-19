/** @jsxImportSource react */
import { Box } from "ink"
import type { QueueEntry } from "../queue/messageQueue.js"
import { looksLikeDroppedFilePath } from "../commands/submit.js"
import { UserMessage } from "./Transcript.js"

/** Render the durable send receipt immediately, outside Static/journal logs.
 * Canonical acceptance replaces this preview with the normal transcript row;
 * preparation failure leaves ownership with the retryable queue entry. */
export function PendingUserMessage({ entry }: { entry?: QueueEntry }) {
  if (!entry || entry.mode !== "queue" || !["queued", "dispatching"].includes(entry.state)) return null
  // Slash commands already echo through dispatchCommand. Absolute file paths
  // are ordinary prompts and must keep their immediate preview.
  if (entry.text.startsWith("/") && !looksLikeDroppedFilePath(entry.text)) return null
  return <Box paddingX={1} flexDirection="column">
    <UserMessage deliveryState="pending" log={{
      id: -1, type: "user", text: entry.displayForm, restoreText: entry.restoreText,
      images: entry.images?.map(({ content }) => ({
        filePath: content.filePath, source: content.source, mediaType: content.mediaType,
      })),
    }} />
  </Box>
}

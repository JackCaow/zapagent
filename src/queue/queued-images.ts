import type { ImageContent } from "../../zapsdk/core/types.js"
import { loadImageFromFile } from "../../zapsdk/utils/image.js"

/** The pending-message journal is rewritten on every queue change. Pasted
 *  images are already on disk, so the journal keeps only their file reference
 *  and drops the inline base64 (several MB per screenshot), which otherwise
 *  made every enqueue, claim and edit serialize and fsync tens of MB. */
export function journalReplacer(key: string, value: unknown): unknown {
  return key === "base64" ? undefined : value
}

/** Restore the bytes of a queued image that was reloaded from the journal. */
export function hydrateQueuedImage(image: ImageContent): { image: ImageContent; readable: boolean } {
  if (image.base64 !== undefined) return { image, readable: true }
  try {
    return { image: { ...loadImageFromFile(image.filePath), source: image.source }, readable: true }
  } catch {
    return { image, readable: false }
  }
}

/** Restore every image of an entry reloaded from the journal. Doing this once,
 *  when entries are recovered, means delivery, steering and editing all see the
 *  same bytes they would have had before the restart. Paths that can no longer
 *  be read are returned so the entry can say so instead of dropping them. */
export function hydrateEntryImages<T extends { images?: readonly { id: number; content: ImageContent }[] }>(
  entry: T,
): { entry: T; unreadable: string[] } {
  if (!entry.images?.length) return { entry, unreadable: [] }
  const unreadable: string[] = []
  const images = entry.images.map(image => {
    const result = hydrateQueuedImage(image.content)
    if (!result.readable) unreadable.push(image.content.filePath)
    return { ...image, content: result.image }
  })
  return { entry: { ...entry, images }, unreadable }
}

import { resolve } from "node:path"
import { existsSync } from "node:fs"
import { isSupportedImage } from "./image.js"

export interface ParsedInput {
  text: string
  imageRefs: string[]
  fileRefs: string[]
}

/**
 * Parse @references from user input.
 *
 * Supported syntax:
 * - @path/to/file.ts        — relative file path (from autocomplete)
 * - @/absolute/path/file.ts  — absolute file path
 * - @./relative/file.ts      — explicit relative path
 * - @~/home/file.ts          — home-relative path
 * - @https://example.com/img.png — image URL
 *
 * Images go to imageRefs, other files go to fileRefs.
 * Returns cleaned text with @refs removed.
 */
export function parseFileReferences(input: string): ParsedInput {
  const imageRefs: string[] = []
  const fileRefs: string[] = []
  const homedir = process.env.HOME ?? process.env.USERPROFILE ?? ""

  // Match @path or @url tokens
  // Accept: @url, @~/..., @./..., @/..., @relative/path (with at least one .)
  const cleaned = input.replace(/@((?:https?:\/\/)[^\s]+|(?:[~./][^\s]+)|(?:[^\s/@]+\/[^\s]+)|(?:[^\s/@]+\.[^\s]+))/g, (full, ref: string) => {
    // Resolve ~ to home dir
    if (ref.startsWith("~/") && homedir) {
      ref = resolve(homedir, ref.slice(2))
    } else if (!ref.startsWith("http")) {
      ref = resolve(ref)
    }

    if (ref.startsWith("http")) {
      imageRefs.push(ref)
      return ""
    }

    if (isSupportedImage(ref)) {
      imageRefs.push(ref)
      return ""
    }

    // Text file — only accept if file exists
    if (existsSync(ref)) {
      fileRefs.push(ref)
      return ""
    }

    return full // leave unresolved refs intact
  })

  return {
    text: cleaned.replace(/\s{2,}/g, " ").trim(),
    imageRefs,
    fileRefs,
  }
}

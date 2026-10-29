import { createHash } from "node:crypto"
import { DYNAMIC_BOUNDARY, splitAtBoundary } from "../../zapsdk/core/prompt-boundary.js"
import { TokenCounter } from "../../zapsdk/context/token-counter.js"
import type { ToolDefinition } from "../../zapsdk/tools/types.js"
import { countCodePoints } from "../../zapsdk/utils/logical-lines.js"
import { buildToolSchemaDiagnostics, type ToolSchemaDiagnostics } from "./toolDiagnostics.js"
import type { PromptProfile } from "../../zapsdk/agent/prompt-profile.js"
import type { PromptContext } from "../prompts/context.js"
import type { PromptPurpose } from "../prompts/registry.js"

export interface PromptSectionDiagnostics extends PromptSegmentDiagnostics {
  name: string
  purpose: PromptPurpose
  dynamic: boolean
}

export function createPromptSectionDiagnostics(): {
  sections: PromptSectionDiagnostics[]
  publicPromptSections: string[]
  record: NonNullable<PromptContext["onSection"]>
} {
  const sections: PromptSectionDiagnostics[] = []
  const publicPromptSections: string[] = []
  return {
    sections,
    publicPromptSections,
    record: (name, purpose, dynamic, text, sourceText) => {
      if (purpose === "project") {
        publicPromptSections.push(text)
        if (sourceText && sourceText !== text) publicPromptSections.push(sourceText)
      }
      sections.push({ name, purpose, dynamic, ...segmentDiagnostics(text) })
    },
  }
}

export interface PromptSegmentDiagnostics {
  chars: number
  estimatedTokens: number
  hash: string
}

export interface PromptCacheDiagnostics {
  profile?: PromptProfile
  sections?: PromptSectionDiagnostics[]
  staticPrefix: PromptSegmentDiagnostics
  dynamicSuffix?: PromptSegmentDiagnostics
  toolSchemas?: ToolSchemaDiagnostics
  boundaryPresent: boolean
  /** Number of app-level static/dynamic boundary markers found. Normal is 0 or 1. */
  boundaryCount?: number
}

const tokenCounter = new TokenCounter()

function shortHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 12)
}

function segmentDiagnostics(text: string): PromptSegmentDiagnostics {
  return {
    chars: countCodePoints(text),
    estimatedTokens: tokenCounter.countText(text),
    hash: shortHash(text),
  }
}

export function buildPromptCacheDiagnostics(
  prompt: string,
  toolDefinitions?: ToolDefinition[],
  profile?: PromptProfile,
  sections?: PromptSectionDiagnostics[],
): PromptCacheDiagnostics {
  const [staticPart, dynamicPart] = splitAtBoundary(prompt)
  const dynamic = dynamicPart.trim().length > 0 ? dynamicPart : ""
  const boundaryCount = countOccurrences(prompt, DYNAMIC_BOUNDARY)
  return {
    ...(profile ? { profile } : {}),
    ...(sections ? { sections: sections.map(section => ({ ...section })) } : {}),
    staticPrefix: segmentDiagnostics(staticPart),
    ...(dynamic ? { dynamicSuffix: segmentDiagnostics(dynamic) } : {}),
    ...(toolDefinitions ? { toolSchemas: buildToolSchemaDiagnostics(toolDefinitions) } : {}),
    boundaryPresent: boundaryCount > 0,
    boundaryCount,
  }
}

function countOccurrences(text: string, needle: string): number {
  if (!needle) return 0
  let count = 0
  let offset = 0
  for (;;) {
    const idx = text.indexOf(needle, offset)
    if (idx < 0) return count
    count++
    offset = idx + needle.length
  }
}

import { isAbsolute, relative, resolve } from "node:path"
import type { ToolResult } from "../../zapsdk/tools/types.js"

export interface MemoryReadPostProcessDeps {
  autoMemory: {
    isMemoryPath(filePath: string): boolean
    stalenessNote(filePath: string): Promise<string>
  }
  globalMemoryDir?: string
}

export function createMemoryReadPostProcess(
  deps: MemoryReadPostProcessDeps,
): (toolName: string, args: Record<string, unknown>, result: ToolResult) => Promise<ToolResult> {
  return async (toolName, args, result) => appendMemoryReadStalenessNote(toolName, args, result, deps)
}

export async function appendMemoryReadStalenessNote(
  toolName: string,
  args: Record<string, unknown>,
  result: ToolResult,
  deps: MemoryReadPostProcessDeps,
): Promise<ToolResult> {
  if (toolName !== "read_file" || !result.success || typeof args.path !== "string") return result
  if (!isMemoryReadPath(args.path, deps)) return result
  let note = ""
  try {
    note = await deps.autoMemory.stalenessNote(args.path)
  } catch {
    return result
  }
  return note ? { ...result, output: result.output + note } : result
}

export function isMemoryReadPath(
  filePath: string,
  deps: MemoryReadPostProcessDeps,
): boolean {
  return deps.autoMemory.isMemoryPath(filePath) ||
    (deps.globalMemoryDir ? isPathInsideDirectory(deps.globalMemoryDir, filePath) : false)
}

export function isPathInsideDirectory(dir: string, filePath: string): boolean {
  const rel = relative(resolve(dir), resolve(filePath))
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

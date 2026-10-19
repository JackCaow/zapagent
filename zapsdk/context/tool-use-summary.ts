import { shellCommandDisplay } from "../utils/shell.js";
import type { ToolResult } from "../tools/types.js";
import { countCodePoints, normalizeLogicalNewlines, splitLogicalLines } from "../utils/logical-lines.js";

export interface ToolCallInfo {
  name: string;
  arguments: Record<string, unknown>;
  result: ToolResult;
}

/**
 * Generate a concise summary of tool usage for a step.
 * Used to replace verbose tool results in conversation history.
 */
export function generateToolUseSummary(toolCalls: ToolCallInfo[]): string {
  if (toolCalls.length === 0) return "";

  const lines = toolCalls.map((tc) => {
    const status = tc.result.success ? "✓" : "✗";
    const name = tc.name;

    // Extract the most informative argument
    const keyArg = extractKeyArg(tc.name, tc.arguments);

    // Summarize the result
    const resultSummary = tc.result.success
      ? summarizeOutput(tc.result.output, tc.name)
      : `Error: ${truncateCodePoints(tc.result.error ?? "", 80)}`;

    return `${status} ${name}(${keyArg}) → ${resultSummary}`;
  });

  return lines.join("\n");
}

function extractKeyArg(toolName: string, args: Record<string, unknown>): string {
  // For pattern-based search tools, the query is more informative than the
  // search path — both args are present on search_files/glob_files now that
  // they use `path` like Claude Code's Grep/Glob.
  if (toolName === "search_files" || toolName === "glob_files") {
    const pattern = args.pattern;
    if (pattern) return `"${truncateCodePoints(String(pattern), 30)}"`;
  }

  // Pick the most informative argument based on tool type
  const path = args.path ?? args.file ?? args.file_path ?? args.filePath;
  if (path) return String(path).split("/").slice(-2).join("/");

  const command = toolName === "bash" ? shellCommandDisplay(args) : args.command;
  if (command) return truncateCodePoints(String(command), 40);

  const query = args.query ?? args.pattern;
  if (query) return `"${truncateCodePoints(String(query), 30)}"`;

  const url = args.url;
  if (url) {
    try { return new URL(String(url)).hostname; } catch { return truncateCodePoints(String(url), 30); }
  }

  // Fallback: first string arg
  for (const val of Object.values(args)) {
    if (typeof val === "string") return truncateCodePoints(val, 30);
  }
  return "";
}

function summarizeOutput(output: string, toolName: string): string {
  if (!output) return "(empty)";

  const len = countCodePoints(output);
  const lines = splitLogicalLines(output);

  // For file reads, show line count
  if (toolName === "read_file" || toolName === "pr_file_content") {
    return `${lines.length} lines, ${len} chars`;
  }

  // For search, show match count
  if (toolName === "search_files" || toolName === "web_search") {
    const matches = lines.filter(l => l.trim()).length;
    return `${matches} results`;
  }

  // For commands, show first line of output
  if (toolName === "bash") {
    const first = lines[0]?.trim();
    return first ? truncateCodePoints(first, 60) : `${len} chars output`;
  }

  // For list/glob, show entry count
  if (toolName === "list_tree" || toolName === "list_directory" || toolName === "glob_files") {
    const entries = lines.filter(l => l.trim()).length;
    return `${entries} entries`;
  }

  // Default: size
  if (len > 100) return `${len} chars`;
  return truncateCodePoints(normalizeLogicalNewlines(output), 60).replace(/\n/g, " ");
}

function truncateCodePoints(text: string, maxChars: number): string {
  const limit = Number.isFinite(maxChars) ? Math.max(0, Math.floor(maxChars)) : 0;
  let end = 0;
  let count = 0;
  while (end < text.length && count < limit) {
    const code = text.charCodeAt(end);
    end++;
    if (code >= 0xd800 && code <= 0xdbff && end < text.length) {
      const next = text.charCodeAt(end);
      if (next >= 0xdc00 && next <= 0xdfff) end++;
    }
    count++;
  }
  return text.slice(0, end);
}

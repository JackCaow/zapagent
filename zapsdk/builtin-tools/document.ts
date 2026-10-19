import { extname } from "node:path";
import { readFile, stat } from "node:fs/promises";
import { z } from "zod";
import type { Tool, ToolResult } from "../tools/types.js";
import { countCodePoints, sliceHeadCodePoints } from "../utils/logical-lines.js";
import { isToolPathAllowed, resolveToolPath, resolveToolPathCanonical } from "./filesystem.js";

export interface DocumentReadOptions {
  allowedPaths?: string[];
  useExecutionGrants?: boolean;
  defaultCwd?: string;
  maxFileBytes?: number;
  maxOutputChars?: number;
  maxSelectedPages?: number;
}

/**
 * Model-facing document reader. PDF and DOCX use distinct parsers internally,
 * but exposing them as one capability prevents a model from spending a turn
 * choosing a parser based solely on a filename extension.
 */
export function readDocumentTool(options: DocumentReadOptions = {}): Tool {
  const defaultCwd = options.defaultCwd ?? process.cwd();
  return {
    definition: {
      name: "read_document",
      description: "Read bounded text from a local PDF or Word (.docx) document. The parser is selected from the file extension.",
      parameters: z.object({
        path: z.string().describe("Path to a PDF or Word (.docx) file"),
        pages: z.string().max(10_000).optional().describe("PDF page range, e.g. '1-5', '3', '1,3,5'; ignored for .docx"),
        format: z.enum(["text", "html"]).optional().describe("DOCX output format (default: text); ignored for PDF"),
      }),
      permission: "confirm",
      readOnly: true,
      limits: {
        maxFileBytes: options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
        maxOutputBytes: (options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS) * 4,
      },
      resolveEffects: (args) => ({
        filesystem: [{
          kind: "filesystem",
          operation: "read",
          paths: [resolveToolPathCanonical(String(args.path), defaultCwd)],
        }],
        network: [],
        process: [],
        external: [],
        workspace: { mode: "shared-readonly" },
        confidence: "declared",
      }),
    },
    handler: async (args, signal, context) => {
      const extension = extname(String(args.path)).toLowerCase();
      if (extension === ".pdf") return readPdfTool(options).handler(args, signal, context);
      if (extension === ".docx") return readDocxTool(options).handler(args, signal, context);
      return {
        success: false,
        output: "",
        error: `Unsupported document type ${extension || "(no extension)"}. Supported types: .pdf, .docx.`,
      };
    },
  };
}

const DEFAULT_MAX_FILE_BYTES = 25_000_000;
const DEFAULT_MAX_OUTPUT_CHARS = 200_000;
const DEFAULT_MAX_SELECTED_PAGES = 1_000;

function resolveOptions(options: DocumentReadOptions) {
  return {
    defaultCwd: options.defaultCwd ?? process.cwd(),
    maxFileBytes: Math.max(0, Math.floor(options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES)),
    maxOutputChars: Math.max(0, Math.floor(options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS)),
    maxSelectedPages: Math.max(1, Math.floor(options.maxSelectedPages ?? DEFAULT_MAX_SELECTED_PAGES)),
  };
}

async function readDocumentBuffer(
  path: string,
  maxFileBytes: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  if (signal?.aborted) throw new Error("aborted");
  const fileStat = await stat(path);
  if (!fileStat.isFile()) throw new Error(`Not a file: ${path}`);
  if (fileStat.size > maxFileBytes) {
    throw new Error(`Document is too large (${fileStat.size} bytes; max ${maxFileBytes})`);
  }
  const buffer = await readFile(path);
  if (signal?.aborted) throw new Error("aborted");
  return buffer;
}

function capDocumentOutput(output: string, maxChars: number): string {
  const total = countCodePoints(output);
  if (total <= maxChars) return output;
  return `${sliceHeadCodePoints(output, maxChars)}\n\n… [document output truncated — ${total} total chars]`;
}

export function readPdfTool(options: DocumentReadOptions = {}): Tool {
  const resolved = resolveOptions(options);
  return {
    definition: {
      name: "read_pdf",
      description: "Read and extract bounded text content from a PDF file.",
      parameters: z.object({
        path: z.string().describe("Path to the PDF file"),
        pages: z.string().max(10_000).optional().describe("Page range, e.g. '1-5', '3', '1,3,5' (default: all)"),
      }),
      permission: "confirm",
      readOnly: true,
      limits: {
        maxFileBytes: resolved.maxFileBytes,
        maxOutputBytes: resolved.maxOutputChars * 4,
      },
      resolveEffects: (args) => ({
        filesystem: [{
          kind: "filesystem",
          operation: "read",
          paths: [resolveToolPathCanonical(String(args.path), resolved.defaultCwd)],
        }],
        network: [],
        process: [],
        external: [],
        workspace: { mode: "shared-readonly" },
        confidence: "declared",
      }),
    },
    handler: async (args, signal, context): Promise<ToolResult> => {
      try {
        const filePath = resolveToolPath(args.path as string, resolved.defaultCwd);
        if (!(await isToolPathAllowed(filePath, options, context))) {
          return {
            success: false,
            output: "",
            error: `Path "${filePath}" is not allowed. Allowed paths: ${(options.allowedPaths ?? []).join(", ")}`,
          };
        }
        const buffer = await readDocumentBuffer(filePath, resolved.maxFileBytes, signal);
        const pagesArg = args.pages as string | undefined;
        const pageSet = pagesArg
          ? parsePageRange(pagesArg, resolved.maxSelectedPages)
          : undefined;
        if (pagesArg && (!pageSet || pageSet.size === 0)) {
          return {
            success: false,
            output: "",
            error: `Invalid or oversized page range: ${JSON.stringify(pagesArg)}. Select at most ${resolved.maxSelectedPages} positive pages.`,
          };
        }

        if (signal?.aborted) throw new Error("aborted");
        const mod = await import("pdf-parse");
        const pdfParse = (mod as any).default ?? mod;
        const parseOptions: any = {};
        if (pageSet) {
          parseOptions.pagerender = (pageData: any) => {
            if (pageSet.has(pageData.pageIndex + 1)) {
              return pageData.getTextContent().then((content: any) => {
                return content.items.map((item: any) => item.str).join(" ");
              });
            }
            return "";
          };
        }
        const data = await pdfParse(buffer, parseOptions);
        if (signal?.aborted) throw new Error("aborted");

        let output = "";
        if (data.info?.Title) output += `Title: ${data.info.Title}\n`;
        if (data.info?.Author) output += `Author: ${data.info.Author}\n`;
        output += `Pages: ${data.numpages}\n\n`;
        output += data.text;
        return { success: true, output: capDocumentOutput(output, resolved.maxOutputChars) };
      } catch (err) {
        return { success: false, output: "", error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

export function readDocxTool(options: DocumentReadOptions = {}): Tool {
  const resolved = resolveOptions(options);
  return {
    definition: {
      name: "read_docx",
      description: "Read and extract bounded text content from a Word (.docx) file.",
      parameters: z.object({
        path: z.string().describe("Path to the .docx file"),
        format: z.enum(["text", "html"]).optional().describe("Output format: 'text' (default) or 'html'"),
      }),
      permission: "confirm",
      readOnly: true,
      limits: {
        maxFileBytes: resolved.maxFileBytes,
        maxOutputBytes: resolved.maxOutputChars * 4,
      },
      resolveEffects: (args) => ({
        filesystem: [{
          kind: "filesystem",
          operation: "read",
          paths: [resolveToolPathCanonical(String(args.path), resolved.defaultCwd)],
        }],
        network: [],
        process: [],
        external: [],
        workspace: { mode: "shared-readonly" },
        confidence: "declared",
      }),
    },
    handler: async (args, signal, context): Promise<ToolResult> => {
      try {
        const filePath = resolveToolPath(args.path as string, resolved.defaultCwd);
        if (!(await isToolPathAllowed(filePath, options, context))) {
          return {
            success: false,
            output: "",
            error: `Path "${filePath}" is not allowed. Allowed paths: ${(options.allowedPaths ?? []).join(", ")}`,
          };
        }
        const buffer = await readDocumentBuffer(filePath, resolved.maxFileBytes, signal);
        if (signal?.aborted) throw new Error("aborted");
        const mammoth = await import("mammoth") as any;
        const format = (args.format as string | undefined) ?? "text";
        const result = format === "html" && typeof mammoth.convertToHtml === "function"
          ? await mammoth.convertToHtml({ buffer })
          : await mammoth.extractRawText({ buffer });
        if (signal?.aborted) throw new Error("aborted");

        let output = String(result.value ?? "");
        if (result.messages?.length) {
          const warnings = result.messages.map((message: any) => message.message).join("; ");
          output += `\n\n[Warnings: ${warnings}]`;
        }
        return { success: true, output: capDocumentOutput(output, resolved.maxOutputChars) };
      } catch (err) {
        return { success: false, output: "", error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

function parsePageRange(spec: string, maxPages: number): Set<number> | null {
  const pages = new Set<number>();
  for (const part of spec.split(",")) {
    const range = part.trim().split("-");
    if (range.length === 2) {
      const start = Number(range[0]);
      const end = Number(range[1]);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) return null;
      if (end - start + 1 > maxPages || pages.size + end - start + 1 > maxPages) return null;
      for (let page = start; page <= end; page++) pages.add(page);
    } else if (range.length === 1) {
      const page = Number(range[0]);
      if (!Number.isSafeInteger(page) || page < 1) return null;
      pages.add(page);
      if (pages.size > maxPages) return null;
    } else {
      return null;
    }
  }
  return pages;
}

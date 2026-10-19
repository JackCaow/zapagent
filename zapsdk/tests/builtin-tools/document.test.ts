import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readDocumentTool } from "../../builtin-tools/document.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("document read boundaries", () => {
  it("exposes one model-facing reader and dispatches by file extension", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zap-doc-"));
    dirs.push(dir);
    const tool = readDocumentTool({ defaultCwd: dir, maxFileBytes: 4 });

    expect(tool.definition.name).toBe("read_document");
    expect(tool.definition.resolveEffects?.({ path: "a.pdf" }, { cwd: dir, toolName: "read_document" }).filesystem[0]?.paths)
      .toEqual([join(realpathSync(dir), "a.pdf")]);

    const unsupported = await tool.handler({ path: "notes.txt" });
    expect(unsupported.success).toBe(false);
    expect(unsupported.error).toContain("Unsupported document type")
  });

  it("requires confirmation and resolves effects against defaultCwd", () => {
    const dir = mkdtempSync(join(tmpdir(), "zap-doc-"));
    dirs.push(dir);
    const tool = readDocumentTool({ defaultCwd: dir });

    expect(tool.definition.permission).toBe("confirm");
    expect(tool.definition.resolveEffects?.({ path: "a.pdf" }, { cwd: dir, toolName: "read_document" }).filesystem[0]?.paths)
      .toEqual([join(realpathSync(dir), "a.pdf")]);
  });

  it("rejects oversized files before importing a parser", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zap-doc-"));
    dirs.push(dir);
    writeFileSync(join(dir, "large.docx"), "12345");
    const tool = readDocumentTool({ defaultCwd: dir, maxFileBytes: 4 });

    const result = await tool.handler({ path: "large.docx" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("too large");
  });

  it("rejects page ranges that exceed the configured bound", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zap-doc-"));
    dirs.push(dir);
    writeFileSync(join(dir, "small.pdf"), "not parsed because range is rejected");
    const tool = readDocumentTool({ defaultCwd: dir, maxSelectedPages: 3 });

    const result = await tool.handler({ path: "small.pdf", pages: "1-100" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid or oversized page range");
  });
});

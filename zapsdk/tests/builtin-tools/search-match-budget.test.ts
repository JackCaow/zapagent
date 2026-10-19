import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { searchFilesTool } from "../../builtin-tools/search.js";
import { DEFAULT_TOOL_RESOURCE_LIMITS } from "../../tools/effects.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(text: string, name = "sample.ts") {
  const root = mkdtempSync(join(tmpdir(), "zap-match-budget-"));
  roots.push(root);
  writeFileSync(join(root, name), text);
  return root;
}

it("retains a match and its default context with a one-match budget", async () => {
  const root = fixture("before1\nbefore2\nTARGET\nafter1\nafter2\n");
  const result = await searchFilesTool({ maxResults: 1 }).handler({ path: root, pattern: "TARGET" });
  expect(result.success).toBe(true);
  expect(result.meta).toMatchObject({ search: { backend: "ripgrep", complete: true } });
  expect(result.output).toContain("sample.ts:3:TARGET");
  for (const text of ["before1", "before2", "after1", "after2"]) expect(result.output).toContain(text);
});

it("clips extra matches without emitting their unrelated before-context", async () => {
  const root = fixture("before\nTARGET first\nafter1\nafter2\nnoise\nexcluded-before1\nexcluded-before2\nTARGET second\n");
  const result = await searchFilesTool({ maxResults: 1 }).handler({ path: root, pattern: "TARGET" });
  expect(result.success).toBe(true);
  expect(result.meta).toMatchObject({ search: { complete: false, reason: "result_limit" } });
  expect(result.output).toContain("TARGET first");
  expect(result.output).toContain("after2");
  expect(result.output).not.toContain("TARGET second");
  expect(result.output).not.toContain("excluded-before");
});

it("counts multiline matches as blocks and retains every line in an accepted block", async () => {
  const root = fixture("before\nBEGIN\nmiddle\nEND\nafter\n");
  const result = await searchFilesTool({ maxResults: 1 }).handler({ path: root, pattern: "BEGIN.*END", multiline: true });
  expect(result.meta).toMatchObject({ search: { complete: true } });
  expect(result.output).toContain("sample.ts:2:BEGIN");
  expect(result.output).toContain("sample.ts:3:middle");
  expect(result.output).toContain("sample.ts:4:END");
  expect(result.output).toContain("after");
});

it("does not confuse delimiters or newlines in filenames with match records", async () => {
  const root = fixture("before\nTARGET\nafter\n", "file:2-\n中文.ts");
  const result = await searchFilesTool({ maxResults: 1 }).handler({ path: root, pattern: "TARGET" });
  expect(result.meta).toMatchObject({ search: { complete: true } });
  expect(result.output).toContain('file:2-\\n中文.ts":2:TARGET');
});

it("keeps the byte limit independent of match and context counts", async () => {
  const root = fixture(`TARGET ${"x".repeat(500)}\n`);
  const result = await searchFilesTool({ maxResults: 1 }).handler({ path: root, pattern: "TARGET" }, undefined,
    { limits: { ...DEFAULT_TOOL_RESOURCE_LIMITS, maxOutputBytes: 2148 } });
  expect(result.meta).toMatchObject({ search: { complete: false, reason: "output_limit" } });
  expect(result.output).not.toContain("No matches found.");
});

it("discloses when binary detection stops a file after an earlier text match", async () => {
  const root = fixture(`TARGET\n${"line\n".repeat(20000)}\0tail\n`, "data.bin");
  const result = await searchFilesTool().handler({ path: root, pattern: "TARGET", context_lines: 0 });
  expect(result.success).toBe(true);
  expect(result.output).toContain("data.bin:1:TARGET");
  expect(result.output).toContain("binary file(s) detected");
  expect(result.meta).toMatchObject({ search: { complete: false, binaryFiles: 1 } });
});

it("warns about binary line numbers when an explicit file search continues past NUL", async () => {
  const root = fixture("TARGET\n\0secret\nTARGET after\n", "data.bin");
  const result = await searchFilesTool().handler({ path: join(root, "data.bin"), pattern: "TARGET", context_lines: 0 });
  expect(result.output).toContain("line numbers unreliable");
  expect(result.meta).toMatchObject({ search: { complete: false, binaryFiles: 1 } });
});

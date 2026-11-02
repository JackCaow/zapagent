import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { editFileTool } from "../../builtin-tools/edit.js";
import { multiEditTool } from "../../builtin-tools/multi-edit.js";

describe("empty edit search strings", () => {
  for (const replace_all of [false, true]) {
    it(`rejects empty strings in both schemas (replace_all=${replace_all})`, () => {
      const edit = { old_string: "", new_string: "insert", replace_all };
      expect(editFileTool().definition.parameters.safeParse({ path: "a.txt", ...edit }).success).toBe(false);
      expect(multiEditTool().definition.parameters.safeParse({ path: "a.txt", edits: [edit] }).success).toBe(false);
    });
  }

  it("rejects direct handler calls without hanging or partially writing a batch", () => {
    // Use an external process deadline: a regression blocks the event loop,
    // so an in-process timeout or AbortSignal cannot stop the original bug.
    const editModule = fileURLToPath(new URL("../../builtin-tools/edit.ts", import.meta.url));
    const multiModule = fileURLToPath(new URL("../../builtin-tools/multi-edit.ts", import.meta.url));
    const child = spawnSync(process.execPath, ["--eval", `
      import { editFileTool } from ${JSON.stringify(editModule)};
      import { multiEditTool } from ${JSON.stringify(multiModule)};
      import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
      import { tmpdir } from "node:os";
      import { join } from "node:path";
      import assert from "node:assert/strict";
      const dir = mkdtempSync(join(tmpdir(), "zap-empty-edit-"));
      const path = join(dir, "fixture.txt");
      try {
        for (const original of ["", "abc"]) {
          for (const replace_all of [false, true]) {
            for (const tool of [editFileTool({allowedPaths:[dir]}), multiEditTool({allowedPaths:[dir]})]) {
              writeFileSync(path, original);
              const edit = { old_string: "", new_string: "insert", replace_all };
              const args = tool.definition.name === "edit_file" ? { path, ...edit } : { path, edits: [edit] };
              const result = await tool.handler(args);
              assert.equal(result.success, false);
              assert.match(result.error, /old_string must not be empty/);
              assert.equal(readFileSync(path, "utf8"), original);
            }
            writeFileSync(path, "abc");
            const result = await multiEditTool({allowedPaths:[dir]}).handler({path, edits: [
              {old_string:"abc", new_string:"changed"},
              {old_string:"", new_string:"insert", replace_all},
            ]});
            assert.equal(result.success, false);
            assert.match(result.error, /Edit #2 failed: old_string must not be empty/);
            assert.equal(readFileSync(path, "utf8"), "abc");
          }
        }
        // Empty replacement strings remain valid deletions.
        for (const tool of [editFileTool({allowedPaths:[dir]}), multiEditTool({allowedPaths:[dir]})]) {
          writeFileSync(path, "abc");
          const edit = {old_string:"b", new_string:""};
          const result = await tool.handler(tool.definition.name === "edit_file" ? {path,...edit} : {path,edits:[edit]});
          assert.equal(result.success, true);
          assert.equal(readFileSync(path,"utf8"), "ac");
        }
        console.log("verified");
      } finally { rmSync(dir, {recursive:true, force:true}); }
    `], { timeout: 10_000, encoding: "utf8" });
    expect(child.error).toBeUndefined();
    expect(child.stderr).toBe("");
    expect(child.status).toBe(0);
    expect(child.stdout.trim()).toBe("verified");
  }, 15_000);
});

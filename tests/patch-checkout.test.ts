import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

test("Windows-style Git checkouts preserve a patch that verifies the installed Ink bytes", () => {
  const root = mkdtempSync(join(tmpdir(), "zap-patch-checkout-"));
  const source = join(root, "source"), checkout = join(root, "checkout"), ink = join(root, "ink");
  mkdirSync(join(source, "patches"), { recursive: true });
  mkdirSync(checkout);
  const run = (args: string[], cwd = source) => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    expect({ status: result.status, error: result.stderr }).toEqual({ status: 0, error: "" });
  };
  try {
    writeFileSync(join(source, ".gitattributes"), readFileSync(".gitattributes"));
    writeFileSync(join(source, "patches/ink.patch"), readFileSync("patches/ink@7.1.1.patch"));
    run(["init", "-q"]);
    run(["-c", "core.autocrlf=false", "add", "."]);
    run(["-c", "core.autocrlf=true", "checkout-index", "--all", `--prefix=${checkout}${sep}`]);
    const patch = join(checkout, "patches/ink.patch");
    expect(readFileSync(patch, "utf8")).not.toContain("\r\n");
    cpSync("node_modules/ink", ink, { recursive: true });
    run(["apply", "--reverse", "--check", patch], ink);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

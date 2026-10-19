import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { compileGlob, type GlobMatcher } from "./glob-util.js";

export type IgnoreMatcher = (relPath: string) => boolean;

const NOOP: IgnoreMatcher = () => false;

/**
 * Load `.gitignore` from `rootDir` and return a relPath→ignored matcher.
 *
 * Supports:
 *   - Comments (#...) and blank lines
 *   - Trailing "/"   (dir-only pattern — treated as basename match)
 *   - Leading "/"    (anchor at rootDir)
 *   - Anywhere match (bare name → `** /name`)
 *
 * Does NOT support negation (!pat) or nested .gitignore files.
 */
export async function loadGitignore(rootDir: string): Promise<IgnoreMatcher> {
  let content: string;
  try {
    content = await readFile(join(rootDir, ".gitignore"), "utf-8");
  } catch {
    return NOOP;
  }

  const matchers: GlobMatcher[] = [];
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("!")) continue;

    let pat = line.endsWith("/") ? line.slice(0, -1) : line;
    let globPat: string;
    if (pat.startsWith("/")) {
      globPat = pat.slice(1);
    } else if (pat.includes("/")) {
      globPat = pat;
    } else {
      globPat = `**/${pat}`;
    }
    try { matchers.push(compileGlob(globPat)); } catch {}
  }

  if (matchers.length === 0) return NOOP;
  return (relPath) => matchers.some((m) => m(relPath));
}

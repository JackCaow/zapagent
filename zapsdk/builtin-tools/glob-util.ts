/**
 * Shared glob matching utility used by glob_files and search_files.
 * Supports: * ** ? {a,b} brace expansion
 */

/** Expand {a,b,c} brace alternatives into an array of patterns. */
function expandBraces(pattern: string): string[] {
  const open = pattern.indexOf("{");
  if (open === -1) return [pattern];
  const close = pattern.indexOf("}", open);
  if (close === -1) return [pattern];
  const prefix = pattern.slice(0, open);
  const suffix = pattern.slice(close + 1);
  const alts = pattern.slice(open + 1, close).split(",");
  return alts.flatMap((alt) => expandBraces(prefix + alt + suffix));
}

function patternToRegex(pattern: string): RegExp {
  const normalized = pattern.replace(/\\/g, "/");
  const segments = normalized.split("/");
  let regexStr = "";
  let prevWasDoubleStar = false;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (i > 0 && !prevWasDoubleStar) regexStr += "/";
    if (seg === "**") {
      // "**" in middle matches zero or more path segments (including empty);
      // "**" trailing matches any remaining substring.
      regexStr += i < segments.length - 1 ? "(?:.*/)?" : ".*";
      prevWasDoubleStar = true;
    } else {
      regexStr += seg
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, "[^/]*")
        .replace(/\?/g, "[^/]");
      prevWasDoubleStar = false;
    }
  }

  return new RegExp(`^${regexStr}$`);
}

export type GlobMatcher = (filePath: string) => boolean;

/** Compile once, match many. Prefer this when matching >1 path against the same pattern. */
export function compileGlob(pattern: string): GlobMatcher {
  const regexes = expandBraces(pattern).map(patternToRegex);
  return (filePath: string) => {
    const normalized = filePath.replace(/\\/g, "/");
    return regexes.some((r) => r.test(normalized));
  };
}

export function matchGlob(filePath: string, pattern: string): boolean {
  return compileGlob(pattern)(filePath);
}

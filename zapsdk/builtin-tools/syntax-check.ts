// Lightweight pre-write syntax validator. Goal: catch the bracket/paren/quote
// kinds of breakage that the model can't see when it dispatches an edit, so we
// reject the write instead of silently corrupting the file. Type errors,
// missing imports, and other semantic issues are NOT this validator's job —
// they show up later via test/build feedback.

import ts from "typescript";
import { extname } from "node:path";

export interface SyntaxOk {
  ok: true;
}
export interface SyntaxErr {
  ok: false;
  /** One-liner suitable for inclusion in a tool error message. */
  error: string;
}
export type SyntaxResult = SyntaxOk | SyntaxErr;

const TS_LIKE = new Set([".ts", ".tsx", ".mts", ".cts"]);
const JS_LIKE = new Set([".js", ".jsx", ".mjs", ".cjs"]);

/**
 * Validate `content` against the syntax rules for the language inferred from
 * `path`'s extension. Unknown extensions return ok (this is a safety net, not
 * a gatekeeper — we only reject when we're confident).
 *
 * Strategy:
 *  - .json → JSON.parse (strict; rejects trailing commas, comments, etc.)
 *  - .ts/.tsx/.mts/.cts → TS parser, TSX kind for .tsx
 *  - .js/.jsx/.mjs/.cjs → TS parser in JS mode, JSX kind for .jsx
 *  - everything else → skip
 *
 * The TS path uses createSourceFile (no type checker — that would need a
 * Program and would catch errors that aren't actually syntax errors). We then
 * read parseDiagnostics, which is the syntax-error subset.
 */
export function validateSyntax(path: string, content: string): SyntaxResult {
  const ext = extname(path).toLowerCase();

  if (ext === ".json") {
    try {
      JSON.parse(content);
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `Invalid JSON: ${msg}` };
    }
  }

  if (TS_LIKE.has(ext) || JS_LIKE.has(ext)) {
    const scriptKind = pickScriptKind(ext);
    const sourceFile = ts.createSourceFile(
      path,
      content,
      ts.ScriptTarget.Latest,
      /* setParentNodes */ false,
      scriptKind,
    );
    // parseDiagnostics is exposed but not in the public type for SourceFile
    // in older typings; this cast keeps it strongly-typed at the boundary.
    const diags = (sourceFile as unknown as { parseDiagnostics?: ts.Diagnostic[] })
      .parseDiagnostics;
    if (!diags || diags.length === 0) return { ok: true };

    const errors = diags.filter((d) => d.category === ts.DiagnosticCategory.Error);
    if (errors.length === 0) return { ok: true };

    const first = errors[0];
    const msg = ts.flattenDiagnosticMessageText(first.messageText, "\n");
    if (first.file && first.start !== undefined) {
      const { line, character } = first.file.getLineAndCharacterOfPosition(first.start);
      return {
        ok: false,
        error: `Syntax error at line ${line + 1}, column ${character + 1}: ${msg}`,
      };
    }
    return { ok: false, error: `Syntax error: ${msg}` };
  }

  // Unknown / unsupported extension — skip. We don't pretend to validate
  // languages we can't actually parse.
  return { ok: true };
}

function pickScriptKind(ext: string): ts.ScriptKind {
  switch (ext) {
    case ".tsx": return ts.ScriptKind.TSX;
    case ".jsx": return ts.ScriptKind.JSX;
    case ".js":
    case ".mjs":
    case ".cjs": return ts.ScriptKind.JS;
    default: return ts.ScriptKind.TS;
  }
}

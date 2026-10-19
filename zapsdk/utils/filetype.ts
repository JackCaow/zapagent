import { posix as posixPath } from "node:path";

/**
 * `pathToFiletype` resolves a file path to a canonical filetype id used
 * downstream by the diff renderer and shiki highlighter.
 *
 * Adapted from @opentui/core (MIT, Copyright (c) 2025 opentui). Inlined here
 * after the Ink migration removed @opentui/core as a runtime dependency. Keep
 * the map exact-aligned with upstream so renderer keys don't drift.
 */

const extensionToFiletype = new Map<string, string>([
  ["astro", "astro"],
  ["bash", "bash"],
  ["c", "c"],
  ["cc", "cpp"],
  ["cjs", "javascript"],
  ["clj", "clojure"],
  ["cljs", "clojure"],
  ["cljc", "clojure"],
  ["cpp", "cpp"],
  ["cxx", "cpp"],
  ["cs", "csharp"],
  ["cts", "typescript"],
  ["ctsx", "typescriptreact"],
  ["dart", "dart"],
  ["diff", "diff"],
  ["edn", "clojure"],
  ["go", "go"],
  ["gemspec", "ruby"],
  ["groovy", "groovy"],
  ["h", "c"],
  ["handlebars", "handlebars"],
  ["hbs", "handlebars"],
  ["hpp", "cpp"],
  ["hxx", "cpp"],
  ["h++", "cpp"],
  ["hh", "cpp"],
  ["hrl", "erlang"],
  ["hs", "haskell"],
  ["htm", "html"],
  ["html", "html"],
  ["ini", "ini"],
  ["js", "javascript"],
  ["jsx", "javascriptreact"],
  ["jl", "julia"],
  ["json", "json"],
  ["ksh", "bash"],
  ["kt", "kotlin"],
  ["kts", "kotlin"],
  ["latex", "latex"],
  ["less", "less"],
  ["lua", "lua"],
  ["markdown", "markdown"],
  ["md", "markdown"],
  ["mdown", "markdown"],
  ["mkd", "markdown"],
  ["mjs", "javascript"],
  ["ml", "ocaml"],
  ["mli", "ocaml"],
  ["mts", "typescript"],
  ["mtsx", "typescriptreact"],
  ["patch", "diff"],
  ["php", "php"],
  ["pl", "perl"],
  ["pm", "perl"],
  ["ps1", "powershell"],
  ["psm1", "powershell"],
  ["py", "python"],
  ["pyi", "python"],
  ["r", "r"],
  ["rb", "ruby"],
  ["rake", "ruby"],
  ["rs", "rust"],
  ["ru", "ruby"],
  ["sass", "sass"],
  ["sc", "scala"],
  ["scala", "scala"],
  ["scss", "scss"],
  ["sh", "bash"],
  ["sql", "sql"],
  ["svelte", "svelte"],
  ["swift", "swift"],
  ["ts", "typescript"],
  ["tsx", "typescriptreact"],
  ["tex", "latex"],
  ["toml", "toml"],
  ["vue", "vue"],
  ["vim", "vim"],
  ["xml", "xml"],
  ["xsl", "xsl"],
  ["yaml", "yaml"],
  ["yml", "yaml"],
  ["zig", "zig"],
  ["zon", "zig"],
  ["zsh", "bash"],
  ["c++", "cpp"],
  ["erl", "erlang"],
  ["exs", "elixir"],
  ["ex", "elixir"],
  ["elm", "elm"],
  ["fsharp", "fsharp"],
  ["fs", "fsharp"],
  ["fsx", "fsharp"],
  ["fsscript", "fsharp"],
  ["fsi", "fsharp"],
  ["java", "java"],
  ["css", "css"],
]);

const basenameToFiletype = new Map<string, string>([
  [".bash_aliases", "bash"],
  [".bash_logout", "bash"],
  [".bash_profile", "bash"],
  [".bashrc", "bash"],
  [".kshrc", "bash"],
  [".profile", "bash"],
  [".vimrc", "vim"],
  [".zlogin", "bash"],
  [".zlogout", "bash"],
  [".zprofile", "bash"],
  [".zshenv", "bash"],
  [".zshrc", "bash"],
  ["appfile", "ruby"],
  ["berksfile", "ruby"],
  ["brewfile", "ruby"],
  ["cheffile", "ruby"],
  ["containerfile", "dockerfile"],
  ["dockerfile", "dockerfile"],
  ["fastfile", "ruby"],
  ["gemfile", "ruby"],
  ["gnumakefile", "make"],
  ["gvimrc", "vim"],
  ["guardfile", "ruby"],
  ["makefile", "make"],
  ["podfile", "ruby"],
  ["rakefile", "ruby"],
  ["thorfile", "ruby"],
  ["vagrantfile", "ruby"],
]);

function normalizeFiletypeToken(value: string): string | undefined {
  const normalized = value.trim().replace(/^\./, "").toLowerCase();
  return normalized || undefined;
}

function getBasename(value: string): string | undefined {
  // Normalize Windows separators so basename works on `C:\foo\bar.ts` too.
  const normalized = value.trim().replaceAll("\\", "/");
  if (!normalized) return undefined;
  const base = posixPath.basename(normalized).toLowerCase();
  return base || undefined;
}

function extToFiletype(extension: string): string | undefined {
  const ext = normalizeFiletypeToken(extension);
  if (!ext) return undefined;
  return extensionToFiletype.get(ext);
}

/**
 * Resolve a path to a canonical filetype id (e.g. `"typescriptreact"`,
 * `"dockerfile"`). Returns `undefined` when nothing matches — callers should
 * fall back to the raw lowercased extension.
 */
export function pathToFiletype(path: string): string | undefined {
  if (typeof path !== "string") return undefined;
  const base = getBasename(path);
  if (!base) return undefined;
  const byBasename = basenameToFiletype.get(base);
  if (byBasename) return byBasename;
  const lastDot = base.lastIndexOf(".");
  if (lastDot === -1 || lastDot === base.length - 1) return undefined;
  return extToFiletype(base.substring(lastDot + 1));
}

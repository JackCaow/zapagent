import { lstatSync, readFileSync, realpathSync } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"

/**
 * Commands that only look at things. Inside the OS sandbox they run without an
 * approval prompt.
 *
 * "Read-only" is a claim about a whole command line, so this is an ALLOWLIST at
 * every level, because the denylist version of this parser was broken in review:
 *
 *  - Shell syntax: any of ; & | < > ` $ ( ) newline CR backslash anywhere in the
 *    text, even inside quotes, rejects the command. A false refusal costs one
 *    prompt, a false approval costs a write.
 *  - Command: only the names below.
 *  - Flags: only the exact spellings listed per command. git and the GNU tools
 *    accept any unique prefix (`--open` is `--open-files-in-pager`, `--out` is
 *    `--output`) and short options can carry their value (`sort -ox.txt`), so a
 *    list of flags to refuse can never be complete. Valued flags are checked
 *    against a pattern.
 *  - Expansion: an unquoted * ? [ ] { } ~ is refused, because the shell would
 *    expand it into paths this parser never sees (`cat {/etc/hosts,a}`).
 *  - Paths: every operand must resolve, link by link, inside the workspace.
 *    `link/..` is the parent of the link's target, not of the link.
 *
 * Deliberately absent: anything that can print the environment (env, printenv,
 * jq, awk), run code (sed, awk, xargs, make, find -exec), or write (tee, sed -i).
 */

// ; & | < > ` $ ( ) newline, carriage return and backslash.
const SHELL_METACHARACTERS = /[;&|<>`$()\n\r\\]/
// What the shell expands when it is not quoted: globs and braces anywhere in a
// word. A tilde only expands at the START of a word, so HEAD~3 is just text.
const EXPANSION_CHARACTERS = /[*?[\]{}]/

const NUMBER = /^\d+$/
// Quoted values such as --since="2 weeks ago" legitimately contain spaces; shell
// metacharacters and newlines were already refused for the whole command.
const ANY = /^.*$/
// %G? %GS %GK ... make git run gpg.
const GIT_FORMAT = /^(?!.*%G)/s

interface Spec {
  /** Single-letter flags without a value; may be clustered (-la). */
  flags?: string
  /** Single-letter flags that take a value, attached (-n5) or as the next word. */
  valued?: Record<string, RegExp>
  /** Exact long flags without a value. */
  long?: string[]
  /** Exact long flags written --name=value. */
  longValued?: Record<string, RegExp>
  /** -5 style counts, as in head and git log. */
  numeric?: boolean
  /** Operands are text, not file names (echo). */
  textOperands?: boolean
  /** Operands that do not match are refused (date accepts only +FORMAT). */
  operandPattern?: RegExp
  /** The command takes no operands at all. */
  noOperands?: boolean
  /** Maximum number of operands. */
  maxOperands?: number
}

const SPECS: Record<string, Spec> = {
  pwd: { flags: "LP", noOperands: true },
  whoami: { noOperands: true },
  hostname: { noOperands: true },
  id: { flags: "ugGnr", noOperands: true },
  uname: { flags: "asrmnpv", noOperands: true },
  true: { noOperands: true },
  false: { noOperands: true },
  echo: { flags: "neE", textOperands: true },
  which: { flags: "a" },
  date: { flags: "u", operandPattern: /^\+/, maxOperands: 1 },
  ls: { flags: "aAlhRdtSrFp1icskn" },
  cat: { flags: "nbsvetAET" },
  head: { flags: "qv", valued: { n: NUMBER, c: NUMBER }, numeric: true },
  tail: { flags: "qv", valued: { n: NUMBER, c: NUMBER }, numeric: true },
  grep: {
    flags: "ivnclLHhwxFEGPoqsrIa",
    valued: { m: NUMBER, A: NUMBER, B: NUMBER, C: NUMBER, e: ANY },
    long: ["--line-number", "--ignore-case", "--files-with-matches", "--count", "--recursive", "--no-messages", "--word-regexp",
      "--fixed-strings", "--extended-regexp", "--invert-match", "--no-filename", "--with-filename", "--color", "--colour"],
    longValued: { "--include": ANY, "--exclude": ANY, "--exclude-dir": ANY, "--max-count": NUMBER, "--context": NUMBER,
      "--after-context": NUMBER, "--before-context": NUMBER, "--color": /^(auto|always|never)$/, "--colour": /^(auto|always|never)$/ },
  },
  rg: {
    flags: "inlcvwxFsSuHho",
    valued: { e: ANY, g: ANY, t: /^[a-z0-9]+$/, T: /^[a-z0-9]+$/, A: NUMBER, B: NUMBER, C: NUMBER, m: NUMBER },
    long: ["--files", "--hidden", "--no-ignore", "--count", "--files-with-matches", "--line-number", "--heading", "--no-heading",
      "--ignore-case", "--smart-case", "--fixed-strings", "--word-regexp", "--invert-match", "--no-messages"],
    longValued: { "--type": /^[a-z0-9]+$/, "--glob": ANY, "--max-count": NUMBER, "--color": /^(auto|always|never)$/ },
  },
}

/** find is the odd one: its "flags" are single-dash predicates. */
const FIND_PREDICATES = new Set(["-name", "-iname", "-path", "-ipath", "-type", "-maxdepth", "-mindepth", "-size", "-mtime", "-mmin",
  "-empty", "-print", "-print0", "-not", "-a", "-o", "!"])
const FIND_VALUED = new Set(["-name", "-iname", "-path", "-ipath", "-type", "-maxdepth", "-mindepth", "-size", "-mtime", "-mmin"])

const GIT_LOG_LIKE: Spec = {
  flags: "pswubqnz",
  valued: { n: NUMBER, U: NUMBER, S: ANY },
  numeric: true,
  long: ["--oneline", "--stat", "--shortstat", "--numstat", "--name-only", "--name-status", "--graph", "--decorate", "--no-decorate",
    "--all", "--abbrev-commit", "--no-merges", "--merges", "--first-parent", "--reverse", "--cached", "--staged", "--no-color",
    "--color", "--patch", "--no-patch", "--summary", "--follow", "--full-history", "--date-order", "--topo-order", "--stdin",
    "--no-ext-diff", "--no-textconv", "--root", "--cc", "--raw", "--stat"],
  longValued: { "--format": GIT_FORMAT, "--pretty": GIT_FORMAT, "--since": ANY, "--until": ANY, "--after": ANY, "--before": ANY, "--author": ANY,
    "--committer": ANY, "--grep": ANY, "--max-count": NUMBER, "--skip": NUMBER, "--diff-filter": /^[A-Za-z]+$/, "--abbrev": NUMBER,
    "--date": ANY, "--color": /^(auto|always|never)$/, "--stat": ANY, "--unified": NUMBER },
}

const GIT_SPECS: Record<string, Spec> = {
  status: { flags: "sbuz", long: ["--short", "--branch", "--porcelain", "--ignored"], longValued: { "--porcelain": /^v?[12]$/, "--untracked-files": /^(no|normal|all)$/ } },
  diff: GIT_LOG_LIKE,
  log: GIT_LOG_LIKE,
  show: GIT_LOG_LIKE,
  shortlog: { flags: "sne", long: ["--summary", "--numbered", "--email"], longValued: { "--since": ANY, "--until": ANY } },
  blame: { flags: "wsefl", valued: { L: /^\d+(,[+-]?\d+)?$/ }, long: ["--porcelain", "--line-porcelain"], longValued: { "--abbrev": NUMBER } },
  "ls-files": { flags: "cmdostv", long: ["--others", "--cached", "--modified", "--deleted", "--stage", "--exclude-standard", "--ignored"] },
  "rev-parse": { long: ["--show-toplevel", "--abbrev-ref", "--is-inside-work-tree", "--verify", "--symbolic-full-name", "--short", "--git-dir"] },
  grep: {
    flags: "nIiwlcFEvhH",
    valued: { e: ANY },
    long: ["--line-number", "--ignore-case", "--files-with-matches", "--count", "--fixed-strings", "--extended-regexp", "--invert-match", "--word-regexp"],
  },
}
const GIT_BRANCH_LIST: Spec = { flags: "arvl", long: ["--list", "--show-current", "--all", "--remotes", "--verbose"] }

interface Token { text: string; unquotedExpansion: boolean }

/** Split a metacharacter-free command into words, noting an unquoted * ? [ ] { } ~ . */
function words(command: string): Token[] | null {
  const out: Token[] = []
  let current = ""
  let started = false
  let unquotedExpansion = false
  let quote: '"' | "'" | null = null
  const flush = () => {
    if (started || current) out.push({ text: current, unquotedExpansion })
    current = ""; started = false; unquotedExpansion = false
  }
  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = null
      else current += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch; started = true
    } else if (ch === " " || ch === "\t") {
      flush()
    } else {
      if (EXPANSION_CHARACTERS.test(ch) || (ch === "~" && current === "" && !started)) unquotedExpansion = true
      current += ch
    }
  }
  if (quote) return null
  flush()
  return out
}

/**
 * Follow `path` the way the kernel does, one component at a time: a symbolic
 * link is replaced by its target before the next component is applied, so
 * `link/..` is the parent of the link's target. Components that do not exist
 * yet are kept as written.
 */
function realResolve(path: string): string | null {
  if (!isAbsolute(path)) return null
  let current: string = sep
  const rest = path.split(sep).filter(part => part !== "" && part !== ".")
  let hops = 0
  while (rest.length > 0) {
    const part = rest.shift()!
    if (part === "..") { current = dirname(current); continue }
    const next = join(current, part)
    let info
    try { info = lstatSync(next) } catch { current = next; continue }
    if (!info.isSymbolicLink()) { current = next; continue }
    if (++hops > 40) return null
    try { current = realpathSync(next) } catch { return null }
  }
  return current
}

/** True when `arg`, resolved link by link against `cwd`, stays inside `cwd`. */
function insideWorkspace(arg: string, cwd: string): boolean {
  if (arg === "-" || arg === "") return true
  if (arg.startsWith("~")) return false
  const root = realResolve(resolve(cwd))
  if (root === null) return false
  // Plain concatenation: join() and resolve() would collapse `link/..` lexically
  // before the link is followed, which is exactly what must not happen.
  const real = realResolve(isAbsolute(arg) ? arg : `${root}${sep}${arg}`)
  if (real === null) return false
  const rel = relative(root, real)
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel) && !rel.startsWith(`..${sep}`))
}

/** Parse flags against `spec`; return the operands, or null when a flag is not allowed. */
function parseArgs(tokens: Token[], spec: Spec): string[] | null {
  const operands: string[] = []
  let flagsDone = false
  for (let i = 0; i < tokens.length; i++) {
    const { text, unquotedExpansion } = tokens[i]!
    if (unquotedExpansion) return null
    if (flagsDone || !text.startsWith("-") || text === "-") { operands.push(text); continue }
    if (text === "--") { flagsDone = true; continue }
    if (text.startsWith("--")) {
      const eq = text.indexOf("=")
      const name = eq < 0 ? text : text.slice(0, eq)
      if (eq < 0) { if (!spec.long?.includes(name)) return null; continue }
      const check = spec.longValued?.[name]
      if (!check || !check.test(text.slice(eq + 1))) return null
      continue
    }
    if (spec.numeric && /^-\d+$/.test(text)) continue
    // A cluster such as -la, or a valued flag with its value attached (-n5) or following.
    let consumed = false
    for (let c = 1; c < text.length && !consumed; c++) {
      const letter = text[c]!
      if (spec.flags?.includes(letter)) continue
      const check = spec.valued?.[letter]
      if (!check) return null
      let value = text.slice(c + 1)
      if (value === "") {
        const next = tokens[++i]
        if (!next || next.unquotedExpansion) return null
        value = next.text
      }
      if (!check.test(value)) return null
      consumed = true
    }
  }
  return operands
}

function operandsAreAcceptable(operands: string[], spec: Spec, cwd: string): boolean {
  if (spec.noOperands && operands.length > 0) return false
  if (spec.maxOperands !== undefined && operands.length > spec.maxOperands) return false
  if (spec.operandPattern && !operands.every(operand => spec.operandPattern!.test(operand))) return false
  if (spec.textOperands || spec.operandPattern) return true
  return operands.every(operand => insideWorkspace(operand, cwd))
}

function findIsReadOnly(tokens: Token[], cwd: string): boolean {
  // `find . -name *` becomes `find . -name -delete` when a file is called -delete.
  if (tokens.some(token => token.unquotedExpansion)) return false
  const starts: string[] = []
  let i = 0
  while (i < tokens.length && !tokens[i]!.text.startsWith("-") && tokens[i]!.text !== "!") {
    if (tokens[i]!.unquotedExpansion) return false
    starts.push(tokens[i]!.text)
    i++
  }
  for (; i < tokens.length; i++) {
    const predicate = tokens[i]!.text
    if (!FIND_PREDICATES.has(predicate)) return false
    if (FIND_VALUED.has(predicate)) {
      const value = tokens[++i]
      if (!value || (value.text.startsWith("-") && !/^[-+]?\d/.test(value.text))) return false
    }
  }
  return starts.every(start => insideWorkspace(start, cwd))
}

// Keys in a repository's own config that make read-only git commands run a
// program: core.fsmonitor, diff.external, textconv, filter drivers, pagers...
const PROGRAM_RUNNING_KEYS = /^\s*(fsmonitor|external|textconv|pager|sshcommand|process|smudge|clean|command|helper|hookspath|askpass|editor|program)\s*=/im

/**
 * `git status`, `diff`, `log -p`, `blame` and `grep` run the programs named in
 * the repository's config without any flag. The sandbox keeps a sandboxed
 * command from writing .git/config, but a checkout that arrived with one (an
 * archive of a repository, a copied directory) can carry it. Such a repository
 * is not auto-approved, nor is one whose git directory we cannot read.
 */
function repositoryRunsPrograms(cwd: string): boolean {
  let dir = cwd
  for (let hops = 0; hops < 64; hops++) {
    const dotGit = join(dir, ".git")
    try {
      const info = lstatSync(dotGit)
      if (!info.isDirectory()) return true // a gitfile points somewhere we do not scan
      for (const name of ["config", "config.worktree"]) {
        try { if (PROGRAM_RUNNING_KEYS.test(readFileSync(join(dotGit, name), "utf8"))) return true } catch { /* absent */ }
      }
      return false
    } catch { /* not here, look one level up */ }
    const parent = dirname(dir)
    if (parent === dir) return false
    dir = parent
  }
  return true
}

function gitIsReadOnly(tokens: Token[], cwd: string): boolean {
  // `git -c x=y log` and `git --git-dir=... log` change what git runs, so the
  // subcommand must be the very first word.
  const sub = tokens[0]?.text
  if (!sub || sub.startsWith("-")) return false
  if (repositoryRunsPrograms(cwd)) return false
  const rest = tokens.slice(1)
  if (sub === "remote") return rest.length === 0 || (rest.length === 1 && (rest[0]!.text === "-v" || rest[0]!.text === "--verbose"))
  if (sub === "stash") return rest.length === 1 && (rest[0]!.text === "list" || rest[0]!.text === "show")
  let spec: Spec | undefined
  if (Object.hasOwn(GIT_SPECS, sub)) spec = GIT_SPECS[sub]
  else if (sub === "branch") spec = GIT_BRANCH_LIST
  else if (sub === "tag") spec = { flags: "ln", long: ["--list"], numeric: true }
  else return false
  const operands = parseArgs(rest, spec!)
  if (operands === null) return false
  const listing = rest.some(token => token.text === "-l" || token.text === "--list")
  // A name given without a listing flag would create a branch or tag.
  if (sub === "branch" && operands.length > 0) return false
  if (sub === "tag") return operands.length === 0 || listing
  if (sub === "rev-parse") return operands.every(operand => /^[\w@{}^~:./-]+$/.test(operand) && !operand.startsWith("/") && !operand.includes(".."))
  // Revisions and pathspecs are operands too. `HEAD:../x` and `:/x` name a path
  // after the last colon, and that path must stay inside the workspace.
  return operands.every(operand => insideWorkspace(operand, cwd)
    && (!operand.includes(":") || insideWorkspace(operand.slice(operand.lastIndexOf(":") + 1), cwd)))
}

/** True only for a command line that cannot do more than read inside `cwd`. */
export function isReadOnlyCommand(command: string, cwd: string): boolean {
  // cmd.exe expands %VAR% and has its own quoting rules; this parser models /bin/sh.
  if (process.platform === "win32") return false
  if (!command.trim() || SHELL_METACHARACTERS.test(command)) return false
  const tokens = words(command.trim())
  if (!tokens || tokens.length === 0 || tokens[0]!.unquotedExpansion) return false
  const name = tokens[0]!.text
  const args = tokens.slice(1)
  if (name.includes("/") || name.includes("=")) return false
  if (name === "git") return gitIsReadOnly(args, cwd)
  if (name === "find") return findIsReadOnly(args, cwd)
  if (!Object.hasOwn(SPECS, name)) return false
  const spec = SPECS[name]!
  const operands = parseArgs(args, spec)
  return operands !== null && operandsAreAcceptable(operands, spec, cwd)
}

/**
 * The directory a bash call really runs in: its `cwd` argument resolved against
 * the workspace, and only when it is still inside the workspace. The tool
 * expands `~` and variables, so a value that uses either is never trusted.
 */
export function effectiveCommandCwd(workspace: string, cwdArg: unknown): string | null {
  if (cwdArg === undefined || cwdArg === null || cwdArg === "") return workspace
  if (typeof cwdArg !== "string" || cwdArg.startsWith("~") || cwdArg.includes("$")) return null
  // The bash tool folds `link/..` away lexically before it spawns, while the
  // kernel (and insideWorkspace) take `..` after a link to be the parent of the
  // link's target. A `..` could therefore be judged in one directory and run in
  // another, so any `..` component is refused.
  if (cwdArg.split(/[\\/]+/).includes("..")) return null
  const root = realResolve(resolve(workspace))
  if (root === null) return null
  const dir = realResolve(isAbsolute(cwdArg) ? cwdArg : `${root}${sep}${cwdArg}`)
  if (dir === null || !insideWorkspace(dir, workspace)) return null
  return dir
}

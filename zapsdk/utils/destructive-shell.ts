import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep, dirname, basename, posix } from "node:path";

export interface ShellSafetyContext {
  cwd: string;
  workspaceRoot: string;
  syntax?: "posix" | "cmd" | "unknown";
  /** Remote paths have no host realpath evidence. Lexical checks are signals,
   * not a claim that guest symlinks stay inside the workspace. */
  pathResolution?: "local" | "lexical";
}

type Word = { value: string; uncertain: boolean };
type HereDocument = { body: string; delimiter: string; stripTabs: boolean; quoted: boolean };
type Token = Word | { op: string } | { hereDocument: HereDocument };
export type DestructiveShellRisk = "rm_recursive_system_path" | "world_writable_chmod" | "device_removal";

/** Split on shell operators (;, &&, ||, |, &) while ignoring quoted segments. */
export function splitRiskSegments(command: string): string[] {
  const out: string[] = [];
  let buf = "";
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      buf += c;
      if (c === quote && command[i - 1] !== "\\") quote = null;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      buf += c;
      continue;
    }
    const two = command.slice(i, i + 2);
    if (two === "&&" || two === "||") {
      if (buf.trim()) out.push(buf.trim());
      buf = "";
      i++;
      continue;
    }
    if (c === ";" || c === "|" || c === "&") {
      if (buf.trim()) out.push(buf.trim());
      buf = "";
      continue;
    }
    buf += c;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

/** Recognition for the direct shell operations below, not a shell interpreter
 * or containment boundary. In particular, arbitrary programs can mutate files
 * without spelling rm/unlink/chmod. Never execute substitutions to classify them. */
function tokens(command: string, separateHereDocuments = true): Token[] {
  const out: Token[] = [];
  let value = "", started = false, uncertain = false, quoted = false;
  let quote: "'" | '"' | undefined;
  let delimiterOptions: { stripTabs: boolean } | undefined;
  const pending: HereDocument[] = [];
  const flush = () => {
    if (started) {
      out.push({ value, uncertain });
      if (delimiterOptions) {
        const document = { body: "", delimiter: value, quoted, ...delimiterOptions };
        pending.push(document);
        out.push({ hereDocument: document });
        delimiterOptions = undefined;
      }
    }
    value = ""; started = false; uncertain = false; quoted = false;
  };
  // Bodies start after the header's newline, in redirect order. Keep them on
  // their own command token: later header commands must not change their cwd.
  const readBodies = (start: number): number | null => {
    let cursor = start;
    for (const document of pending) {
      let ended = false;
      while (cursor < command.length) {
        const newline = command.indexOf("\n", cursor);
        const end = newline < 0 ? command.length : newline;
        let line = command.slice(cursor, end);
        if (document.stripTabs) line = line.replace(/^\t+/, "");
        // Unquoted backslash-newline folding can change the delimiter. Retain
        // the older conservative scan when this recognizer cannot separate it.
        if (!document.quoted && /\\$/.test(line)) return null;
        cursor = newline < 0 ? command.length : newline + 1;
        if (line === document.delimiter) { ended = true; break; }
        document.body += line + (newline < 0 ? "" : "\n");
      }
      if (!ended) return null;
    }
    pending.length = 0;
    return cursor;
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === "\\" && quote !== "'") {
      const next = command[i + 1];
      if (next === "\n") { i++; continue; }
      if (next !== undefined && (!quote || /[$`"\\]/.test(next))) {
        value += next; started = true; quoted = true; i++; continue;
      }
    }
    if (quote) {
      if (c === quote) quote = undefined;
      else {
        value += c;
        if (quote === '"' && /[$`]/.test(c)) uncertain = true;
      }
      continue;
    }
    if (c === "'" || c === '"') { quote = c; started = true; quoted = true; continue; }
    if (c === "#" && !started) {
      while (i < command.length && command[i] !== "\n") i++;
      out.push({ op: ";" });
      if (pending.length) {
        const next = readBodies(i + 1);
        if (next === null) return tokens(command, false);
        i = next - 1;
      }
      continue;
    }
    if (/\s/.test(c)) {
      flush();
      if (c === "\n") {
        out.push({ op: ";" });
        if (pending.length) {
          const next = readBodies(i + 1);
          if (next === null) return tokens(command, false);
          i = next - 1;
        }
      }
      continue;
    }
    if (/[;&|()<>]/.test(c)) {
      // An adjacent numeric word before a redirect is a file descriptor.
      if ((c === ">" || c === "<") && /^\d+$/.test(value)) {
        value = ""; started = false;
      }
      flush();
      const pair = command.slice(i, i + 2);
      if (separateHereDocuments && pair === "<<") {
        if (command[i + 2] === "<") {
          out.push({ op: "<<<" }); i += 2;
        } else {
          delimiterOptions = { stripTabs: command[i + 2] === "-" };
          out.push({ op: "<<" }); i += delimiterOptions.stripTabs ? 2 : 1;
        }
        continue;
      }
      if (["&&", "||", ">>", "<<", ">&", "<&", "|&"].includes(pair)) {
        out.push({ op: pair }); i++;
      } else out.push({ op: c });
      continue;
    }
    if (/[$`*?\[\]{}]/.test(c) || (c === "~" && !started)) uncertain = true;
    value += c; started = true;
  }
  if (quote) uncertain = true;
  flush();
  if (separateHereDocuments && (pending.length || delimiterOptions)) return tokens(command, false);
  return out;
}

/** Preserve symlink/.. ordering: path.resolve before realpath would erase it.
 * Missing final components are resolved against their existing real ancestor.
 * Permission errors and loops provide no evidence that a path is contained. */
function canonical(path: string): string | null {
  let current = path;
  const missing: string[] = [];
  for (;;) {
    try { return resolve(realpathSync.native(current), ...missing.reverse()); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") return null;
      const cut = current.lastIndexOf(sep);
      if (cut < 0 || current === sep) return null;
      missing.push(current.slice(cut + 1));
      current = current.slice(0, cut) || sep;
    }
  }
}

function worldWritable(mode: string): boolean {
  if (/^[0-7]{3,4}$/.test(mode)) return (parseInt(mode, 8) & 2) !== 0;
  return mode.split(",").some(clause => /^(?:[ugoa]*[oa][ugoa]*|)[+=][rwxXst]*w/.test(clause));
}

// Preserve the older risk signal in opaque interpreter/expansion strings.
// Their argv cannot be proved literal by this recognizer. This intentionally
// remains conservative; it is not permission to execute an unknown script.
function opaqueRisk(text: string): DestructiveShellRisk | null {
  for (const segment of splitRiskSegments(text)) {
    const rm = segment.match(/\brm\s+(?:(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)\s+)+(?:--\s+)?("[^"]+"|'[^']+'|[^\s;|&]+)/);
    if (rm && /^(?:\/|~|\$HOME|\*|\.\*)/.test(rm[1].replace(/^['"]|['"]$/g, ""))) return "rm_recursive_system_path";
    const chmod = segment.match(/\bchmod\s+(?:-R\s+)?(?:777|a\+w|o\+w|a=rwx)\s+(?:--\s+)?("[^"]+"|'[^']+'|[^\s;|&]+)/);
    if (chmod && (/^(?:\/|~|\$HOME|\*|\.\*)/.test(chmod[1].replace(/^['"]|['"]$/g, ""))
      || /\bchmod\s+-R\b/.test(segment))) return "world_writable_chmod";
  }
  return null;
}

/** Known direct destructive operations require narrow, resolved workspace
 * targets. Returning null only means this guard did not identify a risk;
 * normal approval, execution policy and OS restrictions still apply. */
export function destructiveShellRisk(
  command: string,
  context: ShellSafetyContext,
  depth = 0,
): DestructiveShellRisk | null {
  return scopedRisk(command, context, depth);
}

function scopedRisk(
  command: string,
  context: ShellSafetyContext,
  depth: number,
  inheritedDirectories?: Array<string | null>,
): DestructiveShellRisk | null {
  const syntax = context.syntax ?? (process.platform === "win32" ? "cmd" : "posix");
  if (syntax !== "posix") return opaqueRisk(command);
  const paths = context.pathResolution === "lexical" ? posix : { isAbsolute, relative, resolve, sep, dirname, basename };
  const canonicalPath = context.pathResolution === "lexical" ? posix.resolve : canonical;
  const root = canonicalPath(context.workspaceRoot);
  let directories: Array<string | null> = inheritedDirectories ?? [canonicalPath(context.cwd)];
  const pathFrom = (base: string | null, word: Word): string | null => {
    if (word.uncertain || !word.value || (!base && !paths.isAbsolute(word.value))) return null;
    return canonicalPath(paths.isAbsolute(word.value) ? word.value : `${base}${paths.sep}${word.value}`);
  };
  const removesDeviceEntry = (base: string | null, word: Word): boolean => {
    if (!word.value || (!base && !paths.isAbsolute(word.value))) return false;
    const raw = paths.isAbsolute(word.value) ? word.value : `${base}${paths.sep}${word.value}`;
    const inDevices = (path: string): boolean => path === "/dev" || path.startsWith("/dev/");
    // Retain literal /dev prefixes even when a glob or expansion is unresolved.
    if (inDevices(paths.resolve(raw))) return true;
    if (word.uncertain) return false;
    // Unlinking a workspace symlink removes that entry, not its target. Resolve
    // its parent only, while still recognizing a directory symlink into /dev.
    const parent = canonicalPath(paths.dirname(raw));
    return parent !== null && inDevices(paths.resolve(parent, paths.basename(raw)));
  };
  const strictChild = (path: string, root: string): boolean => {
    const rel = paths.relative(root, path);
    return rel !== "" && rel !== ".." && !rel.startsWith(`..${paths.sep}`) && !paths.isAbsolute(rel);
  };
  const stack: Array<Array<string | null>> = [];
  let words: Word[] = [];
  let documents: HereDocument[] = [];
  let redirect = false;
  const risk = (nextOperator?: string): DestructiveShellRisk | null => {
    const argv = words;
    words = [];
    const inputDocuments = documents;
    documents = [];
    // A body can contain shell code or substitutions. Preserve conservative
    // risk recognition, but never merge its cd/parenthesis state into the caller.
    for (const document of inputDocuments) {
      const found = scopedRisk(document.body, context, depth + 1, [...directories]);
      if (found) return found;
    }
    if (!argv.length) return null;
    let index = 0;
    while (argv[index] && /^[A-Za-z_][A-Za-z_0-9]*=/.test(argv[index].value)) index++;
    while (["command", "builtin", "exec"].includes(argv[index]?.value)) {
      index++;
      while (argv[index]?.value.startsWith("-")) index++;
    }
    // Branches retain every directory reached by a cd below. Ordinary
    // conditions alone do not change the working directory.
    if (["if", "then", "else", "elif", "do", "while", "until", "!"].includes(argv[index]?.value)) {
      index++;
    }
    let name = argv[index]?.value.split(/[\\/]/).at(-1) ?? "";
    if (!name) return null;
    const opaque = argv.map(w => w.value).join(" ");
    if (argv.some(w => w.uncertain)) {
      const embedded = opaqueRisk(opaque);
      if (embedded) return embedded;
    }
    // Plain echo/printf arguments are data, but their substitutions above can
    // execute code. Other wrappers may execute a later rm/unlink/chmod argv directly.
    if (!["rm", "unlink", "chmod", "cd", "echo", "printf"].includes(name)) {
      const nested = argv.findIndex((w, i) => i > index && /^(?:.*\/)?(?:rm|unlink|chmod)$/.test(w.value));
      if (nested >= 0) {
        const transparent = ["env", "timeout", "nice", "nohup", "command", "builtin", "exec"].includes(name)
          && !argv.slice(index + 1, nested).some(w => w.uncertain || /^(?:-C|--chdir)(?:=|$)/.test(w.value));
        index = nested;
        name = argv[index].value.split("/").at(-1) ?? "";
        if (!transparent) directories = [null]; // opaque wrappers may change cwd
      } else {
        const embedded = opaqueRisk(opaque);
        if (embedded) return embedded;
      }
    }
    const args = argv.slice(index + 1);
    if (name === "cd") {
      const cdArgs = [...args];
      let physical = false;
      while (cdArgs[0] && ["-L", "-P", "-e"].includes(cdArgs[0].value)) {
        const option = cdArgs.shift()!.value;
        if (option === "-P") physical = true;
        if (option === "-L") physical = false;
      }
      if (cdArgs[0]?.value === "--") cdArgs.shift();
      const target = cdArgs[0];
      // Only a successful cd reaches the right side of &&. For other control
      // flow retain the old directory too, since a failed cd may continue.
      // Logical cd collapses '..' before following symlinks; keep that spelling
      // for subsequent cd operations. File operands still use kernel realpath.
      const cdPath = (base: string | null): string | null => {
        if (physical) return pathFrom(base, target);
        if (target.uncertain || !target.value || (!base && !paths.isAbsolute(target.value))) return null;
        return paths.resolve(base ?? paths.sep, target.value);
      };
      directories = target && cdArgs.length === 1 && !target.value.startsWith("-")
        ? [...new Set([...(nextOperator === "&&" ? [] : directories), ...directories.map(cdPath)])]
        : [null];
      if (directories.length > 16) directories = [null];
      return null;
    }
    if (["eval", "source", ".", "pushd", "popd"].includes(name) || argv[index].uncertain) {
      directories = [null];
    }
    if (["sh", "bash", "dash", "zsh", "ksh"].includes(name)) {
      const pos = args.findIndex(a => /^-[^-]*c/.test(a.value));
      const script = args[pos + 1];
      if (pos >= 0 && script && !script.uncertain && depth < 8) {
        const found = scopedRisk(script.value, context, depth + 1, [...directories]);
        if (found) return found;
      }
    }
    if (name !== "rm" && name !== "unlink" && name !== "chmod") return null;
    let recursive = false, options = true;
    const operands: Word[] = [];
    for (const arg of args) {
      if (options && arg.value === "--") { options = false; continue; }
      if (options && arg.value.startsWith("-") && arg.value !== "-") {
        if (arg.value === "--recursive" || /^-[^-]*[rR]/.test(arg.value)) recursive = true;
        continue;
      }
      operands.push(arg);
    }
    if (name === "rm" || name === "unlink") {
      if (operands.some(target => directories.some(base => removesDeviceEntry(base, target)))) {
        return "device_removal";
      }
      if (name === "unlink") return null;
    }
    const id = name === "rm" ? "rm_recursive_system_path" : "world_writable_chmod";
    if (name === "rm" && !recursive) return null;
    if (name === "chmod") {
      const mode = operands.shift();
      if (!mode || (!mode.uncertain && !worldWritable(mode.value))) return null;
      if (recursive) return id;
    }
    for (const target of operands) {
      for (const base of directories) {
        const path = pathFrom(base, target);
        // A filesystem-root workspace cannot turn system-wide operations into
        // narrow project operations. The workspace itself is broad too.
        if (!root || root === paths.resolve(root, "..") || !path || !strictChild(path, root)) return id;
      }
    }
    return null;
  };
  // At the nesting bound retain the old conservative scan rather than silently
  // omitting nested input. No shell command or expansion is ever executed here.
  for (const token of tokens(command, depth < 8)) {
    if ("hereDocument" in token) {
      documents.push(token.hereDocument);
      continue;
    }
    if ("value" in token) {
      if (redirect) redirect = false;
      else words.push(token);
      continue;
    }
    if ([">", ">>", "<", "<<", "<<<", ">&", "<&"].includes(token.op)) {
      redirect = true;
      continue;
    }
    const found = risk(token.op);
    if (found) return found;
    redirect = false;
    if (token.op === "(") { stack.push(directories); directories = [...directories]; }
    if (token.op === ")") directories = stack.pop() ?? [null];
  }
  return risk();
}

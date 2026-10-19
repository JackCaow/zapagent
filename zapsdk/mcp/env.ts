// Construct the env passed to stdio MCP children.
//
// Threat model: an MCP server is a third-party process running with full
// host capability. The previous implementation passed the entire parent
// process.env, leaking every API key in the user's shell to whatever npm
// package they pointed at. We start from a minimal baseline and let users
// opt in to additional vars via `envPassthrough` or override explicitly via
// `env`.

/** Variables that MCP servers almost universally need to function. */
const BASELINE = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "TERM",
  "TMPDIR",
  "TMP",
  "TEMP",
  // Locale family (LC_*) handled via prefix match below
  // OS-level
  "SYSTEMROOT", // Windows
  "APPDATA",
  "LOCALAPPDATA",
  "USERPROFILE",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMDATA",
  "COMSPEC",
  "PATHEXT",
]);

export interface BuildEnvOptions {
  /** Host env to pull from. Defaults to process.env. */
  hostEnv?: NodeJS.ProcessEnv;
  /** Names from hostEnv to forward in addition to BASELINE. Wildcards not supported — exact names only. */
  passthrough?: string[];
  /** Explicit env additions/overrides applied last. */
  overrides?: Record<string, string>;
}

export function buildChildEnv(opts: BuildEnvOptions = {}): Record<string, string> {
  const host = opts.hostEnv ?? process.env;
  const out: Record<string, string> = {};

  for (const [k, v] of Object.entries(host)) {
    if (v === undefined) continue;
    if (BASELINE.has(k) || k.startsWith("LC_")) {
      out[k] = v;
    }
  }

  if (opts.passthrough) {
    for (const name of opts.passthrough) {
      const v = host[name];
      if (typeof v === "string") out[name] = v;
    }
  }

  if (opts.overrides) {
    for (const [k, v] of Object.entries(opts.overrides)) {
      out[k] = v;
    }
  }

  return out;
}

export interface WatchOptions { enabled: boolean; port: number; open: boolean; linger: number; lingerSpecified?: boolean }
export function parseWatchArgs(argv: readonly string[]): { args: string[]; watch: WatchOptions } {
  const watch: WatchOptions = { enabled: false, port: 0, open: true, linger: 0 }, args: string[] = [];
  const seen = new Set<string>(), flags = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    // Prompt/config values are opaque, including a value that looks like --watch.
    if (["-p", "--print", "--cwd", "--model", "--session-id", "--permission-mode", "--output-format", "--max-turns",
      "--result-schema", "--timeout-ms", "--result-source-policy", "--service-owner", "--system-prompt-prepend", "--system-prompt-append", "--allowed-tools", "--disallowed-tools", "--public-checks"].includes(arg)) {
      args.push(arg); if (argv[i + 1] !== undefined) args.push(argv[++i]!); continue;
    }
    if (!["--watch", "--watch-port", "--watch-no-open", "--watch-linger"].includes(arg)) { if (arg.startsWith("--watch-")) throw new Error(`Unknown option ${arg}`); if (arg.startsWith("-")) flags.add(arg); args.push(arg); continue; }
    if (seen.has(arg)) throw new Error(`Duplicate ${arg}`);
    seen.add(arg);
    if (arg === "--watch") watch.enabled = true;
    else if (arg === "--watch-no-open") watch.open = false;
    else {
      const value = argv[++i];
      if (!value || !/^\d+$/.test(value)) throw new Error(`${arg} requires a non-negative integer`);
      const number = Number(value), max = arg === "--watch-port" ? 65535 : 300;
      if (!Number.isSafeInteger(number) || number > max) throw new Error(`${arg} must be between 0 and ${max}`);
      if (arg === "--watch-port") watch.port = number; else { watch.linger = number; watch.lingerSpecified = true; }
    }
  }
  if (seen.size && !watch.enabled) throw new Error("Watch options require --watch");
  if (watch.enabled && ([...flags].some(arg => ["--dev", "--acp", "--acp-worker"].includes(arg)) || ["acp", "workflow"].includes(args[0] ?? ""))) {
    throw new Error("--watch cannot be combined with DevTools, ACP or workflow commands");
  }
  return { args, watch };
}

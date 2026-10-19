import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import type {
  OsSandbox,
  SandboxCommandOptions,
  SandboxExecutionContext,
  SandboxedCommand,
  SandboxStatus,
} from "./types.js";
import { WINDOWS_APPCONTAINER_HELPER } from "./windows-appcontainer.js";
import { localExecutionShell } from "./shell.js";
import { linkedWorktreeReadRoots, macToolShimPath, workspaceRuntimeDirectory, workspaceRuntimeEnvironment, workspaceRuntimeTemporaryDirectory } from "./workspace-runtime.js";
import { NODE_PROXY_PRELOAD } from "./node-proxy-preload.generated.js";
import { ExecutionBoundaryError, operationFailure } from "./failure.js";

export interface PlatformSandboxOptions {
  platform?: NodeJS.Platform;
  sandboxExecPath?: string;
  bwrapPath?: string;
  windowsHelperPath?: string;
  tempRoot?: string;
  /** Host-owned, workspace-scoped home/cache/scratch. Omitted for strict,
   * stateless SDK sandboxes and remote runtimes. */
  workspaceStateRoot?: string;
  /** Embedder-owned paths that stay writable inside the process sandbox.
   * These are not derived from model/tool grants and must only be supplied by
   * a trusted runtime boundary such as a per-Computer persistent tool store. */
  trustedWritablePaths?: string[];
  /** Embedder-owned environment names that may cross into sandboxed child
   * processes. Values still come from the current process; callers must not
   * use this for model/search credentials. */
  trustedEnvironmentNames?: string[];
  /** Domain-filtering proxy for platforms that confine egress to loopback.
   * A factory returns a command-owned proxy. A supplied instance is forked. */
  networkProxy?: NetworkProxy | (() => NetworkProxy | undefined);
  /** Emit Windows helper lifecycle diagnostics. Intended for acceptance tests. */
  trace?: boolean;
}

import type { NetworkProxy } from "./network-proxy.js";

export function createPlatformSandbox(options: PlatformSandboxOptions = {}): OsSandbox {
  const platform = options.platform ?? process.platform;
  if (platform === "darwin") return new MacOsSeatbeltSandbox(options);
  if (platform === "linux") return new LinuxBubblewrapSandbox(options);
  if (platform === "win32") return new WindowsHelperSandbox(options);
  return new UnavailableSandbox(`unsupported platform: ${platform}`);
}

abstract class CommandWrappingSandbox implements OsSandbox {
  protected readonly tempRoot: string;
  private readonly trustedWritablePaths: string[];
  private readonly trustedEnvironmentNames: string[];
  protected readonly networkProxy?: NetworkProxy | (() => NetworkProxy | undefined);
  protected readonly workspaceStateRoot?: string;
  /** True only where the OS sandbox confines a command to the proxy port. */
  protected readonly enforcesNetworkProxy: boolean = false;

  constructor(
    tempRoot?: string,
    trustedWritablePaths: string[] = [],
    trustedEnvironmentNames: string[] = [],
    networkProxy?: NetworkProxy | (() => NetworkProxy | undefined),
    workspaceStateRoot?: string,
  ) {
    this.networkProxy = networkProxy;
    this.workspaceStateRoot = workspaceStateRoot;
    this.tempRoot = resolve(tempRoot ?? join(tmpdir(), "zapcode-sandbox"));
    this.trustedWritablePaths = trustedWritablePaths.map((path) => canonicalPath(resolve(path)));
    this.trustedEnvironmentNames = [...new Set(trustedEnvironmentNames)];
  }

  abstract status(): SandboxStatus;
  protected abstract wrap(
    executable: string,
    args: string[],
    input: {
      cwd: string;
      readablePaths: string[];
      writablePaths: string[];
      protectedPaths: string[];
      networkAllowed: boolean;
      proxyPort?: number;
      tempDir: string;
    },
  ): { executable: string; args: string[]; release?: () => void };

  createContext(input: Parameters<OsSandbox["createContext"]>[0]): SandboxExecutionContext {
    const status = this.status();
    if (!status.available || status.provider === "none") {
      throw new Error(status.reason ?? "OS sandbox is unavailable");
    }
    const runtimeDirectory = this.workspaceStateRoot
      ? workspaceRuntimeDirectory(this.workspaceStateRoot, input.workspace.root) : undefined;
    const runtimeTemp = runtimeDirectory ? workspaceRuntimeTemporaryDirectory(runtimeDirectory) : undefined;
    const writablePaths = [...new Set([
      ...(input.grant.filesystem?.write ?? []),
      ...this.trustedWritablePaths,
      ...(runtimeDirectory ? [runtimeDirectory] : []),
      ...(runtimeTemp ? [runtimeTemp] : []),
    ].map((path) => canonicalPath(resolve(input.workspace.root, path))))];
    const readablePaths = [...new Set([
      ...(input.grant.filesystem?.read ?? []),
      ...writablePaths,
      ...hostToolchainReadRoots(),
      ...linkedWorktreeReadRoots(input.workspace.root),
      dirname(canonicalPath(process.execPath)),
    ].map((path) => canonicalPath(resolve(input.workspace.root, path))))];
    const networkAllowed = (input.grant.network?.destinations.length ?? 0) > 0;
    const protectedPaths = [".git", ".zapcode"]
      .map((name) => canonicalPath(resolve(input.workspace.root, name)));
    const provider = status.provider;
    const prepare = (
      executable: string,
      args: string[],
      options: SandboxCommandOptions,
    ): SandboxedCommand => {
      mkdirSync(this.tempRoot, { recursive: true, mode: 0o700 });
      const tempDir = mkdtempSync(join(this.tempRoot, "run-"));
      const canonicalExecutable = canonicalPath(executable);
      let proxy: NetworkProxy | undefined;
      let wrapped: { executable: string; args: string[]; release?: () => void } | undefined;
      try {
        if (networkAllowed && this.enforcesNetworkProxy) {
          try {
            proxy = typeof this.networkProxy === "function" ? this.networkProxy() : this.networkProxy?.fork();
          } catch {
            throw new ExecutionBoundaryError("Sandbox network proxy could not start; the command was not launched. Check loopback listener availability.",
              operationFailure("BACKEND_UNAVAILABLE", "backend", input.executionId));
          }
        }
        wrapped = this.wrap(executable, args, {
          cwd: canonicalPath(resolve(options.cwd)),
          readablePaths: [...new Set([
            ...readablePaths,
            dirname(canonicalExecutable),
            canonicalPath(tempDir),
          ])],
          writablePaths,
          protectedPaths,
          networkAllowed,
          proxyPort: proxy?.port,
          tempDir: canonicalPath(tempDir),
        });
        let released = false;
        return {
          ...wrapped,
          env: sandboxEnvironment(tempDir, options, this.trustedEnvironmentNames, proxy?.url, runtimeDirectory, runtimeTemp),
          networkDenials: () => [...(proxy?.blockedHosts() ?? [])].map(([host, reason]) => ({ host, reason })),
          release: () => {
            if (released) return;
            released = true;
            proxy?.close();
            try { wrapped?.release?.(); } catch {}
            try {
              rmSync(tempDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
            } catch {
              // Cleanup must never turn a completed tool into a failed call.
              // Windows AV/ACL propagation can briefly retain a handle; the
              // next startup retention pass may safely remove this private dir.
            }
          },
        };
      } catch (error) {
        proxy?.close();
        try { wrapped?.release?.(); } catch {}
        rmSync(tempDir, { recursive: true, force: true });
        throw error;
      }
    };
    return {
      provider,
      enforced: true,
      readablePaths,
      writablePaths,
      protectedPaths,
      networkAllowed,
      prepareCommand: prepare,
      prepareShell: (command, options) => {
        const { executable, argsPrefix } = localExecutionShell();
        return prepare(executable, [...argsPrefix, command], options);
      },
    };
  }
}

class MacOsSeatbeltSandbox extends CommandWrappingSandbox {
  private readonly executable: string;
  protected override readonly enforcesNetworkProxy = true;

  constructor(options: PlatformSandboxOptions) {
    super(options.tempRoot, options.trustedWritablePaths, options.trustedEnvironmentNames, options.networkProxy, options.workspaceStateRoot);
    this.executable = options.sandboxExecPath ?? "/usr/bin/sandbox-exec";
  }

  status(): SandboxStatus {
    return existsSync(this.executable)
      ? { provider: "macos-seatbelt", available: true }
      : { provider: "macos-seatbelt", available: false, reason: `${this.executable} not found` };
  }

  protected wrap(
    executable: string,
    args: string[],
    input: {
      readablePaths: string[];
      writablePaths: string[];
      protectedPaths: string[];
      networkAllowed: boolean;
      proxyPort?: number;
      tempDir: string;
    },
  ): { executable: string; args: string[] } {
    const readable = [...new Set([...macSystemReadRoots(), ...input.readablePaths])]
      .map((path) => `(literal ${schemeString(path)}) (subpath ${schemeString(path)})`)
      .join(" ");
    const writable = [...input.writablePaths, input.tempDir]
      .map((path) => `(subpath ${schemeString(path)})`)
      .join(" ");
    const profile = [
      "(version 1)",
      "(deny default)",
      "(allow process*)",
      // A GUI app started here cannot load its frameworks, so it crashes and macOS
      // shows a crash-report dialog. Refuse the launch cleanly instead; the failure
      // text then points the model at the approved run outside the sandbox.
      '(deny process-exec (regex #"^/(System/)?Applications/[^/]+\\.app/Contents/MacOS/" #"^/Users/[^/]+/Applications/[^/]+\\.app/Contents/MacOS/"))',
      "(allow file-read-metadata)",
      "(allow file-read-data (literal \"/\"))",
      `(allow file-read* ${readable})`,
      "(allow sysctl-read)",
      "(allow mach-lookup)",
      "(allow ipc-posix-shm)",
      "(allow signal (target self))",
      "(allow file-write* (literal \"/dev/null\") (literal \"/dev/tty\"))",
      writable ? `(allow file-write* ${writable})` : "",
      // Workspace-local IPC is needed by build/watch tools. External sockets
      // (SSH agents, Docker, user daemons) remain outside these grants.
      `(allow network-bind network-outbound ${writable})`,
      `(deny file-write* ${input.protectedPaths
        .map((path) => `(literal ${schemeString(path)}) (subpath ${schemeString(path)})`)
        .join(" ")})`,
      // With a proxy the command may only dial loopback (the proxy and its own dev servers);
      // a tool that ignores the proxy settings cannot reach anything else.
      input.networkAllowed && input.proxyPort !== undefined
        ? `(allow network-outbound (remote ip "localhost:*")) (allow network-bind (local ip "localhost:*")) (allow network-inbound (local ip "localhost:*"))`
        : input.networkAllowed ? "(allow network*)" : "",
    ].filter(Boolean).join(" ");
    return {
      executable: this.executable,
      args: ["-p", profile, executable, ...args],
    };
  }
}

class LinuxBubblewrapSandbox extends CommandWrappingSandbox {
  private readonly executable: string;

  constructor(options: PlatformSandboxOptions) {
    super(options.tempRoot, options.trustedWritablePaths, options.trustedEnvironmentNames, undefined, options.workspaceStateRoot);
    this.executable = options.bwrapPath ?? findOnPath("bwrap") ?? "bwrap";
  }

  status(): SandboxStatus {
    return existsSync(this.executable)
      ? { provider: "linux-bwrap", available: true }
      : { provider: "linux-bwrap", available: false, reason: "bubblewrap (bwrap) not found" };
  }

  protected wrap(
    executable: string,
    args: string[],
    input: {
      cwd: string;
      readablePaths: string[];
      writablePaths: string[];
      protectedPaths: string[];
      networkAllowed: boolean;
      tempDir: string;
    },
  ): { executable: string; args: string[]; release?: () => void } {
    const createdProtectedPaths: string[] = [];
    for (const path of input.protectedPaths) {
      if (existsSync(path)) continue;
      try {
        mkdirSync(path, { mode: 0o555 });
        createdProtectedPaths.push(path);
      } catch {
        // A concurrent creator wins; the existence check below decides
        // whether a read-only overlay can still be installed.
      }
    }
    const bwrapArgs = [
      "--die-with-parent",
      "--new-session",
      "--unshare-all",
      "--proc", "/proc",
      "--dev", "/dev",
    ];
    const systemRoots = ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc"]
      .filter(existsSync);
    for (const path of systemRoots) bwrapArgs.push("--ro-bind", path, path);
    const writable = [...new Set([...input.writablePaths, input.tempDir])];
    const readable = input.readablePaths.filter((path) => (
      !writable.some((root) => pathIsWithin(path, root))
      && !systemRoots.some((root) => pathIsWithin(path, root))
    ));
    const grants = [...readable.map((path) => ({ path, writable: false })), ...writable.map((path) => ({ path, writable: true }))];
    const createdParents = new Set<string>();
    for (const grant of grants) {
      for (const parent of missingMountParents(grant.path, systemRoots)) {
        if (createdParents.has(parent)) continue;
        createdParents.add(parent);
        bwrapArgs.push("--perms", "0555", "--dir", parent);
      }
      bwrapArgs.push(grant.writable ? "--bind" : "--ro-bind", grant.path, grant.path);
    }
    // Later mounts override a broad writable workspace bind. Existing control
    // paths remain readable; absent paths appear as empty read-only directories
    // so a shell cannot create them during this execution.
    for (const path of input.protectedPaths) {
      for (const parent of missingMountParents(path, systemRoots)) {
        if (createdParents.has(parent)) continue;
        createdParents.add(parent);
        bwrapArgs.push("--perms", "0555", "--dir", parent);
      }
      if (existsSync(path)) bwrapArgs.push("--ro-bind", path, path);
    }
    if (input.networkAllowed) bwrapArgs.push("--share-net");
    bwrapArgs.push("--chdir", input.cwd, executable, ...args);
    return {
      executable: this.executable,
      args: bwrapArgs,
      release: () => {
        for (const path of createdProtectedPaths.reverse()) {
          try { rmdirSync(path); } catch {}
        }
      },
    };
  }
}

function pathIsWithin(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

function missingMountParents(path: string, systemRoots: string[]): string[] {
  const parents: string[] = [];
  let current = dirname(path);
  while (current !== "/" && !systemRoots.some((root) => pathIsWithin(current, root))) {
    parents.push(current);
    current = dirname(current);
  }
  return parents.reverse();
}

class WindowsHelperSandbox extends CommandWrappingSandbox {
  private readonly executable: string;
  private readonly trace: boolean;

  constructor(options: PlatformSandboxOptions) {
    super(options.tempRoot, options.trustedWritablePaths, options.trustedEnvironmentNames, undefined, options.workspaceStateRoot);
    this.executable = options.windowsHelperPath
      ?? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    this.trace = options.trace === true;
  }

  status(): SandboxStatus {
    return existsSync(this.executable)
      ? { provider: "windows-appcontainer", available: true }
      : {
          provider: "windows-appcontainer",
          available: false,
          reason: `Windows PowerShell bootstrap not found at ${this.executable}`,
        };
  }

  protected wrap(
    executable: string,
    args: string[],
    input: {
      cwd: string;
      readablePaths: string[];
      writablePaths: string[];
      protectedPaths: string[];
      networkAllowed: boolean;
      tempDir: string;
    },
  ): { executable: string; args: string[] } {
    const windowsRoot = canonicalPath(process.env.SystemRoot ?? "C:\\Windows").toLowerCase();
    const policy = Buffer.from(JSON.stringify({
      cwd: input.cwd,
      readablePaths: input.readablePaths.filter((path) => {
        const normalized = path.toLowerCase();
        return normalized !== windowsRoot && !normalized.startsWith(`${windowsRoot}\\`);
      }),
      writablePaths: input.writablePaths,
      protectedPaths: input.protectedPaths,
      networkAllowed: input.networkAllowed,
      tempDir: input.tempDir,
      launcherAssembly: canonicalPath(join(this.tempRoot, "windows-appcontainer-launcher-v1.dll")),
      trace: this.trace,
    })).toString("base64url");
    const helperPath = join(input.tempDir, "zap-appcontainer.ps1");
    writeFileSync(helperPath, WINDOWS_APPCONTAINER_HELPER, { encoding: "utf8", mode: 0o600 });
    return {
      executable: this.executable,
      args: [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy", "Bypass",
        "-File", helperPath,
        policy,
        executable,
        this.trace ? "on" : "off",
        ...args,
      ],
    };
  }
}

class UnavailableSandbox implements OsSandbox {
  constructor(private readonly reason: string) {}
  status(): SandboxStatus {
    return { provider: "none", available: false, reason: this.reason };
  }
  createContext(): never {
    throw new Error(this.reason);
  }
}

function schemeString(value: string): string {
  return JSON.stringify(value);
}

function canonicalPath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

/** Read-only roots for developer toolchains that live under HOME (bun, nvm,
 * cargo, ...). Only binary/runtime directories, never config or credentials. */
function hostToolchainReadRoots(): string[] {
  if (process.platform === "win32") return [];
  const home = homedir();
  const roots = [
    ".bun/bin", ".cargo/bin", ".deno/bin", ".local/bin", ".volta", ".nvm/versions", ".fnm",
    ".asdf", ".pyenv", ".rbenv", ".rustup", ".sdkman/candidates", ".nix-profile",
  ].map((name) => join(home, name));
  if (process.platform === "darwin") roots.push("/Applications/Xcode.app", "/Library/Developer");
  // A symlinked root (for example into a dotfiles repo) must not widen the
  // grant beyond the directory it names.
  const base = canonicalPath(home);
  return roots.filter(existsSync).map(canonicalPath)
    .filter((path) => path.startsWith("/Applications/") || path.startsWith("/Library/") || pathIsWithin(path, base));
}

/** Package-manager caches and user-level library dirs that stay writable in the
 * host sandbox, so `pip install`, `npm install`, `cargo build` and friends do not
 * need an approved escape. Never `bin` directories: those are on PATH. Only
 * directories that already exist (a bind mount needs its source). */
export function hostPackageWriteRoots(): string[] {
  if (process.platform === "win32") return [];
  const home = homedir();
  const roots = [
    ".cache/pip", ".cache/uv", ".cache/pnpm", ".cache/yarn", ".npm", ".bun/install", ".cargo/registry", ".cargo/git",
    "go/pkg/mod", "Library/Caches/pip", "Library/Caches/Yarn", "Library/pnpm", "Library/Python", ".local/lib",
  ].map((name) => join(home, name));
  const base = canonicalPath(home);
  return roots.filter(existsSync).map(canonicalPath).filter((path) => pathIsWithin(path, base));
}

function macSystemReadRoots(): string[] {
  return [
    "/System",
    "/usr",
    "/bin",
    "/sbin",
    "/Library",
    "/opt/homebrew",
    "/private/etc",
    "/private/var/db",
    "/dev",
  ].filter(existsSync).map(canonicalPath);
}

function sandboxEnvironment(
  tempDir: string,
  options: SandboxCommandOptions,
  trustedEnvironmentNames: string[] = [],
  proxyUrl?: string,
  runtimeDirectory?: string,
  runtimeTemp?: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const safeNames = new Set([
    "PATH", "PATHEXT", "SystemRoot", "SYSTEMROOT", "WINDIR", "ComSpec", "COMSPEC",
    "PROCESSOR_ARCHITECTURE", "PROCESSOR_IDENTIFIER", "NUMBER_OF_PROCESSORS",
    "SystemDrive", "SYSTEMDRIVE", "ALLUSERSPROFILE", "ProgramData",
    "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432",
    "CommonProgramFiles", "CommonProgramFiles(x86)", "CommonProgramW6432",
    "PSModulePath", "POWERSHELL_DISTRIBUTION_CHANNEL",
    "LANG", "LANGUAGE", "LC_ALL", "TERM", "COLORTERM", "NO_COLOR", "FORCE_COLOR", "TZ",
    "USER", "USERNAME", "LOGNAME",
  ]);
  for (const [key, value] of Object.entries(process.env)) {
    if (safeNames.has(key) || key.startsWith("LC_")) env[key] = value;
  }
  for (const key of [...trustedEnvironmentNames, ...(options.preserveEnvironment ?? [])]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  const realGitDir = macToolShimPath(tempDir);
  if (realGitDir) env.PATH = env.PATH ? `${realGitDir}${delimiter}${env.PATH}` : realGitDir;
  Object.assign(env, options.environment);
  for (const key of options.temporaryDirectoryEnvironment ?? []) env[key] = tempDir;
  env.HOME = options.hostHome ? homedir() : tempDir;
  env.TMPDIR = tempDir;
  env.TMP = tempDir;
  env.TEMP = tempDir;
  if (runtimeDirectory && runtimeTemp && !options.hostHome) {
    Object.assign(env, workspaceRuntimeEnvironment(runtimeDirectory, runtimeTemp));
    // User installs live in the private HOME too. Keep their entry points
    // available to later commands without writing into the host's PATH bins.
    const bins = process.platform === "win32" ? [join(env.HOME!, "npm")]
      : [join(env.HOME!, ".local", "bin"), join(env.HOME!, ".cargo", "bin"), join(env.HOME!, ".bun", "bin")];
    env.PATH = [...bins, ...(env.PATH ? [env.PATH] : [])].join(delimiter);
  }
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  if (proxyUrl) {
    for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) env[name] = proxyUrl;
    env.NO_PROXY = env.no_proxy = "localhost,127.0.0.1,::1";
    env.NODE_USE_ENV_PROXY = "1";
    const preload = join(tempDir, "node-proxy.cjs");
    writeFileSync(preload, NODE_PROXY_PRELOAD, { mode: 0o600 });
    // Host NODE_OPTIONS is deliberately filtered. JSON quoting supports spaces
    // in the sandbox storage path; no shell interprets this value.
    env.NODE_OPTIONS = `${env.NODE_OPTIONS ? `${env.NODE_OPTIONS} ` : ""}--require ${JSON.stringify(preload)}`;
  }
  if (process.platform === "win32") {
    env.USERPROFILE = env.HOME;
    env.LOCALAPPDATA = runtimeDirectory && !options.hostHome ? join(runtimeDirectory, "cache") : tempDir;
    env.APPDATA = env.HOME;
    env.GIT_CONFIG_GLOBAL = "NUL";
  }
  return env;
}

function findOnPath(name: string): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

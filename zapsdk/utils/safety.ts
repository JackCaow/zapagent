/** Shell risk signals used before ordinary permission rules. These heuristics
 * do not enumerate arbitrary program effects or replace OS containment.
 * Interactive hosts prompt on a match; noninteractive hosts refuse it. */
import { destructiveShellRisk, splitRiskSegments as splitSegments, type ShellSafetyContext } from "./destructive-shell.js";
import { shellCommandDisplay, shellExecutionCommands } from "./shell.js";
import { resolveToolPath } from "../builtin-tools/filesystem.js";
import { posix } from "node:path";
import { resolveZapVmGuestCwd } from "../execution/workspace-path.js";
import type { ShellExecutionEnvironment } from "../execution/types.js";

export type { ShellSafetyContext } from "./destructive-shell.js";

export interface DangerousPattern {
  id: string;
  reason: string;
  match: (command: string) => boolean;
}

export const DEFAULT_DANGEROUS_PATTERNS: DangerousPattern[] = [
  {
    id: "device_removal",
    reason: "removing entries from the system device namespace can break the execution environment",
    match: (cmd) => destructiveShellRisk(cmd, {
      cwd: process.cwd(), workspaceRoot: process.cwd(),
    }) === "device_removal",
  },
  {
    id: "rm_recursive_system_path",
    reason: "`rm` with recursive flag targeting a system or wide path",
    match: (cmd) => destructiveShellRisk(cmd, {
      cwd: process.cwd(), workspaceRoot: process.cwd(),
    }) === "rm_recursive_system_path",
  },
  {
    id: "sudo_elevation",
    reason: "`sudo` or `runas` — privilege escalation is never required for agent tasks",
    match: (cmd) =>
      splitSegments(cmd).some((s) => /^\s*(?:sudo|runas)(?:\s|$)/.test(s)),
  },
  {
    id: "pipe_to_shell",
    reason: "piping downloaded content to a shell (`curl … | sh`) — arbitrary remote code execution",
    match: (cmd) =>
      /\b(?:curl|wget|fetch|http)\b[^;]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|ksh|fish|dash|pwsh|powershell)\b/.test(
        cmd,
      ),
  },
  {
    id: "raw_device_write",
    reason: "writing to a raw block device (`> /dev/sd*`, `dd of=/dev/…`)",
    match: (cmd) =>
      /(?:>|>>)\s*\/dev\/(?:sd|nvme|hd|disk|vd|xvd|mmcblk)\w*/.test(cmd) ||
      /\bdd\b[^;|&]*\bof=\/dev\/(?:sd|nvme|hd|disk|vd|xvd|mmcblk)/.test(cmd),
  },
  {
    id: "filesystem_format",
    reason: "filesystem format / partition table edit",
    match: (cmd) =>
      splitSegments(cmd).some((s) =>
        /^\s*(?:mkfs(?:\.[a-z0-9]+)?|mke2fs|fdisk|parted|gdisk|sgdisk|cfdisk|wipefs)\b/.test(s),
      ),
  },
  {
    id: "power_state",
    reason: "power state change (`reboot`, `shutdown`, `halt`, `poweroff`)",
    match: (cmd) =>
      splitSegments(cmd).some((s) =>
        /^\s*(?:reboot|shutdown|halt|poweroff|init\s+[06]|telinit\s+[06])\b/.test(s),
      ),
  },
  {
    id: "crontab_wipe",
    reason: "`crontab -r` wipes the user's crontab without confirmation",
    match: (cmd) => /\bcrontab\s+-r\b/.test(cmd),
  },
  {
    id: "fork_bomb",
    reason: "fork bomb pattern — will hang the host",
    match: (cmd) => /:\s*\(\s*\)\s*\{[^}]*:\s*\|\s*:\s*&[^}]*\}\s*;\s*:/.test(cmd),
  },
  {
    id: "world_writable_chmod",
    reason: "`chmod` granting world-writable on a broad target",
    match: (cmd) => destructiveShellRisk(cmd, {
      cwd: process.cwd(), workspaceRoot: process.cwd(),
    }) === "world_writable_chmod",
  },
  {
    id: "git_force_push_main",
    reason: "force-push to main/master — can overwrite upstream history",
    match: (cmd) =>
      /\bgit\s+push\s+(?:[^;|&]*\s)?(?:--force\b|--force-with-lease\b|-f\b)(?:[^;|&]*\s)?(?:origin\s+)?(?:main|master|HEAD:(?:main|master))\b/.test(
        cmd,
      ),
  },
];

/** First matching risk signal. A null result is not a safety attestation. */
export function matchDangerous(command: string, context: ShellSafetyContext = {
  cwd: process.cwd(), workspaceRoot: process.cwd(),
}): DangerousPattern | null {
  const destructive = destructiveShellRisk(command, context);
  for (const p of DEFAULT_DANGEROUS_PATTERNS) {
    if (p.id === "rm_recursive_system_path" || p.id === "world_writable_chmod" || p.id === "device_removal") {
      if (p.id === destructive) return p;
    } else if (p.match(command)) return p;
  }
  return null;
}

/** Both hosts use the same initial directory as the command tool. Structured
 * checks each launch a fresh shell, so their directory changes are not shared. */
export function matchDangerousToolCall(
  args: Record<string, unknown>, workspaceRoot: string, defaultCwd = workspaceRoot,
  environment: Readonly<ShellExecutionEnvironment> = { syntax: process.platform === "win32" ? "cmd" : "posix", filesystem: "host" },
): DangerousPattern | null {
  const normalized = { ...args, command: shellCommandDisplay(args) };
  const context: ShellSafetyContext = {
    workspaceRoot,
    cwd: resolveToolPath(typeof args.cwd === "string" ? args.cwd : defaultCwd, defaultCwd),
    syntax: environment.syntax,
  };
  if (environment.filesystem === "workspace-mapped") {
    context.workspaceRoot = environment.workspaceRoot;
    context.pathResolution = "lexical";
    try { context.cwd = posix.resolve(environment.workspaceRoot, resolveZapVmGuestCwd(workspaceRoot, context.cwd)); }
    catch { context.cwd = "/"; } // The actual VM broker rejects an out-of-workspace initial cwd.
  }
  for (const command of shellExecutionCommands(normalized)) {
    const found = matchDangerous(command, context);
    if (found) return found;
  }
  return null;
}

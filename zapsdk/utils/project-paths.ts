import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";
import { realpathSync } from "node:fs";

export function legacyProjectDataSegment(cwd: string): string {
  return cwd.replace(/[\\/:]/g, "-");
}

export function resolveProjectDataSegment(cwd: string): string {
  return resolveGitProjectIdentity(cwd) ?? legacyProjectDataSegment(cwd);
}

export function resolveGitProjectIdentity(cwd: string): string | null {
  const root = gitOutput(cwd, ["rev-parse", "--show-toplevel"]);
  if (!root) return null;

  const remote = gitOutput(root, ["config", "--get", "remote.origin.url"]);
  const source = remote ? normalizeGitRemote(remote) : `local:${safeRealpath(root)}`;
  const label = remote ? remoteLabel(source) : basename(root);
  return `git-${sanitizeProjectSegment(label) || "repo"}-${shortHash(source)}`;
}

function gitOutput(cwd: string, args: string[]): string | null {
  try {
    const out = execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

function normalizeGitRemote(remote: string): string {
  let value = remote.trim();
  const ssh = value.match(/^git@([^:]+):(.+)$/);
  if (ssh) {
    value = `${ssh[1]}/${ssh[2]}`;
  } else {
    try {
      const url = new URL(value);
      value = `${url.host}${url.pathname}`;
    } catch {
      // Unknown remote formats are still hashed below.
    }
  }
  value = value.replace(/^\/+/, "").replace(/\.git$/i, "");
  return value.toLowerCase();
}

function remoteLabel(normalizedRemote: string): string {
  const parts = normalizedRemote.split(/[/:]/).filter(Boolean);
  return parts[parts.length - 1] ?? "repo";
}

function safeRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function sanitizeProjectSegment(value: string): string {
  return value
    .replace(/\.git$/i, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48)
    .toLowerCase();
}

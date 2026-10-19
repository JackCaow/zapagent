// Per-server OAuth state, persisted to ~/.config/zapcode/mcp-tokens.json.
//
// One JSON file holds entries for every configured server. Atomic write via
// rename so a crash mid-write can't leave us with a half-flushed file. Mode
// 0600 because this contains long-lived refresh tokens.

import { chmod, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";
import { writeFileAtomic } from "../../utils/atomic-write.js";
import type {
  OAuthClientInformationFull,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

export interface MCPOAuthEntry {
  serverName: string;
  /** The MCP server's URL — used to detect when config.url changes vs the saved state. */
  serverUrl: string;
  redirectUri?: string;
  loopbackPort?: number;
  clientInformation?: OAuthClientInformationFull;
  tokens?: OAuthTokens;
  /** PKCE verifier in-flight while waiting for the user's callback. */
  codeVerifier?: string;
  /** RFC 8707 resource indicator (canonical MCP URL the AS bound the token to). */
  resourceUrl?: string;
  /** Last successful auth timestamp — for UI display only. */
  lastAuthAt?: string;
}

interface StoreShape {
  version: 1;
  servers: Record<string, MCPOAuthEntry>;
}

export class MCPTokenStore {
  private path: string;
  private protectParentDir: boolean;
  private loaded: StoreShape | null = null;

  constructor(path?: string) {
    this.path = path ?? defaultStorePath();
    this.protectParentDir = path === undefined || basename(dirname(this.path)) === "zapcode";
  }

  static defaultPath(): string {
    return defaultStorePath();
  }

  async load(): Promise<StoreShape> {
    if (this.loaded) return this.loaded;
    if (!existsSync(this.path)) {
      this.loaded = { version: 1, servers: {} };
      return this.loaded;
    }
    try {
      const raw = await readFile(this.path, "utf-8");
      const parsed = JSON.parse(raw) as Partial<StoreShape>;
      this.loaded = {
        version: 1,
        servers: sanitizeServers(parsed.servers),
      };
      return this.loaded;
    } catch {
      // Corrupt file — start fresh rather than crash. The old file is left
      // on disk (we write via rename) so an operator can recover by hand.
      this.loaded = { version: 1, servers: {} };
      return this.loaded;
    }
  }

  async get(serverName: string): Promise<MCPOAuthEntry | undefined> {
    const data = await this.load();
    return data.servers[serverName];
  }

  async upsert(entry: MCPOAuthEntry): Promise<void> {
    const data = await this.load();
    data.servers[entry.serverName] = entry;
    await this.flush();
  }

  async patch(serverName: string, patch: Partial<MCPOAuthEntry>): Promise<MCPOAuthEntry> {
    const data = await this.load();
    const current = data.servers[serverName] ?? {
      serverName,
      serverUrl: patch.serverUrl ?? "",
    };
    const next: MCPOAuthEntry = { ...current, ...patch };
    data.servers[serverName] = next;
    await this.flush();
    return next;
  }

  async delete(serverName: string): Promise<void> {
    const data = await this.load();
    if (data.servers[serverName]) {
      delete data.servers[serverName];
      await this.flush();
    }
  }

  private async flush(): Promise<void> {
    if (!this.loaded) return;
    await this.ensurePrivateParentDir();
    await writeFileAtomic(this.path, JSON.stringify(this.loaded, null, 2) + "\n", { mode: 0o600 });
  }

  private async ensurePrivateParentDir(): Promise<void> {
    const dir = dirname(this.path);
    await mkdir(dir, { recursive: true });
    if (!this.protectParentDir || process.platform === "win32") return;
    try { await chmod(dir, 0o700); } catch {}
  }
}

function sanitizeServers(value: unknown): Record<string, MCPOAuthEntry> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, MCPOAuthEntry> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const rec = raw as Record<string, unknown>;
    const serverName = typeof rec.serverName === "string" && rec.serverName
      ? rec.serverName
      : key;
    const serverUrl = typeof rec.serverUrl === "string" ? rec.serverUrl : "";
    out[key] = {
      ...(raw as MCPOAuthEntry),
      serverName,
      serverUrl,
    };
  }
  return out;
}

function defaultStorePath(): string {
  // Prefer XDG_CONFIG_HOME, fall back to ~/.config (Linux/macOS) or
  // %APPDATA% (Windows). Keep tokens out of the project dir so a `git
  // clean -fdx` can't nuke them by accident.
  const xdg = process.env.XDG_CONFIG_HOME;
  const appdata = process.env.APPDATA;
  const base = xdg ?? appdata ?? join(homedir(), ".config");
  return join(base, "zapcode", "mcp-tokens.json");
}

// OAuth client per MCP server.
//
// MCP's auth model (RFC 7591 dynamic client registration + RFC 8707 resource
// indicators + PKCE) is implemented end-to-end by the SDK. Our job is to
// supply the small set of callbacks the SDK needs:
//   - where to load/save tokens, client info, PKCE verifier
//   - where to direct the user's browser
// We also expose a `runAuthFlow()` method the manager invokes when it gets
// an UnauthorizedError on connect.

import { randomBytes } from "node:crypto";
import type {
  OAuthClientInformationFull,
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { openBrowser } from "./browser.js";
import { startLoopback, type LoopbackCallback } from "./loopback.js";
import { MCPTokenStore } from "./token-store.js";

export interface MCPOAuthProviderOptions {
  serverName: string;
  serverUrl: string;
  store: MCPTokenStore;
  /**
   * Called when the SDK needs the user to authorize and the redirect URL
   * has been computed. Default behaviour: spawn the system browser. Tests
   * override this to short-circuit the flow.
   */
  openUrl?: (url: string) => Promise<void>;
  /** Surface auth-flow lifecycle to the UI (e.g. show a toast / log). */
  onPrompt?: (url: string) => void;
}

const CLIENT_NAME = "zapcode";
const SOFTWARE_ID = "zapcode";

export class MCPOAuthProvider implements OAuthClientProvider {
  readonly options: MCPOAuthProviderOptions;
  /** Active loopback listener while we're waiting on a callback. */
  private loopback: LoopbackCallback | null = null;
  /** Cached redirect URI: must match what was registered with the AS. */
  private currentRedirectUri: string | null = null;

  constructor(opts: MCPOAuthProviderOptions) {
    this.options = opts;
  }

  // ── SDK callbacks ─────────────────────────────────────────────────────

  get redirectUrl(): string {
    // The SDK reads this synchronously when building the authorize URL.
    // We populate `currentRedirectUri` inside runAuthFlow() before kicking
    // the SDK off, so by the time the SDK reads this it's set.
    if (this.currentRedirectUri) return this.currentRedirectUri;
    // Fallback: synthesise from any persisted port so re-validation paths
    // (e.g. token refresh after restart) don't crash before the listener
    // is up. The SDK only uses redirectUrl for the authorize URL, so this
    // is harmless if never hit during a successful refresh.
    return "http://127.0.0.1:0/callback";
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: CLIENT_NAME,
      software_id: SOFTWARE_ID,
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none", // public client; PKCE protects us
    };
  }

  state(): string {
    return randomBytes(16).toString("hex");
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    const entry = await this.options.store.get(this.options.serverName);
    // Legacy credentials have no authorization-server binding. Never let a
    // newly advertised issuer claim them; force a fresh registration instead.
    if (entry?.serverUrl !== this.options.serverUrl || !entry.clientInformation?.issuer) return undefined;
    return entry.clientInformation;
  }

  async saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
    await this.options.store.patch(this.options.serverName, {
      serverName: this.options.serverName,
      serverUrl: this.options.serverUrl,
      clientInformation: info as OAuthClientInformationFull,
    });
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    const entry = await this.options.store.get(this.options.serverName);
    if (entry?.serverUrl !== this.options.serverUrl || !entry.tokens?.issuer) return undefined;
    return entry.tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.options.store.patch(this.options.serverName, {
      serverName: this.options.serverName,
      serverUrl: this.options.serverUrl,
      tokens,
      lastAuthAt: new Date().toISOString(),
    });
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    await this.options.store.patch(this.options.serverName, {
      serverName: this.options.serverName,
      serverUrl: this.options.serverUrl,
      codeVerifier,
    });
  }

  async codeVerifier(): Promise<string> {
    const entry = await this.options.store.get(this.options.serverName);
    if (!entry?.codeVerifier) {
      throw new Error(`No code verifier stored for ${this.options.serverName}`);
    }
    return entry.codeVerifier;
  }

  async redirectToAuthorization(url: URL): Promise<void> {
    const u = url.toString();
    this.options.onPrompt?.(u);
    const openFn = this.options.openUrl ?? openBrowser;
    await openFn(u);
  }

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
    if (scope === "all") {
      await this.options.store.delete(this.options.serverName);
      return;
    }
    const patch: Record<string, undefined> = {};
    if (scope === "client") patch.clientInformation = undefined;
    if (scope === "tokens") patch.tokens = undefined;
    if (scope === "verifier") patch.codeVerifier = undefined;
    // discovery scope: no persisted state to clear in this layer
    await this.options.store.patch(this.options.serverName, patch as never);
  }

  // ── Driver: kick off the interactive flow on demand ─────────────────────

  /**
   * Run the full authorization-code+PKCE flow. The transport must be the
   * StreamableHTTPClientTransport that triggered the UnauthorizedError;
   * the SDK uses `finishAuth(code)` on it to complete the exchange.
   */
  async runAuthFlow(transport: StreamableHTTPClientTransport): Promise<void> {
    // Reuse the persisted port if we have one. If it's busy we fall back to
    // a random free port and re-register on the server.
    const prior = await this.options.store.get(this.options.serverName);
    this.loopback = await startLoopback({ preferredPort: prior?.loopbackPort });
    this.currentRedirectUri = this.loopback.redirectUri;

    // If the redirect URI we just minted differs from what the AS has on
    // file, invalidate the saved client info so the SDK re-registers with
    // the new redirect_uri.
    if (prior?.redirectUri && prior.redirectUri !== this.loopback.redirectUri) {
      await this.invalidateCredentials("client");
    }
    await this.options.store.patch(this.options.serverName, {
      serverName: this.options.serverName,
      serverUrl: this.options.serverUrl,
      redirectUri: this.loopback.redirectUri,
      loopbackPort: parsePort(this.loopback.redirectUri),
    });

    try {
      // Kick the SDK's discovery → DCR → authorize URL pipeline. This call
      // synchronously invokes redirectToAuthorization() (which opens the
      // browser) and then throws UnauthorizedError.
      await transport.start();
    } catch {
      // expected — we just want the redirect to fire
    }

    const { code } = await this.loopback.waitForCode();
    await transport.finishAuth(code);
  }

  /** Tear down any in-flight loopback listener. */
  stop(): void {
    this.loopback?.close();
    this.loopback = null;
  }
}

function parsePort(redirectUri: string): number | undefined {
  try { return Number(new URL(redirectUri).port) || undefined; } catch { return undefined; }
}

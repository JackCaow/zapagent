// Tiny localhost HTTP server that catches the OAuth redirect, extracts
// `code` + `state`, and unblocks the auth flow. We bind on 127.0.0.1 only —
// not 0.0.0.0 — so other machines on the LAN can't steal the authorization
// code in flight.

import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";

export interface LoopbackCallback {
  redirectUri: string;
  /** Resolves once the user's browser hits /callback with a valid `code`. */
  waitForCode(): Promise<{ code: string; state?: string }>;
  /** Stop the server. Safe to call multiple times. */
  close(): void;
}

export interface StartLoopbackOptions {
  /** Prefer this port (e.g. a previously persisted one). Falls back to a
   *  random free port if it's busy. */
  preferredPort?: number;
  /** Absolute timeout for waitForCode(); rejects after this many ms. */
  timeoutMs?: number;
  /** Where to land the user after success — defaults to a built-in HTML stub. */
  successHtml?: string;
  errorHtml?: (err: string) => string;
}

const DEFAULT_TIMEOUT_MS = 5 * 60_000;

export async function startLoopback(opts: StartLoopbackOptions = {}): Promise<LoopbackCallback> {
  // Try preferredPort first, fall back to 0 (OS-assigned) on EADDRINUSE.
  let server: Server;
  try {
    server = await listen(opts.preferredPort ?? 0);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EADDRINUSE" && opts.preferredPort) {
      server = await listen(0);
    } else {
      throw err;
    }
  }

  const port = (server.address() as AddressInfo).port;
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  let resolver: ((v: { code: string; state?: string }) => void) | null = null;
  let rejecter: ((e: Error) => void) | null = null;

  const codePromise = new Promise<{ code: string; state?: string }>((res, rej) => {
    resolver = res;
    rejecter = rej;
  });

  const timer = setTimeout(() => {
    rejecter?.(new Error("OAuth callback timed out"));
  }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  server.on("request", (req, res) => {
    // Reject anything that isn't our callback path. Stops bots that scan
    // localhost (Chrome's omnibox autofill probes, etc.) from racing the
    // real callback.
    if (!req.url || !req.url.startsWith("/callback")) {
      res.writeHead(404).end();
      return;
    }
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state") ?? undefined;
    const error = url.searchParams.get("error");

    if (error) {
      const desc = url.searchParams.get("error_description") ?? error;
      res.writeHead(400, { "Content-Type": "text/html" })
         .end(opts.errorHtml ? opts.errorHtml(desc) : defaultErrorHtml(desc));
      rejecter?.(new Error(`OAuth authorization failed: ${desc}`));
      return;
    }
    if (!code) {
      res.writeHead(400, { "Content-Type": "text/html" })
         .end(defaultErrorHtml("missing code parameter"));
      rejecter?.(new Error("OAuth callback missing code"));
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html" }).end(opts.successHtml ?? DEFAULT_SUCCESS_HTML);
    resolver?.({ code, state });
  });

  return {
    redirectUri,
    waitForCode: () => codePromise,
    close: () => {
      clearTimeout(timer);
      server.close(() => { /* ignore */ });
    },
  };
}

function listen(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}

const DEFAULT_SUCCESS_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>zapcode · MCP authorized</title>
<style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;background:#0e1116;color:#e6edf3;}main{text-align:center;}h1{margin:0 0 .5em;}p{opacity:.7;}</style>
</head><body><main><h1>Authorized.</h1><p>You can close this tab and return to zapcode.</p></main></body></html>`;

function defaultErrorHtml(desc: string): string {
  const escaped = desc.replace(/[<>&"]/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>zapcode · MCP auth failed</title>
<style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;background:#0e1116;color:#e6edf3;}main{text-align:center;max-width:32rem;padding:1rem;}h1{margin:0 0 .5em;color:#f85149;}p{opacity:.8;}</style>
</head><body><main><h1>Authorization failed</h1><p>${escaped}</p><p>Return to zapcode and try <code>/mcp auth &lt;server&gt;</code> again.</p></main></body></html>`;
}

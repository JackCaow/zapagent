import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes, timingSafeEqual } from "node:crypto";
import client from "./client.html" with { type: "text" };
import { WatchHub } from "./hub.js";

export class WatchServer {
  private server?: Server;
  private readonly clients = new Set<() => void>();
  private readonly token = randomBytes(32).toString("base64url");
  origin = "";
  constructor(readonly hub: WatchHub, readonly port = 0) {}
  get url() { return `${this.origin}/#token=${this.token}`; }
  async start() {
    if (this.server) throw new Error("Watch server already started");
    const server = createServer({ maxHeaderSize: 8192 }, (request, response) => {
      response.setHeader("cache-control", "no-store");
      response.setHeader("referrer-policy", "no-referrer");
      response.setHeader("x-content-type-options", "nosniff");
      const fail = (status: number, code: string) => {
        response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify({ code }));
      };
      if (request.headers.host !== this.origin.slice("http://".length)
        || (request.headers.origin !== undefined && request.headers.origin !== this.origin)) { fail(403, "INVALID_ORIGIN"); return; }
      if (request.method !== "GET") { fail(405, "READ_ONLY"); return; }
      const url = new URL(request.url ?? "/", this.origin);
      if (url.pathname === "/") {
        const nonce = randomBytes(16).toString("hex");
        response.writeHead(200, { "content-type": "text/html; charset=utf-8",
          "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'` });
        response.end(client.replaceAll("__WATCH_NONCE__", nonce)); return;
      }
      const auth = request.headers.authorization?.replace(/^Bearer /i, "") ?? "";
      const actual = Buffer.from(auth), expected = Buffer.from(this.token);
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) { fail(401, "UNAUTHORIZED"); return; }
      if (url.pathname === "/api/watch/v1/snapshot") {
        const snapshot = JSON.stringify(this.hub.snapshot());
        if (Buffer.byteLength(snapshot) > 8 * 1024 * 1024) { fail(503, "SNAPSHOT_CAPACITY"); return; }
        response.writeHead(200, { "content-type": "application/json" }); response.end(snapshot); return;
      }
      if (url.pathname !== "/api/watch/v1/events") { fail(404, "NOT_FOUND"); return; }
      if (this.clients.size >= 4) { fail(429, "CLIENT_LIMIT"); return; }
      const cursor = url.searchParams.get("after");
      if (!cursor || !/^\d+$/.test(cursor) || !Number.isSafeInteger(Number(cursor))) { fail(400, "INVALID_CURSOR"); return; }
      let closed = false, blocked = false, queuedBytes = 0;
      const queue: string[] = [];
      let detach: (() => void) | undefined;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      const close = () => {
        if (closed) return; closed = true; detach?.(); clearInterval(heartbeat);
        this.clients.delete(close); queue.length = 0; response.destroy();
      };
      const send = (text: string) => {
        if (closed) return;
        if (blocked) {
          queue.push(text); queuedBytes += Buffer.byteLength(text);
          if (queue.length > 256 || queuedBytes + response.writableLength > 1024 * 1024) close();
        } else {
          blocked = !response.write(text);
          if (response.writableLength > 1024 * 1024) close();
        }
      };
      const data = (json: string) => {
        const seq = (JSON.parse(json) as { seq: number }).seq;
        send(`id: ${seq}\nevent: watch\ndata: ${json}\n\n`);
      };
      const subscription = this.hub.connect(url.searchParams.get("instanceId") ?? "", Number(cursor), data);
      if (!subscription) { fail(409, "RESET_REQUIRED"); return; }
      detach = subscription.close;
      this.clients.add(close);
      response.on("close", close); response.on("error", close);
      response.on("drain", () => {
        blocked = false;
        while (queue.length && !blocked && !closed) { const item = queue.shift()!; queuedBytes -= Buffer.byteLength(item); send(item); }
      });
      response.writeHead(200, { "content-type": "text/event-stream", connection: "keep-alive", "x-accel-buffering": "no" });
      response.flushHeaders();
      for (const json of subscription.replay) { data(json); if (closed) break; }
      heartbeat = setInterval(() => send(`event: heartbeat\ndata: ${JSON.stringify({ serverNow: Date.now(), currentSeq: this.hub.seq })}\n\n`), 2000);
      heartbeat.unref();
      if (closed) clearInterval(heartbeat);
    });
    this.server = server; server.maxConnections = 32; server.headersTimeout = 10000; server.requestTimeout = 10000;
    try {
      await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(this.port, "127.0.0.1", resolve); });
    } catch (error) { this.server = undefined; server.close(); throw error; }
    this.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    server.on("error", () => { this.hub.stop("transport_error"); });
    return this;
  }
  async close() {
    const server = this.server; if (!server) return;
    this.server = undefined; this.hub.stop();
    for (const close of [...this.clients]) close();
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { server.closeAllConnections(); resolve(); }, 500); timer.unref();
      server.close(() => { clearTimeout(timer); resolve(); });
    });
    this.hub.close();
  }
}

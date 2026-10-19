import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { URL } from "node:url";
import type { RuntimeEvent } from "../runtime/types.js";
import { HostProtocolService } from "./service.js";

const MAX_BODY_BYTES = 1024 * 1024;

class RequestBodyTooLargeError extends Error {}

export interface AppServerOptions {
  service: HostProtocolService;
  hostname?: string;
  port?: number;
  authToken?: string;
}

export interface AppServerEndpoint {
  origin: string;
  token: string;
}

function safeTokenEqual(actual: string, expected: string): boolean {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export class AppServer {
  private readonly service: HostProtocolService;
  private readonly hostname: string;
  private readonly port: number;
  private readonly token: string;
  private readonly streamClosers = new Set<() => void>();
  private server?: Server;

  constructor(options: AppServerOptions) {
    this.service = options.service;
    this.hostname = options.hostname ?? "127.0.0.1";
    this.port = options.port ?? 0;
    this.token = options.authToken ?? randomBytes(32).toString("base64url");
    if (!["127.0.0.1", "::1", "localhost"].includes(this.hostname) && !options.authToken) {
      throw new Error("A caller-supplied authToken is required for non-loopback AppServer bindings");
    }
  }

  async start(): Promise<AppServerEndpoint> {
    if (this.server) throw new Error("AppServer is already running");
    this.server = createServer((request, response) => {
      void this.route(request, response).catch((error) => {
        if (!response.headersSent) response.writeHead(
          error instanceof RequestBodyTooLargeError ? 413 : 500,
          { "content-type": "application/json" },
        );
        response.end(JSON.stringify({ error: "internal server error" }));
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.port, this.hostname, () => resolve());
    });
    const address = this.server.address() as AddressInfo;
    const host = address.family === "IPv6" ? `[${address.address}]` : address.address;
    return { origin: `http://${host}:${address.port}`, token: this.token };
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    for (const closeStream of [...this.streamClosers]) closeStream();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }

  private async route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader("cache-control", "no-store");
    response.setHeader("x-content-type-options", "nosniff");
    const auth = request.headers.authorization?.replace(/^Bearer\s+/iu, "") ?? "";
    if (!safeTokenEqual(auth, this.token)) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method === "POST" && ["/v1/rpc", "/v2/rpc"].includes(url.pathname)) {
      const body = await this.readBody(request);
      let value: unknown;
      try {
        value = JSON.parse(body);
      } catch {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "invalid JSON" }));
        return;
      }
      const result = await this.service.handle(value);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(result));
      return;
    }
    const stream = /^\/v([12])\/threads\/([^/]+)\/events$/u.exec(url.pathname);
    if (request.method === "GET" && stream?.[2]) {
      const threadId = decodeURIComponent(stream[2]);
      const after = Number(url.searchParams.get("after") ?? "0");
      if (!Number.isSafeInteger(after) || after < 0) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "invalid after cursor" }));
        return;
      }
      const queued: RuntimeEvent[] = [];
      let streaming = false;
      const send = (event: RuntimeEvent) => {
        if (!streaming) {
          queued.push(event);
          return;
        }
        response.write(`id: ${event.sequence}\nevent: runtime_event\ndata: ${JSON.stringify(event)}\n\n`);
      };
      let unsubscribe: () => void;
      try {
        unsubscribe = await this.service.subscribe(threadId, after, send, stream[1] === "2" ? 2 : 1);
      } catch {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "thread not found" }));
        return;
      }
      response.writeHead(200, {
        "content-type": "text/event-stream",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      streaming = true;
      for (const event of queued) send(event);
      const heartbeat = setInterval(() => response.write(": keepalive\n\n"), 15_000);
      let closed = false;
      const closeStream = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        this.streamClosers.delete(closeStream);
        if (!response.writableEnded) response.end();
      };
      this.streamClosers.add(closeStream);
      request.once("close", closeStream);
      response.once("close", closeStream);
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not found" }));
  }

  private readBody(request: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let settled = false;
      request.on("data", (chunk: Buffer) => {
        if (settled) return;
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          settled = true;
          chunks.length = 0;
          reject(new RequestBodyTooLargeError("request body too large"));
          return;
        }
        chunks.push(chunk);
      });
      request.once("end", () => {
        if (!settled) resolve(Buffer.concat(chunks).toString("utf8"));
      });
      request.once("error", (error) => {
        if (!settled) reject(error);
      });
    });
  }
}

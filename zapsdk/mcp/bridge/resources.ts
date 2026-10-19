// Resources bridge.
//
// MCP resources are read-only data sources (files, DB rows, URL contents).
// Servers expose them in two flavours:
//   - concrete resources (uri is final)
//   - resource templates (URI templates per RFC 6570, e.g. file:///{path})
//
// We mirror both into framework-side `MCPResource` / `MCPResourceTemplate`
// records that the UI uses for the `@` reference picker, and we expose a
// `read(server, uri)` helper that pulls content for inclusion in user
// messages.

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { MCPError, withTimeout } from "../errors.js";
import { DEFAULTS, type MCPServerConfig } from "../types.js";

export interface MCPResource {
  server: string;
  uri: string;
  name?: string;
  title?: string;
  description?: string;
  mimeType?: string;
  size?: number;
}

export interface MCPResourceTemplate {
  server: string;
  uriTemplate: string;
  name?: string;
  title?: string;
  description?: string;
  mimeType?: string;
}

export interface MCPResourceContent {
  uri: string;
  /** Inline UTF-8 if the server returned text. */
  text?: string;
  /** Base64 if the server returned a blob (binary). */
  blob?: string;
  mimeType?: string;
}

const MAX_PAGES = 32;

export async function fetchResources(
  client: Client,
  config: MCPServerConfig,
): Promise<{ resources: MCPResource[]; templates: MCPResourceTemplate[] }> {
  const [resourcesRes, templatesRes] = await Promise.allSettled([
    listAllResources(client, config),
    listAllResourceTemplates(client, config),
  ]);
  return {
    resources: resourcesRes.status === "fulfilled" ? resourcesRes.value : [],
    templates: templatesRes.status === "fulfilled" ? templatesRes.value : [],
  };
}

async function listAllResources(client: Client, config: MCPServerConfig): Promise<MCPResource[]> {
  const out: MCPResource[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < MAX_PAGES; i++) {
    let res: Awaited<ReturnType<Client["listResources"]>>;
    try {
      res = await client.listResources(cursor ? { cursor } : undefined);
    } catch (err) {
      if (isUnsupportedMethodError(err)) return out;
      throw err;
    }
    for (const r of res.resources ?? []) {
      out.push({
        server: config.name,
        uri: r.uri,
        name: r.name,
        title: r.title,
        description: r.description,
        mimeType: r.mimeType,
        size: r.size,
      });
    }
    cursor = res.nextCursor;
    if (!cursor) break;
  }
  return out;
}

async function listAllResourceTemplates(client: Client, config: MCPServerConfig): Promise<MCPResourceTemplate[]> {
  const out: MCPResourceTemplate[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < MAX_PAGES; i++) {
    let res: Awaited<ReturnType<Client["listResourceTemplates"]>>;
    try {
      res = await client.listResourceTemplates(cursor ? { cursor } : undefined);
    } catch (err) {
      if (isUnsupportedMethodError(err)) return out;
      throw err;
    }
    for (const t of res.resourceTemplates ?? []) {
      out.push({
        server: config.name,
        uriTemplate: t.uriTemplate,
        name: t.name,
        title: t.title,
        description: t.description,
        mimeType: t.mimeType,
      });
    }
    cursor = res.nextCursor;
    if (!cursor) break;
  }
  return out;
}

function isUnsupportedMethodError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return msg.includes("-32601") || msg.includes("not found") || msg.includes("not supported");
}

export async function readResource(
  client: Client,
  config: MCPServerConfig,
  uri: string,
): Promise<MCPResourceContent[]> {
  const timeout = config.callTimeoutMs ?? DEFAULTS.callTimeoutMs;
  try {
    const res = await withTimeout(
      client.readResource({ uri }),
      timeout,
      `mcp:${config.name}:readResource`,
    );
    return (res.contents ?? []).map((c) => ({
      uri: c.uri,
      text: "text" in c ? c.text : undefined,
      blob: "blob" in c ? c.blob : undefined,
      mimeType: c.mimeType,
    }));
  } catch (err) {
    throw MCPError.wrap(err, config.name);
  }
}

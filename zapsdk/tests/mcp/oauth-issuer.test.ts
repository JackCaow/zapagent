import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MCPOAuthProvider, MCPTokenStore } from "../../mcp/oauth/index.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "zap-oauth-issuer-"));
  roots.push(root);
  const store = new MCPTokenStore(join(root, "tokens.json"));
  const provider = new MCPOAuthProvider({ serverName: "test", serverUrl: "https://mcp.example.test", store });
  return { root, store, provider };
}

test("legacy unbound credentials cannot be reused", async () => {
  const { store, provider } = fixture();
  await store.upsert({ serverName: "test", serverUrl: provider.options.serverUrl,
    clientInformation: { client_id: "fixture", redirect_uris: [] },
    tokens: { access_token: "fixture", token_type: "Bearer", refresh_token: "fixture" } });
  expect(await provider.clientInformation()).toBeUndefined();
  expect(await provider.tokens()).toBeUndefined();
});

test("issuer survives persistence and a different MCP URL cannot reuse credentials", async () => {
  const { root, provider } = fixture();
  const issuer = "https://auth.example.test";
  await provider.saveClientInformation({ client_id: "fixture", redirect_uris: [], issuer });
  await provider.saveTokens({ access_token: "fixture", token_type: "Bearer", issuer });
  const store = new MCPTokenStore(join(root, "tokens.json"));
  const restored = new MCPOAuthProvider({ ...provider.options, store });
  expect((await restored.clientInformation())?.issuer).toBe(issuer);
  expect((await restored.tokens())?.issuer).toBe(issuer);
  const changed = new MCPOAuthProvider({ ...provider.options, store, serverUrl: "https://other.example.test" });
  expect(await changed.clientInformation()).toBeUndefined();
  expect(await changed.tokens()).toBeUndefined();
});

import { expect, it } from "bun:test";
import { WatchHub } from "../../src/watch/hub.js";
import { WatchServer } from "../../src/watch/server.js";

it("serves only authenticated read-only metadata, with bounded replay and strict origin checks", async () => {
  const hub = new WatchHub(), server = await new WatchServer(hub).start();
  const url = new URL(server.url), token = url.hash.slice("#token=".length), headers = { Authorization: `Bearer ${token}` };
  const controller = new AbortController();
  try {
    const html = await fetch(server.origin);
    expect(html.status).toBe(200); expect(html.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(await html.text()).not.toContain("__WATCH_NONCE__");
    expect((await fetch(server.origin + "/api/watch/v1/snapshot")).status).toBe(401);
    expect((await fetch(server.origin + "/api/watch/v1/snapshot", { headers: { ...headers, Origin: "https://attacker.invalid" } })).status).toBe(403);
    expect((await fetch(server.origin + "/v2/rpc", { method: "POST", headers })).status).toBe(405);
    const snapshot = await (await fetch(server.origin + "/api/watch/v1/snapshot", { headers })).json() as any;
    const stream = await fetch(`${server.origin}/api/watch/v1/events?instanceId=${snapshot.instanceId}&after=${snapshot.throughSeq}`, { headers, signal: controller.signal });
    expect(stream.status).toBe(200);
    const reader = stream.body!.getReader();
    hub.session("known-session", "idle");
    const next = await reader.read();
    const frame = new TextDecoder().decode(next.value);
    expect(frame).toContain("event: watch"); expect(frame).toContain("known-session");
    expect((await fetch(`${server.origin}/api/watch/v1/events?instanceId=foreign&after=0`, { headers })).status).toBe(409);
    expect((await fetch(`${server.origin}/api/watch/v1/events?instanceId=${snapshot.instanceId}&after=-1`, { headers })).status).toBe(400);
    await reader.cancel();
  } finally { controller.abort(); await server.close(); }
}, 10000);

it("closes long-lived readers within a bounded shutdown interval", async () => {
  const server = await new WatchServer(new WatchHub()).start(); const url = new URL(server.url);
  const headers = { Authorization: `Bearer ${url.hash.slice(7)}` }, controller = new AbortController();
  try {
    const response = await fetch(`${server.origin}/api/watch/v1/events?instanceId=${server.hub.instanceId}&after=0`, { headers, signal: controller.signal });
    expect(response.status).toBe(200); const start = performance.now();
    await server.close(); expect(performance.now() - start).toBeLessThan(1000);
  } finally { controller.abort(); await server.close(); }
}, 10000);

import { describe, expect, it } from "bun:test";
import { redactJsonSecrets, redactTextSecrets } from "../../utils/redact.js";

describe("redactTextSecrets", () => {
  it("redacts bearer/basic credentials and token assignments", () => {
    const redacted = redactTextSecrets([
      "Authorization: Bearer sk-live",
      "Proxy-Authorization: Basic abc123",
      "api_key = sk-other",
      "client-secret: 'client-secret-value'",
      "keep=this-value",
    ].join("\n"));

    expect(redacted).toBe([
      "Authorization: Bearer [REDACTED]",
      "Proxy-Authorization: Basic [REDACTED]",
      "api_key = [REDACTED]",
      "client-secret: '[REDACTED]'",
      "keep=this-value",
    ].join("\n"));
  });

  it("preserves non-secret token-like words without assignments", () => {
    expect(redactTextSecrets("token budget and password manager docs")).toBe(
      "token budget and password manager docs",
    );
  });

  it("redacts high-confidence bare provider API keys", () => {
    const redacted = redactTextSecrets(
      "keys: sk-proj-abcdefghijklmnopqrstuvwxyz and sk-ant-abcdefghijklmnopqrstuvwxyz",
    );

    expect(redacted).toBe("keys: [REDACTED] and [REDACTED]");
  });
});

describe("redactJsonSecrets", () => {
  it("redacts complete nested credential values before escaping without mutating the input", () => {
    const value = { id: "call-a", path: "/tmp/fixture", token_count: 123, nested: [
      { password: 'prefix"tail-marker\nnext-line', "access-token": { nested: "private-fixture" } },
      { CLIENT_SECRET: "fixture-secret", secret: ["one", "two"] },
    ] };
    const before = JSON.stringify(value);
    const serialized = JSON.stringify(value, redactJsonSecrets);
    expect(JSON.parse(serialized)).toEqual({ id: "call-a", path: "/tmp/fixture", token_count: 123, nested: [
      { password: "[REDACTED]", "access-token": "[REDACTED]" },
      { CLIENT_SECRET: "[REDACTED]", secret: "[REDACTED]" },
    ] });
    expect(serialized).not.toContain("tail-marker");
    expect(serialized).not.toContain("private-fixture");
    expect(JSON.stringify(value)).toBe(before);
  });

  it("redacts credentials inside command strings before JSON quoting", () => {
    const serialized = JSON.stringify({ command: 'run --label fixture password="two word fixture"\nAuthorization: Bearer fixture-token' }, redactJsonSecrets);
    expect(JSON.parse(serialized).command).toBe('run --label fixture password="[REDACTED]"\nAuthorization: Bearer [REDACTED]');
    expect(serialized).not.toContain("word fixture");
    expect(serialized).not.toContain("fixture-token");
  });
});

import { describe, expect, it } from "bun:test";
import {
  redactBody,
  redactDevtoolsHttpRecord,
  redactDevtoolsValue,
  redactHeaders,
  redactUrl,
} from "../../devtools/redact.js";

describe("devtools redaction", () => {
  it("redacts sensitive headers while preserving diagnostic headers", () => {
    expect(redactHeaders({
      Authorization: "Bearer sk-live",
      "x-api-key": "secret",
      "content-type": "application/json",
    })).toEqual({
      Authorization: "[REDACTED]",
      "x-api-key": "[REDACTED]",
      "content-type": "application/json",
    });
  });

  it("redacts sensitive query parameters from URLs", () => {
    expect(redactUrl("https://api.example.test/v1?api_key=sk-live&model=x")).toBe(
      "https://api.example.test/v1?api_key=%5BREDACTED%5D&model=x",
    );
  });

  it("redacts nested config and JSON body secrets", () => {
    const value = redactDevtoolsValue({
      providers: [
        { id: "openai", apiKey: "sk-live", baseURL: "https://api.openai.com" },
      ],
      mcp: { token: "oauth-token", enabled: true },
      visible: "keep",
    });
    expect(value).toEqual({
      providers: [
        { id: "openai", apiKey: "[REDACTED]", baseURL: "https://api.openai.com" },
      ],
      mcp: { token: "[REDACTED]", enabled: true },
      visible: "keep",
    });

    expect(JSON.parse(redactBody(JSON.stringify({
      api_key: "sk-live",
      messages: [{ role: "user", content: "debug me" }],
      nested: { client_secret: "client-secret" },
    })))).toEqual({
      api_key: "[REDACTED]",
      messages: [{ role: "user", content: "debug me" }],
      nested: { client_secret: "[REDACTED]" },
    });
  });

  it("redacts urlencoded body secrets while preserving non-sensitive fields", () => {
    expect(redactBody("grant_type=refresh_token&refresh_token=rt-live&client_secret=cs-live&scope=read")).toBe(
      "grant_type=refresh_token&refresh_token=%5BREDACTED%5D&client_secret=%5BREDACTED%5D&scope=read",
    );
  });

  it("redacts plain text bearer/basic credentials and token assignments", () => {
    expect(redactBody([
      "Authorization: Bearer sk-live",
      "Proxy-Authorization: Basic abc123",
      "api_key = sk-other",
      "client-secret: 'client-secret-value'",
      "keep=this-value",
    ].join("\n"))).toBe([
      "Authorization: Bearer [REDACTED]",
      "Proxy-Authorization: Basic [REDACTED]",
      "api_key = [REDACTED]",
      "client-secret: '[REDACTED]'",
      "keep=this-value",
    ].join("\n"));
  });

  it("falls back to plain text redaction when JSON parsing fails", () => {
    expect(redactBody('{"api_key":"sk-live", "broken":')).toBe(
      '{"api_key":"[REDACTED]", "broken":',
    );
  });

  it("redacts full HTTP records", () => {
    const record = redactDevtoolsHttpRecord({
      id: "http_1",
      phase: "request",
      url: "https://api.example.test/chat?token=abc&safe=1",
      method: "POST",
      requestHeaders: {
        authorization: "Bearer abc",
        accept: "application/json",
      },
      responseHeaders: {
        "set-cookie": "sid=secret",
        "x-request-id": "req_1",
      },
      requestBody: JSON.stringify({ apiKey: "sk-live", prompt: "hello" }),
      startedAt: 1,
    });

    expect(record.url).toBe("https://api.example.test/chat?token=%5BREDACTED%5D&safe=1");
    expect(record.requestHeaders?.authorization).toBe("[REDACTED]");
    expect(record.requestHeaders?.accept).toBe("application/json");
    expect(record.responseHeaders?.["set-cookie"]).toBe("[REDACTED]");
    expect(record.responseHeaders?.["x-request-id"]).toBe("req_1");
    expect(JSON.parse(record.requestBody ?? "{}")).toEqual({
      apiKey: "[REDACTED]",
      prompt: "hello",
    });
  });

  it("redacts form bodies in full HTTP records", () => {
    const record = redactDevtoolsHttpRecord({
      id: "http_2",
      phase: "request",
      url: "https://api.example.test/oauth",
      method: "POST",
      requestHeaders: {
        "content-type": "application/x-www-form-urlencoded",
      },
      requestBody: "client_id=zap&client_secret=secret&refresh_token=rt",
      startedAt: 1,
    });

    expect(record.requestBody).toBe(
      "client_id=zap&client_secret=%5BREDACTED%5D&refresh_token=%5BREDACTED%5D",
    );
    expect(record.requestBodyTruncated).toBe(false);
  });

  it("redacts and truncates nested long strings", () => {
    const value = redactDevtoolsValue({
      apiKey: "sk-live",
      output: `start-${"x".repeat(120)}-end`,
      nested: { token: "secret" },
    }, 80);

    expect(value).toEqual({
      apiKey: "[REDACTED]",
      output: (value as any).output,
      nested: { token: "[REDACTED]" },
    });
    expect((value as any).output).toContain("truncated by devtools");
    expect((value as any).output).toContain("start-");
    expect((value as any).output).toContain("-end");
    expect((value as any).output.length).toBeLessThanOrEqual(80);
  });

  it("caps oversized HTTP request bodies after redaction", () => {
    const record = redactDevtoolsHttpRecord({
      id: "http_3",
      phase: "request",
      url: "https://api.example.test/chat",
      method: "POST",
      requestBody: JSON.stringify({
        model: "test",
        apiKey: "sk-live",
        messages: [{ role: "user", content: `head-${"x".repeat(80_000)}-tail` }],
      }),
      startedAt: 1,
    });

    expect(record.requestBodyTruncated).toBe(true);
    expect(record.requestBodyOriginalChars).toBeGreaterThan(64_000);
    expect(record.requestBody?.length).toBeLessThanOrEqual(64_000);
    expect(record.requestBody).toContain("[REDACTED]");
    expect(record.requestBody).toContain("truncated by devtools");
    expect(record.requestBody).not.toContain("sk-live");
  });
});

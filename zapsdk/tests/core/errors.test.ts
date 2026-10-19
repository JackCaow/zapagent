import { describe, expect, it } from "bun:test";
import {
  isLikelyContextLimitErrorMessage,
  isRequestBodyLimitError,
  looksLikeImageContentRejection,
} from "../../core/errors.js";

describe("context error classification", () => {
  it("recognizes scoped prompt and context limit errors", () => {
    expect(isLikelyContextLimitErrorMessage("prompt too long")).toBe(true);
    expect(isLikelyContextLimitErrorMessage("input is too long for this model")).toBe(true);
    expect(isLikelyContextLimitErrorMessage("context length exceeded")).toBe(true);
    expect(isLikelyContextLimitErrorMessage("token limit exceeded")).toBe(true);
    expect(isLikelyContextLimitErrorMessage("413 request entity too large")).toBe(false);
  });

  it("does not treat generic latency or auth errors as context overflow", () => {
    expect(isLikelyContextLimitErrorMessage("request took too long")).toBe(false);
    expect(isLikelyContextLimitErrorMessage("operation ran too long and timed out")).toBe(false);
    expect(isLikelyContextLimitErrorMessage("401 API token expired")).toBe(false);
    expect(isLikelyContextLimitErrorMessage("429 rate limit exceeded")).toBe(false);
  });

  it("keeps image schema rejections out of context compaction recovery", () => {
    const msg = "400 Bad Request: unknown variant `image_url`, expected `text`";

    expect(looksLikeImageContentRejection(msg)).toBe(true);
    expect(isLikelyContextLimitErrorMessage(msg)).toBe(false);
  });

  it("requires HTTP status or body-limit evidence rather than a numeric 413", () => {
    expect(isRequestBodyLimitError(new SyntaxError("Unexpected token x in JSON at position 413"))).toBe(false);
    expect(isRequestBodyLimitError(new Error("prompt too long: 413 tokens exceeds context length"))).toBe(false);
    expect(isLikelyContextLimitErrorMessage("prompt too long: 413 tokens exceeds context length")).toBe(true);
    for (const message of ["HTTP 413", "HTTP/1.1 413 Content Too Large", "status code: 413", "413 request entity too large", "Failed to buffer the request body: length limit exceeded"]) {
      expect(isRequestBodyLimitError(new Error(message))).toBe(true);
    }
    expect(isRequestBodyLimitError({ status: 413 })).toBe(true);
    expect(isRequestBodyLimitError(Object.assign(new Error("request body size limit exceeded"), { status: 429 }))).toBe(false);
  });
});

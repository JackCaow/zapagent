import type { ToolObservationSink, ToolResult } from "./types.js";

const HEADER = "[Partial completed tool observations; the delegated task did not finish.]\n";
const OMITTED = "[Earlier observation content omitted.]\n";

function tailUtf8(text: string, bytes: number): string {
  if (bytes <= 0) return "";
  // Slice before encoding so a huge tool result cannot expand this buffer.
  const buffer = Buffer.from(text.slice(-bytes));
  let start = Math.max(0, buffer.length - bytes);
  while (start < buffer.length && (buffer[start]! & 0xc0) === 0x80) start++;
  return buffer.subarray(start).toString("utf8");
}

/** One executor invocation owns this buffer, including through coordinator hops. */
export class PartialObservations implements ToolObservationSink {
  private maxBytes = 32_000;
  private body = "";
  private omitted = false;
  private closed = false;

  limit(maxBytes: number): void {
    if (this.closed || !Number.isFinite(maxBytes) || maxBytes < 0) return;
    this.maxBytes = Math.min(this.maxBytes, Math.floor(maxBytes));
    this.trim();
  }

  record(observation: { toolName: string; success: boolean; output: string; error?: string }): void {
    if (this.closed || (!observation.output && !observation.error)) return;
    const text = `[${observation.toolName.slice(0, 128)}: ${observation.success ? "succeeded" : "failed"}]\n`
      + tailUtf8(observation.output, this.maxBytes)
      + (observation.error ? `\nError: ${tailUtf8(observation.error, this.maxBytes)}` : "");
    if (Buffer.byteLength(observation.output) + Buffer.byteLength(observation.error ?? "") > this.maxBytes) this.omitted = true;
    this.body += (this.body ? "\n---\n" : "") + text;
    this.trim();
  }

  private trim(): void {
    const available = Math.max(0, this.maxBytes - Buffer.byteLength(HEADER + OMITTED));
    if (Buffer.byteLength(this.body) > available) {
      this.omitted = true;
      this.body = tailUtf8(this.body, available);
    }
  }

  retain(result: ToolResult): ToolResult {
    if (result.success || result.output || !this.body
      || !["CANCELLED", "DEADLINE_EXCEEDED", "EXECUTION_FAILED"].includes(result.failure?.code ?? "")) return result;
    return { ...result, output: HEADER + (this.omitted ? OMITTED : "") + this.body };
  }

  close(): void {
    this.closed = true;
    this.body = "";
  }
}

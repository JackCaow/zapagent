import { AgentEventEmitter, type AgentEvent } from "./events.js";

export const PROMPT_LEAK_RUN_LENGTH = 300;
const PROMPT_LEAK_MARKERS = [
  "# Persistent Memory",
  "## Memory types",
  "## How to save a memory",
  "# Project Guidelines (from AGENTS.md)",
  "[AGENT PROTOCOL]",
  "<system-context>",
  "<active_plan>",
  "<system-reminder>",
];

/** Exempt only bytes matching a host-classified public source. A shared tag
 * does not exempt a different/private body following it. */
function matchesPublicSource(text: string, offset: number, width: number, sources: readonly string[]): boolean {
  const candidate = text.slice(offset, offset + Math.max(width, PROMPT_LEAK_RUN_LENGTH));
  const anchor = candidate.slice(0, width);
  return sources.some(source => {
    for (let at = source.indexOf(anchor); at >= 0; at = source.indexOf(anchor, at + 1)) {
      const length = Math.min(candidate.length, source.length - at);
      if (source.slice(at, at + length) === candidate.slice(0, length)) return true;
    }
    return false;
  });
}

export function findPromptLeak(text: string, corpus: string, scanFrom = 0, publicSources: readonly string[] = []): Record<string, string> | undefined {
  for (const marker of PROMPT_LEAK_MARKERS) {
    if (!corpus.includes(marker)) continue;
    for (let at = text.indexOf(marker); at >= 0; at = text.indexOf(marker, at + 1)) {
      let width = marker.length;
      if (publicSources.length) {
        // A public document may end with a literal tag. Its tag alone must
        // not exempt private bytes that follow the same tag in host context.
        for (let sourceAt = corpus.indexOf(marker); sourceAt >= 0; sourceAt = corpus.indexOf(marker, sourceAt + 1)) {
          let matched = marker.length;
          while (matched < PROMPT_LEAK_RUN_LENGTH && at + matched < text.length && sourceAt + matched < corpus.length
            && text[at + matched] === corpus[sourceAt + matched]) matched++;
          width = Math.max(width, matched);
        }
      }
      if (!matchesPublicSource(text, at, width, publicSources)) return { marker };
    }
  }
  for (let i = Math.max(0, scanFrom); i + PROMPT_LEAK_RUN_LENGTH <= text.length; i++) {
    if (corpus.includes(text.slice(i, i + PROMPT_LEAK_RUN_LENGTH))
      && !matchesPublicSource(text, i, PROMPT_LEAK_RUN_LENGTH, publicSources)) return { reason: "long_verbatim_run" };
  }
  return undefined;
}

interface OutputBuffer {
  text: string;
  released: number;
  blocked?: string;
}

/** Guard the public event boundary, including preambles and visible reasoning.
 * Keep a possible match private until the detector has enough characters to decide.
 * Provider replay data and tool lifecycle events are left intact. */
export class PromptOutputEmitter extends AgentEventEmitter {
  private buffers = new Map<string, OutputBuffer>();

  constructor(
    private guard: (text: string, scanFrom?: number) => string,
    private enabled: () => boolean = () => true,
  ) {
    super();
  }

  clearOutputBuffers(): void {
    this.buffers.clear();
  }

  override emit(event: AgentEvent): void {
    // Descendants guard their own output against their own prompt and memory.
    if (!this.enabled() || event.path?.length) { super.emit(event); return; }
    if (event.type === "content_abandoned") this.buffers.delete(event.id);
    if ((event.type !== "content_delta" && event.type !== "content_final")
      || (event.kind !== "text" && event.kind !== "thinking")) {
      super.emit(event);
      return;
    }
    const buffer = this.buffers.get(event.id);
    if (event.type === "content_final") {
      const safe = buffer?.blocked ?? this.guard(event.text);
      if (buffer && !buffer.blocked) {
        // stream-json consumes deltas, so flush a safe tail before finalizing.
        const delta = safe === event.text ? buffer.text.slice(buffer.released) : safe;
        if (delta) super.emit({ ...event, type: "content_delta", text: delta });
      }
      // A streaming preamble can finalize at tool_call_start and then resume
      // under the same id. Retain its detection state until the run ends.
      const state = buffer ?? { text: event.text, released: event.text.length };
      state.released = state.text.length;
      if (safe !== event.text) state.blocked = safe;
      this.buffers.set(event.id, state);
      super.emit({ ...event, text: safe });
      return;
    }

    const state = buffer ?? { text: "", released: 0 };
    this.buffers.set(event.id, state);
    if (state.blocked) return;
    const scanFrom = Math.max(0, state.text.length - PROMPT_LEAK_RUN_LENGTH + 1);
    state.text += event.text;
    const safe = this.guard(state.text, scanFrom);
    if (safe !== state.text) {
      state.blocked = safe;
      super.emit({ ...event, text: safe });
      return;
    }
    let end = Math.max(0, state.text.length - PROMPT_LEAK_RUN_LENGTH + 1);
    // Do not split a UTF-16 surrogate pair at the release boundary.
    if (end > 0 && /[\uD800-\uDBFF]/.test(state.text[end - 1]!)) end--;
    end = Math.max(state.released, end);
    const delta = state.text.slice(state.released, end);
    state.released = end;
    if (delta) super.emit({ ...event, text: delta });
  }
}

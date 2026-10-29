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
  return sources.some(source => source.includes(text.slice(offset, offset + width)));
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
  visible: string;
  released: number;
  finalized: number;
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
    private normalize: (text: string, final: boolean) => string = text => text,
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
      // A tool preamble boundary is not EOF. Retain both the lookahead and
      // unstable markup; previews keep their buffer until the complete final.
      if (event.streamContinues) return;
      const state = buffer ?? { text: event.text, visible: "", released: 0, finalized: 0 };
      const projected = this.normalize(state.text, true);
      const rawSafe = state.blocked ?? this.guard(state.text);
      const safe = state.blocked ?? (rawSafe !== state.text ? rawSafe : this.guard(projected));
      // A final may already have been replaced by the loop's output policy.
      // Only release the checked projection, never a different raw tail.
      const finalSafe = this.guard(this.normalize(event.text, true));
      const isReplacement = finalSafe !== this.normalize(event.text, true)
        || (buffer && event.text !== buffer.text && event.text !== buffer.text.slice(buffer.text.length - event.text.length)
          && event.text !== projected);
      const complete = state.blocked ?? (safe !== projected ? safe : isReplacement ? finalSafe : projected);
      if (buffer && !buffer.blocked) {
        const prefix = state.visible.slice(0, state.released);
        const delta = complete.startsWith(prefix) ? complete.slice(state.released)
          : prefix.startsWith(complete) ? "" : complete;
        if (delta) super.emit({ ...event, type: "content_delta", text: delta });
      }
      const segment = state.blocked || complete !== projected ? complete : complete.slice(state.finalized);
      if (complete !== projected) state.blocked = complete;
      state.visible = complete;
      state.released = complete.length;
      state.finalized = complete.length;
      this.buffers.set(event.id, state);
      super.emit({ ...event, text: segment });
      return;
    }

    const state = buffer ?? { text: "", visible: "", released: 0, finalized: 0 };
    this.buffers.set(event.id, state);
    if (state.blocked) return;
    const scanFrom = Math.max(0, state.text.length - PROMPT_LEAK_RUN_LENGTH + 1);
    state.text += event.text;
    const visible = this.normalize(state.text, false);
    const rawSafe = this.guard(state.text, scanFrom);
    const safe = rawSafe !== state.text ? rawSafe : this.guard(visible,
      visible.startsWith(state.visible) ? Math.max(0, state.visible.length - PROMPT_LEAK_RUN_LENGTH + 1) : 0);
    if (rawSafe !== state.text || safe !== visible) {
      state.blocked = safe;
      super.emit({ ...event, text: safe });
      return;
    }
    const prefix = state.visible.slice(0, state.released);
    state.visible = visible;
    if (!visible.startsWith(prefix)) return;
    let end = Math.max(0, visible.length - PROMPT_LEAK_RUN_LENGTH + 1);
    // Do not split a UTF-16 surrogate pair at the release boundary.
    if (end > 0 && /[\uD800-\uDBFF]/.test(visible[end - 1]!)) end--;
    end = Math.max(state.released, end);
    const delta = visible.slice(state.released, end);
    state.released = end;
    if (delta) super.emit({ ...event, text: delta });
  }
}

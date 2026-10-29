/** Once control markup begins, later deletions can join text across nested
 * structures. Quarantine that suffix through true stream EOF; ordinary text
 * still streams once it is distinguishable from a partial control opener. */
function stableStreamPrefix(text: string): string {
  const prefixes = ["<tool_call", "<|tool_call", "<arg_key>"];
  for (let at = text.indexOf("<"); at >= 0; at = text.indexOf("<", at + 1)) {
    const tail = text.slice(at), lower = tail.toLowerCase();
    if (prefixes.some(prefix => prefix.startsWith(lower)) || /^<\|?tool_call[s_a-z]*\|?$/i.test(tail)
      || /^<\|?tool_call[s_a-z]*\|?>/i.test(tail) || lower.startsWith("<arg_key>")) return text.slice(0, at);
  }
  return text;
}

/** Shared display projection; private matching and lookahead use these same
 * characters, while the provider's original replay text remains untouched. */
export function normalizeAssistantText(text: string, final = true): string {
  if (!text) return text;
  let cleaned = final ? text : stableStreamPrefix(text);
  let previous: string;
  // Deletions may enable an outer pair. A fixed point makes the projection
  // idempotent across the loop, event boundary and final result serialization.
  do {
    previous = cleaned;
    cleaned = cleaned
      .replace(/<\|?tool_call[s_a-z]*\|?>[^]*?<\/?[|]?tool_call[s_a-z]*[|]?>/gi, "")
      .replace(/<\|?tool_calls_section_begin\|?>[^]*?<\|?tool_calls_section_end\|?>/gi, "")
      .replace(/<arg_key>[^<]*<\/arg_key><arg_value>[^<]*<\/arg_value>/gi, "");
  } while (cleaned !== previous);
  cleaned = cleaned.trimStart();
  if (final) cleaned = cleaned.trimEnd();
  const toolCallStart = cleaned.lastIndexOf("<|tool_call");
  if (toolCallStart !== -1 && !cleaned.includes("<|tool_call", toolCallStart + 1)) cleaned = cleaned.slice(0, toolCallStart).trimEnd();
  return cleaned;
}

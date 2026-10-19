/** Replace lone surrogates with U+FFFD before provider JSON serialization.
 *
 * Bun's JSON.stringify can emit \uD800-style escaped lone surrogate code
 * units, which strict upstream JSON parsers may reject. Valid surrogate pairs
 * must survive because they carry emoji and other non-BMP user text.
 */
export function sanitizeProviderText(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xDC00 && next <= 0xDFFF) {
        out += s[i] + s[i + 1];
        i++;
      } else {
        out += "\uFFFD";
      }
    } else if (code >= 0xDC00 && code <= 0xDFFF) {
      out += "\uFFFD";
    } else {
      out += s[i];
    }
  }
  return out;
}

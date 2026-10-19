export function normalizeLogicalNewlines(text: string): string {
  return text.replace(/\r\n?/gu, "\n");
}

export function splitLogicalLines(text: string): string[] {
  return normalizeLogicalNewlines(text).split("\n");
}

export function countLogicalLines(text: string): number {
  return splitLogicalLines(text).length;
}

export function hasLogicalNewline(text: string): boolean {
  return /(?:\r\n?|\n)/u.test(text);
}

export function countCodePoints(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    count++;
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) i++;
    }
  }
  return count;
}

export function sliceHeadCodePoints(text: string, maxChars: number): string {
  const limit = Number.isFinite(maxChars) ? Math.max(0, Math.floor(maxChars)) : 0;
  let end = 0;
  let count = 0;
  while (end < text.length && count < limit) {
    const code = text.charCodeAt(end);
    end++;
    if (isHighSurrogate(code) && end < text.length && isLowSurrogate(text.charCodeAt(end))) {
      end++;
    }
    count++;
  }
  return text.slice(0, end);
}

export function sliceTailCodePoints(text: string, maxChars: number): string {
  const limit = Number.isFinite(maxChars) ? Math.max(0, Math.floor(maxChars)) : 0;
  let start = text.length;
  let count = 0;
  while (start > 0 && count < limit) {
    start--;
    const code = text.charCodeAt(start);
    if (isLowSurrogate(code) && start > 0 && isHighSurrogate(text.charCodeAt(start - 1))) {
      start--;
    }
    count++;
  }
  return text.slice(start);
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

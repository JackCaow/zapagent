import type { ImageContent } from "../core/types.js";

export interface ImageDimensions { width: number; height: number }
const cache = new WeakMap<ImageContent, { base64: string; dimensions?: ImageDimensions }>();
const HEADER_BYTES = 64 * 1024;

/** Inspect only the encoded header; never decode pixels, read paths, or fetch URLs.
 * Old persisted/MCP image blocks need no migration. Weak keys don't retain history.
 * Unusually long JPEG metadata falls back to the model's unknown-size budget. */
export function imageDimensions(image: ImageContent): ImageDimensions | undefined {
  if (!image.base64) return undefined;
  const previous = cache.get(image);
  if (previous?.base64 === image.base64) return previous.dimensions;
  let dimensions: ImageDimensions | undefined;
  try {
    const bytes = Buffer.from(image.base64.slice(0, Math.ceil(HEADER_BYTES / 3) * 4), "base64");
    dimensions = parseImageDimensions(bytes);
  } catch { /* Corrupt/unsupported data is validated by the provider, not budgeting. */ }
  cache.set(image, { base64: image.base64, dimensions });
  return dimensions;
}

export function parseImageDimensions(b: Buffer): ImageDimensions | undefined {
  const size = (width: number, height: number) =>
    Number.isSafeInteger(width) && Number.isSafeInteger(height) && width > 0 && height > 0
      ? { width, height } : undefined;
  if (b.length >= 24 && b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    && b.toString("ascii", 12, 16) === "IHDR") {
    return size(b.readUInt32BE(16), b.readUInt32BE(20));
  }
  if (b.length >= 10 && /^(GIF87a|GIF89a)$/.test(b.toString("ascii", 0, 6))) {
    return size(b.readUInt16LE(6), b.readUInt16LE(8));
  }
  if (b.length >= 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") {
    for (let offset = 12; offset + 8 <= b.length;) {
      const kind = b.toString("ascii", offset, offset + 4);
      const length = b.readUInt32LE(offset + 4);
      const p = offset + 8;
      if (kind === "VP8X" && length >= 10 && p + 10 <= b.length) {
        return size(1 + b.readUIntLE(p + 4, 3), 1 + b.readUIntLE(p + 7, 3));
      }
      if (kind === "VP8L" && length >= 5 && p + 5 <= b.length && b[p] === 0x2f) {
        const bits = b.readUInt32LE(p + 1);
        return size((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
      }
      if (kind === "VP8 " && length >= 10 && p + 10 <= b.length
        && b[p + 3] === 0x9d && b[p + 4] === 1 && b[p + 5] === 0x2a) {
        return size(b.readUInt16LE(p + 6) & 0x3fff, b.readUInt16LE(p + 8) & 0x3fff);
      }
      offset = p + length + (length % 2);
    }
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let offset = 2;
    while (offset + 3 < b.length) {
      if (b[offset++] !== 0xff) return undefined;
      while (b[offset] === 0xff) offset++;
      const marker = b[offset++];
      if (marker === 0xda || marker === 0xd9) return undefined;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > b.length) return undefined;
      const length = b.readUInt16BE(offset);
      if (length < 2) return undefined;
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        if (length < 8 || offset + 7 > b.length) return undefined;
        return size(b.readUInt16BE(offset + 5), b.readUInt16BE(offset + 3));
      }
      offset += length;
    }
  }
  return undefined;
}

import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { atomicWrite } from "../builtin-tools/filesystem.js";
import { join } from "node:path";
import { Resvg } from "@resvg/resvg-js";
import { IMAGE_MAX_BYTES, validateGeneratedPng, type GeneratedImage } from "../core/providers/codex-image-generation.js";

export interface GeneratedImageArtifact {
  id: string;
  filePath?: string;
  cachePath?: string;
  mediaType: "image/png";
  width: number;
  height: number;
  bytes: number;
  /** Small RGB thumbnail, never provider-controlled terminal escape sequences. */
  thumbnail?: { width: number; height: number; rgb: string };
}
export interface GeneratedImageMeta {
  generatedImage: GeneratedImageArtifact;
  providerRequest: { requestBytes: number; responseBytes: number };
}
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

export function generatedImageArtifact(meta: unknown): GeneratedImageArtifact | undefined {
  const image = (meta as GeneratedImageMeta | undefined)?.generatedImage;
  if (!image || typeof image.id !== "string" || !/^[a-f0-9]{64}$/.test(image.id) || image.mediaType !== "image/png" || !Number.isSafeInteger(image.bytes)
    || image.bytes < 32 || image.bytes > IMAGE_MAX_BYTES || !Number.isSafeInteger(image.width) || !Number.isSafeInteger(image.height)
    || image.width < 1 || image.height < 1 || image.width > 4096 || image.height > 4096) return;
  return { id: image.id, mediaType: "image/png", width: image.width, height: image.height, bytes: image.bytes,
    ...(typeof image.filePath === "string" && image.filePath.length <= 4096 && !/[\x00-\x1f\x7f]/.test(image.filePath) ? { filePath: image.filePath } : {}),
    ...(typeof image.cachePath === "string" && image.cachePath.length <= 4096 && !/[\x00-\x1f\x7f]/.test(image.cachePath) ? { cachePath: image.cachePath } : {}),
    ...(image.thumbnail ? { thumbnail: image.thumbnail } : {}) };
}

export function generatedImageThumbnail(bytes: Buffer): GeneratedImageArtifact["thumbnail"] {
  const { width, height } = validateGeneratedPng(bytes);
  const w = 32, h = Math.max(2, Math.min(32, Math.round(w * height / width)));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="white"/><image href="data:image/png;base64,${bytes.toString("base64")}" width="${w}" height="${h}"/></svg>`;
  const rendered = new Resvg(svg, { font: { loadSystemFonts: false } }).render();
  const rgba = rendered.pixels, rgb = Buffer.alloc(w * h * 3);
  for (let i = 0; i < w * h; i++) rgba.copy(rgb, i * 3, i * 4, i * 4 + 3);
  return { width: w, height: h, rgb: rgb.toString("hex") };
}

/** Runtime-owned artifact storage is separate from model-chosen workspace writes.
 * A cache key is always a digest; restore never reads an arbitrary metadata path. */
export async function cacheGeneratedImage(directory: string, image: GeneratedImage): Promise<GeneratedImageArtifact> {
  const dimensions = validateGeneratedPng(image.bytes);
  const thumbnail = generatedImageThumbnail(image.bytes); // Decode/validate before publishing.
  const id = hash(image.bytes), path = join(directory, `${id}.png`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try { await atomicWrite(path, image.bytes, { replaceExisting: false, mode: 0o600 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = restoreGeneratedImage(directory, { generatedImage: { id, mediaType: "image/png", ...dimensions, bytes: image.bytes.length } });
    if (!existing?.equals(image.bytes)) throw new Error("Generated image artifact cache collision.");
  }
  return { id, cachePath: path, mediaType: "image/png", ...dimensions, bytes: image.bytes.length, thumbnail };
}

export function restoreGeneratedImage(directory: string, meta: unknown): Buffer | undefined {
  const image = generatedImageArtifact(meta);
  if (!image) return;
  let fd: number | undefined;
  try {
    if (lstatSync(join(directory, `${image.id}.png`)).isSymbolicLink()) return;
    fd = openSync(join(directory, `${image.id}.png`), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size !== image.bytes || stat.size > IMAGE_MAX_BYTES) return;
    const bytes = Buffer.alloc(image.bytes);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) return;
      offset += count;
    }
    if (fstatSync(fd).size !== image.bytes) return;
    const size = validateGeneratedPng(bytes);
    if (hash(bytes) !== image.id || size.width !== image.width || size.height !== image.height) return;
    return bytes;
  } catch { return; } finally { if (fd !== undefined) closeSync(fd); }
}

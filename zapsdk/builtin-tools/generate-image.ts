import { access, lstat, mkdir, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, extname, join } from "node:path";
import { z } from "zod";
import type { Tool, ToolResult } from "../tools/types.js";
import type { GeneratedImage, ImageGenerationRequest } from "../core/providers/codex-image-generation.js";
import { IMAGE_TIMEOUT_MS } from "../core/providers/codex-image-generation.js";
import { cacheGeneratedImage, type GeneratedImageMeta } from "../utils/generated-image.js";
import { atomicWrite, isToolPathWriteAllowed, resolveToolEffectPaths, resolveToolPath, resolveToolPathCanonical, type FileAccessOptions } from "./filesystem.js";

export interface GenerateImageOptions extends FileAccessOptions {
  defaultCwd?: string;
  protectedPaths?: string[];
  /** Host-owned model capability: pinned authenticated provider, independently
   * bounded request/response bytes and deadlines, and no automatic retries.
   * Model HTTP uses the provider budget; workspace bytes use execution grants. */
  generate: (request: ImageGenerationRequest, signal?: AbortSignal) => Promise<GeneratedImage>;
  /** Trusted runtime storage, never chosen by model arguments. Retains completed
   * results if a workspace write fails, until the user removes the artifacts. */
  artifactDirectory: string;
}

export function generateImageTool(options: GenerateImageOptions): Tool {
  const cwd = options.defaultCwd ?? process.cwd();
  return {
    definition: {
      name: "generate_image",
      description: "Generate a PNG image with your Codex/ChatGPT account and save it to output_path. Use for illustrations, UI assets, photos, backgrounds and transparent cutouts. Creates a new file; never overwrites an existing file. Generation uses account image limits.",
      prompt: "Use generate_image when the user asks to create an image. Choose a descriptive .png output_path in the workspace, then report the saved image path. Describe the desired visual in prompt; background=transparent produces a cutout. The provider chooses the final pixel dimensions. If a completed image has a local save error, recover the cached artifact reported by the tool instead of generating again. Do not retry a failed or interrupted generation without an explicit user request.",
      parameters: z.object({
        prompt: z.string().min(1).max(16000).describe("Visual description: subject, composition, style and constraints"),
        output_path: z.string().min(1).max(1024).regex(/^[^\x00-\x1f\x7f]+$/).describe("New .png path, relative to the workspace or absolute; an existing file is never replaced"),
        quality: z.enum(["auto", "low", "medium", "high"]).optional(),
        size: z.enum(["auto", "1024x1024", "1536x1024", "1024x1536"]).optional().describe("Requested shape/size; returned dimensions may differ"),
        background: z.enum(["auto", "opaque", "transparent"]).optional(),
      }),
      permission: "confirm", executionLocation: "host", timeoutMs: IMAGE_TIMEOUT_MS + 10_000,
      checkpointTracking: "files",
      writesPath: args => [resolveToolPath(String(args.output_path), cwd)],
      resolveEffects: args => ({
        filesystem: [{ kind: "filesystem", operation: "create", paths: resolveToolEffectPaths(String(args.output_path), cwd) }],
        network: [{ kind: "network", operation: "mutate", destinations: ["https://chatgpt.com/backend-api/codex/responses"], methods: ["POST"] }],
        external: [{ kind: "external", system: "openai:codex:image-generation", operation: "mutate" }],
        process: [], workspace: { mode: "root-integration" }, confidence: "declared",
      }),
    },
    handler: async (args, signal, context) => {
      const path = resolveToolPath(String(args.output_path), cwd);
      let meta: GeneratedImageMeta | undefined;
      let providerCompleted = false;
      try {
        signal?.throwIfAborted();
        if (extname(path).toLowerCase() !== ".png") throw new Error("Image output_path must end in .png.");
        const check = async (expected?: string) => {
          signal?.throwIfAborted();
          if (!(await isToolPathWriteAllowed(path, options, context))) throw new Error("Image output path is outside the granted writable paths or is protected.");
          const canonical = resolveToolPathCanonical(path, cwd);
          if (expected && canonical !== expected) throw new Error("Image output path changed during generation; recover the cached image.");
          try { await lstat(path); throw new Error("Image output already exists. Choose a new .png path; no generation was retried."); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
          return canonical;
        };
        const target = await check();
        // Fail unwritable/missing parents before spending image usage.
        await mkdir(dirname(path), { recursive: true });
        const parent = await realpath(dirname(path));
        await check(target);
        await mkdir(options.artifactDirectory, { recursive: true, mode: 0o700 });
        await access(options.artifactDirectory, constants.W_OK);
        const image = await options.generate({ prompt: String(args.prompt), quality: args.quality as ImageGenerationRequest["quality"],
          size: args.size as ImageGenerationRequest["size"], background: args.background as ImageGenerationRequest["background"] }, signal);
        // Cache only a confirmed provider result. Runtime artifact storage uses
        // the provider's image bound, separately from workspace execution bytes.
        providerCompleted = true;
        const artifact = await cacheGeneratedImage(options.artifactDirectory, image);
        meta = { generatedImage: artifact, providerRequest: { requestBytes: image.requestBytes, responseBytes: image.responseBytes } };
        signal?.throwIfAborted();
        context?.resources?.consumeFiles();
        context?.resources?.consumeFileBytes(image.bytes.length);
        await check(target);
        if (await realpath(dirname(path)) !== parent) throw new Error("Image output directory changed during generation.");
        await atomicWrite(target, image.bytes, { replaceExisting: false, signal, mode: 0o600, beforeCommit: async () => {
          await check(target);
          if (await realpath(dirname(path)) !== parent) throw new Error("Image output directory changed during generation.");
        } });
        artifact.filePath = path;
        return { success: true, output: `Generated image saved to ${path}\nPNG · ${artifact.width}×${artifact.height} · ${image.bytes.length} bytes`, meta,
          contentBlocks: [{ type: "image", filePath: path, mediaType: "image/png", base64: image.bytes.toString("base64"), source: "generate_image" }] };
      } catch (error) {
        const failure = error instanceof Error ? error.message : "Image generation failed.";
        const recovery = meta ? `\nGeneration completed; recover the existing PNG at ${join(options.artifactDirectory, `${meta.generatedImage.id}.png`)}. Do not generate it again.` : providerCompleted ? "\nImage generation completed but persistence failed. Do not generate it again automatically." : "";
        return { success: false, output: recovery.trim(), error: failure + recovery, ...(meta ? { meta } : {}) } satisfies ToolResult;
      }
    },
  };
}

import { execFile } from "node:child_process"
import { mkdtemp, readFile, realpath, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, extname, join } from "node:path"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"
import { parseHTML } from "linkedom"
import { z } from "zod"
import { isPathAllowed, isToolPathAllowed, resolveToolPath, resolveToolPathCanonical } from "../zapsdk/builtin-tools/filesystem.js"
import type { Tool } from "../zapsdk/tools/types.js"

const launch = promisify(execFile)
const maxBytes = 4 * 1024 * 1024
const imageTypes = new Map([
  [".avif", "image/avif"], [".gif", "image/gif"], [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"],
  [".png", "image/png"], [".svg", "image/svg+xml"], [".webp", "image/webp"],
])
const escape = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;")

function render(path: string, data: Buffer): string {
  const extension = extname(path).toLowerCase()
  const mime = imageTypes.get(extension)
  if (mime) return `<img style="max-width:100%;height:auto" src="data:${mime};base64,${data.toString("base64")}" alt="${escape(basename(path))}">`
  if (extension !== ".html" && extension !== ".htm") return `<pre style="white-space:pre-wrap">${escape(data.toString("utf8"))}</pre>`
  const { document } = parseHTML(data.toString("utf8"))
  // The frame also disallows scripts, nested content, forms and remote resources.
  document.querySelectorAll("base, meta, script, iframe, frame, object, embed, link").forEach(node => node.remove())
  document.querySelectorAll("a[href], area[href]").forEach(node => node.removeAttribute("href"))
  return document.toString()
}

async function openPreview(path: string, signal?: AbortSignal): Promise<void> {
  const url = pathToFileURL(path).href
  if (process.platform === "darwin") await launch("/usr/bin/open", [url], { signal, timeout: 5000 })
  else if (process.platform === "win32") {
    const system = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "rundll32.exe")
    await launch(system, ["url.dll,FileProtocolHandler", url], { signal, timeout: 5000 })
  } else await launch("/usr/bin/xdg-open", [url], { signal, timeout: 5000 })
}

export function artifactPreviewTool(root: string, open = openPreview): Tool {
  const protectedRoots = [join(root, ".git"), join(root, ".zapcode")]
  return {
    definition: {
      name: "preview_artifact",
      description: "Show an offline preview of a project file in the user's browser when they ask to see it. HTML and images render without scripts or remote resources. Other files show their text.",
      parameters: z.object({ path: z.string().min(1).describe("Path to the file inside the workspace") }),
      permission: "confirm",
      resolveEffects: args => ({
        filesystem: [{ kind: "filesystem", operation: "read", paths: [resolveToolPathCanonical(String(args.path), root)] }],
        network: [], process: [], external: [{ kind: "external", system: "artifact:preview", operation: "read" }],
        workspace: { mode: "none" }, confidence: "declared",
      }),
    },
    handler: async (args, signal, context) => {
      const path = resolveToolPath(String(args.path), root)
      try {
        const target = await realpath(path)
        if (!(await isPathAllowed(target, [root])) || await isPathAllowed(target, protectedRoots)
          || !(await isToolPathAllowed(target, { useExecutionGrants: true }, context, "read"))) {
          return { success: false, output: "", error: "Preview requires a file inside the project." }
        }
        const info = await stat(target)
        if (!info.isFile() || info.size > maxBytes) return { success: false, output: target, error: "Preview supports files up to 4 MiB." }
        const data = await readFile(target)
        if (data.length > maxBytes || (data.includes(0) && !imageTypes.has(extname(target).toLowerCase()))) {
          return { success: false, output: target, error: "This file cannot be rendered as an offline preview." }
        }
        const policy = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"
        const content = `<meta http-equiv="Content-Security-Policy" content="${policy}">${render(target, data)}`
        const preview = join(await mkdtemp(join(tmpdir(), "zap-preview-")), "preview.html")
        await writeFile(preview, `<!doctype html><meta charset="utf-8"><title>${escape(basename(target))} — Zap preview</title><iframe title="Artifact preview" sandbox style="position:fixed;inset:0;width:100%;height:100%;border:0" srcdoc="${escape(content)}"></iframe>`, { mode: 0o600 })
        signal?.throwIfAborted()
        await open(preview, signal)
        return { success: true, output: `Opened an offline preview of ${target}.` }
      } catch (error) {
        return { success: false, output: path, error: `Could not open a preview: ${error instanceof Error ? error.message : String(error)}` }
      }
    },
  }
}

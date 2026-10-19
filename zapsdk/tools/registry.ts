import type { Tool, ToolDefinition } from "./types.js";
import { adaptLegacyTool, type ToolManifest } from "./manifest.js";

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): void {
    const { name } = tool.definition;
    if (this.tools.has(name)) {
      throw new Error(`Tool "${name}" is already registered`);
    }
    this.tools.set(name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /** Map a model-emitted tool name onto a registered one. Exact names win. Models
   *  sometimes emit near misses (`http_фetch`, `Read-File`, `read_files`); a name
   *  that normalizes to a registered tool, or is one edit away from exactly one
   *  registered tool, is repaired instead of costing a failed round trip. Anything
   *  more distant stays unknown, and arguments are still validated by the tool. */
  resolveName(name: string): string | undefined {
    if (this.tools.has(name)) return name;
    const squash = (s: string) => s.trim().toLowerCase().replace(/[\s.\-]+/g, "_");
    const wanted = squash(name);
    const registered = [...this.tools.keys()];
    const same = registered.filter((candidate) => squash(candidate) === wanted);
    if (same.length === 1) return same[0];
    if (wanted.length < 5) return undefined;
    const near = registered.filter((candidate) => editDistanceAtMostOne(squash(candidate), wanted));
    return near.length === 1 ? near[0] : undefined;
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** Remove a tool by name. No-op if not registered. */
  unregister(name: string): void {
    this.tools.delete(name);
  }

  /** Return a shallow copy of this registry. */
  clone(): ToolRegistry {
    const copy = new ToolRegistry();
    for (const [, tool] of this.tools) copy.tools.set(tool.definition.name, tool);
    return copy;
  }

  private orderedTools(): Tool[] {
    return Array.from(this.tools.values())
      .sort((a, b) => a.definition.name.localeCompare(b.definition.name));
  }

  definitions(): ToolDefinition[] {
    return this.orderedTools().map((t) => t.definition);
  }

  manifests(cwd: string = process.cwd()): ToolManifest[] {
    return this.orderedTools().map((tool) => adaptLegacyTool(tool, cwd));
  }

  /** Collect extended prompts from all tools that have them. */
  toolPrompts(): string {
    const prompts: string[] = [];
    for (const tool of this.orderedTools()) {
      if (tool.definition.prompt) {
        prompts.push(`## ${tool.definition.name}\n${tool.definition.prompt}`);
      }
    }
    return prompts.length > 0 ? `# Tool usage guidance\n\n${prompts.join("\n\n")}` : "";
  }

  subset(names: string[]): ToolRegistry {
    const filtered = new ToolRegistry();
    for (const name of names) {
      const tool = this.tools.get(name);
      if (tool) {
        filtered.register(tool);
      }
    }
    return filtered;
  }
}

/** True when `a` and `b` differ by at most one insertion, deletion or substitution. */
function editDistanceAtMostOne(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1);
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

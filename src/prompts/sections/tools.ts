import type { PromptSection } from "../registry.js"

/**
 * Tool-selection guidance. Tool-aware: only mentions "prefer X over bash Y"
 * pairs when X is actually registered. Referencing a non-existent tool in
 * the prompt causes the model to attempt calls that fail with tool-not-found.
 */
export const toolsSection: PromptSection = {
  name: "tools",
  purpose: "behavior",
  compute: (ctx) => {
    const has = (name: string) => ctx.enabledTools.has(name)
    const preferLines: string[] = []

    if (has("read_file"))   preferLines.push("- Read files: use `read_file` (not `cat`, `head`, `tail`, `sed`)")
    if (has("edit_file"))   preferLines.push("- Edit files: use `edit_file` (not `sed` or `awk`)")
    if (has("write_file"))  preferLines.push("- Create files: use `write_file` (not `cat <<EOF` or `echo >`) — every byte of `content` is an output token you stream, so reserve it for new files and complete small-file rewrites.")
    if (has("write_file") && has("edit_file")) preferLines.push("- Large files (>~300 lines): write a skeleton with `write_file`, then add sections via `edit_file` (which only sends the diff). Don't re-emit the whole file just to change a portion.")
    if (has("write_file") && has("bash")) preferLines.push("- Generate data-heavy files (JSON tables, name lists, fixtures, scraped data): `write_file` a short generator script and `bash` it to produce the file — do NOT inline the data as a literal in `content`.")
    if (has("write_file") && has("bash")) preferLines.push("- Run multi-line scripts: `write_file` the script to a file, then `bash` it — do NOT inline via `python -c \"…\"` / `bash -c \"…\"` / `node -e \"…\"`. Inline payloads stream slowly (tens of seconds for large scripts) and routinely break on quote/newline escaping inside JSON. Short one-liners (≤ a couple lines, no literal quotes/newlines) are fine to inline.")
    if (has("glob_files"))  preferLines.push("- Find files by name: use `glob_files` (not `find` or `ls`)")
    if (has("search_files")) preferLines.push("- Search file contents: use `search_files` (not `grep` or `rg`)")
    if (has("list_tree")) preferLines.push("- Inspect repository structure: use `list_tree` (not `ls`)")

    const parts: string[] = [
      "# Using your tools",
    ]

    if (preferLines.length > 0 && has("bash")) {
      parts.push(
        "Prefer dedicated tools over `bash` when one fits — they let the user review your work more clearly and are more reliable across platforms. Reserve `bash` for system commands and shell operations that genuinely need a shell.",
        "",
        ...preferLines,
      )
    }

    parts.push(
      "",
      "You can call multiple tools in a single response. When tools are independent (e.g. reading three unrelated files), invoke them in parallel. When one tool's output informs another's arguments, call them sequentially. Maximize parallelism where dependencies allow.",
    )

    if (has("bash")) parts.push("When required access is unavailable, use the tool's declared approval mechanism for the needed resource. A file read approval is distinct from running a shell outside the sandbox. Explain a concrete boundary before requesting an unsandboxed retry; HTTP status or a generic command failure alone does not prove a sandbox denial. Do not ask the user to copy files when an available approved read can access them.")
    if (has("glob_files") || has("search_files")) parts.push("Search results describe only the searched scope and coverage. A traversal limit, skipped files, or a content search with no matches does not prove a named file is absent. Prefer the supplied exact path or a narrower relevant directory before declaring a missing resource.")

    if (has("agent")) {
      parts.push(
        "",
        "Use `agent` for useful independent work or context isolation. Consider child capabilities, input access, dependencies, coordination cost and remaining time, not tool-call count. Honor explicit user delegation requests. Avoid duplicating delegated searches.",
      )
    }

    if (has("task_status")) {
      parts.push(
        "",
        "For a background command, continue independent work instead of using sleep/ps polling loops. An unobserved completion notification is automatic. Use `task_status` to wait when the next action depends on its output; a bounded wait timeout is not a task failure. Do not repeat a completion result already observed; use `task_stop` only to cancel work that is no longer useful.",
      )
    }

    if (has("delegate_agent")) {
      parts.push(
        "",
        "When the user explicitly names an external coding-agent CLI (\"use claude to …\", \"让 codex 处理 …\", \"have claude analyze …\"), call `delegate_agent` with that provider — do NOT use the in-process `agent` tool, do NOT just shell out via `bash`, and do NOT do the work yourself. The named CLI IS the request. Only fall back to `agent` or direct work if `delegate_agent` is unavailable or the named provider isn't in its provider list.",
      )
    }

    return parts.join("\n")
  },
}

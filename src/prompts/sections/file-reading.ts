import type { PromptSection } from "../registry.js"

/**
 * Workflow guidance for navigating large or unfamiliar files.
 *
 * Without this, models — especially reasoning models — reach for `read_file`
 * first and dump entire files into the context "just in case". On a 3k-line
 * markdown that's 100k+ chars the agent burns through its budget before it
 * even knows what it's looking for. `read_file` now caps at 2000 lines by
 * default (see filesystem.ts), but a cap is a passive guardrail — this
 * section actively teaches the model how to paginate intelligently.
 *
 * Only emitted when the search/read tools are actually registered; in
 * agent setups that exclude them this section would be dead weight.
 */
export const fileReadingSection: PromptSection = {
  name: "file-reading",
  purpose: "behavior",
  compute: (ctx) => {
    const has = (name: string) => ctx.enabledTools.has(name)
    if (!has("read_file")) return null

    return `# Reading files strategically

When exploring unfamiliar code or large files (>500 lines), prefer a **find-then-read** flow over dumping entire files:

1. **Find first.** ${has("search_files") ? "Use `search_files` with a keyword or symbol name to locate the relevant lines. It returns `file:line` matches with a snippet — often that's enough context to answer without any additional read." : "Use an available inspection tool or the user's supplied path to locate the relevant content."}
2. **Read around the match.** Once you have specific line numbers, \`read_file\` with \`offset\` and \`limit\` (±10-20 lines of context) gives you the precise region with no waste.
3. ${has("glob_files") ? "**Survey unfamiliar directories with `glob_files`** before drilling into specific files — much cheaper than reading candidates one by one." : "**Narrow the scope** using available tools before reading candidate files."}
4. **Reading a whole large file is a last resort.** When \`read_file\` hits its default 2000-line cap it will tell you so in the header; follow the instruction there and page with \`offset\` instead of re-reading.

This matters because \`read_file\` output goes straight into your context window. A 3000-line file is ~100K characters — reading it "just in case" burns budget you'll need for the real work.`
  },
}

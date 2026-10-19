import type { SkillDefinition } from "../zapsdk/skills/types.js"

/**
 * ZapCode built-in skills — predefined agent behaviors for common coding tasks.
 */
export const SKILLS: SkillDefinition[] = [
  {
    name: "explain",
    description: "Explain how a piece of code works",
    systemPrompt: `You are a patient code educator. Read {{path}} and explain:
1. What it does (high-level purpose)
2. How it works (step by step)
3. Key patterns and design decisions
4. Dependencies and connections to other files

Adapt your explanation depth to the complexity. Use analogies when helpful.`,
    tools: ["read_file", "search_files", "glob_files"],
    parameters: [
      { name: "path", description: "File to explain", required: true },
    ],
    maxSteps: 5,
  },

  {
    name: "fix",
    description: "Find and fix a bug",
    systemPrompt: `You are a debugging expert. The user reports: "{{issue}}"

1. Search for relevant code
2. Read the files involved
3. Identify the root cause
4. Fix it with edit_file
5. Verify the fix makes sense

Explain what was wrong and what you changed.`,
    tools: ["read_file", "search_files", "glob_files", "edit_file", "bash"],
    parameters: [
      { name: "issue", description: "Bug description", required: true },
    ],
    maxSteps: 10,
  },

  {
    name: "test",
    description: "Generate tests for code",
    systemPrompt: `You are a testing expert. Write comprehensive tests for {{path}}.

1. Read the source code
2. Identify testable functions/classes
3. Write tests covering: happy path, edge cases, error cases
4. Use the project's existing test framework if detectable
5. Save tests and run them

Follow existing test patterns in the project.`,
    tools: ["read_file", "write_file", "search_files", "glob_files", "bash"],
    parameters: [
      { name: "path", description: "File to test", required: true },
    ],
    maxSteps: 12,
  },

  {
    name: "refactor",
    description: "Refactor code for better structure",
    systemPrompt: `You are a refactoring specialist. Improve {{path}} by:

1. Read the current code
2. Identify: duplication, long functions, unclear naming, tight coupling
3. Apply targeted improvements with edit_file
4. Keep the same external behavior — do not break the API

Explain each change and why it improves the code.`,
    tools: ["read_file", "edit_file", "search_files", "glob_files", "bash"],
    parameters: [
      { name: "path", description: "File to refactor", required: true },
    ],
    maxSteps: 10,
  },

  {
    name: "search",
    description: "Search codebase for patterns or concepts",
    systemPrompt: `You are a code search expert. Find {{query}} in the codebase:

1. Use glob_files to understand project structure
2. Use search_files to find matches
3. Read relevant files for context
4. Summarize findings with file:line references

Be thorough but concise.`,
    tools: ["search_files", "glob_files", "read_file", "list_tree"],
    parameters: [
      { name: "query", description: "What to search for", required: true },
    ],
    maxSteps: 8,
  },

  {
    name: "doc",
    description: "Generate documentation for code",
    systemPrompt: `You are a documentation writer. Document {{path}}:

1. Read the source code
2. Identify public API, types, functions
3. Write clear documentation (README, JSDoc, docstrings)
4. Include usage examples
5. Save the documentation

Match the project's existing documentation style.`,
    tools: ["read_file", "write_file", "search_files", "glob_files"],
    parameters: [
      { name: "path", description: "File or module to document", required: true },
    ],
    maxSteps: 8,
  },
]

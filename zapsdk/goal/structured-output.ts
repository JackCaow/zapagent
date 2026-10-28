import { z } from "zod";
import { OutcomeProtocolError } from "../runtime/outcome.js";

export class GoalStructuredOutputError extends OutcomeProtocolError {
  constructor() { super("GOAL_STRUCTURED_OUTPUT_INVALID", "GOAL_STRUCTURED_OUTPUT_INVALID: result is missing, ambiguous or fails its schema"); }
}

function parseUniqueKeys(text: string): unknown {
  const stack: Set<string>[] = [];
  let start = -1, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (start >= 0) {
      if (escaped) { escaped = false; continue; }
      if (char === "\\") { escaped = true; continue; }
      if (char === '\"') {
        let next = i + 1; while (/\s/.test(text[next] ?? "") && next < text.length) next++;
        if (text[next] === ":") {
          const key = JSON.parse(text.slice(start, i + 1)) as string, keys = stack.at(-1);
          if (!keys || keys.has(key)) throw new GoalStructuredOutputError();
          keys.add(key);
        }
        start = -1;
      }
    } else if (char === '\"') start = i;
    else if (char === "{") stack.push(new Set());
    else if (char === "}") stack.pop();
  }
  return JSON.parse(text);
}

/** Extract a single balanced object, ignoring braces inside JSON strings.
 * Surrounding prose/fences are tolerated; multiple objects never select a winner. */
export function parseGoalObject<T>(text: string, schema: z.ZodType<T>): T {
  if (text.length > 1024 * 1024) throw new GoalStructuredOutputError();
  const objects: string[] = [];
  let start = -1, depth = 0, quoted = false, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (start < 0) { if (char === "{") { start = i; depth = 1; } continue; }
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) { objects.push(text.slice(start, i + 1)); start = -1; }
  }
  if (start >= 0 || objects.length !== 1) throw new GoalStructuredOutputError();
  // A whole JSON value (e.g. an array containing an object) must not be
  // reinterpreted as prose around an otherwise valid inner object.
  const trimmed = text.trim();
  if (trimmed.startsWith("[")) throw new GoalStructuredOutputError();
  try { return schema.parse(parseUniqueKeys(objects[0]!)); }
  catch { throw new GoalStructuredOutputError(); }
}

export const goalPlanSchema = z.strictObject({ tasks: z.array(z.strictObject({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/), description: z.string().trim().min(1),
  acceptance: z.string().trim().min(1), dependencies: z.array(z.string()).optional(),
})).min(1).max(64) }).superRefine((plan, ctx) => {
  const tasks = new Map(plan.tasks.map(task => [task.id, task]));
  const done = new Set<string>(), visiting = new Set<string>();
  const visit = (id: string): boolean => {
    if (done.has(id)) return true;
    const task = tasks.get(id);
    if (!task || visiting.has(id)) return false;
    visiting.add(id);
    for (const dep of task.dependencies ?? []) if (!visit(dep)) return false;
    visiting.delete(id); done.add(id); return true;
  };
  if (tasks.size !== plan.tasks.length || plan.tasks.some(task => !visit(task.id))) ctx.addIssue({ code: "custom", message: "Invalid task DAG" });
});
export const goalVerdictSchema = z.strictObject({ status: z.enum(["passed", "failed", "unverified"]), detail: z.string().trim().min(1).max(8000) });

/** Only schema failures are retried. The caller supplies a fresh sealed,
 * metered read-only phase each time; execution/permission errors propagate. */
export async function readGoalStructuredResult<T>(run: (correction: string) => Promise<string>, schema: z.ZodType<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const text = await run(attempt === 0 ? "" : "\n\nYour previous result failed the required JSON schema. Return exactly the requested JSON object, without commentary or examples. Do not perform development work.");
    try { return parseGoalObject(text, schema); }
    catch (error) { if (!(error instanceof GoalStructuredOutputError) || attempt >= 2) throw error; }
  }
}

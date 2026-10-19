import { randomBytes } from "node:crypto";
import { z } from "zod";
import { Cron } from "croner";
import type { Tool } from "../tools/types.js";

export interface CronJob {
  id: string;
  cron: string;
  prompt: string;
  recurring: boolean;
  next: number;
  createdAt: number;
  lastFiredAt?: number;
  humanSchedule: string;
  /** Identifier of the agent that created this job. Undefined means
   *  "team lead" (main agent) — it can see/delete all jobs. A non-undefined
   *  value scopes visibility and delete rights to the same agent id. */
  ownerAgentId?: string;
}

export interface CronFireEvent {
  jobId: string;
  prompt: string;
  firedAt: number;
  recurring: boolean;
  ownerAgentId?: string;
}

export interface CronToolsOptions {
  /** Called when a job's schedule elapses. Integrators wire this to their
   *  event bus / UI / prompt queue. Throws from the callback are swallowed
   *  so a bad listener can't kill the scheduler. */
  onFire?: (event: CronFireEvent) => void;
  /** Max concurrent jobs. Matches Claude Code's 50. */
  maxJobs?: number;
  /** Tick cadence (ms). Default 60_000. Lower values are for tests. */
  tickMs?: number;
  /** Clock function. Defaults to Date.now. Overridable for tests. */
  now?: () => number;
  /** Owner id stamped on jobs created through this handle. When set,
   *  `cron_delete` refuses to delete jobs owned by other agents and
   *  `cron_list` filters out jobs with a different owner. Leave undefined
   *  for the main agent (team-lead semantics: sees and deletes all). */
  agentId?: string;
}

export interface CronToolsHandle {
  cronCreate: Tool;
  cronDelete: Tool;
  cronList: Tool;
  /** Fire any jobs whose `next` is <= now. Exposed for tests — in normal
   *  operation the internal setInterval drives ticks. */
  tick: () => void;
  /** Clear the scheduler and drop all jobs. Idempotent. */
  stop: () => void;
  /** Read-only view of current jobs (for tests/UI). */
  snapshot: () => CronJob[];
}

export function cronTools(options: CronToolsOptions = {}): CronToolsHandle {
  const jobs = new Map<string, CronJob>();
  const maxJobs = options.maxJobs ?? 50;
  const tickMs = options.tickMs ?? 60_000;
  const now = options.now ?? (() => Date.now());
  let intervalHandle: ReturnType<typeof setInterval> | null = null;

  function ensureScheduler(): void {
    if (intervalHandle !== null) return;
    intervalHandle = setInterval(tick, tickMs);
    // Don't hold the process open just for the scheduler.
    (intervalHandle as unknown as { unref?: () => void }).unref?.();
  }

  function maybeStopScheduler(): void {
    if (intervalHandle !== null && jobs.size === 0) {
      clearInterval(intervalHandle);
      intervalHandle = null;
    }
  }

  // If the process was suspended (sleep, debugger pause) between ticks,
  // overdue jobs collapse into a single fire and their `next` is advanced
  // from wake-up time. We do not replay every missed fire.
  function tick(): void {
    const t = now();
    for (const job of Array.from(jobs.values())) {
      if (job.next > t) continue;
      try {
        options.onFire?.({
          jobId: job.id,
          prompt: job.prompt,
          firedAt: t,
          recurring: job.recurring,
          ownerAgentId: job.ownerAgentId,
        });
      } catch {
        // swallow — bad listeners must not break the scheduler loop
      }
      job.lastFiredAt = t;
      if (!job.recurring) {
        jobs.delete(job.id);
        continue;
      }
      const nextDate = new Cron(job.cron).nextRun(new Date(t));
      if (!nextDate) {
        jobs.delete(job.id);
      } else {
        job.next = nextDate.getTime();
      }
    }
    maybeStopScheduler();
  }

  // Team-lead (no agentId) sees all jobs. Teammate (agentId set) sees only
  // its own. Mirrors Claude Code's role-filtered visibility.
  function visibleJobs(): CronJob[] {
    if (options.agentId === undefined) return Array.from(jobs.values());
    return Array.from(jobs.values()).filter((j) => j.ownerAgentId === options.agentId);
  }

  function newId(): string {
    for (let i = 0; i < 8; i++) {
      const id = randomBytes(4).toString("hex");
      if (!jobs.has(id)) return id;
    }
    throw new Error("Failed to generate unique cron id after 8 attempts");
  }

  const cronCreate: Tool = {
    definition: {
      name: "cron_create",
      description:
        "Schedule a prompt to fire on a standard 5-field cron expression (min hour dom mon dow, local time). " +
        "Returns a job id. Session-only: jobs die when zap exits. " +
        "Use `recurring=false` for a one-shot task.",
      parameters: z.object({
        cron: z
          .string()
          .min(1)
          .describe("5-field cron expression, e.g. '30 14 * * *' = 2:30pm daily"),
        prompt: z.string().min(1).describe("Prompt text to emit when the job fires"),
        recurring: z
          .boolean()
          .optional()
          .describe("If false, auto-deletes after first fire. Default true."),
      }),
      permission: "confirm",
      resolveEffects: () => ({
        filesystem: [], network: [], process: [],
        external: [{ kind: "external", system: "runtime:cron", operation: "mutate", resource: "jobs" }],
        workspace: { mode: "none" },
        confidence: "declared",
      }),
    },
    handler: async (args) => {
      const cronExpr = args.cron as string;
      const prompt = args.prompt as string;
      const recurring = (args.recurring as boolean | undefined) ?? true;

      if (jobs.size >= maxJobs) {
        return {
          success: false,
          output: "",
          error: `Cron job limit reached (${maxJobs}). Delete an existing job first via cron_delete.`,
        };
      }

      let nextDate: Date | null;
      try {
        nextDate = new Cron(cronExpr).nextRun(new Date(now()));
      } catch (err) {
        return {
          success: false,
          output: "",
          error: `Invalid cron expression "${cronExpr}": ${(err as Error).message}`,
        };
      }
      if (!nextDate) {
        return {
          success: false,
          output: "",
          error: `Cron expression "${cronExpr}" has no future fire time`,
        };
      }

      const id = newId();
      const job: CronJob = {
        id,
        cron: cronExpr,
        prompt,
        recurring,
        next: nextDate.getTime(),
        createdAt: now(),
        humanSchedule: humanize(cronExpr),
        ownerAgentId: options.agentId,
      };
      jobs.set(id, job);
      ensureScheduler();

      return {
        success: true,
        output: JSON.stringify(
          {
            id,
            cron: cronExpr,
            humanSchedule: job.humanSchedule,
            next: new Date(job.next).toISOString(),
            recurring,
          },
          null,
          2,
        ),
      };
    },
  };

  const cronDelete: Tool = {
    definition: {
      name: "cron_delete",
      description: "Cancel a scheduled cron job by id. Errors if the id is unknown.",
      parameters: z.object({
        id: z.string().min(1).describe("Job id returned by cron_create"),
      }),
      permission: "confirm",
      resolveEffects: (args) => ({
        filesystem: [], network: [], process: [],
        external: [{ kind: "external", system: "runtime:cron", operation: "destructive", resource: String(args.id) }],
        workspace: { mode: "none" },
        confidence: "declared",
      }),
    },
    handler: async (args) => {
      const id = args.id as string;
      const job = jobs.get(id);
      if (!job) {
        return {
          success: false,
          output: "",
          error: `No cron job with id "${id}"`,
        };
      }
      // Teammate isolation: if this handle is scoped to an agentId, refuse
      // to delete jobs owned by others. Team-lead (agentId undefined) can
      // delete anything.
      if (options.agentId !== undefined && job.ownerAgentId !== options.agentId) {
        return {
          success: false,
          output: "",
          error: `Cron job "${id}" is owned by another agent`,
        };
      }
      jobs.delete(id);
      maybeStopScheduler();
      return { success: true, output: JSON.stringify({ id, deleted: true }) };
    },
  };

  const cronList: Tool = {
    definition: {
      name: "cron_list",
      description:
        "List active cron jobs in the current session with their schedule, prompt, and next fire time.",
      parameters: z.object({}),
      permission: "auto",
      readOnly: true,
    },
    handler: async () => {
      const list = visibleJobs().map((j) => ({
        id: j.id,
        cron: j.cron,
        humanSchedule: j.humanSchedule,
        prompt: j.prompt,
        recurring: j.recurring,
        next: new Date(j.next).toISOString(),
        lastFiredAt: j.lastFiredAt ? new Date(j.lastFiredAt).toISOString() : undefined,
      }));
      return {
        success: true,
        output: list.length === 0 ? "(no cron jobs)" : JSON.stringify({ jobs: list }, null, 2),
      };
    },
  };

  return {
    cronCreate,
    cronDelete,
    cronList,
    tick,
    stop: () => {
      jobs.clear();
      maybeStopScheduler();
    },
    snapshot: () => Array.from(jobs.values()).map((j) => ({ ...j })),
  };
}

// Covers the most common patterns. Falls back to echoing the expression
// verbatim when no pattern matches — that's fine, it's advisory only.
function humanize(expr: string): string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return `cron: ${expr}`;
  const [min, hour, dom, mon, dow] = parts;
  if (expr === "* * * * *") return "Every minute";
  const everyNMin = min.match(/^\*\/(\d+)$/);
  if (everyNMin && hour === "*" && dom === "*" && mon === "*" && dow === "*") {
    return `Every ${everyNMin[1]} minutes`;
  }
  const everyNHour = hour.match(/^\*\/(\d+)$/);
  if (min === "0" && everyNHour && dom === "*" && mon === "*" && dow === "*") {
    return `Every ${everyNHour[1]} hours`;
  }
  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && dom === "*" && mon === "*" && dow === "*") {
    return `Daily at ${hour.padStart(2, "0")}:${min.padStart(2, "0")}`;
  }
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  if (
    /^\d+$/.test(min) &&
    /^\d+$/.test(hour) &&
    dom === "*" &&
    mon === "*" &&
    /^\d$/.test(dow)
  ) {
    return `Weekly on ${days[Number(dow)] ?? dow} at ${hour.padStart(2, "0")}:${min.padStart(2, "0")}`;
  }
  return `cron: ${expr}`;
}

import { z } from "zod";
import { currentRuntimeObservation, observeRuntime } from "../runtime/observation.js";
import type { Tool } from "../tools/types.js";

export interface AskUserQuestion {
  question: string;
  /** Short label shown above the question (at most ~12 chars). */
  header?: string;
  options: { label: string; description?: string }[];
  multiSelect?: boolean;
}

export interface AskUserAnswer {
  question: string;
  /** Chosen option labels, or the user's own text when `custom` is true. */
  answers: string[];
  custom?: boolean;
}

/** The app layer owns the UI. Resolve with the answers, or null when the user
 *  dismissed the question without answering. */
export interface AskUserCallbacks {
  ask(questions: AskUserQuestion[]): Promise<AskUserAnswer[] | null>;
}

export interface AskUserToolOptions {
  callbacks: AskUserCallbacks;
}

const optionSchema = z.object({
  label: z.string().min(1).max(80).describe("What the user picks (1-5 words)"),
  description: z.string().max(300).optional().describe("What choosing it means or implies"),
});

const questionSchema = z.object({
  question: z.string().min(1).describe("The complete question, ending with a question mark"),
  header: z.string().max(16).optional().describe("Very short tag shown above the question"),
  options: z.array(optionSchema).min(2).max(4)
    .describe("2-4 distinct choices. Put your recommendation first and say so in its label. The user can always type their own answer, so do not add an 'Other' option"),
  multiSelect: z.boolean().optional().describe("Allow more than one choice"),
});

/**
 * `ask_user_question` — pause and let the user pick between concrete options
 * when a decision is theirs to make and cannot be resolved from the request or
 * the code. Not for confirming a plan (use exit_plan_mode) or asking permission
 * for a tool call (the permission prompt does that).
 */
export function askUserQuestionTool(options: AskUserToolOptions): Tool {
  return {
    definition: {
      name: "ask_user_question",
      description:
        "Ask the user 1-4 multiple-choice questions and wait for the answers. Use only when a decision is the user's to make and you cannot settle it from the request, the code or sensible defaults; otherwise pick a default and say so.",
      parameters: z.object({ questions: z.array(questionSchema).min(1).max(4) }),
      permission: "auto",
      resolveEffects: () => ({
        filesystem: [], network: [], process: [],
        external: [{ kind: "external", system: "runtime:user-input", operation: "mutate" }],
        workspace: { mode: "none" },
        confidence: "declared",
      }),
      // The user may take as long as they like.
      timeoutMs: 24 * 60 * 60 * 1000,
    },
    handler: async (args, _signal, context) => {
      const questions = args.questions as AskUserQuestion[];
      const observation = currentRuntimeObservation();
      const publish = (phase: "requested" | "settled") => {
        if (observation) observeRuntime({ kind: "input_wait", scope: observation.scope,
          toolCallId: context?.toolCallId, step: context?.step, phase });
      };
      publish("requested");
      let answers: AskUserAnswer[] | null;
      try { answers = await options.callbacks.ask(questions); }
      finally { publish("settled"); }
      if (!answers) {
        return {
          success: false,
          output: "",
          error: "The user dismissed the question without answering. Do not ask again; proceed with a reasonable default and state it, or stop and say what you need.",
        };
      }
      const lines = answers.map((a) =>
        `- ${a.question}\n  → ${a.answers.length ? a.answers.join("; ") : "(no choice)"}${a.custom ? " (typed by the user)" : ""}`);
      return { success: true, output: `The user answered:\n${lines.join("\n")}` };
    },
  };
}

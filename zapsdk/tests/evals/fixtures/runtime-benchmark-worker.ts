import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

let input = "";
for await (const chunk of process.stdin) input += chunk.toString();
const request = JSON.parse(input) as {
  version: number;
  cwd: string;
  task: { prompt: string };
  cachePhase?: "cold" | "warm" | "post_compact";
  session?: {
    profile: "short" | "long";
    minimumMessages?: number;
    resume?: boolean;
    compactBeforeRun?: boolean;
  };
};
if (request.version !== 1) throw new Error("unsupported test executor protocol");

const emit = (record: unknown) => process.stdout.write(`${JSON.stringify(record)}\n`);
const prompt = request.task.prompt;
const sessionEvidence = request.session ? {
  sessionMessages: request.session.minimumMessages ?? (request.session.profile === "long" ? 100 : 5),
  sessionResumed: request.session.resume === true,
  compactOccurred: request.session.compactBeforeRun === true,
} : {};

if (prompt.includes("__hang__")) {
  process.on("SIGTERM", () => {});
  setTimeout(() => {
    void writeFile(join(request.cwd, "late-side-effect.txt"), "escaped\n");
  }, 1_500);
  setInterval(() => {}, 1_000);
} else if (prompt.includes("__forbidden__")) {
  await mkdir(join(request.cwd, "secrets"));
  await writeFile(join(request.cwd, "secrets", "leak.txt"), "bad\n");
  emit({ type: "error", error: "agent crashed" });
} else if (prompt.includes("__noop__")) {
  emit({ type: "result", result: { inputTokens: 20, ...sessionEvidence } });
} else if (prompt.includes("__baseline__")) {
  await writeFile(join(request.cwd, "value.txt"), "new\n");
  emit({ type: "result", result: { inputTokens: 5, ...sessionEvidence } });
} else if (prompt.includes("replace value")) {
  await writeFile(join(request.cwd, "value.txt"), "new\n");
  emit({ type: "result", result: { inputTokens: 10, outputTokens: 5, ...sessionEvidence } });
} else {
  const valuePath = join(request.cwd, "src", "value.txt");
  if ((await readFile(valuePath, "utf8")).trim() !== "broken") {
    throw new Error("unexpected fixture state");
  }
  await writeFile(valuePath, "fixed\n");
  emit({
    type: "runtime_event",
    event: {
      schemaVersion: 2,
      eventId: "event-1",
      sequence: 1,
      timestamp: 1_000,
      threadId: "thread-1",
      turnId: "turn-1",
      runId: "run-1",
      correlationId: "turn-1",
      payload: {
        type: "turn_started",
        thread: {
          threadId: "thread-1",
          status: "running",
          createdAt: 1_000,
          updatedAt: 1_000,
          activeTurnId: "turn-1",
        },
        turn: {
          turnId: "turn-1",
          threadId: "thread-1",
          rootRunId: "run-1",
          status: "running",
          createdAt: 1_000,
          updatedAt: 1_000,
        },
        run: {
          runId: "run-1",
          threadId: "thread-1",
          turnId: "turn-1",
          agentType: "root",
          task: "SECRET_RUNTIME_TASK",
          status: "running",
          sequence: 1,
          createdAt: 1_000,
          updatedAt: 1_000,
        },
        item: {
          itemId: "item-1",
          threadId: "thread-1",
          turnId: "turn-1",
          runId: "run-1",
          type: "message",
          role: "user",
          text: "SECRET_RUNTIME_MESSAGE",
          createdAt: 1_000,
        },
      },
    },
  });
  emit({
    type: "result",
    result: {
      steps: 3,
      toolCalls: 2,
      inputTokens: 10,
      outputTokens: 4,
      cacheReadTokens: 90,
      cacheWriteTokens: 0,
      ...sessionEvidence,
    },
  });
}

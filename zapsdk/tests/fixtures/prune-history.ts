import type { Message } from "../../core/types.js";

export function pruneHistory(): Message[] {
  return [{ role: "system", content: "Stable system" }, { role: "user", content: "Historical task" },
    ...Array.from({ length: 10 }, (_, i): Message[] => [
      { role: "assistant", content: "", toolCalls: [{ id: `read-${i}`, name: "read_file", arguments: { path: `src/${i}.ts`, offset: i } }] },
      { role: "tool_result", toolCallId: `read-${i}`, toolResultSuccess: i !== 0,
        content: `OBSERVATION_${i} ` + "a ".repeat(1200) + ` ERROR_TAIL_${i}`, ...(i === 0 ? { executionObservation: { command: { exitCode: 2 } } } : {}) },
    ]).flat(), { role: "user", content: "CURRENT_TASK: must preserve P1 and do not publish" }];
}

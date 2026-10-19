import { describe, it, expect } from "bun:test";
import { sessionLogsToMessages } from "../src/session.js";

// Reproduces the DeepSeek V4 400 bug: restoring a session that had thinking +
// tool calls must produce ONE assistant message with `raw.reasoning_content`
// attached, not split into thinking-less fragments.

describe("sessionLogsToMessages reasoning_content reconstruction", () => {
  it("merges thinking + text + tool_calls from a single stream turn into one message with raw", () => {
    const logs = [
      { type: "user", text: "do the thing" },
      { type: "thinking", text: "Let me plan the approach carefully." },
      { type: "agent", text: "I'll read the file first." },
      { type: "tool", text: "", tool: { id: "call_A", name: "read_file", arguments: { path: "/tmp/x" } } },
      { type: "result", text: "", tool: { id: "call_A", name: "read_file", arguments: { path: "/tmp/x" }, output: "content" } },
    ] as any[];

    const msgs = sessionLogsToMessages(logs);

    // Expect: [user, assistant(text, toolCalls=[A], raw={reasoning_content:...}), tool_result]
    expect(msgs.length).toBe(3);
    expect(msgs[0].role).toBe("user");
    expect(msgs[1].role).toBe("assistant");
    expect(msgs[1].content).toBe("I'll read the file first.");
    expect(msgs[1].toolCalls?.length).toBe(1);
    expect(msgs[1].toolCalls?.[0].id).toBe("call_A");
    expect(msgs[1].raw).toEqual({ reasoning_content: "Let me plan the approach carefully." });
    expect(msgs[2].role).toBe("tool_result");
  });

  it("groups multi-tool stream turn into one assistant message (thinking is shared)", () => {
    const logs = [
      { type: "user", text: "scan" },
      { type: "thinking", text: "I'll list then glob." },
      { type: "agent", text: "Listing now." },
      { type: "tool", text: "", tool: { id: "call_A", name: "list_directory", arguments: { path: "/" } } },
      { type: "tool", text: "", tool: { id: "call_B", name: "glob_files", arguments: { pattern: "**/*" } } },
      { type: "result", text: "", tool: { id: "call_A", name: "list_directory", arguments: { path: "/" }, output: "ok" } },
      { type: "result", text: "", tool: { id: "call_B", name: "glob_files", arguments: { pattern: "**/*" }, output: "ok" } },
    ] as any[];

    const msgs = sessionLogsToMessages(logs);

    // [user, assistant(text, toolCalls=[A,B], raw), tool_result A, tool_result B]
    expect(msgs.length).toBe(4);
    expect(msgs[1].role).toBe("assistant");
    expect(msgs[1].toolCalls?.length).toBe(2);
    expect(msgs[1].toolCalls?.map(tc => tc.id)).toEqual(["call_A", "call_B"]);
    expect(msgs[1].raw).toEqual({ reasoning_content: "I'll list then glob." });
  });

  it("text-only turn attaches reasoning_content via raw (DeepSeek V4 tolerates on no-tool turns, strictly requires after any tool turn)", () => {
    const logs = [
      { type: "user", text: "hi" },
      { type: "thinking", text: "Simple greeting." },
      { type: "agent", text: "Hello!" },
    ] as any[];

    const msgs = sessionLogsToMessages(logs);
    expect(msgs.length).toBe(2);
    expect(msgs[1].role).toBe("assistant");
    expect(msgs[1].content).toBe("Hello!");
    expect(msgs[1].raw).toEqual({ reasoning_content: "Simple greeting." });
  });

  it("groups multi-result stream turn (replaceLog collapses tool→result, no `tool` logs in parsed output)", () => {
    // Reproduces the actual zapcode JSONL shape: writer uses replaceLog so the
    // "tool" progress log gets superseded by the "result" log, and parseSessionJsonl
    // drops the replaced line. Restore sees ONLY result logs for a turn that had N tools.
    const logs = [
      { type: "user", text: "explore" },
      { type: "thinking", text: "I'll read four files." },
      { type: "agent", text: "Reading files now." },
      { type: "result", text: "", tool: { id: "call_A", name: "read_file", arguments: { path: "/a" }, output: "A" } },
      { type: "result", text: "", tool: { id: "call_B", name: "read_file", arguments: { path: "/b" }, output: "B" } },
      { type: "result", text: "", tool: { id: "call_C", name: "read_file", arguments: { path: "/c" }, output: "C" } },
      { type: "result", text: "", tool: { id: "call_D", name: "read_file", arguments: { path: "/d" }, output: "D" } },
      { type: "thinking", text: "Next turn's thinking." },
      { type: "agent", text: "Summary text." },
    ] as any[];

    const msgs = sessionLogsToMessages(logs);

    // [user, assistant(text, toolCalls=[A,B,C,D], raw), tr_A, tr_B, tr_C, tr_D, assistant(text-only, no raw)]
    expect(msgs.length).toBe(7);
    expect(msgs[1].role).toBe("assistant");
    expect(msgs[1].toolCalls?.length).toBe(4);
    expect(msgs[1].toolCalls?.map(tc => tc.id)).toEqual(["call_A", "call_B", "call_C", "call_D"]);
    expect(msgs[1].raw).toEqual({ reasoning_content: "I'll read four files." });
    expect(msgs[1].content).toBe("Reading files now.");
    expect(msgs[2].role).toBe("tool_result"); expect(msgs[2].toolCallId).toBe("call_A");
    expect(msgs[3].toolCallId).toBe("call_B");
    expect(msgs[4].toolCallId).toBe("call_C");
    expect(msgs[5].toolCallId).toBe("call_D");
    expect(msgs[6].role).toBe("assistant");
    expect(msgs[6].content).toBe("Summary text.");
    expect(msgs[6].raw).toEqual({ reasoning_content: "Next turn's thinking." });
  });

  it("handles successive stream turns (text → tool → result → text → tool → result)", () => {
    const logs = [
      { type: "user", text: "go" },
      { type: "thinking", text: "think1" },
      { type: "agent", text: "first" },
      { type: "tool", text: "", tool: { id: "call_A", name: "read_file", arguments: { path: "/a" } } },
      { type: "result", text: "", tool: { id: "call_A", name: "read_file", arguments: { path: "/a" }, output: "a" } },
      { type: "thinking", text: "think2" },
      { type: "agent", text: "second" },
      { type: "tool", text: "", tool: { id: "call_B", name: "bash", arguments: { command: "ls" } } },
      { type: "result", text: "", tool: { id: "call_B", name: "bash", arguments: { command: "ls" }, output: "b" } },
    ] as any[];

    const msgs = sessionLogsToMessages(logs);

    // [user, asst(first, tools=[A], raw=think1), tool_result A, asst(second, tools=[B], raw=think2), tool_result B]
    expect(msgs.length).toBe(5);
    expect(msgs[1].raw).toEqual({ reasoning_content: "think1" });
    expect(msgs[1].content).toBe("first");
    expect(msgs[3].raw).toEqual({ reasoning_content: "think2" });
    expect(msgs[3].content).toBe("second");
  });
});

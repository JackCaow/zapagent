import { describe, expect, it } from "bun:test";
import { ToolProgressTracker, type ToolProgressCall } from "../../harness/tool-progress.js";

const edit: ToolProgressCall = { name: "edit", arguments: { path: "source" }, readOnly: false,
  result: { success: true, output: "written" } };
const failedCheck: ToolProgressCall = { name: "bash", arguments: { command: "test" }, readOnly: false,
  result: { success: false, output: "assertion failed", runtime: { verification: {
    passed: false, steps: [{ command: "test", exitCode: 1 }],
  } } } };

describe("ToolProgressTracker", () => {
  it("does not equate a successful mutation with new evidence", () => {
    const tracker = new ToolProgressTracker();
    for (let i = 0; i < 3; i++) tracker.observeRound([edit]);
    expect(tracker.consecutiveNoProgress).toBe(3);
    expect(tracker.workspaceChanged).toBe(true);
  });

  it("keeps repeated failures stalled despite interleaved successful edits", () => {
    const tracker = new ToolProgressTracker();
    expect(tracker.observeRound([failedCheck]).newEvidence).toBe(true);
    tracker.observeRound([edit]);
    tracker.observeRound([failedCheck]);
    expect(tracker.observeRound([edit, failedCheck]).consecutiveNoProgress).toBe(3);
  });

  it("recognizes new read evidence but not repeated identical reads", () => {
    const tracker = new ToolProgressTracker();
    const read = { ...edit, readOnly: true, name: "read", result: { success: true, output: "first" } };
    expect(tracker.observeRound([read]).newEvidence).toBe(true);
    expect(tracker.observeRound([read]).consecutiveNoProgress).toBe(1);
    expect(tracker.observeRound([{ ...read, result: { success: true, output: "new diagnostic" } }]).newEvidence).toBe(true);
    expect(tracker.consecutiveNoProgress).toBe(0);
    expect(tracker.workspaceChanged).toBe(false);
  });

  it("does not infer verification from a successful shell or reassuring text", () => {
    const tracker = new ToolProgressTracker();
    expect(tracker.observeRound([{ ...edit, name: "bash", result: { success: true, output: "PASS" } }]))
      .toMatchObject({ executionSucceeded: true, newEvidence: false, verificationPassed: false });
  });

  it("observes changed shell diagnostics without declaring verification or read-only execution", () => {
    const tracker = new ToolProgressTracker();
    for (const output of ["weights=124439808", "layernorm offsets=3077,3079", "Hello token=15496"]) {
      expect(tracker.observeRound([{ name: "bash", arguments: { command: "compile && diagnose" },
        readOnly: false, mayChangeWorkspace: true, result: { success: true, output,
          runtime: { command: { commandRef: "diagnostic", exitCode: 0, timedOut: false, aborted: false } } },
      }])).toMatchObject({ newObservation: true, newEvidence: false, verificationPassed: false,
        workspaceChanged: true, consecutiveNoProgress: 0 });
    }
  });

  it("does not treat changed command spelling or new process IDs as new diagnostics", () => {
    const tracker = new ToolProgressTracker();
    for (let i = 0; i < 4; i++) {
      const result = tracker.observeRound([{ name: "bash", arguments: { command: `test --attempt ${i}` },
        readOnly: false, result: { success: true, output: "same diagnostic",
          runtime: { command: { commandRef: `process-${i}`, exitCode: 0, timedOut: false, aborted: false } } },
      }]);
      expect(result.consecutiveNoProgress).toBe(i);
      expect(result.newObservation).toBe(i === 0);
    }
  });

  it("does not reset repeated failures solely because command arguments changed", () => {
    const tracker = new ToolProgressTracker();
    for (let i = 0; i < 4; i++) {
      expect(tracker.observeRound([{ ...failedCheck, arguments: { command: `test --attempt ${i}` } }])
        .consecutiveNoProgress).toBe(i);
    }
  });

  it("does not count empty command output as a new observation", () => {
    const tracker = new ToolProgressTracker();
    expect(tracker.observeRound([{ name: "bash", arguments: { command: "true" }, readOnly: false,
      result: { success: true, output: "", runtime: {
        command: { commandRef: "empty", exitCode: 0, timedOut: false, aborted: false },
      } },
    }])).toMatchObject({ newObservation: false, verificationPassed: false, consecutiveNoProgress: 1 });
  });

  it("records explicit checks without claiming they cover every mutation", () => {
    const tracker = new ToolProgressTracker();
    tracker.observeRound([edit]);
    expect(tracker.observeRound([{ ...failedCheck, result: { success: true, output: "", runtime: {
      verification: { passed: true, steps: [{ command: "test", exitCode: 0 }] },
    } } }])).toMatchObject({ verificationPassed: true, newEvidence: true, workspaceChanged: true });
  });

  it("keeps directory-only write evidence unverified", () => {
    const tracker = new ToolProgressTracker();
    tracker.observeRound([{ ...edit, mayChangeWorkspace: true, result: { success: true, output: "", runtime: {
      writeEvidence: { paths: [{ path: "/workspace", before: { exists: true, kind: "directory" }, after: { exists: true, kind: "directory" } }] },
    } } }]);
    expect(tracker.workspaceChanged).toBe(true);
  });

  it("does not confuse runtime todo state with workspace changes", () => {
    const tracker = new ToolProgressTracker();
    tracker.observeRound([{ ...edit, name: "todo_write", mayChangeWorkspace: false }]);
    expect(tracker.workspaceChanged).toBe(false);
  });

  it("does not mark an unchanged write fingerprint as a mutation", () => {
    const tracker = new ToolProgressTracker();
    tracker.observeRound([{ ...edit, result: { success: true, output: "unchanged", runtime: {
      writeEvidence: { paths: [{ path: "source", before: { exists: true, sha256: "a" }, after: { exists: true, sha256: "a" } }] },
    } } }]);
    expect(tracker.workspaceChanged).toBe(false);
  });
});

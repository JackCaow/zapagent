import { describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { runRipgrepRecords } from "../../builtin-tools/ripgrep.js";
import { createLocalProcessBroker } from "../../execution/process.js";

function scriptBroker(script: string) {
  const broker = createLocalProcessBroker();
  const spawn = broker.spawnCommand.bind(broker);
  broker.spawnCommand = (_executable, _args, options) => spawn(process.execPath, ["-e", script], options);
  return broker;
}

describe("ripgrep record integrity and exit status", () => {
  for (const exitCode of [0, 2]) it(`does not return an unterminated path on exit ${exitCode}`, async () => {
    const records: string[] = [];
    const run = await runRipgrepRecords("rg", [], {
      process: scriptBroker(`process.stdout.write("real.ts\\0partial.ts");process.exit(${exitCode});`),
      cwd: process.cwd(), separator: "\0",
      onRecord(record) { records.push(record); return undefined; },
    });
    expect(records).toEqual(["real.ts"]);
    expect(run.error).toContain(exitCode === 0 ? "unterminated" : "code 2");
  });

  it("retains a complete final text line without a newline", async () => {
    const records: string[] = [];
    const run = await runRipgrepRecords("rg", [], {
      process: scriptBroker('process.stdout.write("a.ts:1:match");'),
      cwd: process.cwd(), separator: "\n",
      onRecord(record) { records.push(record); return undefined; },
    });
    expect(records).toEqual(["a.ts:1:match"]);
    expect(run.error).toBeUndefined();
  });

  it("keeps a real failure when buffered output also exceeds the result limit", async () => {
    const records: string[] = [];
    const broker = createLocalProcessBroker();
    // Model the process having already exited while its pipes are still being
    // drained. Keep the exit deterministic instead of racing SIGTERM in a test.
    broker.spawnCommand = () => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(), stderr: new PassThrough(),
        exitCode: 2, signalCode: null, kill: () => false,
      });
      queueMicrotask(() => {
        child.stdout.write("first\0second\0");
        child.stderr.write("Permission denied");
        child.stdout.end(); child.stderr.end();
        child.emit("close", 2, null);
      });
      return child as unknown as ChildProcess;
    };
    const run = await runRipgrepRecords("rg", [], {
      process: broker, cwd: process.cwd(), separator: "\0",
      onRecord(record) { if (records.length) return "result_limit"; records.push(record); return undefined; },
    });
    expect(records).toEqual(["first"]);
    expect(run.stopped).toBe("result_limit");
    expect(run.error).toContain("code 2: Permission denied");
  });

  it("keeps partial success when the result limit terminates a running process", async () => {
    const records: string[] = [];
    const run = await runRipgrepRecords("rg", [], {
      process: scriptBroker('process.stdout.write("first\\0second\\0");setTimeout(()=>{},10000);'),
      cwd: process.cwd(), separator: "\0", timeoutMs: 2000,
      onRecord(record) { if (records.length) return "result_limit"; records.push(record); return undefined; },
    });
    expect(records).toEqual(["first"]);
    expect(run.stopped).toBe("result_limit");
    expect(run.error).toBeUndefined();
  });
});

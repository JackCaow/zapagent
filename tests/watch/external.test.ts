import { expect, it } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { delegateAgentTool } from "../../zapsdk/builtin-tools/delegate.js";
import { withRuntimeObservation } from "../../zapsdk/runtime/observation.js";
import { WatchHub } from "../../src/watch/hub.js";

(process.platform === "win32" ? it.skip : it)("observes an opaque external CLI process from host lifecycle rather than trusting parser completion", async () => {
  const work = mkdtempSync(join(tmpdir(), "zap-watch-external-")), script = join(work, "fixture.sh"), hub = new WatchHub();
  try {
    writeFileSync(script, "#!/bin/sh\nprintf '%s\\n' 'UNPARSED_PRIVATE_CANARY'\nexit 0\n"); chmodSync(script, 0o755);
    hub.observe({ kind: "tool_catalog", names: ["delegate_agent"] });
    const tool = delegateAgentTool({ providers: [{ name: "codex", bin: script }], defaultCwd: work })!;
    await withRuntimeObservation({ observer: hub, scope: { threadId: "t", turnId: "turn", runId: "root" }, isActive: () => true },
      () => tool.handler({ provider: "codex", task: "PRIVATE_TASK" }, undefined, { step: 1, toolCallId: "external-call" }));
    const snapshot = hub.snapshot(), external = snapshot.nodes.find(n => n.label === "external");
    expect(external?.status).toBe("exited"); expect(external?.coverage).toBe("opaque");
    expect(external?.unknownEvents).toBe(1); expect(snapshot.edges.some(e => e.kind === "spawns")).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain("UNPARSED_PRIVATE_CANARY"); expect(JSON.stringify(snapshot)).not.toContain("PRIVATE_TASK");
  } finally { hub.close(); rmSync(work, { recursive: true, force: true }); }
}, 10000);

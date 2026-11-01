import { expect, it } from "bun:test"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

it("leaves no owned stdio child after startup cancellation or normal teardown", async () => {
  // Separate process: manager-resilience mocks the factories in the test runner.
  // This check must exercise the real SDK transport and only our local fixture.
  const data = await mkdtemp(join(tmpdir(), "zap-mcp-lifecycle-"))
  const managerPath = resolve(import.meta.dir, "../../mcp/manager.ts")
  const fixturePath = resolve(import.meta.dir, "../../../tests/acp/fixtures/mcp-server.ts")
  const script = `
    import { MCPManager } from ${JSON.stringify(managerPath)};
    import assert from 'node:assert/strict';
    const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
    const waitFor = async predicate => {
      const deadline = Date.now() + 5000;
      while (!predicate()) {
        if (Date.now() >= deadline) throw new Error('fixture did not reach expected state');
        await Bun.sleep(5);
      }
    };
    for (const phase of ['immediate', 'spawned', 'ready']) {
      const mgr = new MCPManager();
      const pending = mgr.reconcile([{ name: 'owned', transport: 'stdio',
        command: process.execPath, args: [${JSON.stringify(fixturePath)}], connectTimeoutMs: 2000 }]);
      const original = mgr.servers.get('owned');
      let transport;
      try {
        if (phase !== 'immediate') await waitFor(() => original.transport?.pid);
        if (phase === 'ready') await waitFor(() => original.status === 'ready');
        transport = original.transport;
        const pid = transport?.pid;
        await mgr.stopAll();
        await pending;
        await Bun.sleep(30);
        await mgr.stopAll();
        assert.deepEqual(mgr.snapshots(), []);
        assert.equal(original.status, 'disconnected');
        assert.equal(original.client, null);
        if (pid) assert.equal(alive(pid), false, 'owned fixture child survived stopAll');
      } finally {
        await mgr.stopAll();
        // Also clean up a detached old entry if this regression ever returns.
        await original.client?.close();
        await (transport ?? original.transport)?.close();
      }
    }
    console.log('MCP_LIFECYCLE_OK');
  `
  try {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, ["--eval", script], {
      env: { ...process.env, ZAPCODE_DATA_DIR: data }, timeout: 12_000,
    })
    expect(stderr).toBe("")
    expect(stdout.trim()).toBe("MCP_LIFECYCLE_OK")
  } finally {
    await rm(data, { recursive: true, force: true })
  }
}, 15_000)

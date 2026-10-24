#!/usr/bin/env node
const { spawn } = require("node:child_process");
const { constants } = require("node:os");
const { ensureBinary } = require("./install.cjs");
(async () => {
  const binary = await ensureBinary();
  const child = spawn(binary, process.argv.slice(2), { stdio: "inherit", env: { ...process.env, ZAPAGENT_NPM_LAUNCHER: __filename, ZAPAGENT_NPM_RUNTIME: process.execPath } });
  const forward = signal => { if (!child.killed) child.kill(signal); };
  const handlers = Object.fromEntries(["SIGINT", "SIGTERM", "SIGHUP"].map(signal => [signal, () => forward(signal)]));
  for (const [signal, handler] of Object.entries(handlers)) process.on(signal, handler);
  child.on("error", error => { console.error(`Could not start zapAgent: ${error.message}`); process.exitCode = 1; });
  child.on("exit", (code, signal) => {
    for (const [name, handler] of Object.entries(handlers)) process.removeListener(name, handler);
    process.exitCode = code ?? (signal ? 128 + (constants.signals[signal] || 1) : 1);
  });
})().catch(error => {
  console.error(`zapAgent: ${error.message}\nCheck network access to GitHub Releases, then run zap again.`);
  process.exitCode = 1;
});

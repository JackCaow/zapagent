// Copied into an isolated consumer; resolution must never use the checkout.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const consumer = createRequire(import.meta.url);
const app = createRequire(consumer.resolve("zapagent/cli"));
const inkEntry = app.resolve("ink");
const reactEntry = realpathSync(app.resolve("react"));
for (const name of ["ink-spinner", "ink-text-input"]) {
  const component = createRequire(app.resolve(name));
  assert.equal(realpathSync(component.resolve("ink")), realpathSync(inkEntry), `${name} must share Ink`);
  assert.equal(realpathSync(component.resolve("react")), reactEntry, `${name} must share React`);
}
const inkRequire = createRequire(inkEntry);
assert.equal(realpathSync(inkRequire.resolve("react")), reactEntry);
assert.equal(realpathSync(createRequire(inkRequire.resolve("react-reconciler")).resolve("react")), reactEntry);
for (const [file, expected] of Object.entries(JSON.parse(process.env.ZAPAGENT_INK_HASHES))) {
  const bytes = readFileSync(join(dirname(inkEntry), file));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), expected, `Ink patch changed: ${file}`);
}
const { ToolRegistry, buildMdPack } = await import("zapagent");
const { ConversationManager } = await import("zapagent/zapsdk/memory/conversation.js");
const testing = await import("zapagent/testing");
assert.equal(typeof ToolRegistry, "function");
assert.equal(typeof buildMdPack, "function");
assert.equal(typeof ConversationManager, "function");
assert.equal(typeof testing.createScriptedProvider, "function");
const React = (await import(app.resolve("react"))).default;
const { renderToString, Box, Text } = await import(inkEntry);
const Spinner = (await import(app.resolve("ink-spinner"))).default;
const TextInput = (await import(app.resolve("ink-text-input"))).default;
const output = renderToString(React.createElement(Box, { flexDirection: "column" },
  React.createElement(Text, null, "npm-package-smoke"),
  React.createElement(Spinner),
  React.createElement(TextInput, { value: "consumer-input", onChange() {} }),
), { columns: 80 });
assert.ok(output.includes("npm-package-smoke"));
assert.ok(output.includes("consumer-input"));
console.log(JSON.stringify({ sdk: "passed", tui: "passed", inkPeers: "shared", patchBytes: "matched" }));

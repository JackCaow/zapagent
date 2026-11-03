import { expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

const fixture = String.raw`
  import { mock } from "bun:test";
  import * as React from "react";
  import { createCustomProvider, getDefaultConfig } from "./src/config.ts";
  let slots = [], position = 0, input;
  mock.module("react", () => ({ ...React,
    useState: value => { const index = position++; if (!(index in slots)) slots[index] = typeof value === "function" ? value() : value;
      return [slots[index], next => { slots[index] = typeof next === "function" ? next(slots[index]) : next; }]; },
    useRef: value => { const index = position++; return slots[index] ??= { current: value }; },
    useEffect() {},
  }));
  mock.module("ink", () => ({ Box: "Box", Text: "Text", useInput: callback => { input = callback; }, usePaste() {} }));
  mock.module("./src/ui/dialog-frame.js", () => ({ DialogFrame: "DialogFrame" }));
  mock.module("./src/ui/term-width.js", () => ({ useTermWidth: () => 160 }));
  const { ModelDialog } = await import("./src/ui/dialog-model.tsx");
  const providers = ["Alpha", "Beta"].map(name => ({ ...createCustomProvider({ name, baseURL: "http://fixture.invalid/" + name, models: ["shared"], apiKey: "fixture-only", contextWindow: name === "Alpha" ? 128000 : 64000 }), id: name }));
  const config = { ...getDefaultConfig(), providers, active: { providerId: "Alpha", model: "shared" } };
  let committed, saved, cancelled = 0;
  let props = { config, onCommit: value => { committed = value; }, onSave: value => { saved = value; }, onCancel: () => { cancelled++; } };
  const render = () => { position = 0; return ModelDialog(props); };
  const text = node => typeof node === "string" ? node : Array.isArray(node) ? node.map(text).join(" ") : node?.props ? text(node.props.children) : "";
  const find = (node, name) => {
    if (Array.isArray(node)) { for (const child of node) { const found = find(child, name); if (found) return found; } }
    if (node?.type?.name === name) return node;
    if (node?.props) return find(node.props.children, name);
  };
  render(); input("", { downArrow: true }); render(); input("", { return: true });
  const selected = committed.active;
  render(); input("c", {}); const context = render();
  const contextBefore = context.props.contextWindow;
  context.props.onSave("manual", 96000);
  const contextSaved = saved;
  render(); input("m", {}); const metadata = render();
  metadata.props.onSelect({ source: "models.dev", contextWindow: 500000, catalogRef: { providerId: "fixture", modelId: "meta" } });
  const metadataSaved = saved;
  render(); input("t", {}); const picker = render();
  const manualOptions = picker.props.options.map(option => option.id);
  picker.props.onSelect("provider:Beta"); const manual = render(); find(manual, "TextField").props.onSubmit("alias");
  const manualSaved = committed;
  render(); input("c", {}); render();
  props = { ...props, config: { ...config, providers: [providers[0]] } };
  render(); input("", { escape: true }); const cancelledAfterRemoval = cancelled;
  slots = []; props = { ...props, config };
  render(); input("p", {}); render();
  props = { ...props, config: { ...config, providers: [] } };
  render(); input("", { escape: true }); const cancelledInPicker = cancelled;
  slots = []; props = { ...props, config: { ...config, providers: [] } };
  render(); input("t", {}); render(); input("p", {}); render(); input("", { escape: true });
  const emptyEscWorks = cancelled === cancelledInPicker + 1;
  slots = []; props = { ...props, config, initialProviderId: "Beta", setup: true };
  const setup = render();
  console.log(JSON.stringify({ selected, contextBefore, contextSaved, metadataSaved, manualOptions, manualSaved, cancelledAfterRemoval, cancelledInPicker, emptyEscWorks, setupText: text(setup) }));
`

it("model dialog binds selection and edits to the highlighted connection, preserves setup scope and stays dismissible", () => {
  const root = mkdtempSync(join(tmpdir(), "zap-model-component-"))
  try {
    const child = spawnSync(process.execPath, ["-e", fixture], { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, ZAPCODE_DATA_DIR: root } })
    if (child.status !== 0) throw new Error(child.stderr)
    expect(child.status).toBe(0)
    expect(child.stderr).toBe("")
    const result = JSON.parse(child.stdout)
    expect(result.selected).toEqual({ providerId: "Beta", model: "shared" })
    expect(result.contextBefore).toBe(64000)
    expect(result.contextSaved.active.providerId).toBe("Alpha")
    expect(result.contextSaved.providers.find((provider: { id: string }) => provider.id === "Beta").contextWindow).toBe(96000)
    expect(result.metadataSaved.providers.find((provider: { id: string }) => provider.id === "Beta").modelMetadata.shared.contextWindow).toBe(500000)
    expect(result.metadataSaved.providers.find((provider: { id: string }) => provider.id === "Alpha").modelMetadata?.shared).toBeUndefined()
    expect(result.manualOptions).toEqual(["provider:Alpha", "provider:Beta"])
    expect(result.manualSaved.active).toEqual({ providerId: "Beta", model: "alias" })
    expect(result.cancelledAfterRemoval).toBe(1)
    expect(result.cancelledInPicker).toBe(2)
    expect(result.emptyEscWorks).toBe(true)
    expect(result.setupText).toContain("Beta ·")
    expect(result.setupText).not.toContain("Alpha ·")
  } finally { rmSync(root, { recursive: true, force: true }) }
})

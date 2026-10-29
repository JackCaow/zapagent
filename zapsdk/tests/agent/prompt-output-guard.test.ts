import { expect, it } from "bun:test";
import { findPromptLeak, PromptOutputEmitter } from "../../agent/prompt-output-guard.js";
import type { AgentEvent } from "../../agent/events.js";

function fixture(corpus = "Private host rules.", normalize: (text: string, final: boolean) => string = text => text) {
  const events: AgentEvent[] = [];
  const emitter = new PromptOutputEmitter((text, start) => findPromptLeak(text, corpus, start) ? "BLOCKED" : text, () => true, normalize);
  emitter.on("*", event => events.push(event));
  return { events, emitter };
}

it("does not duplicate an emitted prefix when the final response is trimmed", () => {
  const { emitter, events } = fixture(undefined, (text, final) => final ? text.trim() : text.trimStart());
  const raw = "  " + "Public words. ".repeat(50) + "  ";
  emitter.emit({ type: "content_delta", kind: "text", id: "text", text: raw });
  emitter.emit({ type: "content_final", kind: "text", id: "text", text: raw.trim() });
  expect(events.flatMap(e => e.type === "content_delta" ? [e.text] : []).join("")).toBe(raw.trim());
  expect(events.at(-1)).toMatchObject({ type: "content_final", text: raw.trim() });
});

it("does not split a surrogate pair at the holdback boundary", () => {
  const { emitter, events } = fixture();
  const raw = "😀" + "a".repeat(298);
  emitter.emit({ type: "content_delta", kind: "text", id: "unicode", text: raw });
  expect(events).toHaveLength(0);
  emitter.emit({ type: "content_delta", kind: "text", id: "unicode", text: "b" });
  expect(events[0]).toMatchObject({ type: "content_delta", text: "😀" });
  emitter.emit({ type: "content_final", kind: "text", id: "unicode", text: raw + "b" });
  expect(events.flatMap(e => e.type === "content_delta" ? [e.text] : []).join("")).toBe(raw + "b");
});

it("discards abandoned and completed-run buffers without flushing them", () => {
  const { emitter, events } = fixture();
  emitter.emit({ type: "content_delta", kind: "thinking", id: "old", text: "Stale draft." });
  emitter.emit({ type: "content_abandoned", kind: "thinking", id: "old", step: 0, attempt: 1, reason: "fixture reset", usageUnknown: true });
  emitter.emit({ type: "content_final", kind: "thinking", id: "old", text: "Reset draft." });
  emitter.clearOutputBuffers();
  emitter.emit({ type: "content_delta", kind: "text", id: "old", text: "Fresh." });
  emitter.emit({ type: "content_final", kind: "text", id: "old", text: "Fresh." });
  expect(events.flatMap(e => e.type === "content_delta" ? [e.text] : []).join("")).toBe("Fresh.");
});

it("forwards already-guarded child events without buffering them twice", () => {
  const { emitter, events } = fixture();
  const event = { type: "content_delta" as const, kind: "text" as const, id: "child", path: ["child"], text: "Guarded child reply." };
  emitter.emit(event);
  expect(events).toEqual([event]);
});

it("finds exactly 300 private characters at any output offset", () => {
  const privateText = "private=" + "z".repeat(292);
  for (let offset = 0; offset < 60; offset++) {
    expect(findPromptLeak("x".repeat(offset) + privateText, privateText)).toEqual({ reason: "long_verbatim_run" });
  }
  expect(findPromptLeak(privateText.slice(0, 299), privateText)).toBeUndefined();
});

it("retains detection across a preamble final followed by text under the same id", () => {
  const secret = "private=" + "z".repeat(292);
  const { emitter, events } = fixture(secret);
  emitter.emit({ type: "content_delta", kind: "text", id: "preamble", text: secret.slice(0, 150) });
  emitter.emit({ type: "content_final", kind: "text", id: "preamble", text: secret.slice(0, 150) });
  emitter.emit({ type: "content_delta", kind: "text", id: "preamble", text: secret.slice(150) });
  emitter.emit({ type: "content_final", kind: "text", id: "preamble", text: secret });
  expect(events.flatMap(e => e.type === "content_delta" ? [e.text] : []).join("")).not.toContain(secret);
  expect(events.at(-1)).toMatchObject({ type: "content_final", text: "BLOCKED" });
});

it("preserves raw chunk boundaries when there is no protected host context", () => {
  const events: AgentEvent[] = [];
  const emitter = new PromptOutputEmitter(text => text, () => false);
  emitter.on("*", event => events.push(event));
  for (const text of ["hel", "lo"]) emitter.emit({ type: "content_delta", kind: "text", id: "plain", text });
  expect(events.map(e => e.type === "content_delta" && e.text)).toEqual(["hel", "lo"]);
});

it("does not replay a finalized preamble when short text resumes under the same id", () => {
  const { emitter, events } = fixture();
  const first = "Safe preamble. ".repeat(10);
  const next = "Continued output. ".repeat(20);
  emitter.emit({ type: "content_delta", kind: "text", id: "resumed", text: first });
  emitter.emit({ type: "content_final", kind: "text", id: "resumed", text: first });
  for (let i = 0; i < next.length; i += 10) emitter.emit({ type: "content_delta", kind: "text", id: "resumed", text: next.slice(i, i + 10) });
  emitter.emit({ type: "content_final", kind: "text", id: "resumed", text: first + next });
  expect(events.flatMap(e => e.type === "content_delta" ? [e.text] : []).join("")).toBe(first + next);
});

it("a public tag does not exempt a different private body", () => {
  const publicSource = "<system-reminder>Public conventions.</system-reminder>";
  const privateText = "<system-reminder>PRIVATE_HOST_DATA</system-reminder>";
  expect(findPromptLeak(publicSource, privateText, 0, [publicSource])).toBeUndefined();
  expect(findPromptLeak(privateText, privateText, 0, [publicSource])).toEqual({ marker: "<system-reminder>" });
});

it("public documents do not exempt separate private verbatim content", () => {
  const publicText = "Public convention. ".repeat(30);
  const privateText = "PRIVATE_DATA=" + "x".repeat(320);
  expect(findPromptLeak(publicText, publicText + privateText, 0, [publicText])).toBeUndefined();
  expect(findPromptLeak(publicText + privateText, publicText + privateText, 0, [publicText])).toEqual({ reason: "long_verbatim_run" });
});

it("a document ending at a public tag cannot exempt a private suffix", () => {
  const source = "Public documentation mentions <system-reminder>";
  const privateText = "<system-reminder>PRIVATE_REVIEW_FIXTURE</system-reminder>";
  expect(findPromptLeak(privateText, privateText, 0, [source])).toEqual({ marker: "<system-reminder>" });
  expect(findPromptLeak(source + "\nThis is a public explanation.", privateText, 0, [source])).toBeUndefined();
  expect(findPromptLeak(privateText, privateText, 0, [source + "PRIVATE_"])).toEqual({ marker: "<system-reminder>" });
});

it("allows a short public tag quote followed by an original explanation", () => {
  const source = "<system-reminder>Public conventions.</system-reminder>";
  const privateText = "<system-reminder>PRIVATE_REVIEW_FIXTURE</system-reminder>";
  expect(findPromptLeak('The document uses `<system-reminder>` as a literal tag.', privateText, 0, [source])).toBeUndefined();
  expect(findPromptLeak("<system-reminder>PRIVATE_REVIEW_FIXTURE", privateText, 0, [source])).toEqual({ marker: "<system-reminder>" });
});

it("withholds a private suffix arriving after an exempt tag in separate deltas", () => {
  const source = "Public documentation mentions <system-reminder>";
  const privateText = "<system-reminder>PRIVATE_REVIEW_FIXTURE</system-reminder>";
  const events: AgentEvent[] = [];
  const emitter = new PromptOutputEmitter((text, start) => findPromptLeak(text, privateText, start, [source]) ? "BLOCKED" : text);
  emitter.on("*", event => events.push(event));
  for (const char of privateText) emitter.emit({ type: "content_delta", kind: "text", id: "private", text: char });
  emitter.emit({ type: "content_final", kind: "text", id: "private", text: privateText });
  expect(events.flatMap(e => e.type === "content_delta" ? [e.text] : []).join("")).toBe("BLOCKED");
  expect(events.at(-1)).toMatchObject({ type: "content_final", text: "BLOCKED" });
});

import { describe, it, expect } from "bun:test"
import { parseMCPPromptInvocation } from "../../../src/commands/submit.js"

describe("parseMCPPromptInvocation", () => {
  it("parses bare invocation", () => {
    const r = parseMCPPromptInvocation("/mcp.github.commit_message")
    expect(r).toEqual({ server: "github", name: "commit_message", args: {} })
  })

  it("parses key=value args", () => {
    const r = parseMCPPromptInvocation("/mcp.linear.start_issue id=ENG-123 priority=high")
    expect(r?.args).toEqual({ id: "ENG-123", priority: "high" })
  })

  it("supports quoted multi-word values", () => {
    const r = parseMCPPromptInvocation('/mcp.notes.create title="hello world" tag=todo')
    expect(r?.args).toEqual({ title: "hello world", tag: "todo" })
  })

  it("returns null on non-MCP slash commands", () => {
    expect(parseMCPPromptInvocation("/help")).toBeNull()
    expect(parseMCPPromptInvocation("/mcp")).toBeNull()
    expect(parseMCPPromptInvocation("/mcp.")).toBeNull()
  })
})

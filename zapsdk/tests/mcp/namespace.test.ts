import { describe, it, expect } from "bun:test"
import { namespaceToolName, denamespaceToolName } from "../../mcp/bridge/tools.js"

describe("namespaceToolName / denamespaceToolName", () => {
  it("namespaces with double-underscore separators", () => {
    expect(namespaceToolName("github", "create_issue")).toBe("mcp__github__create_issue")
    expect(namespaceToolName("linear", "get-issue")).toBe("mcp__linear__get-issue")
  })

  it("round-trips simple names", () => {
    const ns = namespaceToolName("github", "create_issue")
    expect(denamespaceToolName(ns)).toEqual({ server: "github", tool: "create_issue" })
  })

  it("handles tool names containing underscores", () => {
    const ns = namespaceToolName("svc", "fetch_user_data")
    expect(denamespaceToolName(ns)).toEqual({ server: "svc", tool: "fetch_user_data" })
  })

  it("rejects names that would make the namespace ambiguous", () => {
    expect(() => namespaceToolName("bad__server", "tool")).toThrow(/Invalid MCP server name/)
    expect(() => namespaceToolName("server", "bad__tool")).toThrow(/Invalid MCP tool name/)
    expect(denamespaceToolName("mcp__bad__server__tool")).toBeNull()
    expect(denamespaceToolName("mcp__server__bad__tool")).toBeNull()
  })

  it("rejects empty, whitespace, and control-character names", () => {
    expect(() => namespaceToolName("", "tool")).toThrow(/Invalid MCP server name/)
    expect(() => namespaceToolName("server", "")).toThrow(/Invalid MCP tool name/)
    expect(() => namespaceToolName("bad server", "tool")).toThrow(/Invalid MCP server name/)
    expect(() => namespaceToolName("server", "bad\ntool")).toThrow(/Invalid MCP tool name/)
    expect(denamespaceToolName("mcp__bad server__tool")).toBeNull()
    expect(denamespaceToolName("mcp__server__bad\ntool")).toBeNull()
  })

  it("rejects names that providers will not accept as tool names", () => {
    expect(() => namespaceToolName("server.name", "tool")).toThrow(/Invalid MCP server name/)
    expect(() => namespaceToolName("server", "tool.name")).toThrow(/Invalid MCP tool name/)
    expect(() => namespaceToolName("server:name", "tool")).toThrow(/Invalid MCP server name/)
    expect(() => namespaceToolName("server", "tool/name")).toThrow(/Invalid MCP tool name/)
    expect(denamespaceToolName("mcp__server.name__tool")).toBeNull()
    expect(denamespaceToolName("mcp__server__tool.name")).toBeNull()
  })

  it("rejects namespaced tool names longer than provider limits", () => {
    const longServer = "s".repeat(56)
    expect(namespaceToolName(longServer, "t")).toHaveLength(64)
    expect(() => namespaceToolName(longServer, "tt")).toThrow(/64 characters or fewer/)
    expect(denamespaceToolName(`mcp__${longServer}__tt`)).toBeNull()
  })

  it("returns null for non-namespaced names", () => {
    expect(denamespaceToolName("read_file")).toBeNull()
    expect(denamespaceToolName("notmcp__foo__bar")).toBeNull()
  })
})

import { expect, it } from "bun:test"
import { mcpConfigs } from "../../src/acp/worker.js"

it("translates all ACP MCP transports without persisting their credentials", () => {
  const configs = mcpConfigs([
    { name: "stdio", command: "/usr/bin/env", args: ["server"], env: [{ name: "TOKEN", value: "secret" }] },
    { name: "http", type: "http", url: "https://example.com/mcp", headers: [{ name: "Authorization", value: "secret" }] },
    { name: "sse", type: "sse", url: "https://example.com/sse", headers: [] },
  ], "/tmp/workspace")
  expect(configs.map(item => item.transport)).toEqual(["stdio", "http", "sse"])
  expect(configs[0]?.env).toEqual({ TOKEN: "secret" })
  expect(configs[1]?.headers).toEqual({ Authorization: "secret" })
  expect(configs.every(item => item.cwd === "/tmp/workspace")).toBe(true)
})

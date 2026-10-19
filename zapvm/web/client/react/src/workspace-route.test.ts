import { describe, expect, it } from "vitest";
import { parseWorkspaceRoute, workspaceRoutePath } from "./workspace-route";

describe("workspace routes", () => {
  it("parses stable workspace entrypoints", () => {
    expect(parseWorkspaceRoute("/")).toEqual({ kind: "home" });
    expect(parseWorkspaceRoute("/new")).toEqual({ kind: "new" });
    expect(parseWorkspaceRoute("/admin/computers")).toEqual({ kind: "not-found" });
    expect(parseWorkspaceRoute("/admin")).toEqual({ kind: "admin-platform" });
    expect(workspaceRoutePath({ kind: "admin-platform" })).toBe("/admin");
    expect(parseWorkspaceRoute("/sessions/session-123")).toEqual({ kind: "session", sessionID: "session-123" });
  });

  it("round-trips encoded session identifiers", () => {
    const route = { kind: "session", sessionID: "customer_session-1" } as const;
    expect(parseWorkspaceRoute(workspaceRoutePath(route))).toEqual(route);
  });

  it("rejects unknown and nested paths", () => {
    expect(parseWorkspaceRoute("/settings")).toEqual({ kind: "not-found" });
    expect(parseWorkspaceRoute("/sessions/a/files")).toEqual({ kind: "not-found" });
    expect(parseWorkspaceRoute("/sessions/%2Fetc")).toEqual({ kind: "not-found" });
    expect(parseWorkspaceRoute("/sessions/customer%20session")).toEqual({ kind: "not-found" });
  });
});

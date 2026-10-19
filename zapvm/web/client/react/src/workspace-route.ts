export type WorkspaceRoute =
  | { kind: "home" }
  | { kind: "new" }
  | { kind: "admin-platform" }
  | { kind: "session"; sessionID: string }
  | { kind: "not-found" };

export function parseWorkspaceRoute(pathname: string): WorkspaceRoute {
  if (pathname === "/" || pathname === "/index.html") return { kind: "home" };
  if (pathname === "/new" || pathname === "/new/") return { kind: "new" };
  if (pathname === "/admin" || pathname === "/admin/" || pathname === "/admin/platform" || pathname === "/admin/platform/") return { kind: "admin-platform" };
  const match = pathname.match(/^\/sessions\/([^/]+)\/?$/);
  if (!match) return { kind: "not-found" };
  try {
    const sessionID = decodeURIComponent(match[1]);
    if (!sessionID || sessionID.length > 200 || !/^[A-Za-z0-9._~-]+$/.test(sessionID)) return { kind: "not-found" };
    return { kind: "session", sessionID };
  } catch {
    return { kind: "not-found" };
  }
}

export function workspaceRoutePath(route: Exclude<WorkspaceRoute, { kind: "not-found" }>) {
  if (route.kind === "home") return "/";
  if (route.kind === "new") return "/new";
  if (route.kind === "admin-platform") return "/admin";
  return `/sessions/${encodeURIComponent(route.sessionID)}`;
}

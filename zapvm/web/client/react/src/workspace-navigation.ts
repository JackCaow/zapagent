import { useCallback, useEffect, useState } from "react";
import { parseWorkspaceRoute, workspaceRoutePath } from "./workspace-route";
import type { WorkspaceRoute } from "./workspace-route";

export function useWorkspaceNavigation() {
  const [route, setRoute] = useState<WorkspaceRoute>(() => parseWorkspaceRoute(window.location.pathname));

  useEffect(() => {
    const onPopState = () => setRoute(parseWorkspaceRoute(window.location.pathname));
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const navigate = useCallback((next: Exclude<WorkspaceRoute, { kind: "not-found" }>, replace = false) => {
    const path = workspaceRoutePath(next);
    if (path !== window.location.pathname) window.history[replace ? "replaceState" : "pushState"]({ zapvm: true }, "", path);
    setRoute(next);
  }, []);

  return { route, navigate };
}

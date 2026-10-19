import { AuthSessionBoundary } from "./auth-session";
import { WorkspaceApplication } from "./workspace-app";

export function App() {
  return <AuthSessionBoundary>{({ session, signOut }) => (
    <WorkspaceApplication session={session} onSignOut={signOut} />
  )}</AuthSessionBoundary>;
}

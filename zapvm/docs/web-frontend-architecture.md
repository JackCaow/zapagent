# Web Agent Workspace frontend architecture

Status: implemented foundation on `codex/frontend-app-shell-architecture`.

## Product boundary

The browser is a durable Workspace client, not a thin demo page. A URL must
remain meaningful across refresh, authentication changes, browser navigation,
and multiple open tabs. The UI does not own execution truth: Control owns
Sessions, Tasks, Computer availability, events, and artifacts.

## Application layers

```text
main.tsx
  QueryClientProvider
    App composition root
      AuthSessionBoundary
        LoginPage / loading boundary
        WorkspaceApplication
          Workspace navigation
          Session directory
          Conversation runtime
          Outcome and artifact panels
```

- `app.tsx` is composition only. It does not fetch data or render product UI.
- `auth-session.tsx` owns the authenticated/unauthenticated state machine,
  CSRF installation, invitation exchange, login, logout, and recovery.
- `auth-sync.ts` synchronizes only versioned state transitions. It never sends
  access tokens, cookies, CSRF values, project IDs, or user data between tabs.
- `workspace-navigation.ts` owns History API integration and typed routes.
- `workspace-app.tsx` owns authenticated Workspace presentation and Agent loop
  state. It receives identity and logout as explicit dependencies.
- `query-keys.ts` is the cache namespace authority so authentication changes
  can invalidate Workspace data without ad-hoc string keys.

## Authentication state machine

```text
unknown -> checking -> authenticated -> signed-out
                 \-> unauthenticated -> authenticating -> authenticated
```

The last confirmed authenticated Workspace remains rendered during a background
session refresh. This prevents a focus event or transient network request from
flashing the full login screen over an active conversation.

Login and logout publish a credential-free `zapvm.auth-session.v1` event using
`BroadcastChannel`; the storage event is a compatibility fallback. A receiving
tab does not trust the event as authentication proof. On login it re-fetches
`/api/session`; on logout it immediately clears identity-scoped caches and CSRF
state. Window focus and visibility recovery revalidate the server session in
case the browser missed an event while suspended.

## Routing invariants

- `/new` is a stable new-task surface.
- `/sessions/<session_id>` is a stable deep link.
- Authentication never replaces the requested path; successful login resumes
  the original route.
- History navigation changes only route state. It does not rebuild the entire
  authentication or Query Client tree.
- Conversation drafts and complete transcript snapshots survive in-app route
  switches; server state remains authoritative after refresh.

## Acceptance gates

1. TypeScript build and unit tests.
2. Login, invitation, route, conversation, streaming, artifact, and responsive
   Playwright tests.
3. Two-tab acceptance: login in one tab opens the Workspace in the other;
   logout in either tab closes both without exposing credentials.
4. Production smoke test against a real Control Session and Computer.

## Next boundaries

The next extraction should separate `ConversationRuntime` and `OutcomeWorkspace`
from `workspace-app.tsx`. That change should preserve the existing event reducer
and public HTTP contracts while allowing independent loading/error boundaries
for history, the active Agent loop, and artifact delivery.

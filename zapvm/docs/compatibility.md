# Compatibility policy

zapVM has independently versioned delivery surfaces:

1. Host CLI and daemon behavior.
2. Host/guest authenticated protocol.
3. Signed Base image and capability contract.
4. Signed Host/guest Runtime layer.
5. Signed Agent layer.
6. Persistent Session state and its migration schema.
7. Release-update metadata and anti-rollback ledger.

## During 0.x

- Breaking behavior may ship in a minor release and must be called out in
  `CHANGELOG.md`.
- A released Host binary must reject an incompatible image, daemon schema, or
  state version before executing a workload.
- Schema 3 must assign every signed file to exactly one Base, Runtime, Agent, or
  Session layer. An Agent-only release may reuse Base/Runtime versions, but the
  complete manifest and bundle must still be signed and smoke-tested.
- Unknown JSON fields remain rejected on security-sensitive RPC and plan
  messages unless a new schema explicitly changes that rule.
- Persistent state migrations must be monotonic, restart-safe, and covered by
  dirty/interrupted migration tests. A rollback must never silently downgrade
  state.

## Stable-release target

At 1.0, patch releases remain wire and state compatible within the same major
version. A major-version migration must include:

- old Host/new image and new Host/old image behavior;
- daemon rolling restart behavior;
- state migration and interrupted migration recovery;
- release rollback behavior;
- an end-of-support date for the previous major version.

## Consumer requirements

Agent adapters must inspect capabilities and fail closed when a required
workspace, network, credential, or isolation feature is absent. Adapters must
not retry a rejected zapVM command directly on the Host.

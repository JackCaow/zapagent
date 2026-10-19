# zapVM HTTP API contracts

The checked-in contract is the source of truth for Web/BFF clients:

- [`agent-session-v1.openapi.json`](./agent-session-v1.openapi.json) covers Resident Agent submit, inspect, event replay, cancel, workspace reads, and Artifact metadata.
- Every JSON response carries `X-ZapVM-API-Version: 1`.
- Client identity and `tenant/project` scope come from the verified mTLS SPIFFE URI. They are never accepted from request JSON.

## Compatibility policy

Within `/v1` the server may add optional response fields and new error codes. It must not remove a field, change its type or meaning, make an optional request field required, or reuse an error code with different semantics. Such a change requires a new versioned route and a new checked-in contract.

Requests reject unknown JSON fields, trailing JSON, invalid identifiers, non-HTTPS provider URLs, oversized prompts, excessive turns, excessive timeouts, and unsafe workspace paths. Routine responses never include the prompt, provider credential value or ID, search credential value or ID, internal argv, dispatch payload, lease material, node identity, or Host path.

`GET /v1/agent/sessions?after=<cursor>&limit=<n>` lists redacted turn records in stable creation order. The response `next_cursor` is the last returned turn's durable creation sequence. An empty page returns the input cursor. Generic Computer Tasks are never included in this narrower catalog.

`GET /v1/agent/computers` lists only Computers explicitly assigned to the caller's tenant/project in the owner-only Control configuration. Its `online`, `draining`, or `offline` state is aggregated from the authorized Node registry without exposing Node IDs or Host topology. A scope with no explicit catalog retains legacy scope-wide scheduling but is not enumerable. Once any Computer is explicit for a scope, Nodes without an explicit matching Computer cannot act as wildcard schedulers.

`GET /v1/agent/git/providers` lists only non-secret repository descriptors provisioned for the authenticated tenant/project. It never returns a GitHub App JWT, installation token, private-key path, App ID, Installation ID, API origin, or clone credential. Token minting remains an internal Control-to-Host capability flow.

`PUT /v1/agent/credentials/<credential-id>` accepts a bounded JSON `value` byte string (base64 on the wire), immediately creates a new envelope-encrypted version, and returns metadata only. `GET /v1/agent/credentials` lists only ID/version/state/timestamps; `DELETE /v1/agent/credentials/<credential-id>` revokes all versions. The corresponding Web BFF paths are `/api/agent/credentials...` and require its authenticated, same-origin, CSRF-protected session. Credential values never have a read-back API.

`POST /v1/node/tasks/<task-id>/credentials` is Node-mTLS-only and redeems the one-time capability returned by distributed Task claim. It additionally requires the current Node generation and lease token. Replay, expiry, revoked versions, a terminal/requeued Task, or any Task/lease/generation mismatch is fenced. This is the only Control response that contains decrypted Credential bytes, and the Node must destroy them after forwarding the exact bundle through owner-only daemon IPC.

`POST /v1/agent/computers/<computer_id>/git/operations` accepts only an idempotency ID, a succeeded Agent `task_id` and an authorized `provider_id`. Control verifies the same tenant/project/Computer, generates `zapvm/<operation_id>`, and never accepts a caller-selected branch or commit argv. After the Host pushes, Control—not Node or Guest—creates or strictly reuses the matching GitHub Pull Request and persists its number, HTTPS URL and state. Retryable GitHub failures keep the lease retryable; permanent conflicts become a stable failed operation. `GET`/`DELETE .../git/operations/<operation_id>` inspect or remove the redacted terminal record. Node receives the short-lived installation capability only over its current mTLS lease and forwards it through owner-only daemon IPC; Browser and Guest never receive it.

Node version, daemon version, active image digest, daemon health, capacity and stable failure code are available only through the administrator node inventory. An unhealthy or paused daemon makes its tenant-facing Computers `offline`; raw Host errors are never part of either contract. See [Remote Node operations](../node-operations.md).

Workspace browsing is asynchronous and read-only. `POST /v1/agent/computers/<computer_id>/workspace/operations` creates an idempotent `list`, `read`, or `diff` request; `GET .../operations/<operation_id>` returns its redacted status and bounded result, and `DELETE` removes a terminal result after the client consumes it. Only explicitly provisioned Computers are accepted. Paths are portable relative paths, `.git` and `.zapcode` are hidden, symlink/reparse traversal is rejected, and file/diff results are limited to 512 KiB. Control persists the request, the authorized Node claims it over outbound mTLS, and the Host daemon resolves it against the fixed Computer workspace; Control never opens a Host path directly.

The Web client previews only text-like MIME types. Any validated file within the same 512 KiB boundary can be downloaded from the already audited read result through a short-lived in-memory Blob URL; the URL is revoked immediately and is never persisted or sent to another origin.

Artifact metadata is separate from bounded workspace reads. A currently leased Node registers immutable metadata through `POST /v1/node/tasks/<task_id>/artifacts`; the request contains only Artifact ID, relative path, MIME, size, SHA-256 and retention. Control derives tenant, project, Computer, Session, Task and Node ownership from the authenticated Node identity and active Task lease. Browser clients have no Artifact mutation route and cannot provide ownership fields.

`GET /v1/agent/sessions/<task_id>/artifacts` lists creation-ordered metadata for one authorized Agent turn. `GET /v1/agent/artifacts/<artifact_id>` inspects one authorized record. Both surfaces omit tenant keys, Node topology, lease material, Host paths and object-store authority. The Node streams each capability-bound Host snapshot to `PUT /v1/node/tasks/<task_id>/artifacts/<artifact_id>/content`; Control verifies the active lease, immutable size/MIME/SHA-256, uploads it to the configured private S3-compatible bucket, and only then promotes the record to `available`. `GET /v1/agent/artifacts/<artifact_id>/download` returns a five-minute signed URL for an authorized available Artifact. Pending, failed and expired records are never downloadable.

## Cursor recovery

Clients persist the greatest processed event `cursor`. After reconnecting they request:

```http
GET /v1/agent/sessions/turn-01/events?after=42&limit=100
```

For live delivery, clients use `GET /v1/agent/sessions/turn-01/stream?limit=1000` and reconnect with the browser-supplied `Last-Event-ID`, or an explicit `after` query. The stream emits `session` snapshots and cursor-bearing `task-event` records. Every connection is bounded to 25 seconds, 1000 events, or a terminal state, whichever comes first; a timeout emits a keepalive comment before closing.

Both replay surfaces contain only events after the requested cursor. Clients should deduplicate by cursor and stop reconnecting only after observing a terminal Agent Session state. Closing the connection never cancels the Task; cancellation requires `DELETE /v1/agent/sessions/<id>`.

## Idempotency

`POST /v1/agent/sessions` uses `id` as the idempotency key. Repeating the identical request returns the existing Agent Session. Reusing the same ID with a different normalized payload returns `409 conflict`.

`POST /v1/agent/sessions/<source_id>/retry` accepts only a new `id` and only when the source turn is failed or canceled. Control copies the original authorized Resident payload server-side, records `retry_of`, and atomically rejects the retry while any turn in that Session remains active. Retrying the same source with the same new ID is idempotent; the browser never stores or resubmits the original prompt or credential IDs.

The first turn for a new `session_id` must use `continue=false`. Later turns must use `continue=true`, retain the original `computer_id`, and wait until every prior turn in that Session is terminal. Admission is atomic with Task creation, so concurrent continuation requests cannot execute against the same persistent HOME at once.

## Error envelope

All public errors use one stable redacted shape:

```json
{
  "error": {
    "code": "unavailable",
    "category": "infrastructure",
    "action": "retry",
    "retryable": true
  }
}
```

`category` separates authentication, session, authorization, request, not-found, conflict, infrastructure, and rate-limit failures. `action` is one of `login`, `refresh`, `contact_admin`, `fix_request`, or `retry`. `retryable=true` permits an explicit user retry or safe read reconnect; it never authorizes automatic replay of POST/DELETE mutations. Internal error strings are logged with restricted correlation context; they are not returned in this contract. The BFF returns the correlation value in `X-Request-ID` and forwards the same value to Control.

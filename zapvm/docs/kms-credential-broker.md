# KMS Credential Broker

GA-03 replaces long-lived Host credential values with tenant-bound encrypted envelopes and short-lived, task-bound capabilities. This document fixes the security contract before a production KMS provider is enabled.

## Envelope contract

`internal/credentialkms` performs envelope encryption:

1. Generate a fresh 256-bit data-encryption key for every Credential version.
2. Encrypt the Credential value with AES-256-GCM and a fresh 96-bit nonce.
3. Bind the ciphertext to `tenant_id`, `project_id`, `credential_id`, and monotonically increasing version through authenticated data.
4. Ask the configured KMS wrapper to encrypt only the data key. Persist the wrapped key, nonce, ciphertext, algorithm, KMS key identity/version, and AAD digest.
5. Zero the plaintext data key after each operation. A caller that receives decrypted Credential bytes owns and must zero them after the request.

The KMS wrapper error is always replaced with a stable redacted error. Provider response bodies, account identifiers, tokens, Credential values, and plaintext data keys must never enter Control logs or database errors.

Moving an envelope to another tenant/project/Credential/version, modifying its ciphertext, wrapped key, nonce, algorithm, or schema must fail authentication. The database must never contain the Credential value or an unsalted plaintext digest.

## Delivery slices

- **GA-03a1 — envelope cryptography:** provider-neutral key wrapper, AES-GCM envelope, AAD binding, size limits, error redaction, tamper and nonce tests. This is implemented but does not yet authorize production KMS use.
- **GA-03a2 — PostgreSQL ledger:** migration v7 adds encrypted Credential versions, one-time capability hashes, a maximum 15-minute TTL, Task/Node-generation binding, revocation states, forced tenant RLS, and a separate hash-chain access-audit ledger. Real PostgreSQL 16 verifies constraints and confirms a cryptographically generated test plaintext is absent from persisted envelope columns. Runtime issue/redeem transactions remain part of GA-03b.
- **GA-03b — runtime broker:** implemented. Distributed PostgreSQL claim atomically issues a random one-time capability for a specific Task, lease, Node generation, tenant/project scope, and immutable Credential-version set. The Node acknowledges the lease, redeems the capability once over mTLS, validates an exact ID/value bundle, and forwards it only through the daemon's owner-only local IPC message. The daemon passes the values in-memory to the already running worker; the Guest Agent creates request-only owner-readable files and overwrites/removes them at command completion. Rotation preserves already-issued version pins; revocation, expiry, lease expiry, Task terminal state, and Node generation fencing fail closed and append the separate Credential audit chain.
- **GA-03c — node identity:** online enrollment, short-lived Node certificate issuance, overlap rotation, revocation, and claim fencing.
- **GA-03d — production rollout:** managed KMS key policy, dual-CA rotation on Railway and Hosts, revocation drill, and Bash/log/Event/Artifact leakage tests.

The runtime can use an explicitly named development static AES wrapper whose 32-byte key is loaded from an owner-only file and never stored in PostgreSQL. This is a bootstrap/test adapter, not a production KMS. Until GA-03c and GA-03d pass, the repository must not claim production KMS or automatic CA rotation.

### GA-03c implementation contract

GA-03c is delivered in four fail-closed layers:

1. A Control-owned signer accepts only a bounded, self-signed CSR with no caller-selected SANs. Control selects the exact provisioned `spiffe://<trust-domain>/node/<node-id>` identity and issues a client-auth-only certificate valid for 5 minutes to 24 hours.
2. PostgreSQL stores one-way enrollment-token hashes, certificate serial/public-key digests, issuance/renewal/revocation state and an audit chain. Bootstrap tokens are single-use and never enter normal configuration responses, Task data or logs.
3. The unauthenticated enrollment route is available only when the identity issuer is configured, uses server-authenticated TLS, and requires the exact provisioned Node ID plus a live single-use token and CSR. Renewal requires the current non-revoked Node certificate; administrator revocation fences its serial and current Node generation.
4. Node generates its private key locally, writes key/certificate replacements atomically with owner-only permissions, overlaps the old and new certificate only for bounded reconnect, and deletes failed candidates. Claim, ack, Credential redemption and completion all reject a revoked or expired serial.

The signer, PostgreSQL authority, HTTP enrollment/renewal/revocation routes, serial authorization, Node-local key generation, atomic versioned identity files, renewal backoff, expiry sweep and hash-chain audit are implemented. Unit tests cover exact SAN and TLS behavior; real PostgreSQL 16 covers concurrent single-use enrollment, restart replay denial, overlap rotation, token removal revocation, certificate revocation fencing and expiry. GA-03c is not marked complete until the packaged Railway Control and a real Host Node pass the same enrollment, rotation and revocation drill.

### GA-03c acceptance evidence

- Railway deployment `df825829-f201-4b1a-aae2-3ea0b4a222d1` applied PostgreSQL schema v8 and started the packaged Control with the file signer and distributed Backend; stable redeploy `e4559e1f-7904-4a33-8402-a5a1916a8637` started without the one-shot migration flag or an enrollment provision.
- macOS `host-a` enrolled without a client certificate, deleted its consumed token, persisted owner-only versioned key/certificate files, and registered as `online/healthy` with Node version `0.1.0-ga03c.54eb1bd`.
- Real VM Task `ga03c-live-1786151676` traversed submit, claim, ack, Guest execution, output Event and completion, returning `ga03c-node-identity-ok` and terminal `succeeded`.
- Forced automatic renewal changed both the 128-bit serial and local private-key file. Old and new certificates both authorized during overlap; after administrator revocation, the old serial returned HTTP 403, the replacement remained HTTP 200, and the Node recovered `online` after generation fencing.

This closes GA-03c for the current single-region Railway plus macOS Host target. GA-03d still gates any production-KMS/HSM or automatic dual-CA claim.

## Runtime surfaces

- `PUT /v1/agent/credentials/<credential-id>` immediately envelope-encrypts a bounded base64 JSON byte value and returns metadata only. Repeating the request creates a monotonically increasing active version and disables the previous version.
- `GET /v1/agent/credentials` returns only ID, version, state, and timestamps for the authenticated tenant/project.
- `DELETE /v1/agent/credentials/<credential-id>` revokes every version of that Credential. Already-issued but unredeemed capabilities then fail closed.
- `POST /v1/node/tasks/<task-id>/credentials` is Node-mTLS-only. It requires the current generation, lease token, capability ID, and 256-bit capability secret. A successful response is possible exactly once.

Browser/client Task, Event, Audit, Artifact, metrics, and log surfaces never contain the capability or Credential values. The Web BFF may proxy tenant Credential management under `/api/agent/credentials`, retaining its existing authenticated session, same-origin, CSRF, body-size, header-stripping, and project-selection controls.

## GA-03b acceptance evidence

- Real PostgreSQL 16 verifies active-version rotation, immutable version pinning, no plaintext in envelope/capability columns, one successful result under concurrent double redemption, replay rejection, expiry persistence, and exact Task/lease/Node-generation binding.
- Node/daemon tests verify the ordinary daemon RPC is not used for runtime values, the capability secret is destroyed after admission, and an exact dynamic value reaches the Guest only as a request-scoped file.
- Unit, `go vet`, and race suites cover malformed/extra/missing values, tampered wrapped keys, closed wrapper behavior, API cross-tenant denial, absent-runtime fail-closed behavior, Task terminal cleanup, and generation rotation.

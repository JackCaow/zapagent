# zapVM threat model

Status: developer preview. This document defines the intended boundary; only
claims linked to real-platform evidence in `acceptance.md` are considered
validated.

## Assets

- Host files outside explicitly authorized workspace roots.
- Host credentials, signing keys, tokens, sockets, and local services.
- Other workspaces, users, sessions, and VM state disks.
- The integrity of the Host CLI, service, signed image, update metadata, and
  lifecycle audit records.
- Availability of the Host, VM pool, and agent process.

## Trust boundaries

```text
Agent / adapter
      |
      | structured daemon or stdio RPC
      v
zapVM Host control plane ---- TUF metadata / signed image repository
      |
      | VZ, KVM, or HCS hardware virtualization boundary
      v
Guest kernel -> authenticated guest agent -> untrusted workload
      |
      +-- explicitly mounted workspace
      +-- request-scoped credential lease
      +-- optional restricted egress bridge
```

The Agent, prompts, repository contents, downloaded dependencies, and guest
workload are untrusted. The Host operating system, hypervisor, installed zapVM
binary, configured trust roots, and administrator-approved policy are trusted.

## Security properties

When a platform is listed as accepted in `support-matrix.md`, zapVM intends to:

1. Execute workload code behind a separate guest kernel.
2. Mount no Host directory unless it was explicitly authorized and resolved to
   an allowed real path.
3. preserve the requested read-only/read-write workspace mode and protect guest
   control paths from workload writes.
4. Keep network disabled by default; restricted mode permits only approved
   destinations after DNS and IP validation.
5. Keep credential values out of argv, environment values, plans, audit events,
   and later requests; credential files are request scoped and fail closed on
   cleanup failure.
6. Verify the active image signature, architecture, manifest, and every file
   hash before boot.
7. Keep different workspace/policy/image/credential/resource routes out of the
   same VM.
8. Treat lost health, ambiguous lifecycle state, failed cleanup, or corrupt
   persistent state as a terminal/degraded condition rather than silently
   running on the Host.

## Primary attack surfaces

| Surface | Threats | Required controls |
|---|---|---|
| Agent request | shell injection, oversized or ambiguous messages | structured argv, strict JSON, size/concurrency/time limits |
| Workspace mount | symlink/TOCTOU escape, root or HOME exposure | canonicalization, sensitive-root denial, pinned handles where supported |
| Guest RPC | spoofing, replay, malformed frames | mutual authentication, bounded framing, strict schema, fuzzing |
| Restricted egress | DNS rebinding, Fake-IP, private/metadata access, redirects | Host resolution, mixed-answer rejection, post-resolution IP checks, audit |
| Credential broker | cross-request reads, logs, residual files | explicit IDs, 0400 request leases, private mount namespace, cleanup gate |
| Image/update | malicious image, rollback, metadata freeze, key theft | offline TUF root, role separation, Ed25519 manifest, monotonic ledger |
| VM pool | route confusion, stale worker, quota bypass, orphan VMM | complete route key, peer identity, leases, LRU limits, fail-closed recovery |
| Windows service | unprivileged HCS/ACL use, PID reuse, unsafe upgrade | protected DACL, client token/SID binding, pinned process handle, journal |
| Host power | commands admitted during suspend, stale channel after wake | drain, pause gate, boot/agent generation checks, clean stop |

## Explicit non-goals and limitations

- zapVM does not defend against a compromised Host kernel, hypervisor,
  administrator, firmware, or physical attacker.
- It does not prove physical erasure of secrets copied by runtimes, kernels, or
  target tools.
- A network domain allowlist is not content inspection. An allowed service can
  still receive workspace data.
- Hash-chained local audit logs do not prevent an authorized Host user from
  deleting the complete tail without an external anchor.
- Availability against deliberate CPU, memory, storage, or output exhaustion is
  bounded but not guaranteed until the relevant long-running gate is complete.
- Host GUI automation, browser automation, MCP servers, and tools that bypass
  the zapVM adapter are outside this boundary.

## Security claim policy

The following are supporting evidence, not final enforcement proof:

- a configuration or policy field;
- a unit test using a fake VMM;
- cross-compilation;
- a successful VM boot without an adversarial assertion;
- the existence of a workflow or test script that has not run on its target.

Claims must name the backend, host version/architecture, signed artifact, attack
assertion, run URL or retained evidence, and remaining gaps. `acceptance.md` is
the evidence ledger.

## Open gates

Before a stable 1.0 release, the project requires the real-platform, power,
long-soak, production-update, and independent-review gates in
`roadmap-to-1.0.md`.

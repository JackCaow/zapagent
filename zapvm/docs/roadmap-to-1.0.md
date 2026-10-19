# Required gates for 1.0

This file is a release gate, not a claim that the listed workflow has run.

## Platform evidence

- [ ] Linux x64 dedicated KVM host: same-host multi-route, quota, LRU, pause,
      resume, crash recovery, and clean teardown.
- [ ] Windows Server 2022 build 20348+ x64 physical host: HCS, HCN, protected
      service, upgrade interruption, ACL recovery, and clean teardown.
- [ ] macOS Intel, Linux arm64, and Windows arm64 are either accepted on real
      hardware or explicitly removed from the 1.0 support claim.

## Power and stability

- [ ] macOS, Linux, and Windows physical suspend/resume with an active lease.
- [ ] 72-hour macOS soak with bounded RSS, file descriptors, mounts, state-disk
      growth, and no orphan process.
- [ ] Disk pressure, state ENOSPC, daemon crash, VMM crash, and host reboot
      recovery evidence retained for the exact release candidate.
- [ ] Published cold-start, warm-exec, concurrent-exec, memory, and disk baselines.

## Release and security

- [ ] Production TUF role separation, offline root ceremony, rotation, and
      revocation rehearsal.
- [ ] Real HTTPS/CDN staging and production update/rollback across all supported
      hosts.
- [ ] Native Host package signatures and clean-machine verification.
- [ ] Third-party license/source-offer gate for the exact image SBOM.
- [ ] Independent security review covers workspace TOCTOU, guest RPC, network
      rebinding/Fake-IP/redirects, credentials, pool routing, service ACLs, and
      update compromise.
- [ ] All high/critical findings fixed and retested; accepted residual risks are
      documented publicly.

## Operability

- [x] Stable error taxonomy and exit codes documented.
- [x] Redacted diagnostics verified not to collect environment values, workspace
      contents, credentials, or raw identifiers by default.
- [ ] Compatibility and end-of-support policy exercised across at least one
      upgrade and rollback release.

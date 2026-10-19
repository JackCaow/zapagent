# Support matrix

zapVM is a developer preview. “Verified” means the signed artifact completed the
documented black-box acceptance on that host; it does not imply every hardware
or OS variant is covered.

## Host platforms

| Host | Architecture | Backend | Status | Notes |
|---|---|---|---|---|
| macOS Apple Silicon | arm64 | Virtualization.framework | Verified core path | Suspend/resume and 72-hour soak remain release gates. |
| macOS Intel | amd64 | Virtualization.framework | Build-only | No retained real-host acceptance. |
| Ubuntu 24.04 | amd64 | KVM + Cloud Hypervisor + systemd 254+ | Verified core path | Hosted KVM verified; same-host multi-route still requires a dedicated runner. |
| Fedora Linux | amd64 | KVM + Cloud Hypervisor | Experimental | No retained real-host acceptance. |
| Linux | arm64 | KVM + Cloud Hypervisor | Build-only | Image and binaries build; no real KVM acceptance. |
| Windows Server 2025 build 26100 | amd64 | Hyper-V/HCS/HCN | Verified core path | HCS, HCN, daemon, and ACL recovery have real-host evidence. |
| Windows Server 2022 build 20348 | amd64 | Hyper-V/HCS/HCN | Experimental | Minimum-build physical-host acceptance is pending. |
| Windows | arm64 | Hyper-V/HCS/HCN | Build-only | No real-host acceptance. |

WSL is not a zapVM product backend. Linux requires `/dev/kvm`, cgroup v2,
systemd 254+, and a usable user manager. Windows requires an administrator for
the initial protected service installation; ordinary VM requests run as the
calling user. macOS binaries require the Virtualization entitlement.

## Capability status

| Capability | Status |
|---|---|
| Signed immutable rootfs and architecture/hash verification | Implemented and exercised on verified hosts |
| Schema 3 Host Runtime (Base/Runtime/Session) and Agent Computer (Base/Runtime/Agent/Session) profiles | Implemented; exact schema 3 release needs retained three-host acceptance |
| Workspace read-write/read-only authorization | Implemented and exercised on verified hosts |
| Guest `.git`/`.zapcode` and control-path protection | Implemented; retain per-platform regression evidence |
| Network off and restricted HTTPS CONNECT | Implemented, including conservative Host resolution for trusted Fake-IP DNS mappings |
| Request credential file broker | Implemented and exercised on verified hosts |
| Persistent Session HOME and private request TMP | Implemented and exercised on verified hosts |
| Daemon VM reuse, quotas, LRU, pause/resume | Core implemented; Linux same-host multi-route gate pending |
| TUF update, Warm Cache, staged smoke activation, and rollback | Automated tests pass; production keys/CDN and exact three-host candidate acceptance pending |
| Host suspend/resume | Harness implemented; three-platform physical acceptance pending |
| 72-hour soak | Harness implemented; full run pending |

Run `zapvm doctor` before installation and `zapvm capabilities` against the
active image before routing an agent workload. A consumer must not silently
fall back to Host execution when a required capability or backend is missing.

The detailed evidence and current gaps are maintained in `acceptance.md`.

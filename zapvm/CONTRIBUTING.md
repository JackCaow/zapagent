# Contributing to zapVM

Thank you for helping improve zapVM. Changes to a local agent runtime can alter
the security boundary of every command it executes, so evidence matters as much
as implementation.

## Before opening a change

1. Search existing issues and pull requests.
2. Open an issue before a protocol, image format, policy, or lifecycle change.
3. Never include credentials, signing keys, private images, customer code, or
   unredacted diagnostics.
4. Keep generated images and acceptance output out of Git. `.gitignore` already
   excludes `dist`, `.build`, and `.cache`.

## Development

Use the Go patch version declared by `go.mod` or a newer security-supported
patch release in the same toolchain family:

```bash
go test ./...
go test -race ./...
go vet ./...
go run ./cmd/zapvm doctor
```

Run `gofmt` on changed Go files. Changes to shell or PowerShell acceptance
scripts must pass the parser checks documented in `docs/acceptance.md`.

## Pull requests

A pull request should:

- describe the affected trust boundary and failure mode;
- include focused tests and the exact commands run;
- distinguish compilation, simulation, hosted CI, and real-hardware evidence;
- document compatibility or migration effects;
- update the threat model, support matrix, protocol documentation, or changelog
  when applicable.

Cross-compilation is not proof that a VZ, KVM, HCS, HCN, systemd, suspend, or
resume path works. Do not mark a platform accepted without the evidence required
by `docs/acceptance.md`.

By submitting a contribution, you agree that it is licensed under Apache-2.0
and that you have the right to submit it.

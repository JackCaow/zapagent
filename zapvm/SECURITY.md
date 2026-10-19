# Security policy

## Supported versions

Until zapVM reaches 1.0, security fixes are provided for the latest tagged
release and the `main` branch. Older development snapshots are unsupported.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub private
vulnerability reporting:

https://github.com/JackCaow/zapagent/security/advisories/new

This module is maintained in the zapcode monorepo. Follow the root
`../SECURITY.md` policy if private reporting is not yet enabled.

Include the affected version and host platform, the selected VM/network/file
policy, reproduction steps, impact, and a redacted diagnostic when available.
Do not include live credentials or private repository contents.

Maintainers aim to acknowledge a report within three business days. Timelines
for a fix and disclosure depend on severity and affected release channels; these
targets are best effort, not a service-level agreement.

## Security boundary

zapVM treats guest workloads as untrusted. The supported boundary and explicit
non-goals are documented in `docs/threat-model.md`. A policy field, unit test,
cross-build, or successful boot is not by itself proof that a platform boundary
is enforced. Security claims require the corresponding black-box evidence in
`docs/acceptance.md`.

Release signing, TUF metadata, GitHub access, and self-hosted runner credentials
must never be stored in the repository. See `docs/release.md` for key roles and
release gates.

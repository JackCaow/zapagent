# Maintainer infrastructure

The following GitHub settings are not stored in Git and must be configured by a
repository administrator.

## Repository security

- Enable private vulnerability reporting, Dependabot alerts, secret scanning,
  push protection, and CodeQL default/setup results.
- Restrict Actions to approved actions; prefer full commit SHA pins.
- Disable force pushes and deletion for `main`.
- Require pull requests, CODEOWNERS review, conversation resolution, signed
  commits where practical, and these checks:
  - `Source gates`
  - all `Platform build` matrix jobs
  - `CodeQL`
  - `Dependency review`
- Apply the same checks to merge queue runs.

## Environments

Create protected environments:

- `release-preview`: may create draft preview artifacts; requires a maintainer.
- `release-stable`: may publish immutable releases; requires independent review.
- `production-metadata`: narrowly scoped TUF/CDN publication.

Do not attach production image/TUF root private keys to a normal GitHub-hosted or
self-hosted build runner. Use OIDC to call a signing service or perform an
offline signing ceremony with an auditable handoff.

## Self-hosted runners

- Assign one physical host per unique `zapvm-physical-<host-id>` label.
- Do not use a broad organization runner group for untrusted pull requests.
- Run hardware workflows only from reviewed commits and protected environments.
- Reimage or verify the host after a failed isolation test.
- Keep power/72-hour runners dedicated; their workflows intentionally suspend
  the machine or occupy it for multiple days.

The preflight scripts are read-only and must not be changed to silently repair
host permissions, systemd user managers, Hyper-V, or power policy.

## Release administration

- Protect tags matching `v*` from deletion or movement.
- Record the source commit, workflow run, artifact digest, signer identity,
  TUF metadata version, and hardware evidence digest for every release.
- Retain the `HOST_PACKAGE_REPRODUCIBLE` line for every claimed platform and
  confirm the accepted Host SHA-256 matches the draft release asset exactly.
- If the final merge changes the accepted commit, rebuild and rerun native
  acceptance; never transfer evidence from a predecessor commit to the tag.
- Keep acceptance, signing, upload, release publication, and update-channel
  activation as separate auditable decisions.

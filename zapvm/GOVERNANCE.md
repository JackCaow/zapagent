# Governance

zapVM is maintained in the open. Maintainers are responsible for review,
release safety, vulnerability response, and protecting the project's signing
and infrastructure boundaries.

## Decisions

- Routine changes are accepted through reviewed pull requests with required CI.
- Protocol, image format, trust root, compatibility, or security-boundary
  changes require a public design issue or ADR before merge.
- A maintainer must not waive a failed security or hardware gate by relabeling
  compilation as runtime acceptance.
- Stable releases require the release checklist in `docs/release.md`.

Until a second active maintainer is appointed, one maintainer may merge after
all automated gates pass. Production signing must still use independent,
auditable key custody rather than a developer workstation key.

## Maintainers

Repository maintainers and path ownership are declared in
`.github/CODEOWNERS`. New maintainers are added after sustained reviewed
contributions, responsible disclosure practices, and approval by existing
maintainers.

## Changes to governance

Governance changes use the same pull-request process and must remain visible in
the repository history.

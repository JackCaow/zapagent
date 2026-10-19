# Open-source readiness

Status on 2026-10-19: **private source candidate; not cleared for publication**.

## New repository boundary

This repository starts from a reviewed export of the CLI, SDK and independent
VM module. It has a new Git history; old branches, tags, release assets, personal
configuration and ignored local files are not imported. Historical private-repo
benchmark manifests, internal research/planning notes and unverified artwork are
excluded. Existing source attribution remains intact. The original repository
retains the complete development record.

The CLI/SDK license remains ISC; `zapvm/` retains Apache-2.0 and its notices.
A declared license is not evidence of ownership of every imported fragment.
See [source provenance review](source-provenance-review.md) for unresolved items.

## Before changing visibility

- [ ] Resolve the current-code provenance items and record permission evidence or
  independently reviewed replacements. Removing history or attribution comments
  does not establish redistribution rights.
- [ ] Review the final staged snapshot and run a redacted secret scan. A clean
  scanner result does not prove absence of private information.
- [ ] Obtain passing hosted CI for the actual candidate. The original repository's
  latest workflows did not start because of the account's Actions budget.
- [ ] Enable and verify private vulnerability reporting, secret scanning and push
  protection where available, and configure branch protection after visibility
  and account capabilities permit it. The original repository's reporting API
  returned 404; branch protection returned a plan-related 403.
- [ ] Approve public visibility separately from creation of this private candidate.

## Before binary, image or npm publication

Source availability does not imply a release exists. Start with source installs;
README and installer metadata now target this repository. Do not copy old signed
assets, credentials or trust roots into it.

- [ ] Resolve or explicitly accept the remaining dependency findings: the actual
  npm consumer reports four moderate entries from the `sprintf-js` advisory
  through Mammoth/argparse; the optional VM Web client reports three low entries
  from KaTeX through Mermaid/Streamdown. Neither audit reports high/critical
  findings. Do not treat the configured severity threshold as risk acceptance.
- [ ] Repeat dependency audits and inventory the actual bundled license texts.
- [ ] Review VM image SPDX records and corresponding-source obligations using
  `zapvm/THIRD_PARTY_NOTICES.md` and `zapvm/docs/release.md`.
- [ ] Configure repository-specific signing and publishing credentials, review
  workflow permissions, and keep candidates draft until acceptance completes.
- [ ] Verify clean-machine installation and actual advertised platform behavior.
- [ ] Publish only the reviewed candidate with explicit release authorization.

Local checks and their exact outcomes are recorded in
[the preparation report](validation/2026-10-19-open-source-preparation.md).

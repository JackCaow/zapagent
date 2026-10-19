# Third-party notices

zapVM source code is licensed under Apache-2.0. A release also contains or
downloads separately licensed third-party components, including:

- the Linux kernel;
- Alpine Linux and selected Alpine packages;
- Cloud Hypervisor;
- virtiofsd;
- Go modules listed in `go.mod` and `go.sum`.

Every released guest image must include its generated SPDX 2.3 SBOM. The SBOM
is the authoritative per-image inventory; this document is not a replacement
for the license texts, copyright notices, or source-distribution obligations of
those components.

Release maintainers must complete the license gate in `docs/release.md` before
publishing an image. In particular, distributing a Linux kernel binary requires
making the corresponding source and build configuration available under the
kernel's license. A release must not be published when its SBOM contains an
unknown license or when a required license text/source offer is missing.

# Cloud Agent release package

Build the four supported Cloud Agent archives from one reviewed commit:

```bash
./scripts/build-cloud-release.sh 0.2.0-beta.2 /absolute/new/output-directory
```

The output directory must not already exist. Each archive contains:

- `zapvm-control`, `zapvm-control-db`, `zapvm-node`, and `zapvm-web`;
- strict example Control, Node, managed-identity Node, Railway, and Web BFF configuration;
- Control/Node/Web service templates for the target platform where available;
- deployment, Node operation, Web identity, and macOS Web-to-VM acceptance documentation;
- `BUILD-INFO` with the exact source commit, target OS, and architecture.

Linux and Windows are cross-compiled with `CGO_ENABLED=0`; the Darwin archive
must be built natively on Apple Silicon because Virtualization.framework uses
cgo. Every binary uses `-trimpath`, and every long-running service embeds the
release version. Release only the archives listed in
`SHA256SUMS`. Before publishing, extract every archive into a new directory,
run each service's `--version` where supported, and compare `BUILD-INFO` with
the release tag target. A package build does not replace the real macOS VM
acceptance or Railway deployment verification.

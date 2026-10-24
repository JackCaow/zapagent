# Releases

The CLI/SDK are MIT licensed. The separate `zapvm/` module keeps its Apache-2.0
license and its own signed image release requirements.

## CI and release channels

- Pull requests and `main`: typecheck, tests, dependency/secret scans, native
  sandbox acceptance, npm consumer checks, and the existing VM checks.
- `vX.Y.Z` or `vX.Y.Z-rc.N`: validate the version and `main` ancestry, run tests,
  build native CLI binaries, smoke-test each binary, verify the npm candidate,
  then publish one GitHub Release after every required job succeeds.
- Manually run **CLI Release** on `main` to rehearse verification and packaging.
  This uploads Actions artifacts and does not publish a release from a branch.
- **Publish npm release** is a separate manual workflow. It downloads the exact
  checksum-verified tarball from an already published GitHub Release.
- `vm-vX.Y.Z`: the existing **Signed VM Release** flow builds draft VM/runtime
  candidates. It still requires `ZAPVM_IMAGE_SIGNING_PRIVATE_KEY` and its signed
  annotated tag verification. CLI release tags do not require VM credentials.

CLI assets support Linux x64/arm64, macOS x64/arm64, and Windows x64. Each binary
has a `.sha256` sidecar; `SHA256SUMS` covers all binaries and the npm tarball.
License and third-party notices are attached to the Release.
The existing `install.sh` consumes these names. CLI releases use the local OS
sandbox and do not bundle a Guest VM image. macOS binaries are ad-hoc signed;
they are not Developer ID signed or notarized.

## Publish a version

1. Bump `package.json` in a PR. `src/version.ts` reads it directly. Use a new
   semver version; existing published releases and npm versions are not replaced.
2. Merge the PR after CI passes. From the clean, updated `main`, create and push
   an annotated tag matching the version:

   ```sh
   git pull --ff-only origin main
   git tag -a vX.Y.Z -m 'Release vX.Y.Z'
   git push origin vX.Y.Z
   ```

3. Watch **CLI Release**. Release publication requires all native builds and the
   npm candidate check to pass. A prerelease tag creates a prerelease and does
   not replace the stable latest release.
4. Download and install the release on a clean machine. No tag or release is
   created merely by merging the workflow configuration.

The standard GitHub `GITHUB_TOKEN` is sufficient for GitHub Release uploads;
only the final publication job has `contents: write`. No PAT is required.
Ensure GitHub Actions is enabled and the account has runner budget. Protect
release tags with a repository ruleset restricting creation/deletion to release
maintainers. CI configuration alone does not create repository rulesets.

## Optional npm publication

Before the first npm publication, verify ownership/availability of the
`zapagent` npm package. Create the GitHub environment named `npm`, configure its
required reviewers if desired, and add an npm publish token as its `NPM_TOKEN`
secret. Scope the token to this package and the necessary publish permission.
Never put a token in source or workflow YAML.

Run **Publish npm release** on `main` and enter the already published GitHub
Release tag. Stable versions publish to `latest`, prereleases to `next`.
The source workspace remains `private: true`; `pack:npm` prepares the public
manifest, bundled UI dependencies, and license inventory in the tarball.
CLI consumers need Node.js 22+; the npm launcher downloads the exact-version native binary and verifies its SHA-256. No separate Bun install is needed for the CLI. The source SDK still requires Bun.

Postinstall prefetches the binary. If install scripts are disabled or GitHub is temporarily unavailable, the launcher retries on first use. Verified binaries are cached per user, version and platform; cached launches work offline. CI tests the current native candidate through a local release fixture before the public tag exists. `ZAPAGENT_CACHE_DIR` overrides the cache root. `ZAPAGENT_DOWNLOAD_BASE_URL` overrides the release download root for trusted HTTPS mirrors (loopback HTTP is supported for tests).

If a release build fails, fix the issue and publish a new version rather than
moving an existing public release tag. A failed verification/build never starts
the publication job. A network failure during the final upload may leave a
release requiring maintainer inspection; do not silently overwrite its assets.

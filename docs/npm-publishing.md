# Publishing zapagent

The public package is `zapagent`; its executable is `zap`. Bun >=1.3 is the
runtime, including when npm installs the package. This is the CLI/SDK source
package. It does not distribute the independent VM or signed release images.

The source workspace is private to prevent publishing its development manifest.
Do not publish the checkout or a raw `bun pm pack`/`npm pack` result. Build a
separate candidate:

```sh
bun install --frozen-lockfile
bun run typecheck:npm
bun run pack:npm --destination /absolute/new-candidate-directory
bun run verify:npm /absolute/new-candidate-directory/zapagent-1.14.6.tgz
```

The packer snapshots the source allowlist in a temporary directory. It bundles
the installed patched Ink, its two Ink peer consumers, React and their dependency
closure, with their licenses, so the components share one renderer and React
dispatcher. It checks that the complete tracked
patch can be reversed before producing a candidate. An unpatched/stale install
fails; it never patches a user's installed dependencies. The public manifest
has one `zap` bin, exact bundled versions, and no development patch field or
lifecycle scripts. The checkout manifest is never rewritten. Existing candidate
files are not overwritten; choose a new destination when rebuilding.

`bundled-dependencies.json` records the actual bundled packages and license-file
hashes. Missing/empty notices reject the candidate. The upstream Yoga Layout
3.2.1 npm package omits its root license, so the packer adds the original notice
from the matching official tag; its provenance is retained under `third_party/`.
Bundling uses npm's [bundleDependencies contract](https://docs.npmjs.com/cli/configuring-npm/package-json/#bundledependencies),
while the development [Bun patch configuration](https://bun.com/docs/pm/cli/patch)
stays in the private workspace.

The verifier runs npm and Bun independently, both locally and with isolated
global prefixes and a disposable home. Inherited npm configuration is cleared;
Bun's global package and bin directories are explicitly confined to the case.
POSIX npm version-manager shims run through their own interpreter.
Dependency scripts are disabled. It compares installed Ink
bytes with the artifact, checks shared Ink/React resolution, renders the bundled
components, imports the SDK and its subpaths, and starts the real command.
The npm local consumer's actual dependency tree is also audited: missing audit
evidence or high/critical findings fail verification. Lower-severity findings
remain in the raw report and result; passing that threshold is not a risk waiver.
Logs and a result JSON stay in the reported temporary directory; successful install
trees and download caches are reclaimed. Failed cases remain for diagnosis.
On Windows the verifier checks the installed entry through Bun and records
`binShimVerified=false`; that is not a claim of Windows `.cmd` shim acceptance.
The `npm package` workflow runs the same checks across Linux, macOS and Windows;
adding the workflow is not evidence that those hosted checks have passed.

Regular package tests are offline and check candidate contents/startup plus
rejection of an unpatched install. They do not replace the real consumer test.

Before publication, complete [source-publication gates](open-source-readiness.md),
review the candidate contents/hash and actual consumer dependency audit, obtain
green hosted CI, and establish a valid npm publisher session. A local moderate
advisory risk acceptance does not imply an audit passed. Ownership, registry
authentication, npm version/tag, source visibility, and binary/image publication
remain separate decisions. Do not send tokens through chat or commit them.

After those gates and explicit publication authorization, publish the exact
reviewed tarball, using the approved tag (the command below uses `latest`):

```sh
npm publish /absolute/reviewed/zapagent-1.14.6.tgz --registry=https://registry.npmjs.org --access public --tag latest
```

Verify the registry's tarball integrity and dist-tag afterwards. Source visibility
changes are separate; publishing npm source already exposes the candidate files.

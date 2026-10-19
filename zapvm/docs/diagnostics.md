# Diagnostics and incident reports

## First checks

```bash
zapvm version
zapvm doctor
zapvm daemon status
```

Create a default-redacted diagnostic snapshot when image or state information
is relevant:

```bash
zapvm diagnose \
  --output /absolute/path/zapvm-diagnostic.json \
  --state-disk /absolute/path/state.raw \
  --manifest /absolute/path/manifest.json
```

The default snapshot must not include environment variables, workspace content,
credential values, raw Host paths, or stable machine/user identifiers. Review a
snapshot before attaching it to a public issue.

## Failure classes

| Class | Meaning | Consumer behavior |
|---|---|---|
| capability | Host or image lacks a required feature | Stop; do not retry on Host |
| policy | Workspace, network, credential, or resource request was denied | Change the explicit policy or stop |
| image | Signature, architecture, hash, capability, or TUF validation failed | Quarantine the artifact; do not boot |
| protocol | Peer authentication, schema, framing, or version failed | Terminate the channel and VM |
| lifecycle | VMM/agent health, pause/resume, stop, or cleanup became ambiguous | Mark worker degraded and destroy/recover fail closed |
| resource | Timeout, quota, memory, process, disk, or output limit reached | Return a terminal command result; inspect pressure |
| host | Hypervisor, system service, entitlement, ACL, or device prerequisite failed | Run doctor and repair Host prerequisites explicitly |

The Host release CLIs return the stable `ZAPVM_ERROR[code]` and exit-status
contract documented in [Stable CLI error contract](./error-taxonomy.md). Agent
adapters should still use structured daemon/stdio events instead of parsing
stderr prose.

The default diagnostic snapshot has a negative leakage test that places the
same canary in an environment variable, a workspace file, and an input path;
the serialized snapshot must retain useful redacted error structure without
containing the canary, variable name, workspace name, path, or file name.

## VM pool degraded

Do not repeatedly retry arbitrary commands against a degraded pool. Capture the
daemon status and diagnostics, stop the affected route or daemon cleanly, and
verify that no worker/VMM/mount remains before restarting. A consumer must never
fall back to direct Host execution merely because the pool is unavailable.

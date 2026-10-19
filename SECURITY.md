# Security policy

## Supported versions

Security fixes target the latest release and `main`. Older snapshots are not
maintained. This is an actively developed coding agent, not a hardened service
for executing arbitrary hostile workloads.

## Reporting

Do not post exploit details, credentials, or private repository contents in a
public issue. Once the repository is public and private vulnerability reporting
is enabled, use:

https://github.com/JackCaow/zapagent/security/advisories/new

If that channel is unavailable, contact the repository owner privately before
disclosing details. Do not assume the channel is enabled merely because this
file exists. Include version/commit, platform, execution backend, permission
mode, reproduction steps, impact, and redacted diagnostics.

## Execution and data boundaries

- Local execution is the default. Shell sandbox enforcement is platform-specific;
  check the execution diagnostics rather than assuming a VM is active.
- VM execution is opt-in. It isolates guest commands, not the entire host Agent
  process. See [the VM threat model](zapvm/docs/threat-model.md).
- Explicitly approved unsandboxed execution runs with the user's host privileges.
  Permission to call a tool is not proof that its OS sandbox is enforced.
- Provider APIs receive prompts and selected repository/tool content. MCP servers
  and delegated agent CLIs introduce additional trust boundaries and can have
  their own permissions and credential access.
- Provider credentials and session data live in the configured data directory.
  Config file permissions are restricted, but credentials are not encrypted by
  this application. Protect backups and diagnostic exports accordingly.
- Model output, downloaded content, and repository instructions are untrusted.
  Review approvals and diffs; checkpoints are not a substitute for backups or Git.

For testing, use a disposable workspace and `ZAPCODE_DATA_DIR`, with no production
credentials. Never treat bypass mode, a successful smoke run, or a VM build as
proof of containment. Release signing keys and notarization credentials must
remain outside Git and outside untrusted pull-request jobs.

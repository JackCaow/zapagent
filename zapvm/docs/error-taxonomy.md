# Stable CLI error contract

The Host release binaries print machine-readable failures as:

```text
ZAPVM_ERROR[invalid_image]: manifest signature verification failed
```

Only the bracketed code and process exit status are compatibility surface.
Human text is operator context and may change; automation must not parse it.
Daemon, stdio, Node, and HTTP consumers continue to use their structured
protocol errors instead of scraping CLI stderr.

| Code | Exit | Meaning | Default action |
|---|---:|---|---|
| `invalid_request` | 64 | Invalid command, flag, or argument | Fix invocation |
| `invalid_image` | 65 | Image, signature, TUF, architecture, or capability data is invalid | Quarantine candidate |
| `unavailable` | 69 | Required daemon, VM backend, service, network dependency, or timeout is unavailable | Retry only after health recovers |
| `internal` | 70 | zapVM invariant or unexpected software failure | Stop and collect diagnostics |
| `invalid_state` | 74 | Managed state cannot be read, migrated, flushed, or committed safely | Recover state; do not discard automatically |
| `resource_exhausted` | 75 | Disk/quota exhaustion or another explicitly temporary resource boundary | Free capacity, then retry safely |
| `permission_denied` | 77 | OS permissions, entitlement, ACL, or policy denied the operation | Repair authorization |
| `invalid_configuration` | 78 | Host, Node, signing, packaging, or service configuration is invalid | Fix configuration |
| `execution_failed` | 1 | The requested Agent/guest execution failed after admission | Inspect the structured command result |

Standard operating-system causes override a command's fallback class:
`EACCES`/`EPERM` become `permission_denied`, `ENOSPC`/`EDQUOT` become
`resource_exhausted`, and deadline/`EBUSY` failures become `unavailable`.
All unrecognized future codes fail closed as `internal`/70.

The contract applies to the user/operator-facing binaries shipped in a Host
archive: `zapvm`, `zapvm-image`, `zapvm-node`, and `zapvm-sbom`. `--help`
returns success. Guest helper exit statuses are private implementation details;
the immutable-rootfs package-manager shim retains its separately documented
exit 78 and `ZAPVM_ERROR[IMMUTABLE_ROOTFS]` contract.

## Compatibility

Within a stable major release, an existing code will not be reused with a new
meaning and its exit status will not change. New codes may be added. A caller
must treat an unknown code as a non-retryable internal failure unless a newer
versioned contract explicitly says otherwise.

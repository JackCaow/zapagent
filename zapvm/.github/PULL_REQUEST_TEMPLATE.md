## Summary

## Trust boundary and failure mode

## Validation

- [ ] `gofmt` checked
- [ ] `go test ./...`
- [ ] `go test -race ./...`
- [ ] `go vet ./...`
- [ ] Platform-specific evidence attached or explicitly marked not applicable
- [ ] Documentation/changelog updated when behavior or compatibility changed

## Security and release checklist

- [ ] No secrets, private images, customer data, or unredacted diagnostics
- [ ] No new host path, network, credential, socket, or update bypass
- [ ] Cross-compilation is not presented as real-platform acceptance
- [ ] Rollback/migration behavior is documented for persistent state changes

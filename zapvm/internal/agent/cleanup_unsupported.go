//go:build !linux

package agent

func CleanupStaleIsolation() error { return nil }

//go:build !windows

package computer

func protectStoreRoot(string) error { return nil }

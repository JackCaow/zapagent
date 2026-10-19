//go:build windows && !acceptance_fault_injection

package platform

const windowsServiceFaultInjectionEnabled = false

func windowsServiceFaultPoint(_ string, _ int) error { return nil }

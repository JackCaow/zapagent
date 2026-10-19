//go:build windows

package localipc

import "testing"

func TestValidatePipeName(t *testing.T) {
	for _, valid := range []string{`\\.\pipe\zapvm-user`, `\\.\pipe\ZapVM-123`} {
		if err := validatePipeName(valid); err != nil {
			t.Fatalf("valid pipe %q: %v", valid, err)
		}
	}
	for _, invalid := range []string{"", `\\.\pipe\other`, `zapvm-user`} {
		if err := validatePipeName(invalid); err == nil {
			t.Fatalf("invalid pipe %q was accepted", invalid)
		}
	}
}

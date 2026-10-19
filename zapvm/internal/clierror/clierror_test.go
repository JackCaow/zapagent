package clierror

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"syscall"
	"testing"
)

func TestClassifyStableStandardFailures(t *testing.T) {
	for name, test := range map[string]struct {
		err      error
		fallback Code
		want     Classification
	}{
		"permission": {fmt.Errorf("open: %w", syscall.EACCES), Internal, ForCode(PermissionDenied)},
		"disk-full":  {fmt.Errorf("write: %w", syscall.ENOSPC), InvalidState, ForCode(ResourceExhausted)},
		"timeout":    {context.DeadlineExceeded, ExecutionFailed, ForCode(Unavailable)},
		"fallback":   {errors.New("bad manifest"), InvalidImage, ForCode(InvalidImage)},
	} {
		t.Run(name, func(t *testing.T) {
			if got := Classify(test.err, test.fallback); got != test.want {
				t.Fatalf("Classify()=%+v, want %+v", got, test.want)
			}
		})
	}
}

func TestUnknownCodeFailsClosedAsInternal(t *testing.T) {
	if got := ForCode(Code("future")); got != (Classification{Code: Internal, ExitCode: ExitInternal}) {
		t.Fatalf("unknown code classification=%+v", got)
	}
}

func TestReportStableEnvelope(t *testing.T) {
	var output bytes.Buffer
	if exitCode := Report(&output, errors.New("bad config"), InvalidConfiguration); exitCode != ExitInvalidConfiguration {
		t.Fatalf("exit code=%d", exitCode)
	}
	if output.String() != "ZAPVM_ERROR[invalid_configuration]: bad config\n" {
		t.Fatalf("output=%q", output.String())
	}
}

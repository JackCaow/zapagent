// Package clierror defines the stable, machine-readable error contract used by
// zapVM command-line entry points. Human error text may improve between
// releases; Code and ExitCode are compatibility surface.
package clierror

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"syscall"
)

type Code string

const (
	InvalidRequest       Code = "invalid_request"
	InvalidConfiguration Code = "invalid_configuration"
	InvalidImage         Code = "invalid_image"
	InvalidState         Code = "invalid_state"
	PermissionDenied     Code = "permission_denied"
	ResourceExhausted    Code = "resource_exhausted"
	Unavailable          Code = "unavailable"
	ExecutionFailed      Code = "execution_failed"
	Internal             Code = "internal"
)

// Stable exit codes follow sysexits where a matching meaning exists. They are
// duplicated here instead of importing a platform-specific header.
const (
	ExitExecutionFailed      = 1
	ExitInvalidRequest       = 64 // EX_USAGE
	ExitInvalidData          = 65 // EX_DATAERR
	ExitUnavailable          = 69 // EX_UNAVAILABLE
	ExitInternal             = 70 // EX_SOFTWARE
	ExitIO                   = 74 // EX_IOERR
	ExitTemporary            = 75 // EX_TEMPFAIL
	ExitPermissionDenied     = 77 // EX_NOPERM
	ExitInvalidConfiguration = 78 // EX_CONFIG
)

type Classification struct {
	Code     Code
	ExitCode int
}

type codedError interface {
	CLIErrorCode() Code
}

// Classify keeps standard operating-system failures consistent and uses the
// caller's command-level fallback for domain errors that have not yet been
// given a more specific typed code.
func Classify(err error, fallback Code) Classification {
	if err == nil {
		return Classification{}
	}
	var coded codedError
	if errors.As(err, &coded) {
		return ForCode(coded.CLIErrorCode())
	}
	if errors.Is(err, fs.ErrPermission) || errors.Is(err, syscall.EACCES) || errors.Is(err, syscall.EPERM) {
		return ForCode(PermissionDenied)
	}
	if errors.Is(err, syscall.ENOSPC) || errors.Is(err, syscall.EDQUOT) {
		return ForCode(ResourceExhausted)
	}
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, syscall.EBUSY) {
		return ForCode(Unavailable)
	}
	return ForCode(fallback)
}

func ForCode(code Code) Classification {
	switch code {
	case InvalidRequest:
		return Classification{Code: code, ExitCode: ExitInvalidRequest}
	case InvalidConfiguration:
		return Classification{Code: code, ExitCode: ExitInvalidConfiguration}
	case InvalidImage:
		return Classification{Code: code, ExitCode: ExitInvalidData}
	case InvalidState:
		return Classification{Code: code, ExitCode: ExitIO}
	case PermissionDenied:
		return Classification{Code: code, ExitCode: ExitPermissionDenied}
	case ResourceExhausted:
		return Classification{Code: code, ExitCode: ExitTemporary}
	case Unavailable:
		return Classification{Code: code, ExitCode: ExitUnavailable}
	case ExecutionFailed:
		return Classification{Code: code, ExitCode: ExitExecutionFailed}
	case Internal:
		return Classification{Code: code, ExitCode: ExitInternal}
	default:
		return Classification{Code: Internal, ExitCode: ExitInternal}
	}
}

// Report writes the stable prefix consumed by scripts and returns the exit
// status the caller must use. The wrapped message is intended for operators;
// secrets must already have been redacted at their owning boundary.
func Report(output io.Writer, err error, fallback Code) int {
	classification := Classify(err, fallback)
	fmt.Fprintf(output, "ZAPVM_ERROR[%s]: %v\n", classification.Code, err)
	return classification.ExitCode
}

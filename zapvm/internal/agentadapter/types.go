// Package agentadapter defines the Host-side contract between external Agent
// protocols and zapVM execution. Protocol-specific packages translate into
// this contract; executors do not depend on any Agent vendor schema.
package agentadapter

import (
	"context"
	"io"
	"time"
)

type NetworkMode string

const (
	NetworkOff          NetworkMode = "off"
	NetworkRestricted   NetworkMode = "restricted"
	NetworkUnrestricted NetworkMode = "unrestricted"
)

type Diagnostic struct {
	Level   string         `json:"level"`
	Code    string         `json:"code"`
	Message string         `json:"message"`
	Details map[string]any `json:"details,omitempty"`
}

// Request is the normalized execution authority produced by one external
// Agent protocol. SourceCommand and SourceCWD are retained only so the codec
// can answer in the caller's schema; Command and CWD are the Guest values.
type Request struct {
	Protocol                string
	RequestID               string
	SessionID               string
	SourceCommand           []string
	SourceCWD               string
	Workspace               string
	WorkspaceReadOnly       bool
	Network                 NetworkMode
	AllowedDomains          []string
	AllowedPorts            []uint16
	DeniedWorkspacePatterns []string
	Command                 []string
	CWD                     string
	Timeout                 time.Duration
	StdoutLimit             int64
	StderrLimit             int64
	Diagnostics             []Diagnostic
}

type Result struct {
	Stdout      string
	Stderr      string
	ExitCode    *int
	Signal      string
	TimedOut    bool
	WallTime    time.Duration
	Backend     string
	Diagnostics []Diagnostic
}

// Protocol owns one external Agent wire contract. Match must only inspect the
// bounded input. Decode must reject unknown or unsupported authority rather
// than silently weakening it.
type Protocol interface {
	Name() string
	Match([]byte) bool
	Decode([]byte) (Request, error)
	EncodeResult(io.Writer, Request, Result) error
}

type Executor interface {
	Execute(context.Context, Request) Result
}

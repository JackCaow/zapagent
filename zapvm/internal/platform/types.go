package platform

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"path/filepath"
	"runtime"
	"strings"
	"unicode/utf8"
)

const MiB = 1024 * 1024

type CheckStatus string

const (
	CheckPass CheckStatus = "pass"
	CheckWarn CheckStatus = "warn"
	CheckFail CheckStatus = "fail"
)

type Check struct {
	Name   string      `json:"name"`
	Status CheckStatus `json:"status"`
	Detail string      `json:"detail"`
}

type DoctorReport struct {
	Backend string  `json:"backend"`
	OS      string  `json:"os"`
	Arch    string  `json:"arch"`
	Checks  []Check `json:"checks"`
}

func (r DoctorReport) Ready() bool {
	for _, check := range r.Checks {
		if check.Status == CheckFail {
			return false
		}
	}
	return true
}

type NetworkMode string

const (
	NetworkOff          NetworkMode = "off"
	NetworkRestricted   NetworkMode = "restricted"
	NetworkUnrestricted NetworkMode = "unrestricted"
)

type Spec struct {
	ID                string
	CPUCount          uint
	MemoryBytes       uint64
	KernelPath        string
	InitrdPath        string
	RootDiskPath      string
	VMMPath           string
	VirtioFSDPath     string
	VMMVersion        string
	VirtioFSDVersion  string
	StateDiskPath     string
	AgentDiskPath     string
	BootSharePath     string
	WorkspacePath     string
	WorkspaceReadOnly bool
	KernelCmdline     string
	Network           NetworkMode
	Console           bool
}

func (s *Spec) SetDefaults() {
	if s.CPUCount == 0 {
		s.CPUCount = 2
	}
	if s.MemoryBytes == 0 {
		s.MemoryBytes = 2 * 1024 * MiB
	}
	if s.Network == "" {
		s.Network = NetworkOff
	}
}

func (s Spec) Validate() error {
	if s.ID == "" {
		return errors.New("VM ID is required")
	}
	if len(s.ID) > 256 || !utf8.ValidString(s.ID) || strings.IndexByte(s.ID, 0) >= 0 {
		return errors.New("VM ID must contain 1-256 valid UTF-8 non-NUL bytes")
	}
	if s.CPUCount == 0 {
		return errors.New("CPU count must be greater than zero")
	}
	if s.CPUCount > 256 {
		return errors.New("CPU count must not exceed 256")
	}
	if s.MemoryBytes < 256*MiB || s.MemoryBytes%MiB != 0 {
		return errors.New("memory must be at least 256 MiB and aligned to 1 MiB")
	}
	if s.MemoryBytes > 1024*1024*MiB {
		return errors.New("memory must not exceed 1 TiB")
	}
	for name, path := range map[string]string{
		"kernel":    s.KernelPath,
		"root disk": s.RootDiskPath,
	} {
		if path == "" {
			return fmt.Errorf("%s path is required", name)
		}
		if !filepath.IsAbs(path) {
			return fmt.Errorf("%s path must be absolute", name)
		}
		if len(path) > 32767 || strings.IndexByte(path, 0) >= 0 {
			return fmt.Errorf("%s path exceeds the platform-safe length or contains NUL", name)
		}
	}
	if s.InitrdPath != "" && !filepath.IsAbs(s.InitrdPath) {
		return errors.New("initrd path must be absolute")
	}
	if s.VMMPath != "" && !filepath.IsAbs(s.VMMPath) {
		return errors.New("VMM path must be absolute")
	}
	if s.VirtioFSDPath != "" && !filepath.IsAbs(s.VirtioFSDPath) {
		return errors.New("virtiofsd path must be absolute")
	}
	for name, version := range map[string]string{"VMM": s.VMMVersion, "virtiofsd": s.VirtioFSDVersion} {
		if len(version) > 64 || !utf8.ValidString(version) || strings.ContainsAny(version, "\x00\r\n\t ") {
			return fmt.Errorf("%s version exceeds 64 bytes or contains whitespace/NUL", name)
		}
	}
	if s.StateDiskPath != "" && !filepath.IsAbs(s.StateDiskPath) {
		return errors.New("state disk path must be absolute")
	}
	if s.AgentDiskPath != "" && !filepath.IsAbs(s.AgentDiskPath) {
		return errors.New("Agent disk path must be absolute")
	}
	if s.BootSharePath != "" && !filepath.IsAbs(s.BootSharePath) {
		return errors.New("boot share path must be absolute")
	}
	if s.WorkspacePath != "" && !filepath.IsAbs(s.WorkspacePath) {
		return errors.New("workspace path must be absolute")
	}
	for name, path := range map[string]string{
		"initrd": s.InitrdPath, "VMM": s.VMMPath, "virtiofsd": s.VirtioFSDPath, "state disk": s.StateDiskPath, "Agent disk": s.AgentDiskPath,
		"boot share": s.BootSharePath, "workspace": s.WorkspacePath,
	} {
		if len(path) > 32767 || strings.IndexByte(path, 0) >= 0 {
			return fmt.Errorf("%s path exceeds the platform-safe length or contains NUL", name)
		}
	}
	if len(s.KernelCmdline) > 32768 || strings.ContainsAny(s.KernelCmdline, "\x00\r\n") {
		return errors.New("kernel command line exceeds 32768 bytes or contains NUL/newline")
	}
	switch s.Network {
	case NetworkOff, NetworkRestricted, NetworkUnrestricted:
	default:
		return fmt.Errorf("invalid network mode %q", s.Network)
	}
	return nil
}

type State string

const (
	StateStopped  State = "stopped"
	StateStarting State = "starting"
	StateRunning  State = "running"
	StatePausing  State = "pausing"
	StatePaused   State = "paused"
	StateResuming State = "resuming"
	StateStopping State = "stopping"
	StateFailed   State = "failed"
)

type Instance interface {
	ID() string
	State() State
	Wait(context.Context) error
	Pause(context.Context) error
	Resume(context.Context) error
	Stop(context.Context) error
}

type AgentDialer interface {
	DialAgent(context.Context, uint32) (io.ReadWriteCloser, error)
}

type HostListener interface {
	ListenHost(uint32) (net.Listener, error)
}

type Backend interface {
	Name() string
	Doctor(context.Context) DoctorReport
	Start(context.Context, Spec, io.Writer) (Instance, error)
}

func Current() Backend {
	return newBackend()
}

func baseReport(name string) DoctorReport {
	return DoctorReport{Backend: name, OS: runtime.GOOS, Arch: runtime.GOARCH}
}

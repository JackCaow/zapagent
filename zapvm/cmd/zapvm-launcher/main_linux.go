//go:build linux

// zapvm-launcher is the minimal PID 1 for an isolated agent command. The
// parent creates the namespaces and cgroup; this process prepares mounts while
// privileged, permanently drops identity, and execs the structured argv.
package main

import (
	"errors"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"

	"zapvm/internal/credential"
	"zapvm/internal/workspacepolicy"
)

const (
	prSetNoNewPrivs     = 38
	prSetDumpable       = 4
	privateTmpSize      = 256 * 1024 * 1024
	privateHomeSize     = 256 * 1024 * 1024
	credentialMountPath = "/run/zapvm-credentials"
)

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "zapvm-launcher:", err)
		os.Exit(127)
	}
}

func run(args []string) error {
	flags := flag.NewFlagSet("zapvm-launcher", flag.ContinueOnError)
	uidFlag := flags.Uint64("uid", 0, "workload uid")
	gidFlag := flags.Uint64("gid", 0, "workload gid")
	homeSource := flags.String("home-source", "", "optional persistent Session HOME source")
	nixSource := flags.String("nix-source", "", "optional persistent Computer Nix root")
	credentialSource := flags.String("credential-source", "", "optional request credential source")
	workspaceRoot := flags.String("workspace-root", "/workspace", "authorized workspace root")
	var protectedWorkspacePaths []string
	var deniedWorkspacePatterns []string
	flags.Func("protect-workspace-path", "workspace-relative path to bind read-only; repeatable", func(value string) error {
		protectedWorkspacePaths = append(protectedWorkspacePaths, value)
		return nil
	})
	flags.Func("deny-workspace-pattern", "workspace-relative path pattern to mask; repeatable", func(value string) error {
		deniedWorkspacePatterns = append(deniedWorkspacePatterns, value)
		return nil
	})
	if err := flags.Parse(args); err != nil {
		return err
	}
	argv := flags.Args()
	if *uidFlag == 0 || *gidFlag == 0 || *uidFlag > uint64(^uint32(0)) || *gidFlag > uint64(^uint32(0)) {
		return errors.New("uid and gid must be non-root uint32 values")
	}
	if len(argv) == 0 {
		return errors.New("command argv is required")
	}
	uid, gid := uint32(*uidFlag), uint32(*gidFlag)
	if err := prepareMounts(uid, gid, *homeSource, *nixSource, *credentialSource, *workspaceRoot, protectedWorkspacePaths, deniedWorkspacePatterns); err != nil {
		return err
	}
	if err := dropPrivileges(uid, gid); err != nil {
		return err
	}
	path := argv[0]
	if path[0] != '/' {
		resolved, err := exec.LookPath(path)
		if err != nil {
			return err
		}
		path = resolved
	}
	return syscall.Exec(path, argv, os.Environ())
}

func prepareMounts(uid, gid uint32, homeSource, nixSource, credentialSource, workspaceRoot string, protectedWorkspacePaths, deniedWorkspacePatterns []string) error {
	if err := syscall.Mount("", "/", "", syscall.MS_REC|syscall.MS_PRIVATE, ""); err != nil {
		return fmt.Errorf("make mounts private: %w", err)
	}
	if nixSource != "" {
		if err := mountComputerNix(uid, gid, nixSource); err != nil {
			return err
		}
	}
	if err := syscall.Unmount("/proc", syscall.MNT_DETACH); err != nil {
		return fmt.Errorf("detach inherited procfs: %w", err)
	}
	if err := syscall.Mount("proc", "/proc", "proc", syscall.MS_NOSUID|syscall.MS_NODEV|syscall.MS_NOEXEC, "hidepid=2"); err != nil {
		return fmt.Errorf("mount private procfs: %w", err)
	}
	if err := mountPrivateTmpfs("/tmp", 0o1777, uid, gid, privateTmpSize); err != nil {
		return err
	}
	if homeSource == "" {
		if err := mountPrivateTmpfs("/home/zapvm", 0o700, uid, gid, privateHomeSize); err != nil {
			return err
		}
	} else {
		if !filepath.IsAbs(homeSource) {
			return errors.New("Session HOME source must be absolute")
		}
		info, err := os.Lstat(homeSource)
		if err != nil || info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
			return errors.New("Session HOME source must be a real directory")
		}
		if err := syscall.Mount(homeSource, "/home/zapvm", "", syscall.MS_BIND, ""); err != nil {
			return fmt.Errorf("bind persistent Session HOME: %w", err)
		}
		if err := syscall.Mount("", "/home/zapvm", "", syscall.MS_BIND|syscall.MS_REMOUNT|syscall.MS_NOSUID|syscall.MS_NODEV, ""); err != nil {
			return fmt.Errorf("protect persistent Session HOME: %w", err)
		}
	}
	if credentialSource != "" {
		if err := mountCredentials(uid, gid, credentialSource); err != nil {
			return err
		}
	}
	if err := protectWorkspacePaths(workspaceRoot, protectedWorkspacePaths); err != nil {
		return err
	}
	if err := denyWorkspacePaths(workspaceRoot, deniedWorkspacePatterns); err != nil {
		return err
	}
	return nil
}

func mountComputerNix(uid, gid uint32, source string) error {
	if !filepath.IsAbs(source) || filepath.Base(source) != "nix" || filepath.Base(filepath.Dir(source)) != "computer" {
		return errors.New("Computer Nix source is outside the state layout")
	}
	info, err := os.Lstat(source)
	if err != nil || info.Mode()&os.ModeSymlink != 0 || !info.IsDir() || info.Mode().Perm()&0o077 != 0 {
		return errors.New("Computer Nix source must be a private real directory")
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || stat.Uid != uid || stat.Gid != gid {
		return errors.New("Computer Nix source ownership does not match workload identity")
	}
	targetInfo, err := os.Lstat("/nix")
	if err != nil || targetInfo.Mode()&os.ModeSymlink != 0 || !targetInfo.IsDir() {
		return errors.New("signed /nix mountpoint is unavailable")
	}
	if err := syscall.Mount(source, "/nix", "", syscall.MS_BIND|syscall.MS_REC, ""); err != nil {
		return fmt.Errorf("bind persistent Computer Nix root: %w", err)
	}
	flags := uintptr(syscall.MS_BIND | syscall.MS_REMOUNT | syscall.MS_NOSUID | syscall.MS_NODEV)
	if err := syscall.Mount("", "/nix", "", flags, ""); err != nil {
		return fmt.Errorf("make persistent Computer Nix root executable: %w", err)
	}
	return nil
}

func protectWorkspacePaths(workspaceRoot string, relativePaths []string) error {
	paths, err := workspacepolicy.ResolveProtectedPaths(workspaceRoot, relativePaths)
	if err != nil {
		return err
	}
	for index, target := range paths {
		info, err := os.Lstat(target)
		if err != nil {
			return err
		}
		bindFlags := uintptr(syscall.MS_BIND)
		if info.IsDir() {
			bindFlags |= syscall.MS_REC
		}
		if err := syscall.Mount(target, target, "", bindFlags, ""); err != nil {
			return fmt.Errorf("bind protected workspace path %q: %w", relativePaths[index], err)
		}
		remountFlags := uintptr(syscall.MS_BIND | syscall.MS_REMOUNT | syscall.MS_RDONLY | syscall.MS_NOSUID | syscall.MS_NODEV | syscall.MS_NOEXEC)
		if err := syscall.Mount("", target, "", remountFlags, ""); err != nil {
			return fmt.Errorf("make protected workspace path %q read-only: %w", relativePaths[index], err)
		}
	}
	return nil
}

func denyWorkspacePaths(workspaceRoot string, patterns []string) error {
	paths, err := workspacepolicy.ResolveDeniedPaths(workspaceRoot, patterns)
	if err != nil {
		return err
	}
	if len(paths) == 0 {
		return nil
	}
	deniedFile, err := os.CreateTemp("/tmp", ".zapvm-denied-")
	if err != nil {
		return fmt.Errorf("create denied file mount source: %w", err)
	}
	deniedFilePath := deniedFile.Name()
	if err := deniedFile.Close(); err != nil {
		return err
	}
	defer os.Remove(deniedFilePath)
	if err := os.Chmod(deniedFilePath, 0); err != nil {
		return fmt.Errorf("protect denied file mount source: %w", err)
	}
	for _, target := range paths {
		info, err := os.Lstat(target)
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("denied workspace path %q must not be a symlink", target)
		}
		if info.IsDir() {
			if err := syscall.Mount("tmpfs", target, "tmpfs", syscall.MS_NOSUID|syscall.MS_NODEV|syscall.MS_NOEXEC, "mode=000,size=4096"); err != nil {
				return fmt.Errorf("mask denied workspace directory %q: %w", target, err)
			}
			continue
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("denied workspace path %q is not a regular file or directory", target)
		}
		if err := syscall.Mount(deniedFilePath, target, "", syscall.MS_BIND, ""); err != nil {
			return fmt.Errorf("mask denied workspace file %q: %w", target, err)
		}
		flags := uintptr(syscall.MS_BIND | syscall.MS_REMOUNT | syscall.MS_RDONLY | syscall.MS_NOSUID | syscall.MS_NODEV | syscall.MS_NOEXEC)
		if err := syscall.Mount("", target, "", flags, ""); err != nil {
			return fmt.Errorf("protect denied workspace file %q: %w", target, err)
		}
	}
	return nil
}

func mountCredentials(uid, gid uint32, source string) error {
	if !filepath.IsAbs(source) || !strings.HasPrefix(source, "/run/zapvm/credentials/request-") || filepath.Dir(source) != "/run/zapvm/credentials" {
		return errors.New("credential source is outside the Agent credential root")
	}
	info, err := os.Lstat(source)
	if err != nil || info.Mode()&os.ModeSymlink != 0 || !info.IsDir() || info.Mode().Perm() != 0o555 {
		return errors.New("credential source must be a real mode-0555 directory")
	}
	sourceStat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || sourceStat.Uid != 0 || sourceStat.Gid != 0 {
		return errors.New("credential source directory must be owned by root")
	}
	entries, err := os.ReadDir(source)
	if err != nil || len(entries) == 0 || len(entries) > 16 {
		return errors.New("credential source contains an invalid number of entries")
	}
	var totalSize int64
	for _, entry := range entries {
		entryInfo, err := entry.Info()
		if err != nil || !credential.ValidID(entry.Name()) || !entryInfo.Mode().IsRegular() || entryInfo.Mode()&os.ModeSymlink != 0 || entryInfo.Mode().Perm() != 0o400 || entryInfo.Size() <= 0 || entryInfo.Size() > credential.MaxValueSize {
			return errors.New("credential source contains an invalid file")
		}
		stat, ok := entryInfo.Sys().(*syscall.Stat_t)
		if !ok || stat.Uid != uid || stat.Gid != gid {
			return errors.New("credential file ownership does not match workload identity")
		}
		totalSize += entryInfo.Size()
		if totalSize > credential.MaxTotalSize {
			return errors.New("credential source exceeds total size limit")
		}
	}
	if err := os.MkdirAll(credentialMountPath, 0o755); err != nil {
		return fmt.Errorf("create credential mountpoint: %w", err)
	}
	mountInfo, err := os.Lstat(credentialMountPath)
	if err != nil || !mountInfo.IsDir() || mountInfo.Mode()&os.ModeSymlink != 0 {
		return errors.New("credential mountpoint must be a real directory")
	}
	if err := syscall.Mount(source, credentialMountPath, "", syscall.MS_BIND, ""); err != nil {
		return fmt.Errorf("bind request credentials: %w", err)
	}
	if err := syscall.Mount("", credentialMountPath, "", syscall.MS_BIND|syscall.MS_REMOUNT|syscall.MS_RDONLY|syscall.MS_NOSUID|syscall.MS_NODEV|syscall.MS_NOEXEC, ""); err != nil {
		return fmt.Errorf("protect request credentials: %w", err)
	}
	return nil
}

func mountPrivateTmpfs(target string, mode uint32, uid, gid uint32, size int) error {
	data := "mode=" + strconv.FormatUint(uint64(mode), 8) +
		",uid=" + strconv.FormatUint(uint64(uid), 10) +
		",gid=" + strconv.FormatUint(uint64(gid), 10) +
		",size=" + strconv.Itoa(size)
	if err := syscall.Mount("tmpfs", target, "tmpfs", syscall.MS_NOSUID|syscall.MS_NODEV, data); err != nil {
		return fmt.Errorf("mount private tmpfs at %s: %w", target, err)
	}
	return nil
}

func dropPrivileges(uid, gid uint32) error {
	if _, _, errno := syscall.RawSyscall(syscall.SYS_PRCTL, prSetNoNewPrivs, 1, 0); errno != 0 {
		return fmt.Errorf("set no_new_privs: %w", errno)
	}
	if err := syscall.Setgroups([]int{}); err != nil {
		return fmt.Errorf("clear supplementary groups: %w", err)
	}
	if err := syscall.Setresgid(int(gid), int(gid), int(gid)); err != nil {
		return fmt.Errorf("drop gid: %w", err)
	}
	if err := syscall.Setresuid(int(uid), int(uid), int(uid)); err != nil {
		return fmt.Errorf("drop uid: %w", err)
	}
	if _, _, errno := syscall.RawSyscall(syscall.SYS_PRCTL, prSetDumpable, 0, 0); errno != 0 {
		return fmt.Errorf("disable dumpability: %w", errno)
	}
	syscall.Umask(0o077)
	return nil
}

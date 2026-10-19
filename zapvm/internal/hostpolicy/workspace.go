package hostpolicy

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

func ValidateWorkspace(path string) (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("resolve Host home directory: %w", err)
	}
	return validateWorkspace(path, home, runtime.GOOS)
}

func validateWorkspace(path, home, goos string) (string, error) {
	if path == "" || !filepath.IsAbs(path) {
		return "", errors.New("workspace path must be absolute")
	}
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		return "", fmt.Errorf("resolve workspace path: %w", err)
	}
	info, err := os.Stat(resolved)
	if err != nil {
		return "", err
	}
	if !info.IsDir() {
		return "", errors.New("workspace path must be a directory")
	}
	resolvedHome, err := filepath.EvalSymlinks(home)
	if err != nil {
		return "", fmt.Errorf("resolve Host home directory: %w", err)
	}
	home = resolvedHome
	if isVolumeRoot(resolved, goos) {
		return "", errors.New("refusing to share a filesystem root as workspace")
	}
	if samePath(resolved, home, goos == "windows") {
		return "", errors.New("refusing to share the entire Host home directory as workspace")
	}
	for _, denied := range sensitivePaths(home, goos) {
		if denied == "" {
			continue
		}
		if pathWithin(resolved, denied, goos == "windows") {
			return "", fmt.Errorf("workspace resolves inside a protected Host path: %s", denied)
		}
	}
	return resolved, nil
}

func samePath(left, right string, caseInsensitive bool) bool {
	left = filepath.Clean(left)
	right = filepath.Clean(right)
	if caseInsensitive {
		return strings.EqualFold(left, right)
	}
	return left == right
}

func sensitivePaths(home, goos string) []string {
	userSecrets := []string{
		filepath.Join(home, ".ssh"),
		filepath.Join(home, ".aws"),
		filepath.Join(home, ".azure"),
		filepath.Join(home, ".gnupg"),
		filepath.Join(home, ".kube"),
		filepath.Join(home, ".docker"),
	}
	switch goos {
	case "darwin":
		return append(userSecrets,
			"/System",
			"/Library",
			"/private/etc",
			"/private/var/db",
			filepath.Join(home, "Library", "Keychains"),
			filepath.Join(home, "Library", "Cookies"),
		)
	case "linux":
		return append(userSecrets,
			"/boot", "/dev", "/etc", "/proc", "/root", "/sys",
			filepath.Join(home, ".local", "share", "keyrings"),
		)
	case "windows":
		windowsDirectory := os.Getenv("WINDIR")
		programData := os.Getenv("ProgramData")
		return append(userSecrets,
			windowsDirectory,
			programData,
			filepath.Join(home, "AppData", "Roaming", "Microsoft", "Credentials"),
			filepath.Join(home, "AppData", "Roaming", "Microsoft", "Protect"),
			filepath.Join(home, "AppData", "Local", "Microsoft", "Credentials"),
		)
	default:
		return userSecrets
	}
}

func isVolumeRoot(path, goos string) bool {
	cleaned := filepath.Clean(path)
	root := string(filepath.Separator)
	if volume := filepath.VolumeName(cleaned); volume != "" {
		root = volume + string(filepath.Separator)
	}
	if goos == "windows" {
		return strings.EqualFold(cleaned, root)
	}
	return cleaned == root
}

func pathWithin(path, parent string, caseInsensitive bool) bool {
	path = filepath.Clean(path)
	parent = filepath.Clean(parent)
	if caseInsensitive {
		path = strings.ToLower(path)
		parent = strings.ToLower(parent)
	}
	if path == parent {
		return true
	}
	relative, err := filepath.Rel(parent, path)
	return err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator))
}

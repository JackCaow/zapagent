package workspacefs

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	MaxEntries = 1000
	MaxContent = 512 << 10
)

type Entry struct {
	Path       string `json:"path"`
	Name       string `json:"name"`
	Type       string `json:"type"`
	Size       int64  `json:"size,omitempty"`
	ModifiedAt string `json:"modified_at"`
}

type Listing struct {
	Path      string  `json:"path"`
	Entries   []Entry `json:"entries"`
	Truncated bool    `json:"truncated,omitempty"`
}

type File struct {
	Path        string `json:"path"`
	Size        int64  `json:"size"`
	SHA256      string `json:"sha256"`
	ContentType string `json:"content_type"`
	Data        []byte `json:"data"`
}

type Diff struct {
	Path   string `json:"path"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
	Data   []byte `json:"data"`
}

type Explorer struct{ root string }

func New(root string) (*Explorer, error) {
	if root == "" || !filepath.IsAbs(root) || len(root) > 32767 || strings.IndexByte(root, 0) >= 0 {
		return nil, errors.New("workspace root must be a bounded absolute path")
	}
	resolved, err := filepath.EvalSymlinks(root)
	if err != nil {
		return nil, errors.New("resolve workspace root")
	}
	info, err := os.Stat(resolved)
	if err != nil || !info.IsDir() {
		return nil, errors.New("workspace root must be a directory")
	}
	return &Explorer{root: filepath.Clean(resolved)}, nil
}

// OpenRegular pins and opens one portable relative regular file without
// following symlinks or Windows reparse points. The caller owns the handle.
func (explorer *Explorer) OpenRegular(relative string) (*os.File, error) {
	_, segments, err := validateRelative(relative, false)
	if err != nil {
		return nil, err
	}
	opened, err := openPinned(explorer.root, segments, false)
	if err != nil {
		return nil, errors.New("workspace file is unavailable")
	}
	return opened, nil
}

func (explorer *Explorer) List(relative string) (Listing, error) {
	clean, segments, err := validateRelative(relative, true)
	if err != nil {
		return Listing{}, err
	}
	directory, err := openPinned(explorer.root, segments, true)
	if err != nil {
		return Listing{}, errors.New("workspace directory is unavailable")
	}
	defer directory.Close()
	infos, err := directory.Readdir(MaxEntries + 1)
	if err != nil && !errors.Is(err, io.EOF) {
		return Listing{}, errors.New("read workspace directory")
	}
	truncated := len(infos) > MaxEntries
	if truncated {
		infos = infos[:MaxEntries]
	}
	entries := make([]Entry, 0, len(infos))
	for _, info := range infos {
		if clean == "" && protectedName(info.Name()) {
			continue
		}
		entryType := "other"
		switch {
		case info.Mode()&os.ModeSymlink != 0:
			entryType = "symlink"
		case info.IsDir():
			entryType = "directory"
		case info.Mode().IsRegular():
			entryType = "file"
		}
		entryPath := info.Name()
		if clean != "" {
			entryPath = path.Join(clean, info.Name())
		}
		entry := Entry{Path: entryPath, Name: info.Name(), Type: entryType, ModifiedAt: info.ModTime().UTC().Format(time.RFC3339Nano)}
		if entryType == "file" {
			entry.Size = info.Size()
		}
		entries = append(entries, entry)
	}
	sort.Slice(entries, func(left, right int) bool {
		if entries[left].Type == "directory" && entries[right].Type != "directory" {
			return true
		}
		if entries[left].Type != "directory" && entries[right].Type == "directory" {
			return false
		}
		return entries[left].Name < entries[right].Name
	})
	return Listing{Path: clean, Entries: entries, Truncated: truncated}, nil
}

func (explorer *Explorer) Read(relative string) (File, error) {
	clean, segments, err := validateRelative(relative, false)
	if err != nil {
		return File{}, err
	}
	opened, err := openPinned(explorer.root, segments, false)
	if err != nil {
		return File{}, errors.New("workspace file is unavailable")
	}
	defer opened.Close()
	before, err := opened.Stat()
	if err != nil || !before.Mode().IsRegular() || before.Size() > MaxContent {
		return File{}, errors.New("workspace file must be a regular file within the size limit")
	}
	data, err := io.ReadAll(io.LimitReader(opened, MaxContent+1))
	if err != nil || len(data) > MaxContent {
		return File{}, errors.New("read workspace file")
	}
	after, err := opened.Stat()
	if err != nil || !os.SameFile(before, after) || before.Size() != after.Size() || !before.ModTime().Equal(after.ModTime()) || int64(len(data)) != after.Size() {
		return File{}, errors.New("workspace file changed while reading")
	}
	digest := sha256.Sum256(data)
	contentType := http.DetectContentType(data)
	if utf8.Valid(data) && !bytes.ContainsRune(data, 0) {
		contentType = "text/plain; charset=utf-8"
	}
	return File{Path: clean, Size: int64(len(data)), SHA256: hex.EncodeToString(digest[:]), ContentType: contentType, Data: data}, nil
}

// WriteText replaces or creates one bounded UTF-8 text file below the
// workspace without following symlinks or protected metadata paths.
func (explorer *Explorer) WriteText(relative string, data []byte) error {
	_, segments, err := validateRelative(relative, false)
	if err != nil {
		return err
	}
	if len(data) > MaxContent || !utf8.Valid(data) || bytes.ContainsRune(data, 0) {
		return errors.New("workspace text exceeds the size limit or is not valid UTF-8")
	}
	if err := writePinned(explorer.root, segments, data); err != nil {
		return errors.New("write workspace file")
	}
	return nil
}

func (explorer *Explorer) GitDiff(ctx context.Context, relative string) (Diff, error) {
	if ctx == nil {
		return Diff{}, errors.New("workspace diff context is required")
	}
	clean, segments, err := validateRelative(relative, true)
	if err != nil {
		return Diff{}, err
	}
	if clean != "" {
		opened, err := openPinned(explorer.root, segments, false)
		if err != nil {
			opened, err = openPinned(explorer.root, segments, true)
		}
		if err != nil {
			return Diff{}, errors.New("workspace diff path is unavailable")
		}
		_ = opened.Close()
	}
	timeoutContext, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	arguments := []string{"-c", "core.hooksPath=" + os.DevNull, "diff", "--no-ext-diff", "--no-textconv", "--no-color", "--src-prefix=a/", "--dst-prefix=b/", "--"}
	if clean != "" {
		arguments = append(arguments, filepath.FromSlash(clean))
	}
	command := exec.CommandContext(timeoutContext, "git", arguments...)
	command.Dir = explorer.root
	command.Env = append(os.Environ(), "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL="+os.DevNull, "GIT_TERMINAL_PROMPT=0")
	stdout, err := command.StdoutPipe()
	if err != nil {
		return Diff{}, errors.New("prepare workspace diff")
	}
	command.Stderr = io.Discard
	if err := command.Start(); err != nil {
		return Diff{}, errors.New("start workspace diff")
	}
	data, readErr := io.ReadAll(io.LimitReader(stdout, MaxContent+1))
	if len(data) > MaxContent {
		_ = command.Process.Kill()
	}
	waitErr := command.Wait()
	if timeoutContext.Err() != nil {
		return Diff{}, errors.New("workspace diff timed out")
	}
	if readErr != nil || len(data) > MaxContent {
		return Diff{}, errors.New("workspace diff exceeds the size limit")
	}
	if waitErr != nil {
		return Diff{}, errors.New("workspace is not an available Git worktree")
	}
	digest := sha256.Sum256(data)
	return Diff{Path: clean, Size: int64(len(data)), SHA256: hex.EncodeToString(digest[:]), Data: data}, nil
}

func validateRelative(value string, allowRoot bool) (string, []string, error) {
	if len(value) > 4096 || !utf8.ValidString(value) || strings.IndexByte(value, 0) >= 0 || strings.Contains(value, "\\") || strings.HasPrefix(value, "/") {
		return "", nil, errors.New("workspace path must be a portable relative path")
	}
	if value == "" {
		if allowRoot {
			return "", nil, nil
		}
		return "", nil, errors.New("workspace file path is required")
	}
	clean := path.Clean(value)
	if clean == "." || clean != value || clean == ".." || strings.HasPrefix(clean, "../") {
		return "", nil, errors.New("workspace path is not canonical")
	}
	segments := strings.Split(clean, "/")
	for _, segment := range segments {
		if segment == "" || segment == "." || segment == ".." || protectedName(segment) {
			return "", nil, errors.New("workspace path is protected")
		}
	}
	return clean, segments, nil
}

// ValidatePath applies the same portable, protected-metadata-aware path policy
// used by Explorer without touching the filesystem.
func ValidatePath(value string, allowRoot bool) error {
	_, _, err := validateRelative(value, allowRoot)
	return err
}

func protectedName(value string) bool {
	return strings.EqualFold(value, ".git") || strings.EqualFold(value, ".zapcode")
}

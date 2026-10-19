package workspacefs

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"sort"
)

type SnapshotFile struct {
	Path        string
	ContentType string
	Size        uint64
	SHA256      string
}

// Snapshot copies a bounded directory tree into an empty trusted destination.
// Every source component is opened through the platform pinned-open primitive;
// links, reparse points, special files, mutations, and protected paths fail the
// entire snapshot.
func (explorer *Explorer) Snapshot(relative, destination string, maxFiles int, maxFileSize, maxTotalSize uint64) ([]SnapshotFile, error) {
	_, rootSegments, err := validateRelative(relative, false)
	if err != nil || maxFiles < 1 || maxFileSize == 0 || maxTotalSize < maxFileSize {
		return nil, errors.New("workspace snapshot request is invalid")
	}
	if !filepath.IsAbs(destination) {
		return nil, errors.New("workspace snapshot destination must be absolute")
	}
	info, err := os.Lstat(destination)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return nil, errors.New("workspace snapshot destination must be a real directory")
	}
	entries, err := os.ReadDir(destination)
	if err != nil || len(entries) != 0 {
		return nil, errors.New("workspace snapshot destination must be empty")
	}
	files := make([]SnapshotFile, 0)
	var total uint64
	visited := 0
	maxEntries := maxFiles * 10
	var walk func([]string, string) error
	walk = func(segments []string, logicalDirectory string) error {
		directory, err := openPinned(explorer.root, segments, true)
		if err != nil {
			return errors.New("workspace snapshot directory is unavailable")
		}
		defer directory.Close()
		remainingEntries := maxEntries - visited
		children, readErr := directory.ReadDir(remainingEntries + 1)
		if readErr != nil && !errors.Is(readErr, io.EOF) {
			return errors.New("read workspace snapshot directory")
		}
		if len(children) > remainingEntries {
			return errors.New("workspace snapshot exceeds entry limit")
		}
		sort.Slice(children, func(left, right int) bool { return children[left].Name() < children[right].Name() })
		for _, child := range children {
			visited++
			logical := child.Name()
			if logicalDirectory != "" {
				logical = path.Join(logicalDirectory, child.Name())
			}
			if err := ValidatePath(logical, false); err != nil {
				return errors.New("workspace snapshot contains a protected path")
			}
			childSegments := append(append([]string(nil), segments...), child.Name())
			mode := child.Type()
			if mode&os.ModeSymlink != 0 {
				return errors.New("workspace snapshot contains a link or unavailable object")
			}
			switch {
			case child.IsDir():
				directoryPath := filepath.Join(destination, filepath.FromSlash(logical))
				if err := os.Mkdir(directoryPath, 0o700); err != nil {
					return errors.New("create workspace snapshot directory")
				}
				if err := walk(childSegments, logical); err != nil {
					return err
				}
			case mode.IsRegular():
				if len(files) >= maxFiles {
					return errors.New("workspace snapshot exceeds file limit")
				}
				opened, err := openPinned(explorer.root, childSegments, false)
				if err != nil {
					return errors.New("workspace snapshot file is unavailable")
				}
				snapshot, snapshotErr := snapshotFile(opened, destination, logical, maxFileSize, maxTotalSize-total)
				_ = opened.Close()
				if snapshotErr != nil {
					return snapshotErr
				}
				total += snapshot.Size
				files = append(files, snapshot)
			default:
				return errors.New("workspace snapshot contains a special file")
			}
		}
		return nil
	}
	if err := walk(rootSegments, ""); err != nil {
		return nil, err
	}
	return files, nil
}

func snapshotFile(source *os.File, destination, logical string, maxFileSize, remainingTotal uint64) (SnapshotFile, error) {
	before, err := source.Stat()
	if err != nil || !before.Mode().IsRegular() || before.Size() <= 0 || uint64(before.Size()) > maxFileSize || uint64(before.Size()) > remainingTotal {
		return SnapshotFile{}, errors.New("workspace snapshot file exceeds size limit")
	}
	outputPath := filepath.Join(destination, filepath.FromSlash(logical))
	output, err := os.OpenFile(outputPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return SnapshotFile{}, errors.New("create workspace snapshot file")
	}
	committed := false
	defer func() {
		_ = output.Close()
		if !committed {
			_ = os.Remove(outputPath)
		}
	}()
	header := make([]byte, 512)
	headerSize, readErr := io.ReadFull(source, header)
	if readErr != nil && !errors.Is(readErr, io.EOF) && !errors.Is(readErr, io.ErrUnexpectedEOF) {
		return SnapshotFile{}, errors.New("read workspace snapshot header")
	}
	hasher := sha256.New()
	writer := io.MultiWriter(output, hasher)
	if _, err := writer.Write(header[:headerSize]); err != nil {
		return SnapshotFile{}, errors.New("write workspace snapshot file")
	}
	remaining := before.Size() - int64(headerSize)
	copied, err := io.Copy(writer, io.LimitReader(source, remaining+1))
	written := int64(headerSize) + copied
	if err != nil || written != before.Size() {
		return SnapshotFile{}, errors.New("workspace snapshot file changed while reading")
	}
	after, err := source.Stat()
	if err != nil || !os.SameFile(before, after) || before.Size() != after.Size() || !before.ModTime().Equal(after.ModTime()) {
		return SnapshotFile{}, errors.New("workspace snapshot file changed while reading")
	}
	if err := output.Sync(); err != nil || output.Close() != nil {
		return SnapshotFile{}, errors.New("persist workspace snapshot file")
	}
	committed = true
	return SnapshotFile{
		Path: logical, ContentType: http.DetectContentType(header[:headerSize]), Size: uint64(written), SHA256: hex.EncodeToString(hasher.Sum(nil)),
	}, nil
}

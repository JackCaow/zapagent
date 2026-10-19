package hostpolicy

import (
	"path/filepath"
	"strings"
	"testing"
)

func FuzzPathWithin(f *testing.F) {
	f.Add("/tmp/project/file", "/tmp/project", false)
	f.Add("/tmp/project-copy", "/tmp/project", false)
	f.Add("/TMP/PROJECT/file", "/tmp/project", true)
	f.Add("../project", "/tmp/project", false)

	f.Fuzz(func(t *testing.T, path, parent string, caseInsensitive bool) {
		if strings.IndexByte(path, 0) >= 0 || strings.IndexByte(parent, 0) >= 0 {
			return
		}
		got := pathWithin(path, parent, caseInsensitive)
		cleanPath := filepath.Clean(path)
		cleanParent := filepath.Clean(parent)
		if caseInsensitive {
			cleanPath = strings.ToLower(cleanPath)
			cleanParent = strings.ToLower(cleanParent)
		}
		relative, err := filepath.Rel(cleanParent, cleanPath)
		want := err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator))
		if got != want {
			t.Fatalf("pathWithin(%q, %q, %v) = %v, want %v (relative %q, err %v)", path, parent, caseInsensitive, got, want, relative, err)
		}
	})
}

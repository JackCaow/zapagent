//go:build windows

package platform

import (
	"bytes"
	"testing"
)

func TestHCSConsoleLogIsCappedWithoutBlockingGuestOutput(t *testing.T) {
	var output bytes.Buffer
	writer := &cappedConsoleWriter{writer: &output, remaining: 4}
	for _, data := range [][]byte{[]byte("abcdef"), []byte("ghi")} {
		written, err := writer.Write(data)
		if err != nil {
			t.Fatal(err)
		}
		if written != len(data) {
			t.Fatalf("reported write length %d, want %d", written, len(data))
		}
	}
	if got := output.String(); got != "abcd" {
		t.Fatalf("captured output %q, want %q", got, "abcd")
	}
}

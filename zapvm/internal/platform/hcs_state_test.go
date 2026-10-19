package platform

import (
	"strings"
	"testing"
)

func TestParseHCSStopped(t *testing.T) {
	for _, document := range []string{
		`{"State":"Running","RuntimeId":"ignored"}`,
		`{"State":"Created"}`,
		`{"State":"Pausing"}`,
		`{"State":"Paused"}`,
		`{"State":"Resuming"}`,
		`{"State":"Stopping"}`,
	} {
		stopped, err := parseHCSStopped(document)
		if err != nil || stopped {
			t.Fatalf("active document %s = %v, %v", document, stopped, err)
		}
	}
	for _, document := range []string{`{"State":"Stopped"}`, `{"State":"Running","Stopped":true}`} {
		stopped, err := parseHCSStopped(document)
		if err != nil || !stopped {
			t.Fatalf("stopped document %s = %v, %v", document, stopped, err)
		}
	}
}

func TestParseHCSStoppedRejectsMalformedUnknownAndOversized(t *testing.T) {
	for _, document := range []string{`{`, `{}`, `{"State":"Surprise"}`, strings.Repeat("x", (1<<20)+1)} {
		if _, err := parseHCSStopped(document); err == nil {
			t.Fatalf("invalid HCS properties were accepted: %.32q", document)
		}
	}
}

func FuzzParseHCSStopped(f *testing.F) {
	for _, seed := range []string{`{"State":"Running"}`, `{"State":"Stopped"}`, `{}`, `{`, ""} {
		f.Add(seed)
	}
	f.Fuzz(func(t *testing.T, document string) {
		_, _ = parseHCSStopped(document)
	})
}

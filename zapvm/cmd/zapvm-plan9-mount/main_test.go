package main

import (
	"strings"
	"testing"
)

func TestPlan9MountDataUsesConnectedFDAndAccessName(t *testing.T) {
	got := plan9MountData(17, "zapvm_workspace")
	for _, expected := range []string{"trans=fd", "rfdno=17", "wfdno=17", "msize=65536", "version=9p2000.L", "cache=none", "aname=zapvm_workspace"} {
		if !strings.Contains(got, expected) {
			t.Fatalf("mount data %q missing %q", got, expected)
		}
	}
}

func TestPlan9ShareNameRejectsMountOptionInjection(t *testing.T) {
	for _, value := range []string{"zapvm_boot", "share-1", "share.name"} {
		if !validShareName(value) {
			t.Fatalf("valid share %q was rejected", value)
		}
	}
	for _, value := range []string{"", "share,ro", "../share", "share name", strings.Repeat("a", 129)} {
		if validShareName(value) {
			t.Fatalf("invalid share %q was accepted", value)
		}
	}
}

func TestExecutableShareMustRemainWritable(t *testing.T) {
	if err := run([]string{"--target", "/workspace", "--share", "zapvm_workspace", "--readonly", "--executable"}); err == nil {
		t.Fatal("read-only executable share was accepted")
	}
}

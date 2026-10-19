package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestReadIdentity(t *testing.T) {
	path := filepath.Join(t.TempDir(), "identity.json")
	if err := os.WriteFile(path, []byte(`{"uid":501,"gid":20}`), 0o600); err != nil {
		t.Fatal(err)
	}
	uid, gid, faultInjection, err := readIdentity(path)
	if err != nil {
		t.Fatal(err)
	}
	if uid != 501 || gid != 20 {
		t.Fatalf("identity = %d:%d, want 501:20", uid, gid)
	}
	if faultInjection {
		t.Fatal("fault injection unexpectedly enabled")
	}
}

func TestReadIdentityRejectsRoot(t *testing.T) {
	path := filepath.Join(t.TempDir(), "identity.json")
	if err := os.WriteFile(path, []byte(`{"uid":0,"gid":20}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := readIdentity(path); err == nil {
		t.Fatal("expected root identity to be rejected")
	}
}

func TestReadIdentityRejectsReservedProxyIdentity(t *testing.T) {
	for _, data := range []string{`{"uid":998,"gid":20}`, `{"uid":501,"gid":998}`} {
		path := filepath.Join(t.TempDir(), "identity.json")
		if err := os.WriteFile(path, []byte(data), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, _, _, err := readIdentity(path); err == nil {
			t.Fatalf("reserved identity %s was accepted", data)
		}
	}
}

func TestReadIdentityFaultInjectionGate(t *testing.T) {
	path := filepath.Join(t.TempDir(), "identity.json")
	if err := os.WriteFile(path, []byte(`{"uid":501,"gid":20,"fault_injection":true}`), 0o600); err != nil {
		t.Fatal(err)
	}
	_, _, faultInjection, err := readIdentity(path)
	if err != nil {
		t.Fatal(err)
	}
	if !faultInjection {
		t.Fatal("fault injection gate was not read")
	}
}

func TestPrepareStateRoot(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "schema-version"), []byte("3\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(root, ".schema-migrations"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, ".schema-migrations", "2"), []byte("2\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, ".schema-migrations", "3"), []byte("3\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	schema, err := prepareStateRoot(root, uint32(os.Geteuid()), uint32(os.Getegid()))
	if err != nil {
		t.Fatal(err)
	}
	if schema != 3 {
		t.Fatalf("state schema = %d, want 3", schema)
	}
	info, err := os.Stat(filepath.Join(root, "data"))
	if err != nil {
		t.Fatal(err)
	}
	if !info.IsDir() || info.Mode().Perm() != 0o750 {
		t.Fatalf("state data mode = %v", info.Mode())
	}
	for _, name := range []string{"nix"} {
		info, err := os.Stat(filepath.Join(root, "computer", name))
		if err != nil || !info.IsDir() || info.Mode().Perm() != 0o700 {
			t.Fatalf("Computer %s directory = %v, %v", name, info, err)
		}
	}
}

func TestPrepareStateRootRejectsUnknownSchema(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "schema-version"), []byte("4\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := prepareStateRoot(root, uint32(os.Geteuid()), uint32(os.Getegid())); err == nil {
		t.Fatal("expected unknown state schema to be rejected")
	}
}

func TestPrepareStateRootRejectsMissingMigrationMarker(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "schema-version"), []byte("3\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := prepareStateRoot(root, uint32(os.Geteuid()), uint32(os.Getegid())); err == nil {
		t.Fatal("expected missing schema migration marker to be rejected")
	}
}

func TestParseVSockConnectCID(t *testing.T) {
	for _, test := range []struct {
		cmdline string
		want    uint32
		wantErr bool
	}{
		{cmdline: "root=/dev/vda", want: 0},
		{cmdline: "root=/dev/sda zapvm.agent_connect_cid=2", want: 2},
		{cmdline: "zapvm.agent_connect_cid=0", wantErr: true},
		{cmdline: "zapvm.agent_connect_cid=host", wantErr: true},
	} {
		got, err := parseVSockConnectCID(test.cmdline)
		if (err != nil) != test.wantErr || got != test.want {
			t.Fatalf("parseVSockConnectCID(%q) = %d, %v; want %d, error=%t", test.cmdline, got, err, test.want, test.wantErr)
		}
	}
}

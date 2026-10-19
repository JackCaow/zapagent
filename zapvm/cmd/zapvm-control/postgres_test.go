package main

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"zapvm/internal/cloudplane"
)

func TestOpenPostgreSQLPrimaryIntegration(t *testing.T) {
	dsn := os.Getenv("ZAPVM_TEST_POSTGRES_DSN")
	if dsn == "" {
		t.Skip("ZAPVM_TEST_POSTGRES_DSN is not configured")
	}
	path := filepath.Join(t.TempDir(), "postgres-dsn")
	if err := os.WriteFile(path, []byte(dsn), 0o600); err != nil {
		t.Fatal(err)
	}
	database, primary, err := openPostgreSQLPrimary(cloudplane.PostgreSQLPrimaryConfig{
		DSNFile: path, OperationTimeoutSeconds: 5, DevelopmentInsecureLocalhost: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, err := database.Apply(ctx); err != nil {
		t.Fatal(err)
	}
	if _, _, err := primary.Load(ctx); err != nil {
		t.Fatal(err)
	}
}

func TestOpenPostgreSQLMirrorRequiresOwnerOnlyDSNAndRedactsFailure(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "postgres-dsn")
	secret := "private-postgres-password-must-not-leak"
	dsn := "postgres://zapvm:" + secret + "@127.0.0.1:1/zapvm?sslmode=disable"
	if err := os.WriteFile(path, []byte(dsn+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	config := cloudplane.PostgreSQLMirrorConfig{
		DSNFile: path, RetryIntervalSeconds: 1, FlushTimeoutSeconds: 5, DevelopmentInsecureLocalhost: true,
	}
	if runtime.GOOS != "windows" {
		if err := os.Chmod(path, 0o644); err != nil {
			t.Fatal(err)
		}
		if database, mirror, err := openPostgreSQLMirror(config); err == nil || database != nil || mirror != nil {
			t.Fatalf("broad PostgreSQL DSN file accepted: database=%v mirror=%v err=%v", database, mirror, err)
		}
		if err := os.Chmod(path, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	database, mirror, err := openPostgreSQLMirror(config)
	if err == nil || database != nil || mirror != nil {
		t.Fatalf("unreachable PostgreSQL accepted: database=%v mirror=%v err=%v", database, mirror, err)
	}
	if strings.Contains(err.Error(), secret) || strings.Contains(err.Error(), "zapvm:") {
		t.Fatalf("PostgreSQL connection error leaked DSN material: %v", err)
	}
}

func TestOpenPostgreSQLMirrorRejectsEmptyOrNULDSN(t *testing.T) {
	for name, contents := range map[string][]byte{
		"empty": []byte(" \n"),
		"nul":   []byte("postgres://user:secret@localhost/db\x00"),
	} {
		t.Run(name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "postgres-dsn")
			if err := os.WriteFile(path, contents, 0o600); err != nil {
				t.Fatal(err)
			}
			database, mirror, err := openPostgreSQLMirror(cloudplane.PostgreSQLMirrorConfig{
				DSNFile: path, RetryIntervalSeconds: 1, FlushTimeoutSeconds: 5,
			})
			if err == nil || database != nil || mirror != nil || strings.Contains(err.Error(), "secret") {
				t.Fatalf("invalid PostgreSQL DSN result: database=%v mirror=%v err=%v", database, mirror, err)
			}
		})
	}
}

package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/sigstore/sigstore/pkg/signature"
	"github.com/theupdateframework/go-tuf/v2/metadata"
)

func TestUpdateURLPolicy(t *testing.T) {
	for _, value := range []string{
		"https://updates.example.test/metadata",
		"http://127.0.0.1:8080/metadata",
		"http://[::1]:8080/metadata",
	} {
		allowLoopback := strings.HasPrefix(value, "http://")
		if _, err := validateUpdateBaseURL(value, allowLoopback); err != nil {
			t.Fatalf("valid URL %q rejected: %v", value, err)
		}
	}
	for _, value := range []string{
		"http://updates.example.test/metadata",
		"https://user:secret@updates.example.test/metadata",
		"https://updates.example.test/metadata?channel=stable",
		"file:///tmp/metadata",
	} {
		if _, err := validateUpdateBaseURL(value, false); err == nil {
			t.Fatalf("unsafe URL %q accepted", value)
		}
	}
}

func TestUpdateTLSCABundleFailsClosed(t *testing.T) {
	invalid := filepath.Join(t.TempDir(), "invalid-ca.pem")
	if err := os.WriteFile(invalid, []byte("not a certificate\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := newUpdateHTTPClientWithCA(false, invalid); err == nil || !strings.Contains(err.Error(), "no certificates") {
		t.Fatalf("invalid TLS CA bundle was accepted: %v", err)
	}
}

func TestUpdateCustomMetadataStrictAndLedgerRollback(t *testing.T) {
	valid := json.RawMessage(`{"schema_version":1,"release_sequence":7,"image_version":"1.2.3-linux","architecture":"amd64","manifest_sha256":"` + strings.Repeat("a", 64) + `"}`)
	custom, err := decodeUpdateTargetCustom(&valid)
	if err != nil {
		t.Fatal(err)
	}
	if custom.ReleaseSequence != 7 || custom.ImageVersion != "1.2.3-linux" {
		t.Fatalf("unexpected custom metadata: %+v", custom)
	}
	unknown := json.RawMessage(`{"schema_version":1,"release_sequence":7,"image_version":"1.2.3","architecture":"amd64","manifest_sha256":"` + strings.Repeat("a", 64) + `","surprise":true}`)
	if _, err := decodeUpdateTargetCustom(&unknown); err == nil {
		t.Fatal("unknown custom metadata field accepted")
	}
	layered := json.RawMessage(`{"schema_version":2,"release_sequence":8,"image_version":"1.2.4-linux","architecture":"amd64","manifest_sha256":"` + strings.Repeat("b", 64) + `","layers":{"base":"alpine-3.23.5-r1","runtime":"1.2.4","agent":"0.9.4","session":"3"}}`)
	layeredCustom, err := decodeUpdateTargetCustom(&layered)
	if err != nil {
		t.Fatal(err)
	}
	if layeredCustom.Layers == nil || layeredCustom.Layers.Agent != "0.9.4" {
		t.Fatalf("layer version vector was not preserved: %+v", layeredCustom)
	}
	missingLayers := json.RawMessage(`{"schema_version":2,"release_sequence":8,"image_version":"1.2.4-linux","architecture":"amd64","manifest_sha256":"` + strings.Repeat("b", 64) + `"}`)
	if _, err := decodeUpdateTargetCustom(&missingLayers); err == nil || !strings.Contains(err.Error(), "requires a layer version vector") {
		t.Fatalf("schema 2 metadata without layers was not rejected: %v", err)
	}
	independent := json.RawMessage(`{"schema_version":3,"release_sequence":9,"image_version":"1.2.5-linux","architecture":"amd64","manifest_sha256":"` + strings.Repeat("c", 64) + `","layers":{"base":"alpine-3.23.5-r1","runtime":"1.2.5","agent":"0.9.5","session":"3"},"layer_targets":{"base":"layers/amd64/base.layer.tar.zst","runtime":"layers/amd64/runtime.layer.tar.zst","agent":"layers/amd64/agent.layer.tar.zst","session":"layers/amd64/session.layer.tar.zst"}}`)
	independentCustom, err := decodeUpdateTargetCustom(&independent)
	if err != nil || independentCustom.LayerTargets == nil {
		t.Fatalf("independent layer metadata rejected: %+v err=%v", independentCustom, err)
	}
	duplicateTarget := json.RawMessage(`{"schema_version":3,"release_sequence":9,"image_version":"1.2.5-linux","architecture":"amd64","manifest_sha256":"` + strings.Repeat("c", 64) + `","layers":{"base":"alpine-3.23.5-r1","runtime":"1.2.5","agent":"0.9.5","session":"3"},"layer_targets":{"base":"layers/amd64/shared.layer.tar.zst","runtime":"layers/amd64/shared.layer.tar.zst","agent":"layers/amd64/agent.layer.tar.zst","session":"layers/amd64/session.layer.tar.zst"}}`)
	if _, err := decodeUpdateTargetCustom(&duplicateTarget); err == nil {
		t.Fatal("duplicate independent layer target path accepted")
	}

	path := filepath.Join(t.TempDir(), "ledger.json")
	ledger := updateLedger{SchemaVersion: 1, Entries: map[string]updateLedgerEntry{
		"stable/amd64": {
			ReleaseSequence: 9,
			ImageVersion:    "1.2.3-linux",
			ManifestSHA256:  strings.Repeat("a", 64),
			TargetSHA256:    strings.Repeat("b", 64),
			AppliedAt:       time.Now().UTC().Format(time.RFC3339Nano),
		},
	}}
	if err := writeUpdateLedger(path, ledger); err != nil {
		t.Fatal(err)
	}
	loaded, err := readUpdateLedgerOptional(path)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.Entries["stable/amd64"].ReleaseSequence != 9 {
		t.Fatal("ledger release sequence was not preserved")
	}
	if err := os.WriteFile(path, append(mustRead(t, path), []byte("{}")...), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := readUpdateLedgerOptional(path); err == nil {
		t.Fatal("ledger trailing data accepted")
	}
	invalidLayers := `{"schema_version":1,"entries":{"stable/amd64":{"release_sequence":9,"image_version":"1.2.3-linux","manifest_sha256":"` + strings.Repeat("a", 64) + `","target_sha256":"` + strings.Repeat("b", 64) + `","layers":{"base":"","runtime":"1.2.3","agent":"1.2.3","session":"3"},"applied_at":"2026-08-05T00:00:00Z"}}}`
	if err := os.WriteFile(path, []byte(invalidLayers), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := readUpdateLedgerOptional(path); err == nil || !strings.Contains(err.Error(), "layer vector") {
		t.Fatalf("invalid ledger layer vector accepted: %v", err)
	}
}

func TestUpdateLayerVectorMustMatchSchemaThreeManifest(t *testing.T) {
	imageManifest := manifest{
		SchemaVersion: 3,
		Layers: []manifestLayer{
			{Name: "base", Version: "alpine-3.23.5-r1"},
			{Name: "runtime", Version: "1.2.4"},
			{Name: "agent", Version: "0.9.4"},
			{Name: "session", Version: "3"},
		},
	}
	legacy := updateTargetCustom{SchemaVersion: 1}
	if err := verifyUpdateLayerVector(legacy, imageManifest); err == nil || !strings.Contains(err.Error(), "schema 2") {
		t.Fatalf("schema 3 manifest accepted legacy TUF metadata: %v", err)
	}
	want := updateTargetLayers{Base: "alpine-3.23.5-r1", Runtime: "1.2.4", Agent: "0.9.4", Session: "3"}
	current := updateTargetCustom{SchemaVersion: 2, Layers: &want}
	if err := verifyUpdateLayerVector(current, imageManifest); err != nil {
		t.Fatalf("matching layer vector rejected: %v", err)
	}
	wrong := want
	wrong.Agent = "0.9.5"
	if !equalUpdateLayerVectors(&want, &want) || equalUpdateLayerVectors(&want, &wrong) || equalUpdateLayerVectors(&want, nil) {
		t.Fatal("layer vector equality did not preserve nil and exact-version semantics")
	}
	current.Layers = &wrong
	if err := verifyUpdateLayerVector(current, imageManifest); err == nil || !strings.Contains(err.Error(), "does not match") {
		t.Fatalf("mismatched layer vector accepted: %v", err)
	}
	legacyManifest := manifest{SchemaVersion: 2}
	if err := verifyUpdateLayerVector(current, legacyManifest); err == nil || !strings.Contains(err.Error(), "legacy image") {
		t.Fatalf("legacy manifest accepted layer vector: %v", err)
	}
}

func TestDownloadUpdateTargetRejectsTamper(t *testing.T) {
	expected := []byte("signed-target-bytes")
	digest := sha256.Sum256(expected)
	target := &metadata.TargetFiles{
		Path: "channels/stable/arm64.bundle.tar.gz", Length: int64(len(expected)),
		Hashes: metadata.Hashes{"sha256": digest[:]},
	}
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		tampered := append([]byte(nil), expected...)
		tampered[0] ^= 0xff
		_, _ = response.Write(tampered)
	}))
	defer server.Close()
	base, err := validateUpdateBaseURL(server.URL, true)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := downloadUpdateTarget(newUpdateHTTPClient(true), base, target, hex.EncodeToString(digest[:]), t.TempDir()); err == nil || !strings.Contains(err.Error(), "sha256 mismatch") {
		t.Fatalf("tampered target was not rejected: %v", err)
	}
}

func TestDownloadUpdateTargetReusesVerifiedWarmCache(t *testing.T) {
	expected := []byte("verified-warm-cache-target")
	digest := sha256.Sum256(expected)
	target := &metadata.TargetFiles{
		Path: "channels/stable/arm64.bundle.tar.zst", Length: int64(len(expected)),
		Hashes: metadata.Hashes{"sha256": digest[:]},
	}
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		requests++
		_, _ = response.Write(expected)
	}))
	defer server.Close()
	base, err := validateUpdateBaseURL(server.URL, true)
	if err != nil {
		t.Fatal(err)
	}
	directory := t.TempDir()
	first, err := downloadUpdateTarget(newUpdateHTTPClient(true), base, target, hex.EncodeToString(digest[:]), directory)
	if err != nil {
		t.Fatal(err)
	}
	second, err := downloadUpdateTarget(newUpdateHTTPClient(true), base, target, hex.EncodeToString(digest[:]), directory)
	if err != nil {
		t.Fatal(err)
	}
	if first != second || requests != 1 {
		t.Fatalf("warm cache was not reused: first=%q second=%q requests=%d", first, second, requests)
	}
}

func TestUpdateWarmCachePrunesOldContentAddressedBundles(t *testing.T) {
	directory := t.TempDir()
	var paths []string
	for index := 0; index < 6; index++ {
		name := strings.Repeat(string(rune('a'+index)), 64) + ".arm64.bundle.tar.zst"
		path := filepath.Join(directory, name)
		if err := os.WriteFile(path, []byte("bundle"), 0o600); err != nil {
			t.Fatal(err)
		}
		when := time.Unix(int64(index+1), 0)
		if err := os.Chtimes(path, when, when); err != nil {
			t.Fatal(err)
		}
		paths = append(paths, path)
	}
	keep := paths[0]
	if err := pruneUpdateTargetCache(directory, keep, 4); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(directory)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 4 {
		t.Fatalf("cache entries=%d, want 4", len(entries))
	}
	if _, err := os.Stat(keep); err != nil {
		t.Fatalf("explicitly retained cache object was removed: %v", err)
	}
}

func TestImageUpdateLockIsExclusive(t *testing.T) {
	root := filepath.Join(t.TempDir(), "images")
	first, err := acquireImageUpdateLock(root)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	if second, err := acquireImageUpdateLock(root); err == nil {
		_ = second.Close()
		t.Fatal("second update lock was acquired concurrently")
	}
}

func TestSmokeInstalledImageRequiresSuccessfulMarker(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("test fixture uses a POSIX executable")
	}
	passing := filepath.Join(t.TempDir(), "passing-smoke")
	if err := os.WriteFile(passing, []byte("#!/bin/sh\nprintf 'ZAPVM_IMAGE_SMOKE_OK\\n'\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := smokeInstalledImage("/images", "candidate", "/keys/image.pem", passing, false); err != nil {
		t.Fatal(err)
	}
	missingMarker := filepath.Join(t.TempDir(), "missing-marker")
	if err := os.WriteFile(missingMarker, []byte("#!/bin/sh\nexit 0\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := smokeInstalledImage("/images", "candidate", "/keys/image.pem", missingMarker, false); err == nil || !strings.Contains(err.Error(), "success marker") {
		t.Fatalf("missing smoke marker was not rejected: %v", err)
	}
}

func TestExtractBundleRejectsTraversalSymlinkAndLargeManifest(t *testing.T) {
	parent := t.TempDir()
	for name, entries := range map[string][]testTarEntry{
		"traversal":      {{name: "../escape", data: []byte("bad"), typeflag: tar.TypeReg}},
		"symlink":        {{name: "link", data: nil, typeflag: tar.TypeSymlink}},
		"large-manifest": {{name: "manifest.json", data: make([]byte, maxManifestSize+1), typeflag: tar.TypeReg}},
	} {
		t.Run(name, func(t *testing.T) {
			archive := filepath.Join(parent, name+".tar.gz")
			writeTestTarGzip(t, archive, entries)
			if _, _, err := extractBundleArchive(archive, parent); err == nil {
				t.Fatal("malicious archive accepted")
			}
		})
	}
	if _, err := os.Lstat(filepath.Join(parent, "escape")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("traversal created an escaped file: %v", err)
	}
}

func TestTUFUpdateInstallsActivatesAndRejectsLedgerRollback(t *testing.T) {
	fixtureRoot := t.TempDir()
	source, publicKey, manifestPath, signaturePath := makeSignedImageFixture(t, fixtureRoot, "2.0.0-test", "arm64")
	bundlePath := filepath.Join(fixtureRoot, "release.bundle.tar.gz")
	if err := createBundle([]string{"--manifest", manifestPath, "--signature", signaturePath, "--public-key", publicKey, "--output", bundlePath}); err != nil {
		t.Fatal(err)
	}
	extracted, extractedManifest, err := extractBundleArchive(bundlePath, fixtureRoot)
	if err != nil {
		t.Fatal(err)
	}
	if extractedManifest.ImageVersion != "2.0.0-test" {
		t.Fatalf("unexpected extracted manifest: %+v", extractedManifest)
	}
	if _, err := verifyBundle(filepath.Join(extracted, "manifest.json"), filepath.Join(extracted, "manifest.sig"), publicKey, extracted); err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(extracted); err != nil {
		t.Fatal(err)
	}

	repositoryRoot := filepath.Join(fixtureRoot, "repository")
	trustedRoot := writeTestTUFRepository(t, repositoryRoot, bundlePath, manifestPath, 1)
	server := httptest.NewServer(httpNoListingFileServer(repositoryRoot))
	defer server.Close()
	installedRoot := filepath.Join(fixtureRoot, "installed")
	arguments := []string{
		"--root", installedRoot,
		"--trusted-root", trustedRoot,
		"--manifest-public-key", publicKey,
		"--metadata-url", server.URL + "/metadata",
		"--targets-url", server.URL + "/targets",
		"--channel", "stable",
		"--arch", "arm64",
		"--allow-http-loopback",
		"--skip-smoke",
	}
	if err := updateImage(arguments); err != nil {
		t.Fatal(err)
	}
	active, err := readActivation(installedRoot)
	if err != nil {
		t.Fatal(err)
	}
	if active.ActiveVersion != "2.0.0-test" || active.Generation != 1 {
		t.Fatalf("unexpected activation state: %+v", active)
	}
	if data, err := os.ReadFile(filepath.Join(installedRoot, "2.0.0-test", "kernel")); err != nil || string(data) != "kernel-2.0.0-test" {
		t.Fatalf("installed kernel=%q err=%v", data, err)
	}
	ledgerPath := filepath.Join(installedRoot, ".zapvm-update", "ledger.json")
	ledger, err := readUpdateLedgerOptional(ledgerPath)
	if err != nil {
		t.Fatal(err)
	}
	entry := ledger.Entries["stable/arm64"]
	if entry.ReleaseSequence != 1 || entry.ImageVersion != "2.0.0-test" {
		t.Fatalf("unexpected update ledger: %+v", entry)
	}
	entry.ReleaseSequence = 2
	ledger.Entries["stable/arm64"] = entry
	if err := writeUpdateLedger(ledgerPath, ledger); err != nil {
		t.Fatal(err)
	}
	if err := updateImage(arguments); err == nil || !strings.Contains(err.Error(), "release sequence rollback") {
		t.Fatalf("replayed release was not rejected: %v", err)
	}
	_ = source
}

func TestTUFUpdateBindsLayeredReleaseVector(t *testing.T) {
	fixtureRoot := t.TempDir()
	_, publicKey, manifestPath, signaturePath := makeSignedLayeredImageFixture(t, fixtureRoot, "3.0.0-layered", "arm64")
	bundlePath := filepath.Join(fixtureRoot, "layered.bundle.tar.zst")
	if err := createBundle([]string{"--manifest", manifestPath, "--signature", signaturePath, "--public-key", publicKey, "--output", bundlePath}); err != nil {
		t.Fatal(err)
	}
	repositoryRoot := filepath.Join(fixtureRoot, "repository")
	trustedRoot := writeTestTUFRepository(t, repositoryRoot, bundlePath, manifestPath, 4)
	server := httptest.NewServer(httpNoListingFileServer(repositoryRoot))
	defer server.Close()
	installedRoot := filepath.Join(fixtureRoot, "installed")
	if err := updateImage([]string{
		"--root", installedRoot,
		"--trusted-root", trustedRoot,
		"--manifest-public-key", publicKey,
		"--metadata-url", server.URL + "/metadata",
		"--targets-url", server.URL + "/targets",
		"--channel", "stable",
		"--arch", "arm64",
		"--allow-http-loopback",
		"--skip-smoke",
	}); err != nil {
		t.Fatal(err)
	}
	ledger, err := readUpdateLedgerOptional(filepath.Join(installedRoot, ".zapvm-update", "ledger.json"))
	if err != nil {
		t.Fatal(err)
	}
	layers := ledger.Entries["stable/arm64"].Layers
	if layers == nil || *layers != (updateTargetLayers{Base: "alpine-3.23.5-r1", Runtime: "3.0.0", Agent: "1.12.0", Session: "3"}) {
		t.Fatalf("activated layer vector was not committed to the ledger: %+v", layers)
	}
}

func TestTUFUpdateDownloadsIndependentLayersAndReusesWarmCache(t *testing.T) {
	fixtureRoot := t.TempDir()
	_, publicKey, manifestPath, signaturePath := makeSignedLayeredImageFixture(t, fixtureRoot, "3.2.0-layered", "arm64")
	layerDirectory := filepath.Join(fixtureRoot, "layer-targets")
	if err := createLayerBundles([]string{
		"--manifest", manifestPath, "--signature", signaturePath, "--public-key", publicKey, "--output-dir", layerDirectory,
	}); err != nil {
		t.Fatal(err)
	}
	indexPath := filepath.Join(layerDirectory, "layer-targets.json")
	customPath := filepath.Join(fixtureRoot, "target-custom.json")
	if err := createTargetMetadata([]string{
		"--manifest", manifestPath, "--signature", signaturePath, "--public-key", publicKey,
		"--release-sequence", "5", "--layer-target-index", indexPath,
		"--layer-target-prefix", "layers/arm64", "--output", customPath,
	}); err != nil {
		t.Fatal(err)
	}
	var index layerBundleIndex
	if err := json.Unmarshal(mustRead(t, indexPath), &index); err != nil {
		t.Fatal(err)
	}
	targets := map[string][]byte{
		"channels/stable/arm64.composition.tar.zst": mustRead(t, filepath.Join(layerDirectory, index.Composition.Path)),
	}
	for _, target := range index.Layers {
		targets["layers/arm64/"+target.Path] = mustRead(t, filepath.Join(layerDirectory, target.Path))
	}
	repositoryRoot := filepath.Join(fixtureRoot, "repository")
	trustedRoot := writeTestTUFRepositorySet(t, repositoryRoot, targets, "channels/stable/arm64.composition.tar.zst", mustRead(t, customPath))
	targetRequests := 0
	fileServer := httpNoListingFileServer(repositoryRoot)
	server := httptest.NewTLSServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if strings.HasPrefix(request.URL.Path, "/targets/") {
			targetRequests++
		}
		fileServer.ServeHTTP(response, request)
	}))
	defer server.Close()
	caPath := filepath.Join(fixtureRoot, "staging-update-ca.pem")
	caPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: server.Certificate().Raw})
	if err := os.WriteFile(caPath, caPEM, 0o600); err != nil {
		t.Fatal(err)
	}
	installedRoot := filepath.Join(fixtureRoot, "installed")
	arguments := []string{
		"--root", installedRoot, "--trusted-root", trustedRoot, "--manifest-public-key", publicKey,
		"--metadata-url", server.URL + "/metadata", "--targets-url", server.URL + "/targets",
		"--channel", "stable", "--arch", "arm64", "--tls-ca", caPath, "--skip-smoke",
	}
	if err := updateImage(arguments); err != nil {
		t.Fatal(err)
	}
	if targetRequests != 5 {
		t.Fatalf("independent update downloaded %d targets, want composition plus four layers", targetRequests)
	}
	ledger, err := readUpdateLedgerOptional(filepath.Join(installedRoot, ".zapvm-update", "ledger.json"))
	if err != nil {
		t.Fatal(err)
	}
	entry := ledger.Entries["stable/arm64"]
	if entry.LayerTargets == nil || entry.LayerTargets.Agent == "" {
		t.Fatalf("independent layer targets were not committed to ledger: %+v", entry)
	}
	if _, err := verifyInstalledVersion(installedRoot, "3.2.0-layered", publicKey); err != nil {
		t.Fatal(err)
	}
	targetRequests = 0
	if err := updateImage(arguments); err != nil {
		t.Fatalf("warm-cache replay failed: %v", err)
	}
	if targetRequests != 0 {
		t.Fatalf("verified independent warm cache made %d target downloads", targetRequests)
	}
}

func TestInstallBundleVerifiesArchitectureInstallsActivatesAndIsIdempotent(t *testing.T) {
	fixtureRoot := t.TempDir()
	_, publicKey, manifestPath, signaturePath := makeSignedImageFixture(t, fixtureRoot, "3.0.0-offline", "arm64")
	bundlePath := filepath.Join(fixtureRoot, "offline.bundle.tar.gz")
	if err := createBundle([]string{
		"--manifest", manifestPath,
		"--signature", signaturePath,
		"--public-key", publicKey,
		"--output", bundlePath,
	}); err != nil {
		t.Fatal(err)
	}
	secondBundlePath := filepath.Join(fixtureRoot, "offline-second.bundle.tar.gz")
	if err := createBundle([]string{
		"--manifest", manifestPath,
		"--signature", signaturePath,
		"--public-key", publicKey,
		"--output", secondBundlePath,
	}); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(mustRead(t, bundlePath), mustRead(t, secondBundlePath)) {
		t.Fatal("identical signed image inputs produced different bundles")
	}
	installedRoot := filepath.Join(fixtureRoot, "installed")
	arguments := []string{
		"--bundle", bundlePath,
		"--public-key", publicKey,
		"--root", installedRoot,
		"--arch", "arm64",
		"--skip-smoke",
	}
	if err := installBundle(arguments); err != nil {
		t.Fatal(err)
	}
	active, err := readActivation(installedRoot)
	if err != nil {
		t.Fatal(err)
	}
	if active.ActiveVersion != "3.0.0-offline" || active.Generation != 1 {
		t.Fatalf("unexpected activation state: %+v", active)
	}
	if _, err := verifyInstalledVersion(installedRoot, active.ActiveVersion, publicKey); err != nil {
		t.Fatal(err)
	}
	if err := installBundle(arguments); err != nil {
		t.Fatalf("idempotent import failed: %v", err)
	}
	after, err := readActivation(installedRoot)
	if err != nil {
		t.Fatal(err)
	}
	if after != active {
		t.Fatalf("idempotent import changed activation: before=%+v after=%+v", active, after)
	}
	mismatchRoot := filepath.Join(fixtureRoot, "mismatch")
	mismatch := append([]string(nil), arguments...)
	mismatch[5] = mismatchRoot
	mismatch[7] = "amd64"
	if err := installBundle(mismatch); err == nil || !strings.Contains(err.Error(), "does not match expected") {
		t.Fatalf("architecture mismatch was not rejected: %v", err)
	}
	if _, err := os.Lstat(filepath.Join(mismatchRoot, "3.0.0-offline")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("architecture mismatch installed a version: %v", err)
	}
}

func TestZstdBundleIsDeterministicAndExtractable(t *testing.T) {
	fixtureRoot := t.TempDir()
	_, publicKey, manifestPath, signaturePath := makeSignedImageFixture(t, fixtureRoot, "3.1.0-zstd", "arm64")
	first := filepath.Join(fixtureRoot, "first.bundle.tar.zst")
	second := filepath.Join(fixtureRoot, "second.bundle.tar.zst")
	for _, output := range []string{first, second} {
		if err := createBundle([]string{
			"--manifest", manifestPath,
			"--signature", signaturePath,
			"--public-key", publicKey,
			"--output", output,
		}); err != nil {
			t.Fatal(err)
		}
	}
	if !bytes.Equal(mustRead(t, first), mustRead(t, second)) {
		t.Fatal("identical signed image inputs produced different zstd bundles")
	}
	extracted, imageManifest, err := extractBundleArchive(first, fixtureRoot)
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(extracted)
	if imageManifest.ImageVersion != "3.1.0-zstd" {
		t.Fatalf("unexpected extracted manifest: %+v", imageManifest)
	}
	if _, err := verifyBundle(filepath.Join(extracted, "manifest.json"), filepath.Join(extracted, "manifest.sig"), publicKey, extracted); err != nil {
		t.Fatal(err)
	}
}

func TestLayerBundlesAreDeterministicAndRecomposeSignedImage(t *testing.T) {
	root := t.TempDir()
	_, publicKey, manifestPath, signaturePath := makeSignedLayeredImageFixture(t, root, "3.1.0-layered", "arm64")
	first := filepath.Join(root, "layers-first")
	second := filepath.Join(root, "layers-second")
	arguments := func(output string) []string {
		return []string{"--manifest", manifestPath, "--signature", signaturePath, "--public-key", publicKey, "--output-dir", output}
	}
	if err := createLayerBundles(arguments(first)); err != nil {
		t.Fatal(err)
	}
	if err := createLayerBundles(arguments(second)); err != nil {
		t.Fatal(err)
	}
	indexData := mustRead(t, filepath.Join(first, "layer-targets.json"))
	var index layerBundleIndex
	if err := json.Unmarshal(indexData, &index); err != nil {
		t.Fatal(err)
	}
	if index.SchemaVersion != 1 || len(index.Layers) != 4 || index.Composition.Path == "" {
		t.Fatalf("unexpected layer bundle index: %+v", index)
	}
	for _, target := range append([]layerBundleIndexTarget{index.Composition}, index.Layers["base"], index.Layers["runtime"], index.Layers["agent"], index.Layers["session"]) {
		left := mustRead(t, filepath.Join(first, target.Path))
		right := mustRead(t, filepath.Join(second, target.Path))
		if !bytes.Equal(left, right) {
			t.Fatalf("layer target %s was not deterministic", target.Path)
		}
		digest := sha256.Sum256(left)
		if target.Size != int64(len(left)) || target.SHA256 != hex.EncodeToString(digest[:]) {
			t.Fatalf("layer target index mismatch for %s", target.Path)
		}
	}

	assembled, imageManifest, err := extractCompositionArchive(filepath.Join(first, index.Composition.Path), root)
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(assembled)
	files := make(map[string]manifestFile, len(imageManifest.Files))
	for _, file := range imageManifest.Files {
		files[file.Name] = file
	}
	for _, layer := range imageManifest.Layers {
		target, exists := index.Layers[layer.Name]
		if !exists || target.Version != layer.Version {
			t.Fatalf("missing indexed target for layer %+v", layer)
		}
		if err := extractLayerArchive(filepath.Join(first, target.Path), assembled, layer, files); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := verifyBundle(filepath.Join(assembled, "manifest.json"), filepath.Join(assembled, "manifest.sig"), publicKey, assembled); err != nil {
		t.Fatalf("recomposed layer image did not verify: %v", err)
	}
}

func TestHostRuntimeLayerBundlesContainThreeLayers(t *testing.T) {
	root := t.TempDir()
	_, publicKey, manifestPath, signaturePath := makeSignedHostRuntimeFixture(t, root, "3.1.0-host", "arm64")
	output := filepath.Join(root, "host-layers")
	if err := createLayerBundles([]string{"--manifest", manifestPath, "--signature", signaturePath, "--public-key", publicKey, "--output-dir", output}); err != nil {
		t.Fatal(err)
	}
	var index layerBundleIndex
	if err := json.Unmarshal(mustRead(t, filepath.Join(output, "layer-targets.json")), &index); err != nil {
		t.Fatal(err)
	}
	if len(index.Layers) != 3 || index.Layers["agent"].Path != "" {
		t.Fatalf("unexpected Host layer index: %+v", index)
	}
	for _, name := range []string{"base", "runtime", "session"} {
		if index.Layers[name].Path == "" {
			t.Fatalf("Host layer index is missing %s", name)
		}
	}
	customPath := filepath.Join(root, "host-custom.json")
	if err := createTargetMetadata([]string{
		"--manifest", manifestPath, "--signature", signaturePath, "--public-key", publicKey,
		"--release-sequence", "7", "--layer-target-index", filepath.Join(output, "layer-targets.json"),
		"--layer-target-prefix", "layers/arm64", "--output", customPath,
	}); err != nil {
		t.Fatal(err)
	}
	raw := json.RawMessage(mustRead(t, customPath))
	custom, err := decodeUpdateTargetCustom(&raw)
	if err != nil {
		t.Fatal(err)
	}
	if custom.SchemaVersion != 3 || custom.Layers == nil || custom.LayerTargets == nil || custom.Layers.Agent != "" || custom.LayerTargets.Agent != "" {
		t.Fatalf("Host TUF metadata declared an Agent layer: %+v", custom)
	}
	if _, err := readTUFPublicationIndex(filepath.Join(output, "layer-targets.json"), "arm64", custom); err != nil {
		t.Fatalf("Host publication index was rejected: %v", err)
	}
}

func TestLayerBundleRejectsPayloadNotBoundBySignedManifest(t *testing.T) {
	root := t.TempDir()
	_, _, manifestPath, _ := makeSignedLayeredImageFixture(t, root, "3.1.0-layered", "arm64")
	imageManifest, err := decodeManifest(mustRead(t, manifestPath))
	if err != nil {
		t.Fatal(err)
	}
	files := make(map[string]manifestFile, len(imageManifest.Files))
	for _, file := range imageManifest.Files {
		files[file.Name] = file
	}
	layer := imageManifest.Layers[0]
	wrong := filepath.Join(root, "wrong")
	if err := os.WriteFile(wrong, []byte("not-the-signed-payload"), 0o600); err != nil {
		t.Fatal(err)
	}
	archive := filepath.Join(root, "wrong.layer.tar.zst")
	if err := writeSelectedBundleArchive(archive, []bundleArchiveInput{{Path: wrong, Name: layer.Files[0]}}); err != nil {
		t.Fatal(err)
	}
	destination := filepath.Join(root, "assembled")
	if err := os.Mkdir(destination, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := extractLayerArchive(archive, destination, layer, files); err == nil {
		t.Fatal("layer archive payload not bound by the signed manifest was accepted")
	}
}

func TestCreateBundleRejectsUnknownCompressionSuffix(t *testing.T) {
	fixtureRoot := t.TempDir()
	_, publicKey, manifestPath, signaturePath := makeSignedImageFixture(t, fixtureRoot, "3.1.1-suffix", "arm64")
	err := createBundle([]string{
		"--manifest", manifestPath,
		"--signature", signaturePath,
		"--public-key", publicKey,
		"--output", filepath.Join(fixtureRoot, "image.bundle"),
	})
	if err == nil || !strings.Contains(err.Error(), "bundle output must end") {
		t.Fatalf("unknown bundle compression suffix was not rejected: %v", err)
	}
}

func TestInstallBundleFailedSmokeLeavesCandidateStagedAndInactive(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("test fixture uses a POSIX executable")
	}
	fixtureRoot := t.TempDir()
	_, publicKey, manifestPath, signaturePath := makeSignedImageFixture(t, fixtureRoot, "3.2.0-bad-smoke", "arm64")
	bundlePath := filepath.Join(fixtureRoot, "candidate.bundle.tar.zst")
	if err := createBundle([]string{
		"--manifest", manifestPath, "--signature", signaturePath,
		"--public-key", publicKey, "--output", bundlePath,
	}); err != nil {
		t.Fatal(err)
	}
	failing := filepath.Join(fixtureRoot, "failing-smoke")
	if err := os.WriteFile(failing, []byte("#!/bin/sh\nprintf 'candidate failed\\n'\nexit 9\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	installedRoot := filepath.Join(fixtureRoot, "installed")
	err := installBundle([]string{
		"--bundle", bundlePath, "--public-key", publicKey,
		"--root", installedRoot, "--arch", "arm64", "--smoke-binary", failing,
	})
	if err == nil || !strings.Contains(err.Error(), "candidate boot validation failed") {
		t.Fatalf("failed candidate smoke was not rejected: %v", err)
	}
	if _, err := verifyInstalledVersion(installedRoot, "3.2.0-bad-smoke", publicKey); err != nil {
		t.Fatalf("candidate was not retained in staging: %v", err)
	}
	if _, err := os.Lstat(filepath.Join(installedRoot, "active.json")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("failed candidate became active: %v", err)
	}
}

type testTarEntry struct {
	name     string
	data     []byte
	typeflag byte
}

func writeTestTarGzip(t *testing.T, path string, entries []testTarEntry) {
	t.Helper()
	file, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	gzipWriter := gzip.NewWriter(file)
	tarWriter := tar.NewWriter(gzipWriter)
	for _, entry := range entries {
		header := &tar.Header{Name: entry.name, Typeflag: entry.typeflag, Size: int64(len(entry.data)), Linkname: "target", Mode: 0o644}
		if err := tarWriter.WriteHeader(header); err != nil {
			t.Fatal(err)
		}
		if entry.typeflag == tar.TypeReg {
			if _, err := tarWriter.Write(entry.data); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := tarWriter.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gzipWriter.Close(); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
}

func makeSignedImageFixture(t *testing.T, root, version, architecture string) (string, string, string, string) {
	t.Helper()
	source := filepath.Join(root, "source")
	if err := os.Mkdir(source, 0o755); err != nil {
		t.Fatal(err)
	}
	var inputs []string
	for _, item := range []struct{ name, data string }{
		{"kernel", "kernel-" + version},
		{"initramfs", "initramfs-" + version},
		{"rootfs.raw", "rootfs-" + version},
	} {
		path := filepath.Join(source, item.name)
		if err := os.WriteFile(path, []byte(item.data), 0o644); err != nil {
			t.Fatal(err)
		}
		inputs = append(inputs, path)
	}
	manifestPath := filepath.Join(source, "manifest.json")
	manifestArguments := []string{"--arch", architecture, "--output", manifestPath, "--version", version}
	if err := createManifest(append(manifestArguments, inputs...)); err != nil {
		t.Fatal(err)
	}
	privateKey := filepath.Join(root, "manifest-private.pem")
	publicKey := filepath.Join(root, "manifest-public.pem")
	if err := generateKeys([]string{"--private", privateKey, "--public", publicKey}); err != nil {
		t.Fatal(err)
	}
	signaturePath := filepath.Join(source, "manifest.sig")
	if err := signManifest([]string{"--manifest", manifestPath, "--private-key", privateKey, "--output", signaturePath}); err != nil {
		t.Fatal(err)
	}
	return source, publicKey, manifestPath, signaturePath
}

func makeSignedLayeredImageFixture(t *testing.T, root, version, architecture string) (string, string, string, string) {
	t.Helper()
	source := filepath.Join(root, "layered-source")
	if err := os.Mkdir(source, 0o755); err != nil {
		t.Fatal(err)
	}
	names := []string{
		"rootfs.raw", "rootfs.vhdx", "kernel", "initramfs", "cloud-hypervisor", "virtiofsd",
		"linux-runtime-provenance.json", "capabilities.json", "sbom.spdx.json", "source-offer.json",
		"agent.raw", "agent.vhdx", "agent-provenance.json", "state.raw", "state.vhdx",
	}
	inputs := make([]string, 0, len(names))
	sbomData, offerData := layeredSupplyChainFixture(t, version, architecture)
	for _, name := range names {
		path := filepath.Join(source, name)
		data := []byte(name + "-" + version)
		switch name {
		case "sbom.spdx.json":
			data = sbomData
		case "source-offer.json":
			data = offerData
		}
		if err := os.WriteFile(path, data, 0o644); err != nil {
			t.Fatal(err)
		}
		inputs = append(inputs, path)
	}
	manifestPath := filepath.Join(source, "manifest.json")
	arguments := []string{
		"--arch", architecture, "--output", manifestPath, "--version", version,
		"--base-version", "alpine-3.23.5-r1", "--runtime-version", "3.0.0",
		"--agent-version", "1.12.0", "--session-version", "3",
	}
	if err := createManifest(append(arguments, inputs...)); err != nil {
		t.Fatal(err)
	}
	privateKey := filepath.Join(root, "layered-private.pem")
	publicKey := filepath.Join(root, "layered-public.pem")
	if err := generateKeys([]string{"--private", privateKey, "--public", publicKey}); err != nil {
		t.Fatal(err)
	}
	signaturePath := filepath.Join(source, "manifest.sig")
	if err := signManifest([]string{"--manifest", manifestPath, "--private-key", privateKey, "--output", signaturePath}); err != nil {
		t.Fatal(err)
	}
	return source, publicKey, manifestPath, signaturePath
}

func makeSignedHostRuntimeFixture(t *testing.T, root, version, architecture string) (string, string, string, string) {
	t.Helper()
	source := filepath.Join(root, "host-source")
	if err := os.Mkdir(source, 0o755); err != nil {
		t.Fatal(err)
	}
	names := []string{
		"rootfs.raw", "rootfs.vhdx", "kernel", "initramfs", "cloud-hypervisor", "virtiofsd",
		"linux-runtime-provenance.json", "capabilities.json", "sbom.spdx.json", "source-offer.json",
		"state.raw", "state.vhdx",
	}
	inputs := make([]string, 0, len(names))
	sbomData, offerData := layeredSupplyChainFixture(t, version, architecture)
	for _, name := range names {
		path := filepath.Join(source, name)
		data := []byte(name + "-" + version)
		if name == "sbom.spdx.json" {
			data = sbomData
		} else if name == "source-offer.json" {
			data = offerData
		}
		if err := os.WriteFile(path, data, 0o644); err != nil {
			t.Fatal(err)
		}
		inputs = append(inputs, path)
	}
	manifestPath := filepath.Join(source, "manifest.json")
	arguments := []string{
		"--profile", "host-runtime", "--arch", architecture, "--output", manifestPath, "--version", version,
		"--base-version", "alpine-3.23.5-r1", "--runtime-version", "3.0.0", "--session-version", "3",
	}
	if err := createManifest(append(arguments, inputs...)); err != nil {
		t.Fatal(err)
	}
	privateKey := filepath.Join(root, "host-private.pem")
	publicKey := filepath.Join(root, "host-public.pem")
	if err := generateKeys([]string{"--private", privateKey, "--public", publicKey}); err != nil {
		t.Fatal(err)
	}
	signaturePath := filepath.Join(source, "manifest.sig")
	if err := signManifest([]string{"--manifest", manifestPath, "--private-key", privateKey, "--output", signaturePath}); err != nil {
		t.Fatal(err)
	}
	return source, publicKey, manifestPath, signaturePath
}

func layeredSupplyChainFixture(t *testing.T, version, architecture string) ([]byte, []byte) {
	t.Helper()
	id := "SPDXRef-Package-zapvm-agent"
	sbomData, err := json.Marshal(map[string]any{
		"spdxVersion": "SPDX-2.3", "dataLicense": "CC0-1.0", "SPDXID": "SPDXRef-DOCUMENT",
		"packages": []map[string]any{{
			"SPDXID": id, "name": "zapvm-agent", "versionInfo": version,
			"licenseDeclared": "Apache-2.0",
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	offerData, err := json.Marshal(map[string]any{
		"schema_version": 1, "image_version": version, "architecture": architecture,
		"packages": []map[string]any{{
			"spdx_id": id, "name": "zapvm-agent", "version": version,
			"license_declared": "Apache-2.0", "source_type": "git-archive",
			"source_url":      "https://example.test/zapvm.tar.gz",
			"source_revision": strings.Repeat("a", 40), "source_sha256": strings.Repeat("b", 64),
			"source_paths": []string{"."},
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	return sbomData, offerData
}

func writeTestTUFRepository(t *testing.T, root, bundlePath, manifestPath string, sequence uint64) string {
	t.Helper()
	metadataDirectory := filepath.Join(root, "metadata")
	targetDirectory := filepath.Join(root, "targets", "channels", "stable")
	if err := os.MkdirAll(metadataDirectory, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(targetDirectory, 0o755); err != nil {
		t.Fatal(err)
	}
	expiry := time.Now().UTC().Add(24 * time.Hour)
	rootMetadata := metadata.Root(expiry)
	targetsMetadata := metadata.Targets(expiry)
	snapshotMetadata := metadata.Snapshot(expiry)
	timestampMetadata := metadata.Timestamp(expiry)
	keys := make(map[string]ed25519.PrivateKey)
	for _, role := range []string{metadata.ROOT, metadata.TARGETS, metadata.SNAPSHOT, metadata.TIMESTAMP} {
		_, privateKey, err := ed25519.GenerateKey(rand.Reader)
		if err != nil {
			t.Fatal(err)
		}
		keys[role] = privateKey
		key, err := metadata.KeyFromPublicKey(privateKey.Public())
		if err != nil {
			t.Fatal(err)
		}
		if err := rootMetadata.Signed.AddKey(key, role); err != nil {
			t.Fatal(err)
		}
	}
	bundleData := mustRead(t, bundlePath)
	targetPath := "channels/stable/arm64.bundle.tar.gz"
	targetInfo, err := metadata.TargetFile().FromBytes(targetPath, bundleData, "sha256", "sha512")
	if err != nil {
		t.Fatal(err)
	}
	manifestDigest := sha256.Sum256(mustRead(t, manifestPath))
	manifestData := mustRead(t, manifestPath)
	imageManifest, err := decodeManifest(manifestData)
	if err != nil {
		t.Fatal(err)
	}
	custom := updateTargetCustom{
		SchemaVersion: 1, ReleaseSequence: sequence, ImageVersion: imageManifest.ImageVersion,
		Architecture: imageManifest.Architecture, ManifestSHA256: hex.EncodeToString(manifestDigest[:]),
	}
	if imageManifest.SchemaVersion == 3 {
		custom.SchemaVersion = 2
		layers := updateTargetLayers{}
		for _, layer := range imageManifest.Layers {
			switch layer.Name {
			case "base":
				layers.Base = layer.Version
			case "runtime":
				layers.Runtime = layer.Version
			case "agent":
				layers.Agent = layer.Version
			case "session":
				layers.Session = layer.Version
			}
		}
		custom.Layers = &layers
	}
	customData, err := json.Marshal(custom)
	if err != nil {
		t.Fatal(err)
	}
	customRaw := json.RawMessage(customData)
	targetInfo.Custom = &customRaw
	targetsMetadata.Signed.Targets[targetPath] = targetInfo
	mustSignMetadata(t, targetsMetadata, keys[metadata.TARGETS])
	targetsData, err := targetsMetadata.ToBytes(false)
	if err != nil {
		t.Fatal(err)
	}
	snapshotMetadata.Signed.Meta["targets.json"] = metadataFileForBytes(1, targetsData)
	mustSignMetadata(t, snapshotMetadata, keys[metadata.SNAPSHOT])
	snapshotData, err := snapshotMetadata.ToBytes(false)
	if err != nil {
		t.Fatal(err)
	}
	timestampMetadata.Signed.Meta["snapshot.json"] = metadataFileForBytes(1, snapshotData)
	mustSignMetadata(t, timestampMetadata, keys[metadata.TIMESTAMP])
	timestampData, err := timestampMetadata.ToBytes(false)
	if err != nil {
		t.Fatal(err)
	}
	mustSignMetadata(t, rootMetadata, keys[metadata.ROOT])
	rootData, err := rootMetadata.ToBytes(false)
	if err != nil {
		t.Fatal(err)
	}
	for name, data := range map[string][]byte{
		"1.root.json": rootData, "1.targets.json": targetsData,
		"1.snapshot.json": snapshotData, "timestamp.json": timestampData,
	} {
		if err := os.WriteFile(filepath.Join(metadataDirectory, name), data, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	targetDigest := targetInfo.Hashes["sha256"]
	targetName := hex.EncodeToString(targetDigest) + ".arm64.bundle.tar.gz"
	if err := os.WriteFile(filepath.Join(targetDirectory, targetName), bundleData, 0o644); err != nil {
		t.Fatal(err)
	}
	return filepath.Join(metadataDirectory, "1.root.json")
}

func writeTestTUFRepositorySet(t *testing.T, root string, targetPayloads map[string][]byte, channelTarget string, channelCustom []byte) string {
	t.Helper()
	metadataDirectory := filepath.Join(root, "metadata")
	if err := os.MkdirAll(metadataDirectory, 0o755); err != nil {
		t.Fatal(err)
	}
	expiry := time.Now().UTC().Add(24 * time.Hour)
	rootMetadata := metadata.Root(expiry)
	targetsMetadata := metadata.Targets(expiry)
	snapshotMetadata := metadata.Snapshot(expiry)
	timestampMetadata := metadata.Timestamp(expiry)
	keys := make(map[string]ed25519.PrivateKey)
	for _, role := range []string{metadata.ROOT, metadata.TARGETS, metadata.SNAPSHOT, metadata.TIMESTAMP} {
		_, privateKey, err := ed25519.GenerateKey(rand.Reader)
		if err != nil {
			t.Fatal(err)
		}
		keys[role] = privateKey
		key, err := metadata.KeyFromPublicKey(privateKey.Public())
		if err != nil {
			t.Fatal(err)
		}
		if err := rootMetadata.Signed.AddKey(key, role); err != nil {
			t.Fatal(err)
		}
	}
	for targetPath, payload := range targetPayloads {
		targetInfo, err := metadata.TargetFile().FromBytes(targetPath, payload, "sha256", "sha512")
		if err != nil {
			t.Fatal(err)
		}
		if targetPath == channelTarget {
			raw := json.RawMessage(append([]byte(nil), channelCustom...))
			targetInfo.Custom = &raw
		}
		targetsMetadata.Signed.Targets[targetPath] = targetInfo
		directory := filepath.Join(root, "targets", filepath.FromSlash(filepath.Dir(targetPath)))
		if err := os.MkdirAll(directory, 0o755); err != nil {
			t.Fatal(err)
		}
		name := hex.EncodeToString(targetInfo.Hashes["sha256"]) + "." + filepath.Base(targetPath)
		if err := os.WriteFile(filepath.Join(directory, name), payload, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	mustSignMetadata(t, targetsMetadata, keys[metadata.TARGETS])
	targetsData, err := targetsMetadata.ToBytes(false)
	if err != nil {
		t.Fatal(err)
	}
	snapshotMetadata.Signed.Meta["targets.json"] = metadataFileForBytes(1, targetsData)
	mustSignMetadata(t, snapshotMetadata, keys[metadata.SNAPSHOT])
	snapshotData, err := snapshotMetadata.ToBytes(false)
	if err != nil {
		t.Fatal(err)
	}
	timestampMetadata.Signed.Meta["snapshot.json"] = metadataFileForBytes(1, snapshotData)
	mustSignMetadata(t, timestampMetadata, keys[metadata.TIMESTAMP])
	timestampData, err := timestampMetadata.ToBytes(false)
	if err != nil {
		t.Fatal(err)
	}
	mustSignMetadata(t, rootMetadata, keys[metadata.ROOT])
	rootData, err := rootMetadata.ToBytes(false)
	if err != nil {
		t.Fatal(err)
	}
	for name, data := range map[string][]byte{
		"1.root.json": rootData, "1.targets.json": targetsData,
		"1.snapshot.json": snapshotData, "timestamp.json": timestampData,
	} {
		if err := os.WriteFile(filepath.Join(metadataDirectory, name), data, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return filepath.Join(metadataDirectory, "1.root.json")
}

func metadataFileForBytes(version int64, data []byte) *metadata.MetaFiles {
	digest := sha256.Sum256(data)
	return &metadata.MetaFiles{Version: version, Length: int64(len(data)), Hashes: metadata.Hashes{"sha256": digest[:]}}
}

func mustSignMetadata[T metadata.Roles](t *testing.T, value *metadata.Metadata[T], privateKey ed25519.PrivateKey) {
	t.Helper()
	signer, err := signature.LoadSigner(privateKey, crypto.Hash(0))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := value.Sign(signer); err != nil {
		t.Fatal(err)
	}
}

func mustRead(t *testing.T, path string) []byte {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func httpNoListingFileServer(root string) *httpNoListingHandler {
	return &httpNoListingHandler{root: root}
}

type httpNoListingHandler struct {
	root string
}

func (handler *httpNoListingHandler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	clean := filepath.Clean(strings.TrimPrefix(request.URL.Path, "/"))
	if clean == "." || strings.HasPrefix(clean, "..") {
		http.NotFound(response, request)
		return
	}
	path := filepath.Join(handler.root, clean)
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() {
		http.NotFound(response, request)
		return
	}
	http.ServeFile(response, request, path)
}

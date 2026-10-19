package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestReadAPKPackagesAndBuildDeterministicSPDX(t *testing.T) {
	database := strings.Join([]string{
		"P:zlib", "V:1.3-r0", "L:Zlib", "U:https://zlib.net", "",
		"P:alpine-baselayout", "V:3.7.2-r0", "L:GPL-2.0-only", "",
	}, "\n")
	path := filepath.Join(t.TempDir(), "installed")
	if err := os.WriteFile(path, []byte(database), 0o600); err != nil {
		t.Fatal(err)
	}
	packages, err := readAPKPackages(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(packages) != 2 || packages[0].name != "alpine-baselayout" || packages[1].name != "zlib" {
		t.Fatalf("unexpected packages: %#v", packages)
	}
	first, err := buildSPDX(packages, "arm64", "0.1.0", "2026-08-05T00:00:00Z")
	if err != nil {
		t.Fatal(err)
	}
	second, err := buildSPDX(packages, "arm64", "0.1.0", "2026-08-05T00:00:00Z")
	if err != nil {
		t.Fatal(err)
	}
	if first.DocumentNamespace != second.DocumentNamespace || !strings.HasPrefix(first.DocumentNamespace, "https://zapvm.dev/spdx/0.1.0/arm64/") {
		t.Fatalf("non-deterministic namespace: %q / %q", first.DocumentNamespace, second.DocumentNamespace)
	}
	if len(first.Packages) != 7 || len(first.Relationships) != 7 {
		t.Fatalf("packages=%d relationships=%d", len(first.Packages), len(first.Relationships))
	}
	if len(first.ExtractedLicenses) != 2 || first.ExtractedLicenses[0].LicenseID != "LicenseRef-Alpine-Public-Domain" || first.ExtractedLicenses[1].LicenseID != "LicenseRef-Alpine-Custom" {
		t.Fatalf("unexpected extracted licenses: %#v", first.ExtractedLicenses)
	}
}

func TestSPDXIncludesResidentAgent(t *testing.T) {
	document, err := buildSPDXWithComponents([]apkPackage{{name: "busybox", version: "1", license: "GPL-2.0-only"}}, "arm64", "0.2.0", "2026-08-05T00:00:00Z", "v53.0", "v1.14.0", "1.12.0")
	if err != nil {
		t.Fatal(err)
	}
	versions := make(map[string]string)
	licenses := make(map[string]string)
	for _, item := range document.Packages {
		versions[item.Name] = item.VersionInfo
		licenses[item.Name] = item.LicenseDeclared
	}
	if versions["zapvm-resident-agent"] != "0.2.0" || versions["zapcode"] != "1.12.0" {
		t.Fatalf("resident Agent packages missing from SPDX: %#v", versions)
	}
	if licenses["zapvm-resident-agent"] != "Apache-2.0" || licenses["zapcode"] != "ISC" {
		t.Fatalf("resident Agent package licenses are not declared: %#v", licenses)
	}
}

func TestHostRuntimeSPDXIncludesAdapterAndOmitsZapCode(t *testing.T) {
	document, err := buildSPDXForProfile([]apkPackage{{name: "busybox", version: "1", license: "GPL-2.0-only"}}, "arm64", "0.2.0", "2026-08-05T00:00:00Z", "v53.0", "v1.14.0", "unavailable", "host-runtime")
	if err != nil {
		t.Fatal(err)
	}
	foundAdapter := false
	for _, item := range document.Packages {
		if item.Name == "zapcode" {
			t.Fatalf("Host SBOM contains Agent package %q", item.Name)
		}
		if item.Name == "zapvm-resident-agent" {
			foundAdapter = true
		}
	}
	if !foundAdapter {
		t.Fatal("Host SBOM omitted the Runtime-owned Agent adapter")
	}
}

func TestSourceOfferCoversEverySPDXPackage(t *testing.T) {
	commitA := strings.Repeat("a", 40)
	commitB := strings.Repeat("b", 40)
	commitC := strings.Repeat("c", 40)
	hashA := strings.Repeat("d", 64)
	hashB := strings.Repeat("e", 64)
	apkPackages := []apkPackage{{
		name: "busybox", version: "1.37.0-r30", license: "GPL-2.0-only",
		homepage: "https://busybox.net/", origin: "busybox", commit: commitA,
	}}
	document, err := buildSPDXWithComponents(apkPackages, "amd64", "0.3.0", "2026-08-05T00:00:00Z", "v53.0", "v1.14.0", "1.12.0")
	if err != nil {
		t.Fatal(err)
	}
	offer, err := buildSourceOffer(document, apkPackages, "0.3.0", "amd64", commitB, commitC,
		"https://example.test/cloud-hypervisor.tar.gz", hashA,
		"https://example.test/virtiofsd.tar.gz", hashB, commitA)
	if err != nil {
		t.Fatal(err)
	}
	if offer.SchemaVersion != 1 || len(offer.Packages) != len(document.Packages) {
		t.Fatalf("source offer coverage=%d, SPDX packages=%d", len(offer.Packages), len(document.Packages))
	}
	seen := make(map[string]sourceOfferPackage)
	for _, item := range offer.Packages {
		if item.LicenseDeclared == "NOASSERTION" || item.SourceURL == "" || item.SourceRevision == "" {
			t.Fatalf("incomplete source offer item: %+v", item)
		}
		seen[item.Name] = item
	}
	if seen["busybox"].SourceRevision != commitA || len(seen["busybox"].SourcePaths) != 3 {
		t.Fatalf("Alpine source offer is incomplete: %+v", seen["busybox"])
	}
	if seen["cloud-hypervisor"].SourceSHA256 != hashA || seen["virtiofsd"].SourceSHA256 != hashB {
		t.Fatalf("runtime source archives are not hash pinned: %#v", seen)
	}
	vmSource := seen["zapvm-agent"]
	if vmSource.SourceRevision != commitB ||
		vmSource.SourceURL != "https://github.com/JackCaow/zapagent/archive/"+commitB+".tar.gz" ||
		len(vmSource.SourcePaths) != 1 || vmSource.SourcePaths[0] != "zapvm" {
		t.Fatalf("VM source offer does not locate the monorepo module: %+v", vmSource)
	}
}

func TestAPKDatabaseRejectsIncompleteRecord(t *testing.T) {
	path := filepath.Join(t.TempDir(), "installed")
	if err := os.WriteFile(path, []byte("P:missing-version\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := readAPKPackages(path); err == nil {
		t.Fatal("incomplete package record was accepted")
	}
}

func TestSPDXIncludesLockedLinuxRuntime(t *testing.T) {
	document, err := buildSPDXWithRuntime([]apkPackage{{name: "busybox", version: "1", license: "GPL-2.0-only"}}, "amd64", "0.1.0", "2026-08-05T00:00:00Z", "v53.0", "v1.14.0")
	if err != nil {
		t.Fatal(err)
	}
	versions := make(map[string]string)
	for _, item := range document.Packages {
		versions[item.Name] = item.VersionInfo
	}
	if versions["cloud-hypervisor"] != "v53.0" || versions["virtiofsd"] != "v1.14.0" {
		t.Fatalf("Linux runtime packages missing from SPDX: %#v", versions)
	}
	if len(document.Packages) != len(document.Relationships) {
		t.Fatal("not every runtime package is described by the SPDX document")
	}
}

func TestNormalizeAlpineNonSPDXLicenseToken(t *testing.T) {
	want := "GPL-2.0-or-later AND LicenseRef-Alpine-Public-Domain"
	if got := normalizeLicense("GPL-2.0-or-later AND Public-Domain"); got != want {
		t.Fatalf("normalized license = %q, want %q", got, want)
	}
	if got := normalizeLicense(""); got != "NOASSERTION" {
		t.Fatalf("empty license = %q", got)
	}
	if got := normalizeLicense("custom"); got != "LicenseRef-Alpine-Custom" {
		t.Fatalf("custom license = %q", got)
	}
}

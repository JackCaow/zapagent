package image

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestValidateSupplyChainDocumentsRequiresExactCoverage(t *testing.T) {
	manifest := Manifest{SchemaVersion: 3, ImageVersion: "3.0.0", Architecture: "amd64"}
	sbom, offer := validSupplyChainDocuments(t, manifest)
	if err := validateSupplyChainDocuments(sbom, offer, manifest); err != nil {
		t.Fatal(err)
	}

	var decoded sourceOfferDocument
	if err := json.Unmarshal(offer, &decoded); err != nil {
		t.Fatal(err)
	}
	decoded.Packages[0].LicenseDeclared = "NOASSERTION"
	invalid, err := json.Marshal(decoded)
	if err != nil {
		t.Fatal(err)
	}
	if err := validateSupplyChainDocuments(sbom, invalid, manifest); err == nil || !strings.Contains(err.Error(), "does not match") {
		t.Fatalf("license mismatch was not rejected: %v", err)
	}

	decoded.Packages[0].LicenseDeclared = "Apache-2.0"
	decoded.Packages = append(decoded.Packages, decoded.Packages[0])
	invalid, err = json.Marshal(decoded)
	if err != nil {
		t.Fatal(err)
	}
	if err := validateSupplyChainDocuments(sbom, invalid, manifest); err == nil || !strings.Contains(err.Error(), "exactly once") {
		t.Fatalf("duplicate source coverage was not rejected: %v", err)
	}
}

func TestValidateSupplyChainDocumentsRejectsUnsafeSourceLocator(t *testing.T) {
	manifest := Manifest{SchemaVersion: 3, ImageVersion: "3.0.0", Architecture: "arm64"}
	sbom, offer := validSupplyChainDocuments(t, manifest)
	var decoded sourceOfferDocument
	if err := json.Unmarshal(offer, &decoded); err != nil {
		t.Fatal(err)
	}
	decoded.Packages[0].SourceURL = "http://example.test/source.tar.gz"
	decoded.Packages[0].SourcePaths = []string{"../escape"}
	invalid, err := json.Marshal(decoded)
	if err != nil {
		t.Fatal(err)
	}
	if err := validateSupplyChainDocuments(sbom, invalid, manifest); err == nil || !strings.Contains(err.Error(), "HTTPS") {
		t.Fatalf("unsafe source URL was not rejected: %v", err)
	}

	decoded.Packages[0].SourceURL = "https://example.test/source.tar.gz"
	invalid, err = json.Marshal(decoded)
	if err != nil {
		t.Fatal(err)
	}
	if err := validateSupplyChainDocuments(sbom, invalid, manifest); err == nil || !strings.Contains(err.Error(), "unsafe source path") {
		t.Fatalf("unsafe source path was not rejected: %v", err)
	}
}

func TestValidateSupplyChainDocumentsRejectsUnknownOfferFieldsAndTrailingData(t *testing.T) {
	manifest := Manifest{SchemaVersion: 3, ImageVersion: "3.0.0", Architecture: "amd64"}
	sbom, offer := validSupplyChainDocuments(t, manifest)
	withUnknown := append([]byte(nil), offer[:len(offer)-1]...)
	withUnknown = append(withUnknown, []byte(`,"unexpected":true}`)...)
	if err := validateSupplyChainDocuments(sbom, withUnknown, manifest); err == nil || !strings.Contains(err.Error(), "unknown field") {
		t.Fatalf("unknown source-offer field was not rejected: %v", err)
	}
	if err := validateSupplyChainDocuments(sbom, append(offer, []byte(`{}`)...), manifest); err == nil || !strings.Contains(err.Error(), "trailing data") {
		t.Fatalf("trailing source-offer data was not rejected: %v", err)
	}
}

func validSupplyChainDocuments(t *testing.T, manifest Manifest) ([]byte, []byte) {
	t.Helper()
	id := "SPDXRef-Package-zapvm-agent"
	sbom, err := json.Marshal(map[string]any{
		"spdxVersion": "SPDX-2.3", "dataLicense": "CC0-1.0", "SPDXID": "SPDXRef-DOCUMENT",
		"packages": []map[string]any{{
			"SPDXID": id, "name": "zapvm-agent", "versionInfo": manifest.ImageVersion,
			"licenseDeclared": "Apache-2.0",
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	offer, err := json.Marshal(sourceOfferDocument{
		SchemaVersion: 1, ImageVersion: manifest.ImageVersion, Architecture: manifest.Architecture,
		Packages: []sourceOfferPackage{{
			SPDXID: id, Name: "zapvm-agent", Version: manifest.ImageVersion,
			LicenseDeclared: "Apache-2.0", SourceType: "git-archive",
			SourceURL: "https://example.test/zapvm.tar.gz", SourceRevision: strings.Repeat("a", 40),
			SourceSHA256: strings.Repeat("b", 64), SourcePaths: []string{"."},
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	return sbom, offer
}

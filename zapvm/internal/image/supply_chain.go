package image

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"path"
	"path/filepath"
	"strings"
)

const (
	MaxSupplyChainMetadataSize = 8 << 20
	MaxSupplyChainPackages     = 4096
)

type supplyChainSPDXDocument struct {
	SPDXVersion string                   `json:"spdxVersion"`
	DataLicense string                   `json:"dataLicense"`
	SPDXID      string                   `json:"SPDXID"`
	Packages    []supplyChainSPDXPackage `json:"packages"`
}

type supplyChainSPDXPackage struct {
	SPDXID          string `json:"SPDXID"`
	Name            string `json:"name"`
	VersionInfo     string `json:"versionInfo"`
	LicenseDeclared string `json:"licenseDeclared"`
}

type sourceOfferDocument struct {
	SchemaVersion int                  `json:"schema_version"`
	ImageVersion  string               `json:"image_version"`
	Architecture  string               `json:"architecture"`
	Packages      []sourceOfferPackage `json:"packages"`
}

type sourceOfferPackage struct {
	SPDXID          string   `json:"spdx_id"`
	Name            string   `json:"name"`
	Version         string   `json:"version"`
	LicenseDeclared string   `json:"license_declared"`
	SourceType      string   `json:"source_type"`
	SourceURL       string   `json:"source_url"`
	SourceRevision  string   `json:"source_revision"`
	SourceSHA256    string   `json:"source_sha256,omitempty"`
	SourcePaths     []string `json:"source_paths,omitempty"`
}

func ValidateSupplyChainMetadata(baseDirectory string, manifest Manifest) error {
	if manifest.SchemaVersion != 3 {
		return nil
	}
	sbomData, err := ReadBoundedRegular(filepath.Join(baseDirectory, "sbom.spdx.json"), MaxSupplyChainMetadataSize)
	if err != nil {
		return fmt.Errorf("read signed SPDX SBOM: %w", err)
	}
	offerData, err := ReadBoundedRegular(filepath.Join(baseDirectory, "source-offer.json"), MaxSupplyChainMetadataSize)
	if err != nil {
		return fmt.Errorf("read signed source offer: %w", err)
	}
	return validateSupplyChainDocuments(sbomData, offerData, manifest)
}

func validateSupplyChainDocuments(sbomData, offerData []byte, manifest Manifest) error {
	var sbom supplyChainSPDXDocument
	if err := decodeSingleJSON(sbomData, &sbom, false); err != nil {
		return fmt.Errorf("decode SPDX SBOM: %w", err)
	}
	if sbom.SPDXVersion != "SPDX-2.3" || sbom.DataLicense != "CC0-1.0" || sbom.SPDXID != "SPDXRef-DOCUMENT" {
		return errors.New("SPDX SBOM has an unsupported document identity")
	}
	if len(sbom.Packages) == 0 || len(sbom.Packages) > MaxSupplyChainPackages {
		return errors.New("SPDX SBOM has an invalid package count")
	}

	var offer sourceOfferDocument
	if err := decodeSingleJSON(offerData, &offer, true); err != nil {
		return fmt.Errorf("decode source offer: %w", err)
	}
	if offer.SchemaVersion != 1 {
		return errors.New("source offer has an unsupported schema")
	}
	if offer.ImageVersion != manifest.ImageVersion || offer.Architecture != manifest.Architecture {
		return errors.New("source offer does not match the signed image identity")
	}
	if len(offer.Packages) != len(sbom.Packages) || len(offer.Packages) > MaxSupplyChainPackages {
		return errors.New("source offer does not cover every SPDX package exactly once")
	}

	packages := make(map[string]supplyChainSPDXPackage, len(sbom.Packages))
	for _, pkg := range sbom.Packages {
		if !validSupplyChainText(pkg.SPDXID, 256) || !validSupplyChainText(pkg.Name, 256) ||
			!validSupplyChainText(pkg.VersionInfo, 256) || !validDeclaredLicense(pkg.LicenseDeclared) {
			return fmt.Errorf("SPDX package %q has incomplete identity or license metadata", pkg.Name)
		}
		if _, exists := packages[pkg.SPDXID]; exists {
			return fmt.Errorf("SPDX package ID %q is duplicated", pkg.SPDXID)
		}
		packages[pkg.SPDXID] = pkg
	}

	seenOffers := make(map[string]struct{}, len(offer.Packages))
	for _, item := range offer.Packages {
		if _, exists := seenOffers[item.SPDXID]; exists {
			return fmt.Errorf("source offer package ID %q is duplicated", item.SPDXID)
		}
		seenOffers[item.SPDXID] = struct{}{}
		pkg, exists := packages[item.SPDXID]
		if !exists {
			return fmt.Errorf("source offer references unknown SPDX package %q", item.SPDXID)
		}
		if item.Name != pkg.Name || item.Version != pkg.VersionInfo || item.LicenseDeclared != pkg.LicenseDeclared {
			return fmt.Errorf("source offer package %q does not match its SPDX identity", item.SPDXID)
		}
		if err := validateSourceOfferPackage(item); err != nil {
			return fmt.Errorf("source offer package %q: %w", item.SPDXID, err)
		}
	}
	return nil
}

func decodeSingleJSON(data []byte, destination any, disallowUnknown bool) error {
	if len(data) == 0 || len(data) > MaxSupplyChainMetadataSize {
		return errors.New("document is empty or exceeds its size limit")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	if disallowUnknown {
		decoder.DisallowUnknownFields()
	}
	if err := decoder.Decode(destination); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return errors.New("document contains trailing data")
	}
	return nil
}

func validateSourceOfferPackage(item sourceOfferPackage) error {
	switch item.SourceType {
	case "alpine-aports", "git-archive", "release-source-archive":
	default:
		return errors.New("unsupported source type")
	}
	parsed, err := url.Parse(item.SourceURL)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil || parsed.Fragment != "" || strings.ContainsAny(item.SourceURL, "\x00\r\n\t ") {
		return errors.New("source URL must be an absolute HTTPS URL")
	}
	if !validSupplyChainText(item.SourceRevision, 256) {
		return errors.New("source revision is missing or invalid")
	}
	if item.SourceSHA256 != "" && !ValidLowerSHA256(item.SourceSHA256) {
		return errors.New("source archive SHA-256 is invalid")
	}
	if len(item.SourcePaths) == 0 || len(item.SourcePaths) > 32 {
		return errors.New("source paths are missing or excessive")
	}
	seen := make(map[string]struct{}, len(item.SourcePaths))
	for _, sourcePath := range item.SourcePaths {
		if !validSourcePath(sourcePath) {
			return fmt.Errorf("unsafe source path %q", sourcePath)
		}
		if _, exists := seen[sourcePath]; exists {
			return fmt.Errorf("duplicate source path %q", sourcePath)
		}
		seen[sourcePath] = struct{}{}
	}
	return nil
}

func validDeclaredLicense(value string) bool {
	return validSupplyChainText(value, 1024) && value != "NOASSERTION" && value != "NONE"
}

func validSupplyChainText(value string, maximum int) bool {
	return value != "" && len(value) <= maximum && strings.TrimSpace(value) == value && !strings.ContainsAny(value, "\x00\r\n")
}

func validSourcePath(value string) bool {
	return validSupplyChainText(value, 512) && !strings.Contains(value, "\\") && !strings.HasPrefix(value, "/") && path.Clean(value) == value && value != ".." && !strings.HasPrefix(value, "../")
}

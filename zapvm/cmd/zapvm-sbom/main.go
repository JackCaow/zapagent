package main

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"sort"
	"strings"
	"time"
	"unicode"

	"zapvm/internal/clierror"
)

type apkPackage struct {
	name     string
	version  string
	license  string
	homepage string
	origin   string
	commit   string
}

type sourceOffer struct {
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

type spdxDocument struct {
	SPDXVersion       string                 `json:"spdxVersion"`
	DataLicense       string                 `json:"dataLicense"`
	SPDXID            string                 `json:"SPDXID"`
	Name              string                 `json:"name"`
	DocumentNamespace string                 `json:"documentNamespace"`
	CreationInfo      spdxCreationInfo       `json:"creationInfo"`
	Packages          []spdxPackage          `json:"packages"`
	Relationships     []spdxRelationship     `json:"relationships"`
	ExtractedLicenses []spdxExtractedLicense `json:"hasExtractedLicensingInfos,omitempty"`
}

type spdxCreationInfo struct {
	Created  string   `json:"created"`
	Creators []string `json:"creators"`
}

type spdxPackage struct {
	Name             string            `json:"name"`
	SPDXID           string            `json:"SPDXID"`
	VersionInfo      string            `json:"versionInfo"`
	DownloadLocation string            `json:"downloadLocation"`
	FilesAnalyzed    bool              `json:"filesAnalyzed"`
	LicenseConcluded string            `json:"licenseConcluded"`
	LicenseDeclared  string            `json:"licenseDeclared"`
	CopyrightText    string            `json:"copyrightText"`
	Homepage         string            `json:"homepage,omitempty"`
	ExternalRefs     []spdxExternalRef `json:"externalRefs,omitempty"`
}

type spdxExternalRef struct {
	ReferenceCategory string `json:"referenceCategory"`
	ReferenceType     string `json:"referenceType"`
	ReferenceLocator  string `json:"referenceLocator"`
}

type spdxRelationship struct {
	SPDXElementID      string `json:"spdxElementId"`
	RelationshipType   string `json:"relationshipType"`
	RelatedSPDXElement string `json:"relatedSpdxElement"`
}

type spdxExtractedLicense struct {
	LicenseID     string `json:"licenseId"`
	ExtractedText string `json:"extractedText"`
	Name          string `json:"name,omitempty"`
	Comment       string `json:"comment,omitempty"`
}

func main() {
	if err := run(os.Args[1:]); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return
		}
		os.Exit(clierror.Report(os.Stderr, err, clierror.InvalidConfiguration))
	}
}

func run(args []string) error {
	flags := flag.NewFlagSet("zapvm-sbom", flag.ContinueOnError)
	installed := flags.String("installed", "", "Alpine /lib/apk/db/installed file")
	arch := flags.String("arch", "", "arm64 or amd64")
	version := flags.String("version", "", "zapVM image version")
	created := flags.String("created", "", "RFC3339 creation timestamp")
	imageProfile := flags.String("image-profile", "agent-computer", "host-runtime or agent-computer")
	output := flags.String("output", "", "output SPDX JSON file")
	sourceOfferOutput := flags.String("source-offer-output", "", "output corresponding-source offer JSON file")
	zapVMSourceCommit := flags.String("zapvm-source-commit", "", "exact zapVM source commit")
	cloudHypervisorVersion := flags.String("cloud-hypervisor-version", "", "included Linux Host Cloud Hypervisor version")
	cloudHypervisorSourceURL := flags.String("cloud-hypervisor-source-url", "", "immutable Cloud Hypervisor source archive URL")
	cloudHypervisorSourceSHA256 := flags.String("cloud-hypervisor-source-sha256", "", "Cloud Hypervisor source archive SHA-256")
	virtioFSDVersion := flags.String("virtiofsd-version", "", "included Linux Host virtiofsd version")
	virtioFSDSourceURL := flags.String("virtiofsd-source-url", "", "immutable virtiofsd source archive URL")
	virtioFSDSourceSHA256 := flags.String("virtiofsd-source-sha256", "", "virtiofsd source archive SHA-256")
	virtioFSDSourceCommit := flags.String("virtiofsd-source-commit", "", "exact virtiofsd source commit")
	zapVersion := flags.String("zap-version", "unavailable", "embedded Zap Agent version, or unavailable")
	zapSourceCommit := flags.String("zap-source-commit", "unavailable", "exact embedded Zap Agent source commit")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 || *installed == "" || *output == "" || *sourceOfferOutput == "" || *version == "" || (*arch != "arm64" && *arch != "amd64") {
		return errors.New("--installed, --output, --source-offer-output, --version, and --arch=arm64|amd64 are required")
	}
	if *output == *sourceOfferOutput {
		return errors.New("--output and --source-offer-output must be different files")
	}
	if _, err := time.Parse(time.RFC3339, *created); err != nil {
		return fmt.Errorf("invalid --created: %w", err)
	}
	if *imageProfile != "host-runtime" && *imageProfile != "agent-computer" {
		return errors.New("--image-profile must be host-runtime or agent-computer")
	}
	if *imageProfile == "host-runtime" && *zapVersion != "unavailable" {
		return errors.New("host-runtime SBOM must not declare an embedded Zap Agent")
	}
	packages, err := readAPKPackages(*installed)
	if err != nil {
		return err
	}
	if (*cloudHypervisorVersion == "") != (*virtioFSDVersion == "") {
		return errors.New("Linux runtime component versions must be provided together")
	}
	if !validGitCommit(*zapVMSourceCommit) {
		return errors.New("--zapvm-source-commit must be a lowercase 40-character Git commit")
	}
	if *zapVersion != "" && *zapVersion != "unavailable" && !validGitCommit(*zapSourceCommit) {
		return errors.New("--zap-source-commit is required for an embedded Zap Agent")
	}
	if *cloudHypervisorVersion != "" {
		if !validHTTPSURL(*cloudHypervisorSourceURL) || !validSHA256(*cloudHypervisorSourceSHA256) ||
			!validHTTPSURL(*virtioFSDSourceURL) || !validSHA256(*virtioFSDSourceSHA256) || !validGitCommit(*virtioFSDSourceCommit) {
			return errors.New("locked Linux runtime source URLs, SHA-256 values, and virtiofsd commit are required")
		}
	}
	document, err := buildSPDXForProfile(packages, *arch, *version, *created, *cloudHypervisorVersion, *virtioFSDVersion, *zapVersion, *imageProfile)
	if err != nil {
		return err
	}
	offer, err := buildSourceOffer(document, packages, *version, *arch, *zapVMSourceCommit, *zapSourceCommit,
		*cloudHypervisorSourceURL, *cloudHypervisorSourceSHA256, *virtioFSDSourceURL,
		*virtioFSDSourceSHA256, *virtioFSDSourceCommit)
	if err != nil {
		return err
	}
	data, err := json.MarshalIndent(document, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	offerData, err := json.MarshalIndent(offer, "", "  ")
	if err != nil {
		return err
	}
	offerData = append(offerData, '\n')
	if err := os.WriteFile(*sourceOfferOutput, offerData, 0o644); err != nil {
		return err
	}
	return os.WriteFile(*output, data, 0o644)
}

func readAPKPackages(path string) ([]apkPackage, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	var packages []apkPackage
	current := apkPackage{}
	flush := func() error {
		if current.name == "" && current.version == "" {
			return nil
		}
		if current.name == "" || current.version == "" {
			return errors.New("Alpine package record is missing name or version")
		}
		packages = append(packages, current)
		current = apkPackage{}
		return nil
	}
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			if err := flush(); err != nil {
				return nil, err
			}
			continue
		}
		if len(line) < 2 || line[1] != ':' {
			continue
		}
		switch line[0] {
		case 'P':
			current.name = line[2:]
		case 'V':
			current.version = line[2:]
		case 'L':
			current.license = line[2:]
		case 'U':
			current.homepage = line[2:]
		case 'o':
			current.origin = line[2:]
		case 'c':
			current.commit = line[2:]
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	if err := flush(); err != nil {
		return nil, err
	}
	if len(packages) == 0 {
		return nil, errors.New("Alpine installed database contained no packages")
	}
	sort.Slice(packages, func(i, j int) bool {
		if packages[i].name == packages[j].name {
			return packages[i].version < packages[j].version
		}
		return packages[i].name < packages[j].name
	})
	return packages, nil
}

func buildSPDX(apkPackages []apkPackage, arch, version, created string) (spdxDocument, error) {
	return buildSPDXWithRuntime(apkPackages, arch, version, created, "", "")
}

func buildSPDXWithRuntime(apkPackages []apkPackage, arch, version, created, cloudHypervisorVersion, virtioFSDVersion string) (spdxDocument, error) {
	return buildSPDXWithComponents(apkPackages, arch, version, created, cloudHypervisorVersion, virtioFSDVersion, "")
}

func buildSPDXWithComponents(apkPackages []apkPackage, arch, version, created, cloudHypervisorVersion, virtioFSDVersion, zapVersion string) (spdxDocument, error) {
	return buildSPDXForProfile(apkPackages, arch, version, created, cloudHypervisorVersion, virtioFSDVersion, zapVersion, "agent-computer")
}

func buildSPDXForProfile(apkPackages []apkPackage, arch, version, created, cloudHypervisorVersion, virtioFSDVersion, zapVersion, imageProfile string) (spdxDocument, error) {
	packages := make([]spdxPackage, 0, len(apkPackages)+6)
	for _, installed := range apkPackages {
		license := normalizeLicense(installed.license)
		packages = append(packages, spdxPackage{
			Name: installed.name, SPDXID: packageID("apk", installed.name, installed.version),
			VersionInfo: installed.version, DownloadLocation: "NOASSERTION", FilesAnalyzed: false,
			LicenseConcluded: "NOASSERTION", LicenseDeclared: license, CopyrightText: "NOASSERTION",
			Homepage: installed.homepage,
			ExternalRefs: []spdxExternalRef{{
				ReferenceCategory: "PACKAGE-MANAGER", ReferenceType: "purl",
				ReferenceLocator: "pkg:apk/alpine/" + installed.name + "@" + installed.version + "?arch=" + arch,
			}},
		})
	}
	zapVMPackages := []string{"zapvm-agent", "zapvm-launcher", "zapvm-plan9-mount", "zapvm-proxy-bridge", "zapvm-resident-agent"}
	for _, name := range zapVMPackages {
		packages = append(packages, spdxPackage{
			Name: name, SPDXID: packageID("zapvm", name, version), VersionInfo: version,
			DownloadLocation: "https://github.com/JackCaow/zapagent/tree/main/zapvm", FilesAnalyzed: false, LicenseConcluded: "NOASSERTION",
			LicenseDeclared: "Apache-2.0", CopyrightText: "NOASSERTION",
			ExternalRefs: []spdxExternalRef{{
				ReferenceCategory: "PACKAGE-MANAGER", ReferenceType: "purl",
				ReferenceLocator: "pkg:generic/" + name + "@" + version + "?arch=" + arch,
			}},
		})
	}
	if zapVersion != "" && zapVersion != "unavailable" {
		packages = append(packages, spdxPackage{
			Name: "zapcode", SPDXID: packageID("resident-agent", "zapcode", zapVersion), VersionInfo: zapVersion,
			DownloadLocation: "https://github.com/JackCaow/zapagent", FilesAnalyzed: false, LicenseConcluded: "NOASSERTION",
			LicenseDeclared: "ISC", CopyrightText: "NOASSERTION",
			ExternalRefs: []spdxExternalRef{{
				ReferenceCategory: "PACKAGE-MANAGER", ReferenceType: "purl",
				ReferenceLocator: "pkg:generic/zapcode@" + zapVersion + "?arch=" + arch,
			}},
		})
	}
	for _, runtimePackage := range []struct {
		name, version, purl, downloadLocation string
	}{
		{
			"cloud-hypervisor", cloudHypervisorVersion,
			"pkg:github/cloud-hypervisor/cloud-hypervisor@" + cloudHypervisorVersion,
			"https://github.com/cloud-hypervisor/cloud-hypervisor/archive/refs/tags/" + cloudHypervisorVersion + ".tar.gz",
		},
		{
			"virtiofsd", virtioFSDVersion,
			"pkg:generic/virtiofsd@" + virtioFSDVersion,
			"https://gitlab.com/virtio-fs/virtiofsd/-/archive/" + virtioFSDVersion + "/virtiofsd-" + virtioFSDVersion + ".tar.gz",
		},
	} {
		if runtimePackage.version == "" {
			continue
		}
		packages = append(packages, spdxPackage{
			Name: runtimePackage.name, SPDXID: packageID("host-runtime", runtimePackage.name, runtimePackage.version), VersionInfo: runtimePackage.version,
			DownloadLocation: runtimePackage.downloadLocation, FilesAnalyzed: false, LicenseConcluded: "NOASSERTION",
			LicenseDeclared: "Apache-2.0 AND BSD-3-Clause", CopyrightText: "NOASSERTION",
			ExternalRefs: []spdxExternalRef{{
				ReferenceCategory: "PACKAGE-MANAGER", ReferenceType: "purl",
				ReferenceLocator: runtimePackage.purl + "?arch=" + arch,
			}},
		})
	}
	sort.Slice(packages, func(i, j int) bool { return packages[i].SPDXID < packages[j].SPDXID })
	canonical, err := json.Marshal(packages)
	if err != nil {
		return spdxDocument{}, err
	}
	digest := sha256.Sum256(canonical)
	relationships := make([]spdxRelationship, 0, len(packages))
	for _, installed := range packages {
		relationships = append(relationships, spdxRelationship{
			SPDXElementID: "SPDXRef-DOCUMENT", RelationshipType: "DESCRIBES", RelatedSPDXElement: installed.SPDXID,
		})
	}
	return spdxDocument{
		SPDXVersion: "SPDX-2.3", DataLicense: "CC0-1.0", SPDXID: "SPDXRef-DOCUMENT",
		Name:              "zapvm-rootfs-" + arch,
		DocumentNamespace: "https://zapvm.dev/spdx/" + version + "/" + arch + "/" + hex.EncodeToString(digest[:]),
		CreationInfo:      spdxCreationInfo{Created: created, Creators: []string{"Tool: zapvm-sbom-0.1.0"}},
		Packages:          packages, Relationships: relationships,
		ExtractedLicenses: []spdxExtractedLicense{{
			LicenseID:     "LicenseRef-Alpine-Public-Domain",
			ExtractedText: "This package is identified as Public-Domain by the Alpine installed package database.",
			Name:          "Alpine Public-Domain declaration",
			Comment:       "Normalized from Alpine's non-SPDX Public-Domain token; consult the package source for exact notices.",
		}, {
			LicenseID:     "LicenseRef-Alpine-Custom",
			ExtractedText: "This package is identified as custom by the Alpine installed package database.",
			Name:          "Alpine custom license declaration",
			Comment:       "Normalized from Alpine's non-SPDX custom token; consult the package source and notices before release.",
		}},
	}, nil
}

func buildSourceOffer(document spdxDocument, apkPackages []apkPackage, imageVersion, arch, zapVMCommit, zapCommit,
	cloudHypervisorSourceURL, cloudHypervisorSourceSHA256, virtioFSDSourceURL, virtioFSDSourceSHA256, virtioFSDCommit string,
) (sourceOffer, error) {
	byID := make(map[string]spdxPackage, len(document.Packages))
	for _, pkg := range document.Packages {
		if pkg.LicenseDeclared == "" || pkg.LicenseDeclared == "NOASSERTION" || pkg.LicenseDeclared == "NONE" {
			return sourceOffer{}, fmt.Errorf("package %s has no declared license", pkg.Name)
		}
		if _, exists := byID[pkg.SPDXID]; exists {
			return sourceOffer{}, fmt.Errorf("duplicate SPDX package ID %s", pkg.SPDXID)
		}
		byID[pkg.SPDXID] = pkg
	}
	offer := sourceOffer{SchemaVersion: 1, ImageVersion: imageVersion, Architecture: arch}
	appendPackage := func(pkg spdxPackage, sourceType, sourceURL, revision, sourceSHA256 string, sourcePaths ...string) error {
		if !validHTTPSURL(sourceURL) || revision == "" {
			return fmt.Errorf("package %s has an invalid corresponding-source locator", pkg.Name)
		}
		if sourceSHA256 != "" && !validSHA256(sourceSHA256) {
			return fmt.Errorf("package %s has an invalid source SHA-256", pkg.Name)
		}
		offer.Packages = append(offer.Packages, sourceOfferPackage{
			SPDXID: pkg.SPDXID, Name: pkg.Name, Version: pkg.VersionInfo,
			LicenseDeclared: pkg.LicenseDeclared, SourceType: sourceType,
			SourceURL: sourceURL, SourceRevision: revision, SourceSHA256: sourceSHA256,
			SourcePaths: sourcePaths,
		})
		delete(byID, pkg.SPDXID)
		return nil
	}
	for _, installed := range apkPackages {
		if installed.origin == "" || !validGitCommit(installed.commit) {
			return sourceOffer{}, fmt.Errorf("Alpine package %s is missing origin or aports commit", installed.name)
		}
		pkg, exists := byID[packageID("apk", installed.name, installed.version)]
		if !exists {
			return sourceOffer{}, fmt.Errorf("Alpine package %s is missing from SPDX", installed.name)
		}
		archiveURL := "https://gitlab.alpinelinux.org/alpine/aports/-/archive/" + installed.commit + "/aports-" + installed.commit + ".tar.gz"
		if err := appendPackage(pkg, "alpine-aports", archiveURL, installed.commit, "",
			"main/"+installed.origin+"/APKBUILD", "community/"+installed.origin+"/APKBUILD",
			"testing/"+installed.origin+"/APKBUILD"); err != nil {
			return sourceOffer{}, err
		}
	}
	zapVMSourceURL := "https://github.com/JackCaow/zapagent/archive/" + zapVMCommit + ".tar.gz"
	for _, name := range []string{"zapvm-agent", "zapvm-launcher", "zapvm-plan9-mount", "zapvm-proxy-bridge", "zapvm-resident-agent"} {
		pkg, exists := byID[packageID("zapvm", name, imageVersion)]
		if !exists {
			if name == "zapvm-resident-agent" {
				continue
			}
			return sourceOffer{}, fmt.Errorf("zapVM package %s is missing from SPDX", name)
		}
		if err := appendPackage(pkg, "git-archive", zapVMSourceURL, zapVMCommit, "", "zapvm"); err != nil {
			return sourceOffer{}, err
		}
	}
	if zapCommit != "" && zapCommit != "unavailable" {
		var zapPackage *spdxPackage
		for _, pkg := range byID {
			if pkg.Name == "zapcode" {
				copy := pkg
				zapPackage = &copy
				break
			}
		}
		if zapPackage == nil {
			return sourceOffer{}, errors.New("embedded Zap source commit has no SPDX package")
		}
		url := "https://github.com/JackCaow/zapagent/archive/" + zapCommit + ".tar.gz"
		if err := appendPackage(*zapPackage, "git-archive", url, zapCommit, "", "."); err != nil {
			return sourceOffer{}, err
		}
	}
	for _, runtime := range []struct {
		name, sourceURL, sourceSHA256, revision string
	}{
		{"cloud-hypervisor", cloudHypervisorSourceURL, cloudHypervisorSourceSHA256, ""},
		{"virtiofsd", virtioFSDSourceURL, virtioFSDSourceSHA256, virtioFSDCommit},
	} {
		var runtimePackage *spdxPackage
		for _, pkg := range byID {
			if pkg.Name == runtime.name {
				copy := pkg
				runtimePackage = &copy
				break
			}
		}
		if runtimePackage == nil {
			if runtime.sourceURL == "" && runtime.sourceSHA256 == "" && runtime.revision == "" {
				continue
			}
			return sourceOffer{}, fmt.Errorf("runtime package %s is missing from SPDX", runtime.name)
		}
		revision := runtime.revision
		if revision == "" {
			revision = runtimePackage.VersionInfo
		}
		if err := appendPackage(*runtimePackage, "release-source-archive", runtime.sourceURL, revision, runtime.sourceSHA256, "."); err != nil {
			return sourceOffer{}, err
		}
	}
	if len(byID) != 0 {
		names := make([]string, 0, len(byID))
		for _, pkg := range byID {
			names = append(names, pkg.Name)
		}
		sort.Strings(names)
		return sourceOffer{}, fmt.Errorf("source offer does not cover SPDX packages: %s", strings.Join(names, ", "))
	}
	sort.Slice(offer.Packages, func(i, j int) bool { return offer.Packages[i].SPDXID < offer.Packages[j].SPDXID })
	return offer, nil
}

func validGitCommit(value string) bool {
	return len(value) == 40 && validLowerHex(value)
}

func validSHA256(value string) bool {
	return len(value) == 64 && validLowerHex(value)
}

func validLowerHex(value string) bool {
	for _, character := range value {
		if (character < '0' || character > '9') && (character < 'a' || character > 'f') {
			return false
		}
	}
	return true
}

func validHTTPSURL(value string) bool {
	return strings.HasPrefix(value, "https://") && !strings.ContainsAny(value, "\r\n\t ")
}

func normalizeLicense(value string) string {
	if value == "" {
		return "NOASSERTION"
	}
	value = strings.ReplaceAll(value, "Public-Domain", "LicenseRef-Alpine-Public-Domain")
	if value == "custom" {
		return "LicenseRef-Alpine-Custom"
	}
	return value
}

func packageID(kind, name, version string) string {
	digest := sha256.Sum256([]byte(kind + "\x00" + name + "\x00" + version))
	var cleaned strings.Builder
	for _, character := range name {
		if unicode.IsLetter(character) || unicode.IsDigit(character) || character == '.' || character == '-' {
			cleaned.WriteRune(character)
		} else {
			cleaned.WriteByte('-')
		}
	}
	return "SPDXRef-Package-" + cleaned.String() + "-" + hex.EncodeToString(digest[:6])
}

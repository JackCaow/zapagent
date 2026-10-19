package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/theupdateframework/go-tuf/v2/metadata"
	"github.com/theupdateframework/go-tuf/v2/metadata/config"
	"github.com/theupdateframework/go-tuf/v2/metadata/updater"
)

func TestCreateTUFRepositoryPublishesIndependentTargets(t *testing.T) {
	fixture := makeTUFRepositoryFixture(t)
	output := filepath.Join(fixture.root, "repository")
	if err := createTUFRepository(fixture.arguments(output)); err != nil {
		t.Fatal(err)
	}
	for _, directory := range []string{output, filepath.Join(output, "metadata"), filepath.Join(output, "targets")} {
		info, err := os.Stat(directory)
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm() != 0o755 {
			t.Fatalf("published repository directory %s mode = %o, want 755", directory, info.Mode().Perm())
		}
	}
	rootData := mustRead(t, filepath.Join(output, "metadata", "1.root.json"))
	root, err := metadata.Root().FromBytes(rootData)
	if err != nil {
		t.Fatal(err)
	}
	if !root.Signed.ConsistentSnapshot || len(root.Signed.Keys) != 4 {
		t.Fatalf("unexpected root role configuration: %+v", root.Signed)
	}
	keyIDs := make(map[string]struct{}, 4)
	for _, role := range []string{metadata.ROOT, metadata.TARGETS, metadata.SNAPSHOT, metadata.TIMESTAMP} {
		roleInfo := root.Signed.Roles[role]
		if roleInfo == nil || roleInfo.Threshold != 1 || len(roleInfo.KeyIDs) != 1 {
			t.Fatalf("unexpected %s role: %+v", role, roleInfo)
		}
		keyIDs[roleInfo.KeyIDs[0]] = struct{}{}
	}
	if len(keyIDs) != 4 {
		t.Fatalf("TUF roles do not use four distinct keys: %+v", root.Signed.Roles)
	}

	configuration, err := config.New("https://updates.example.test/metadata/", rootData)
	if err != nil {
		t.Fatal(err)
	}
	configuration.LocalMetadataDir = filepath.Join(fixture.root, "client-metadata")
	configuration.LocalTargetsDir = filepath.Join(fixture.root, "client-targets")
	configuration.RemoteTargetsURL = "https://updates.example.test/targets/"
	tufUpdater, err := updater.New(configuration)
	if err != nil {
		t.Fatal(err)
	}
	trusted := tufUpdater.GetTrustedMetadataSet()
	targetsData := mustRead(t, filepath.Join(output, "metadata", "1.targets.json"))
	if _, err := trusted.UpdateTimestamp(mustRead(t, filepath.Join(output, "metadata", "timestamp.json"))); err != nil {
		t.Fatal(err)
	}
	if _, err := trusted.UpdateSnapshot(mustRead(t, filepath.Join(output, "metadata", "1.snapshot.json")), false); err != nil {
		t.Fatal(err)
	}
	if _, err := trusted.UpdateDelegatedTargets(targetsData, metadata.TARGETS, metadata.ROOT); err != nil {
		t.Fatal(err)
	}
	if len(trusted.Targets[metadata.TARGETS].Signed.Targets) != 5 {
		t.Fatalf("published target count = %d, want 5", len(trusted.Targets[metadata.TARGETS].Signed.Targets))
	}
	composition := trusted.Targets[metadata.TARGETS].Signed.Targets["channels/rc/arm64.composition.tar.zst"]
	custom, err := decodeUpdateTargetCustom(composition.Custom)
	if err != nil {
		t.Fatal(err)
	}
	if custom.SchemaVersion != 3 || custom.ImageVersion != "image-rc5" || custom.LayerTargets == nil {
		t.Fatalf("unexpected composition custom metadata: %+v", custom)
	}

	if err := createTUFRepository(fixture.arguments(output)); err == nil || !strings.Contains(err.Error(), "already exists") {
		t.Fatalf("repository output overwrite was not rejected: %v", err)
	}
}

func TestCreateTUFRepositoryRejectsRoleKeyReuse(t *testing.T) {
	fixture := makeTUFRepositoryFixture(t)
	arguments := fixture.arguments(filepath.Join(fixture.root, "repository"))
	for position, value := range arguments {
		if value == "--targets-private-key" {
			arguments[position+1] = fixture.keyPaths[0]
			break
		}
	}
	if err := createTUFRepository(arguments); err == nil || !strings.Contains(err.Error(), "must use different keys") {
		t.Fatalf("TUF role key reuse was not rejected: %v", err)
	}
}

func TestCreateTUFRepositoryRejectsStableSingleProcessPublication(t *testing.T) {
	fixture := makeTUFRepositoryFixture(t)
	arguments := fixture.arguments(filepath.Join(fixture.root, "repository"))
	for position, value := range arguments {
		if value == "--channel" {
			arguments[position+1] = "stable"
			break
		}
	}
	if err := createTUFRepository(arguments); err == nil || !strings.Contains(err.Error(), "separated production roles") {
		t.Fatalf("single-process stable publication was not rejected: %v", err)
	}
}

func TestReadTUFPublicationIndexRejectsTrailingAndPayloadDrift(t *testing.T) {
	fixture := makeTUFRepositoryFixture(t)
	indexPath := filepath.Join(fixture.layers, "layer-targets.json")
	original := mustRead(t, indexPath)
	if err := os.WriteFile(indexPath, append(original, []byte("{}")...), 0o600); err != nil {
		t.Fatal(err)
	}
	customRaw := json.RawMessage(mustRead(t, fixture.customPath))
	custom, err := decodeUpdateTargetCustom(&customRaw)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := readTUFPublicationIndex(indexPath, "arm64", custom); err == nil || !strings.Contains(err.Error(), "trailing") {
		t.Fatalf("trailing index data was not rejected: %v", err)
	}
	if err := os.WriteFile(indexPath, original, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(fixture.layers, "arm64.composition.tar.zst"), []byte("drift"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := createTUFRepository(fixture.arguments(filepath.Join(fixture.root, "repository"))); err == nil || !strings.Contains(err.Error(), "mismatch") {
		t.Fatalf("target payload drift was not rejected: %v", err)
	}
}

func TestParseTUFExpiriesRequiresCanonicalOrder(t *testing.T) {
	if _, err := parseTUFExpiries("2030-01-01T00:00:00Z", "2029-01-01T00:00:00Z", "2028-01-01T00:00:00Z", "2027-01-01T00:00:00Z"); err != nil {
		t.Fatal(err)
	}
	for _, values := range [][]string{
		{"2030-01-01T00:00:00+00:00", "2029-01-01T00:00:00Z", "2028-01-01T00:00:00Z", "2027-01-01T00:00:00Z"},
		{"2027-01-01T00:00:00Z", "2028-01-01T00:00:00Z", "2029-01-01T00:00:00Z", "2030-01-01T00:00:00Z"},
	} {
		if _, err := parseTUFExpiries(values[0], values[1], values[2], values[3]); err == nil {
			t.Fatalf("invalid expiry sequence accepted: %v", values)
		}
	}
	past := time.Now().UTC().Add(-time.Hour).Format(time.RFC3339)
	if _, err := parseTUFExpiries("2030-01-01T00:00:00Z", "2029-01-01T00:00:00Z", "2028-01-01T00:00:00Z", past); err == nil || !strings.Contains(err.Error(), "future") {
		t.Fatalf("expired timestamp metadata was accepted: %v", err)
	}
}

type tufRepositoryFixture struct {
	root, layers, customPath string
	keyPaths                 []string
}

func makeTUFRepositoryFixture(t *testing.T) tufRepositoryFixture {
	t.Helper()
	root := t.TempDir()
	layers := filepath.Join(root, "layers")
	if err := os.Mkdir(layers, 0o700); err != nil {
		t.Fatal(err)
	}
	index := layerBundleIndex{
		SchemaVersion: 1, ImageVersion: "image-rc5", Architecture: "arm64",
		Layers: map[string]layerBundleIndexTarget{},
	}
	composition := []byte("composition")
	index.Composition = writeTUFRepositoryFixtureTarget(t, layers, "arm64.composition.tar.zst", "", composition)
	layersVector := updateTargetLayers{Base: "base-1", Runtime: "runtime-1", Agent: "agent-1", Session: "session-1"}
	targetsVector := updateLayerTargets{}
	for _, name := range []string{"base", "runtime", "agent", "session"} {
		version := layerVersionForName(layersVector, name)
		fileName := "arm64." + name + "-" + version + ".layer.tar.zst"
		index.Layers[name] = writeTUFRepositoryFixtureTarget(t, layers, fileName, version, []byte(name+"-payload"))
		switch name {
		case "base":
			targetsVector.Base = "layers/arm64/" + fileName
		case "runtime":
			targetsVector.Runtime = "layers/arm64/" + fileName
		case "agent":
			targetsVector.Agent = "layers/arm64/" + fileName
		case "session":
			targetsVector.Session = "layers/arm64/" + fileName
		}
	}
	indexData, err := json.Marshal(index)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(layers, "layer-targets.json"), indexData, 0o600); err != nil {
		t.Fatal(err)
	}
	custom := updateTargetCustom{
		SchemaVersion: 3, ReleaseSequence: 5, ImageVersion: "image-rc5", Architecture: "arm64",
		ManifestSHA256: strings.Repeat("a", 64), Layers: &layersVector, LayerTargets: &targetsVector,
	}
	customData, err := json.Marshal(custom)
	if err != nil {
		t.Fatal(err)
	}
	customPath := filepath.Join(root, "custom.json")
	if err := os.WriteFile(customPath, customData, 0o600); err != nil {
		t.Fatal(err)
	}
	keys := make([]string, 4)
	for position := range keys {
		privatePath := filepath.Join(root, "role-"+string(rune('0'+position))+"-private.pem")
		publicPath := filepath.Join(root, "role-"+string(rune('0'+position))+"-public.pem")
		if err := generateKeys([]string{"--private", privatePath, "--public", publicPath}); err != nil {
			t.Fatal(err)
		}
		keys[position] = privatePath
	}
	return tufRepositoryFixture{root: root, layers: layers, customPath: customPath, keyPaths: keys}
}

func writeTUFRepositoryFixtureTarget(t *testing.T, root, name, version string, payload []byte) layerBundleIndexTarget {
	t.Helper()
	if err := os.WriteFile(filepath.Join(root, name), payload, 0o600); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(payload)
	return layerBundleIndexTarget{Version: version, Path: name, Size: int64(len(payload)), SHA256: hex.EncodeToString(digest[:])}
}

func (fixture tufRepositoryFixture) arguments(output string) []string {
	return []string{
		"--layer-target-dir", fixture.layers, "--custom-metadata", fixture.customPath,
		"--root-private-key", fixture.keyPaths[0], "--targets-private-key", fixture.keyPaths[1],
		"--snapshot-private-key", fixture.keyPaths[2], "--timestamp-private-key", fixture.keyPaths[3],
		"--channel", "rc", "--arch", "arm64", "--metadata-version", "1", "--root-version", "1",
		"--root-expires", "2030-01-01T00:00:00Z", "--targets-expires", "2029-01-01T00:00:00Z",
		"--snapshot-expires", "2028-01-01T00:00:00Z", "--timestamp-expires", "2027-01-01T00:00:00Z",
		"--output-dir", output,
	}
}

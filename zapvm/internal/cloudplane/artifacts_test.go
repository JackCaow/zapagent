package cloudplane

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"strings"
	"testing"
	"time"
)

type testArtifactObjectStore struct {
	objects map[string][]byte
	puts    int
}

func (store *testArtifactObjectStore) Put(_ context.Context, key, _ string, size uint64, expectedSHA256 string, reader io.Reader) error {
	data, err := io.ReadAll(io.LimitReader(reader, int64(size)+1))
	digest := sha256.Sum256(data)
	if err != nil || uint64(len(data)) != size || hex.EncodeToString(digest[:]) != expectedSHA256 {
		return errors.New("object upload size or digest mismatch")
	}
	if store.objects == nil {
		store.objects = make(map[string][]byte)
	}
	store.objects[key] = append([]byte(nil), data...)
	store.puts++
	return nil
}

func (store *testArtifactObjectStore) SignedGetURL(_ context.Context, key, name, _ string, _ time.Duration) (string, error) {
	if _, exists := store.objects[key]; !exists {
		return "", ErrNotFound
	}
	return "https://objects.example.test/download/" + key + "?name=" + name + "&signature=test", nil
}

func (store *testArtifactObjectStore) Delete(_ context.Context, key string) error {
	delete(store.objects, key)
	return nil
}

func residentArtifactTask(t *testing.T, store *Store, id string, scope Scope) Task {
	t.Helper()
	registerTestNodeA(t, store)
	request := residentAgentSubmitRequest{
		ID: id, ComputerID: "computer-a", SessionID: "artifact-session", Prompt: "produce a report",
		ProviderBaseURL: "https://api.example.test/v1", Model: "model-1", ModelCredentialID: "model-api-key",
		TimeoutMillis: 60000,
	}
	command, credentials, err := request.command()
	if err != nil {
		t.Fatal(err)
	}
	payload, err := json.Marshal(command)
	if err != nil {
		t.Fatal(err)
	}
	task, created, err := store.SubmitAgentSession(testPrincipalA, SubmitRequest{
		ID: id, Scope: scope, ComputerID: "computer-a", Payload: payload, CredentialIDs: credentials,
	}, request.SessionID, false)
	if err != nil || !created {
		t.Fatalf("submit resident Artifact Task = %#v, %t, %v", task, created, err)
	}
	return task
}

func TestStoreArtifactRegistrationIsLeaseBoundIdempotentAndDurable(t *testing.T) {
	clock := &testClock{now: time.Date(2026, 8, 8, 1, 0, 0, 0, time.UTC)}
	store, root := openTestStore(t, clock)
	scope := Scope{TenantID: "acme", ProjectID: "weather"}
	residentArtifactTask(t, store, "artifact-task", scope)
	if _, err := store.RegisterNode("node-a", "generation-00001"); err != nil {
		t.Fatal(err)
	}
	leases, err := store.Claim("node-a", "generation-00001", 1)
	if err != nil || len(leases) != 1 {
		t.Fatalf("claim = %#v, %v", leases, err)
	}
	lease := leases[0]
	if _, err := store.Acknowledge("node-a", "generation-00001", lease.Task.ID, lease.LeaseToken); err != nil {
		t.Fatal(err)
	}
	request := ArtifactRegistrationRequest{
		ID: "artifact-report", Path: "outputs/report.json", ContentType: "Application/JSON; charset=utf-8",
		Size: 42, SHA256: strings.Repeat("a", 64), RetentionSeconds: uint64((2 * time.Hour) / time.Second),
	}
	if _, _, err := store.RegisterArtifact("node-a", "generation-00001", lease.Task.ID, "wrong", request); !errors.Is(err, ErrFenced) {
		t.Fatalf("wrong lease registration error = %v", err)
	}
	artifact, created, err := store.RegisterArtifact("node-a", "generation-00001", lease.Task.ID, lease.LeaseToken, request)
	if err != nil || !created || artifact.Scope() != scope || artifact.ComputerID != "computer-a" || artifact.SessionID != "artifact-session" ||
		artifact.TaskID != lease.Task.ID || artifact.Name != "report.json" || artifact.State != ArtifactPending || artifact.ContentType != "application/json; charset=utf-8" {
		t.Fatalf("registered Artifact = %#v, %t, %v", artifact, created, err)
	}
	if artifact.ObjectKey != "" {
		t.Fatalf("pending Artifact acquired object authority before upload preparation: %#v", artifact)
	}
	prepared, upload, err := store.PrepareArtifactUpload("node-a", "generation-00001", lease.Task.ID, lease.LeaseToken, artifact.ID)
	if err != nil || !upload || !validArtifactObjectKey(prepared.ObjectKey) {
		t.Fatalf("prepared Artifact is not internally tracked for orphan cleanup: %#v, %t, %v", prepared, upload, err)
	}
	artifact = prepared
	replayed, created, err := store.RegisterArtifact("node-a", "generation-00001", lease.Task.ID, lease.LeaseToken, request)
	if err != nil || created || replayed != artifact {
		t.Fatalf("idempotent Artifact = %#v, %t, %v", replayed, created, err)
	}
	conflict := request
	conflict.Path = "outputs/other.json"
	if _, _, err := store.RegisterArtifact("node-a", "generation-00001", lease.Task.ID, lease.LeaseToken, conflict); !errors.Is(err, ErrConflict) {
		t.Fatalf("conflicting Artifact error = %v", err)
	}
	protected := request
	protected.ID = "artifact-protected"
	protected.Path = ".git/config"
	if _, _, err := store.RegisterArtifact("node-a", "generation-00001", lease.Task.ID, lease.LeaseToken, protected); err == nil {
		t.Fatal("protected Artifact path was accepted")
	}
	if _, err := store.InspectAgentArtifact(Scope{TenantID: "beta", ProjectID: "build"}, artifact.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("cross-tenant Artifact inspect error = %v", err)
	}
	audit, err := store.Audit(scope, 0, 100)
	if err != nil || len(audit) == 0 || audit[len(audit)-1].ArtifactID != artifact.ID || audit[len(audit)-1].Action != "artifact_register" {
		t.Fatalf("Artifact audit = %#v, %v", audit, err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := Open(root, testProvisions(), Options{
		Now: clock.Now, Random: bytes.NewReader(bytes.Repeat([]byte{0x42}, 1024)), HeartbeatTTL: 20 * time.Second, LeaseTTL: 30 * time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	recovered, err := reopened.InspectAgentArtifact(scope, artifact.ID)
	if err != nil || recovered != artifact {
		t.Fatalf("recovered Artifact = %#v, %v", recovered, err)
	}
	clock.Advance(2*time.Hour + time.Second)
	if err := reopened.Sweep(); err != nil {
		t.Fatal(err)
	}
	expired, err := reopened.InspectAgentArtifact(scope, artifact.ID)
	if err != nil || expired.State != ArtifactExpired || expired.UpdatedAt == artifact.UpdatedAt {
		t.Fatalf("expired Artifact = %#v, %v", expired, err)
	}
	candidates, err := reopened.ExpiredArtifactObjects(10)
	if err != nil || len(candidates) != 1 || candidates[0].ObjectKey != artifact.ObjectKey {
		t.Fatalf("expired pending Artifact cleanup candidates = %#v, %v", candidates, err)
	}
}

func TestAPIArtifactRegistrationAndTenantScopedMetadata(t *testing.T) {
	clock := &testClock{now: time.Date(2026, 8, 8, 2, 0, 0, 0, time.UTC)}
	store, _ := openTestStore(t, clock)
	registerTestNodeA(t, store)
	objects := &testArtifactObjectStore{}
	api, err := NewAPIWithArtifactStore(store, "example.test", []string{testPrincipalA}, objects, log.New(io.Discard, "", 0))
	if err != nil {
		t.Fatal(err)
	}
	handler := api.Handler()
	submit := map[string]any{
		"id": "artifact-api-task", "computer_id": "computer-a", "session_id": "artifact-api-session",
		"prompt": "produce output", "provider_base_url": "https://api.example.test/v1", "model": "model-1",
		"model_credential_id": "model-api-key", "timeout_ms": 60000,
	}
	if response := callAPI(t, handler, apiRequest(t, http.MethodPost, "/v1/agent/sessions", testPrincipalA, submit)); response.Code != http.StatusCreated {
		t.Fatalf("submit status=%d body=%s", response.Code, response.Body.String())
	}
	nodePrincipal := "spiffe://example.test/node/node-a"
	if response := callAPI(t, handler, apiRequest(t, http.MethodPost, "/v1/node/register", nodePrincipal, map[string]any{"generation": "generation-00001"})); response.Code != http.StatusOK {
		t.Fatalf("register status=%d body=%s", response.Code, response.Body.String())
	}
	claim := callAPI(t, handler, apiRequest(t, http.MethodPost, "/v1/node/claim", nodePrincipal, map[string]any{"generation": "generation-00001", "maximum": 1}))
	var claimed struct {
		Leases []Lease `json:"leases"`
	}
	if claim.Code != http.StatusOK || json.Unmarshal(claim.Body.Bytes(), &claimed) != nil || len(claimed.Leases) != 1 {
		t.Fatalf("claim status=%d body=%s", claim.Code, claim.Body.String())
	}
	proof := map[string]any{"generation": "generation-00001", "lease_token": claimed.Leases[0].LeaseToken}
	if response := callAPI(t, handler, apiRequest(t, http.MethodPost, "/v1/node/tasks/artifact-api-task/ack", nodePrincipal, proof)); response.Code != http.StatusOK {
		t.Fatalf("ack status=%d body=%s", response.Code, response.Body.String())
	}
	artifactData := []byte("zip")
	digest := sha256.Sum256(artifactData)
	artifactSHA256 := hex.EncodeToString(digest[:])
	registration := map[string]any{
		"generation": "generation-00001", "lease_token": claimed.Leases[0].LeaseToken,
		"artifact": map[string]any{
			"id": "artifact-api-output", "path": "dist/output.zip", "content_type": "application/zip",
			"size": len(artifactData), "sha256": artifactSHA256, "retention_seconds": 3600,
		},
	}
	created := callAPI(t, handler, apiRequest(t, http.MethodPost, "/v1/node/tasks/artifact-api-task/artifacts", nodePrincipal, registration))
	if created.Code != http.StatusCreated || !strings.Contains(created.Body.String(), `"state":"pending"`) {
		t.Fatalf("Artifact registration status=%d body=%s", created.Code, created.Body.String())
	}
	if replay := callAPI(t, handler, apiRequest(t, http.MethodPost, "/v1/node/tasks/artifact-api-task/artifacts", nodePrincipal, registration)); replay.Code != http.StatusOK {
		t.Fatalf("Artifact replay status=%d body=%s", replay.Code, replay.Body.String())
	}
	uploadRequest := apiRequest(t, http.MethodPut, "/v1/node/tasks/artifact-api-task/artifacts/artifact-api-output/content", nodePrincipal, nil)
	uploadRequest.Body = io.NopCloser(bytes.NewReader(artifactData))
	uploadRequest.ContentLength = int64(len(artifactData))
	uploadRequest.Header.Set("Content-Type", "application/zip")
	uploadRequest.Header.Set("X-ZapVM-Artifact-SHA256", artifactSHA256)
	uploadRequest.Header.Set("X-ZapVM-Node-Generation", "generation-00001")
	uploadRequest.Header.Set("X-ZapVM-Lease-Token", claimed.Leases[0].LeaseToken)
	upload := callAPI(t, handler, uploadRequest)
	if upload.Code != http.StatusCreated || !strings.Contains(upload.Body.String(), `"state":"available"`) || objects.puts != 1 {
		t.Fatalf("Artifact upload status=%d body=%s puts=%d", upload.Code, upload.Body.String(), objects.puts)
	}
	retryRequest := uploadRequest.Clone(context.Background())
	retryRequest.Body = io.NopCloser(bytes.NewReader(artifactData))
	retryRequest.ContentLength = int64(len(artifactData))
	retry := callAPI(t, handler, retryRequest)
	if retry.Code != http.StatusOK || objects.puts != 1 {
		t.Fatalf("Artifact upload retry status=%d body=%s puts=%d", retry.Code, retry.Body.String(), objects.puts)
	}
	list := callAPI(t, handler, apiRequest(t, http.MethodGet, "/v1/agent/sessions/artifact-api-task/artifacts?after=0&limit=10", testPrincipalA, nil))
	inspect := callAPI(t, handler, apiRequest(t, http.MethodGet, "/v1/agent/artifacts/artifact-api-output", testPrincipalA, nil))
	if list.Code != http.StatusOK || inspect.Code != http.StatusOK || !strings.Contains(list.Body.String(), `"artifact-api-output"`) ||
		!strings.Contains(inspect.Body.String(), `"task_id":"artifact-api-task"`) || !strings.Contains(inspect.Body.String(), `"state":"available"`) {
		t.Fatalf("Artifact list=%d %s inspect=%d %s", list.Code, list.Body.String(), inspect.Code, inspect.Body.String())
	}
	download := callAPI(t, handler, apiRequest(t, http.MethodGet, "/v1/agent/artifacts/artifact-api-output/download", testPrincipalA, nil))
	if download.Code != http.StatusOK || !strings.Contains(download.Body.String(), "https://objects.example.test/download/") ||
		!strings.Contains(download.Body.String(), "signature=test") {
		t.Fatalf("Artifact download status=%d body=%s", download.Code, download.Body.String())
	}
	for _, body := range []string{created.Body.String(), list.Body.String(), inspect.Body.String()} {
		for _, forbidden := range []string{"tenant_id", "project_id", "registered_node", "generation-00001", "lease_token"} {
			if strings.Contains(body, forbidden) {
				t.Fatalf("public Artifact response exposes %q: %s", forbidden, body)
			}
		}
	}
	cross := callAPI(t, handler, apiRequest(t, http.MethodGet, "/v1/agent/artifacts/artifact-api-output", testPrincipalB, nil))
	crossDownload := callAPI(t, handler, apiRequest(t, http.MethodGet, "/v1/agent/artifacts/artifact-api-output/download", testPrincipalB, nil))
	if cross.Code != http.StatusNotFound || crossDownload.Code != http.StatusNotFound {
		t.Fatalf("cross-tenant Artifact status=%d body=%s download=%d %s", cross.Code, cross.Body.String(), crossDownload.Code, crossDownload.Body.String())
	}
	clientWrite := callAPI(t, handler, apiRequest(t, http.MethodPost, "/v1/agent/artifacts/artifact-api-output", testPrincipalA, registration))
	if clientWrite.Code != http.StatusMethodNotAllowed {
		t.Fatalf("client Artifact write status=%d body=%s", clientWrite.Code, clientWrite.Body.String())
	}
	clock.Advance(time.Hour + time.Second)
	if err := store.Sweep(); err != nil {
		t.Fatal(err)
	}
	expiredDownload := callAPI(t, handler, apiRequest(t, http.MethodGet, "/v1/agent/artifacts/artifact-api-output/download", testPrincipalA, nil))
	if expiredDownload.Code != http.StatusConflict {
		t.Fatalf("expired Artifact download status=%d body=%s", expiredDownload.Code, expiredDownload.Body.String())
	}
	candidates, err := store.ExpiredArtifactObjects(10)
	if err != nil || len(candidates) != 1 || candidates[0].ID != "artifact-api-output" {
		t.Fatalf("expired Artifact GC candidates=%#v err=%v", candidates, err)
	}
	if err := objects.Delete(context.Background(), candidates[0].ObjectKey); err != nil {
		t.Fatal(err)
	}
	if err := store.ConfirmArtifactObjectDeleted(candidates[0].ID, candidates[0].ObjectKey); err != nil {
		t.Fatal(err)
	}
	deleted, err := store.InspectAgentArtifact(Scope{TenantID: "acme", ProjectID: "weather"}, "artifact-api-output")
	if err != nil || deleted.State != ArtifactExpired || deleted.ObjectKey != "" || deleted.AvailableAt != "" || len(objects.objects) != 0 {
		t.Fatalf("deleted Artifact=%#v objects=%#v err=%v", deleted, objects.objects, err)
	}
	audit, err := store.Audit(Scope{TenantID: "acme", ProjectID: "weather"}, 0, 100)
	if err != nil || len(audit) == 0 || audit[len(audit)-1].Action != "artifact_delete" || audit[len(audit)-1].Outcome != "deleted" {
		t.Fatalf("Artifact delete audit=%#v err=%v", audit, err)
	}
	clock.Advance(artifactMetadataRetention + time.Second)
	if err := store.Sweep(); err != nil {
		t.Fatal(err)
	}
	if _, err := store.InspectAgentArtifact(Scope{TenantID: "acme", ProjectID: "weather"}, "artifact-api-output"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("expired deleted Artifact metadata was retained after its recovery window: %v", err)
	}
	audit, err = store.Audit(Scope{TenantID: "acme", ProjectID: "weather"}, 0, 100)
	if err != nil || len(audit) == 0 || audit[len(audit)-1].Action != "artifact_prune" || audit[len(audit)-1].Outcome != "retention" {
		t.Fatalf("Artifact prune audit=%#v err=%v", audit, err)
	}
}

func TestStoreArtifactByteQuotaIsStableAndExcludesExpiredRecords(t *testing.T) {
	clock := &testClock{now: time.Date(2026, 8, 8, 2, 30, 0, 0, time.UTC)}
	store, _ := openTestStore(t, clock)
	store.artifactBytesPerTask = uint64(5 << 30)
	store.artifactBytesPerScope = uint64(8 << 30)
	scope := Scope{TenantID: "acme", ProjectID: "weather"}
	residentArtifactTask(t, store, "artifact-quota-task", scope)
	if _, err := store.RegisterNode("node-a", "generation-00001"); err != nil {
		t.Fatal(err)
	}
	leases, err := store.Claim("node-a", "generation-00001", 1)
	if err != nil || len(leases) != 1 {
		t.Fatalf("claim=%#v err=%v", leases, err)
	}
	lease := leases[0]
	if _, err := store.Acknowledge("node-a", "generation-00001", lease.Task.ID, lease.LeaseToken); err != nil {
		t.Fatal(err)
	}
	first := ArtifactRegistrationRequest{
		ID: "artifact-quota-a", Path: "artifacts/a.bin", ContentType: "application/octet-stream",
		Size: uint64(3 << 30), SHA256: strings.Repeat("a", 64), RetentionSeconds: 3600,
	}
	if _, _, err := store.RegisterArtifact("node-a", "generation-00001", lease.Task.ID, lease.LeaseToken, first); err != nil {
		t.Fatal(err)
	}
	second := first
	second.ID = "artifact-quota-b"
	second.Path = "artifacts/b.bin"
	second.SHA256 = strings.Repeat("b", 64)
	if _, _, err := store.RegisterArtifact("node-a", "generation-00001", lease.Task.ID, lease.LeaseToken, second); !errors.Is(err, ErrQuotaReached) {
		t.Fatalf("Artifact byte quota error=%v", err)
	}
	descriptor := classifyAPIError("quota_exceeded")
	if descriptor.Category != "quota" || descriptor.Action != "reduce_usage" || descriptor.Retryable {
		t.Fatalf("quota descriptor=%#v", descriptor)
	}
	clock.Advance(time.Hour + time.Second)
	if err := store.Sweep(); err != nil {
		t.Fatal(err)
	}
	if _, err := store.RegisterNode("node-a", "generation-00001"); err != nil {
		t.Fatal(err)
	}
	leases, err = store.Claim("node-a", "generation-00001", 1)
	if err != nil || len(leases) != 1 {
		t.Fatalf("reclaim=%#v err=%v", leases, err)
	}
	lease = leases[0]
	if _, err := store.Acknowledge("node-a", "generation-00001", lease.Task.ID, lease.LeaseToken); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.RegisterArtifact("node-a", "generation-00001", lease.Task.ID, lease.LeaseToken, second); err != nil {
		t.Fatalf("expired Artifact still consumed byte quota: %v", err)
	}
}

func TestStoreMigratesSchemaSixArtifactCollection(t *testing.T) {
	clock := &testClock{now: time.Date(2026, 8, 8, 3, 0, 0, 0, time.UTC)}
	store, root := openTestStore(t, clock)
	store.state.SchemaVersion = 6
	store.state.Artifacts = nil
	if err := writeState(root, store.state); err != nil {
		t.Fatal(err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := Open(root, testProvisions(), Options{Now: clock.Now})
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	if reopened.state.SchemaVersion != stateSchemaVersion || reopened.state.Artifacts == nil || len(reopened.state.Artifacts) != 0 {
		t.Fatalf("migrated Artifact collection = schema %d %#v", reopened.state.SchemaVersion, reopened.state.Artifacts)
	}
}

package cloudplane

import (
	"bytes"
	"net/http"
	"strings"
	"testing"

	"zapvm/internal/credential"
)

type apiCredentialBackend struct {
	Backend
	putScope Scope
	putID    string
	putValue []byte
	revoked  bool
}

func (backend *apiCredentialBackend) PutCredential(_ string, scope Scope, id string, value []byte) (CredentialDescriptor, error) {
	backend.putScope = scope
	backend.putID = id
	backend.putValue = append([]byte(nil), value...)
	return CredentialDescriptor{ID: id, Version: 1, State: "active", CreatedAt: "2026-08-08T12:00:00Z", UpdatedAt: "2026-08-08T12:00:00Z"}, nil
}

func (backend *apiCredentialBackend) ListCredentials(scope Scope) ([]CredentialDescriptor, error) {
	if scope != backend.putScope {
		return nil, ErrUnauthorized
	}
	return []CredentialDescriptor{{ID: backend.putID, Version: 1, State: "active", CreatedAt: "2026-08-08T12:00:00Z", UpdatedAt: "2026-08-08T12:00:00Z"}}, nil
}

func (backend *apiCredentialBackend) RevokeCredential(_ string, scope Scope, id string) (CredentialDescriptor, error) {
	if scope != backend.putScope || id != backend.putID {
		return CredentialDescriptor{}, ErrNotFound
	}
	backend.revoked = true
	return CredentialDescriptor{ID: id, Version: 1, State: "revoked", CreatedAt: "2026-08-08T12:00:00Z", UpdatedAt: "2026-08-08T12:01:00Z"}, nil
}

func (backend *apiCredentialBackend) RedeemCredentialCapability(nodeID, generation, taskID, leaseToken string, capability CredentialCapability) (CredentialBundle, error) {
	if nodeID != "node-a" || generation != "generation-00001" || taskID != "task-credential" || leaseToken != "lease-token" ||
		capability.ID != "credcap_api_test_0001" || !bytes.Equal(capability.Secret, bytes.Repeat([]byte{0x42}, 32)) {
		return CredentialBundle{}, ErrFenced
	}
	return CredentialBundle{Values: map[string][]byte{"model-key": []byte("runtime-private-value")}}, nil
}

func TestCredentialAPIStoresOnlyDescriptorsAndRedeemsOnlyForNode(t *testing.T) {
	clock := &testClock{}
	store, _ := openTestStore(t, clock)
	backend := &apiCredentialBackend{Backend: store}
	t.Cleanup(func() { credential.ZeroBytes(backend.putValue) })
	api, err := NewAPI(backend, "example.test", []string{testPrincipalA})
	if err != nil {
		t.Fatal(err)
	}
	handler := api.Handler()
	privateValue := []byte("tenant-private-value")
	put := callAPI(t, handler, apiRequest(t, http.MethodPut, "/v1/agent/credentials/model-key", testPrincipalA, map[string]any{"value": privateValue}))
	if put.Code != http.StatusOK || !bytes.Equal(backend.putValue, privateValue) || backend.putScope != (Scope{TenantID: "acme", ProjectID: "weather"}) ||
		strings.Contains(put.Body.String(), "tenant-private-value") || strings.Contains(put.Body.String(), "value") {
		t.Fatalf("Credential PUT status=%d scope=%#v body=%s", put.Code, backend.putScope, put.Body.String())
	}
	list := callAPI(t, handler, apiRequest(t, http.MethodGet, "/v1/agent/credentials", testPrincipalA, nil))
	if list.Code != http.StatusOK || !strings.Contains(list.Body.String(), `"id":"model-key"`) || strings.Contains(list.Body.String(), "private") {
		t.Fatalf("Credential list status=%d body=%s", list.Code, list.Body.String())
	}
	crossTenant := callAPI(t, handler, apiRequest(t, http.MethodGet, "/v1/agent/credentials", testPrincipalB, nil))
	if crossTenant.Code != http.StatusForbidden {
		t.Fatalf("cross-tenant Credential list status=%d body=%s", crossTenant.Code, crossTenant.Body.String())
	}
	capabilitySecret := bytes.Repeat([]byte{0x42}, 32)
	redeem := callAPI(t, handler, apiRequest(t, http.MethodPost, "/v1/node/tasks/task-credential/credentials", "spiffe://example.test/node/node-a", map[string]any{
		"generation": "generation-00001", "lease_token": "lease-token",
		"capability": map[string]any{"id": "credcap_api_test_0001", "secret": capabilitySecret, "expires_at": "2026-08-08T12:05:00Z"},
	}))
	if redeem.Code != http.StatusOK || !strings.Contains(redeem.Body.String(), "cnVudGltZS1wcml2YXRlLXZhbHVl") {
		t.Fatalf("Credential redeem status=%d body=%s", redeem.Code, redeem.Body.String())
	}
	clientRedeem := callAPI(t, handler, apiRequest(t, http.MethodPost, "/v1/node/tasks/task-credential/credentials", testPrincipalA, map[string]any{}))
	if clientRedeem.Code != http.StatusForbidden {
		t.Fatalf("client redeemed Node Credential status=%d body=%s", clientRedeem.Code, clientRedeem.Body.String())
	}
	revoke := callAPI(t, handler, apiRequest(t, http.MethodDelete, "/v1/agent/credentials/model-key", testPrincipalA, nil))
	if revoke.Code != http.StatusOK || !backend.revoked || !strings.Contains(revoke.Body.String(), `"state":"revoked"`) {
		t.Fatalf("Credential revoke status=%d body=%s", revoke.Code, revoke.Body.String())
	}
}

func TestCredentialAPIFailsClosedWithoutRuntimeBackend(t *testing.T) {
	store, _ := openTestStore(t, &testClock{})
	api, err := NewAPI(store, "example.test", []string{testPrincipalA})
	if err != nil {
		t.Fatal(err)
	}
	response := callAPI(t, api.Handler(), apiRequest(t, http.MethodGet, "/v1/agent/credentials", testPrincipalA, nil))
	if response.Code != http.StatusServiceUnavailable || !strings.Contains(response.Body.String(), `"code":"unavailable"`) {
		t.Fatalf("disabled Credential broker status=%d body=%s", response.Code, response.Body.String())
	}
}

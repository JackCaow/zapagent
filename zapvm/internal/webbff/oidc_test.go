package webbff

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

type fakeEnterpriseProvider struct {
	identity enterpriseIdentity
	state    string
	verifier string
	code     string
}

func (provider *fakeEnterpriseProvider) LoginURL(state, verifier string) string {
	provider.state = state
	provider.verifier = verifier
	return "https://identity.example.test/authorize?state=" + url.QueryEscape(state)
}

func (provider *fakeEnterpriseProvider) Exchange(_ context.Context, code, verifier string) (enterpriseIdentity, error) {
	provider.code = code
	if verifier != provider.verifier {
		return enterpriseIdentity{}, context.Canceled
	}
	return provider.identity, nil
}

func TestEnterpriseOIDCFlowCreatesProjectScopedSession(t *testing.T) {
	config := testConfig(t)
	projects := []ProjectRuntime{
		testRuntime(t, config.Projects[0], testTokenA, "https://control.example.test"),
		testRuntime(t, config.Projects[1], testTokenB, "https://control.example.test"),
	}
	server, err := New(config, bytes.Repeat([]byte{4}, 32), projects, nil)
	if err != nil {
		t.Fatal(err)
	}
	fixedNow := time.Date(2026, 8, 8, 8, 0, 0, 0, time.UTC)
	server.now = func() time.Time { return fixedNow }
	provider := &fakeEnterpriseProvider{identity: enterpriseIdentity{Subject: "employee-42", Email: "alice@example.com", Name: "Alice Chen"}}
	server.oidc = &oidcRuntime{
		provider: provider, issuer: "https://identity.example.test", projectID: "project-a", displayName: "Example SSO",
		allowedEmailDomains: map[string]struct{}{"example.com": {}},
	}
	handler := server.Handler()

	options := httptest.NewRequest(http.MethodGet, "/auth/options", nil)
	options.Host = "web.example.test"
	optionsResponse := httptest.NewRecorder()
	handler.ServeHTTP(optionsResponse, options)
	if optionsResponse.Code != http.StatusOK || !strings.Contains(optionsResponse.Body.String(), `"display_name":"Example SSO"`) || !strings.Contains(optionsResponse.Body.String(), `"start_url":"/auth/oidc/start"`) {
		t.Fatalf("options status=%d body=%s", optionsResponse.Code, optionsResponse.Body.String())
	}

	start := httptest.NewRequest(http.MethodGet, "/auth/oidc/start", nil)
	start.Host = "web.example.test"
	startResponse := httptest.NewRecorder()
	handler.ServeHTTP(startResponse, start)
	flowCookies := startResponse.Result().Cookies()
	if startResponse.Code != http.StatusFound || provider.state == "" || provider.verifier == "" || len(flowCookies) != 1 || flowCookies[0].SameSite != http.SameSiteLaxMode || !flowCookies[0].HttpOnly || !flowCookies[0].Secure {
		t.Fatalf("start status=%d location=%q cookies=%#v", startResponse.Code, startResponse.Header().Get("Location"), flowCookies)
	}

	callback := httptest.NewRequest(http.MethodGet, "/auth/oidc/callback?state="+url.QueryEscape(provider.state)+"&code=authorization-code", nil)
	callback.Host = "web.example.test"
	callback.AddCookie(flowCookies[0])
	callbackResponse := httptest.NewRecorder()
	handler.ServeHTTP(callbackResponse, callback)
	if callbackResponse.Code != http.StatusFound || callbackResponse.Header().Get("Location") != config.PublicOrigin+"/" || provider.code != "authorization-code" {
		t.Fatalf("callback status=%d location=%q code=%q", callbackResponse.Code, callbackResponse.Header().Get("Location"), provider.code)
	}
	var sessionCookie *http.Cookie
	for _, cookie := range callbackResponse.Result().Cookies() {
		if cookie.Name == config.CookieName && cookie.MaxAge > 0 {
			sessionCookie = cookie
		}
	}
	if sessionCookie == nil || sessionCookie.SameSite != http.SameSiteStrictMode {
		t.Fatalf("session cookie = %#v", sessionCookie)
	}

	sessionRequest := authenticatedRequest(t, http.MethodGet, "/api/session", nil, sessionCookie)
	sessionResponse := httptest.NewRecorder()
	handler.ServeHTTP(sessionResponse, sessionRequest)
	if sessionResponse.Code != http.StatusOK || !strings.Contains(sessionResponse.Body.String(), `"project_id":"project-a"`) || !strings.Contains(sessionResponse.Body.String(), `"user_display_name":"Alice Chen"`) || !strings.Contains(sessionResponse.Body.String(), `"auth_method":"oidc"`) || strings.Contains(sessionResponse.Body.String(), "employee-42") {
		t.Fatalf("session status=%d body=%s", sessionResponse.Code, sessionResponse.Body.String())
	}
}

func TestOIDCConfigRequiresExplicitWorkspaceAndEmailPolicy(t *testing.T) {
	config := testConfig(t)
	config.OIDC = &OIDCConfig{
		Issuer: "https://identity.example.test", ClientID: "zapvm-web", ClientSecretFile: "/owner/oidc-secret",
		ProjectID: "project-a", AllowedEmailDomains: []string{"Example.COM"},
	}
	if err := config.Validate(); err != nil {
		t.Fatal(err)
	}
	if config.OIDC.DisplayName != "企业账号" || config.OIDC.AllowedEmailDomains[0] != "example.com" {
		t.Fatalf("normalized OIDC config = %#v", config.OIDC)
	}

	config = testConfig(t)
	config.OIDC = &OIDCConfig{Issuer: "https://identity.example.test", ClientID: "zapvm-web", ClientSecretFile: "/owner/oidc-secret", ProjectID: "project-a"}
	if err := config.Validate(); err == nil || !strings.Contains(err.Error(), "allowed_email_domains") {
		t.Fatalf("missing email policy error = %v", err)
	}
}

func TestOIDCEmailPolicyRequiresExactAllowedDomain(t *testing.T) {
	runtime := oidcRuntime{allowedEmailDomains: map[string]struct{}{"example.com": {}}}
	for email, expected := range map[string]bool{
		"alice@example.com": true, "ALICE@EXAMPLE.COM": true, "alice@sub.example.com": false,
		"alice@example.com.attacker.test": false, "missing-at.example.com": false,
	} {
		if actual := runtime.acceptsEmail(email); actual != expected {
			t.Fatalf("acceptsEmail(%q) = %t, want %t", email, actual, expected)
		}
	}
}

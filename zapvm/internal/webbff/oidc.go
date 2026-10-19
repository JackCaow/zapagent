package webbff

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/coreos/go-oidc/v3/oidc"
	"golang.org/x/oauth2"
	"zapvm/internal/remoteauth"
)

const oidcFlowTTL = 10 * time.Minute

type enterpriseIdentity struct {
	Subject string
	Email   string
	Name    string
}

type enterpriseIdentityProvider interface {
	LoginURL(state, verifier string) string
	Exchange(context.Context, string, string) (enterpriseIdentity, error)
}

type oidcRuntime struct {
	provider            enterpriseIdentityProvider
	issuer              string
	projectID           string
	displayName         string
	allowedEmailDomains map[string]struct{}
}

type standardOIDCProvider struct {
	oauth    oauth2.Config
	verifier *oidc.IDTokenVerifier
}

type oidcFlowClaims struct {
	State     string `json:"s"`
	Verifier  string `json:"v"`
	ExpiresAt int64  `json:"exp"`
}

type oidcIdentityClaims struct {
	Subject       string `json:"sub"`
	Email         string `json:"email"`
	EmailVerified bool   `json:"email_verified"`
	Name          string `json:"name"`
}

func newOIDCRuntime(config OIDCConfig, publicOrigin string) (*oidcRuntime, error) {
	secret, err := remoteauth.ReadOwnerOnlyFile(config.ClientSecretFile, 16<<10)
	if err != nil {
		return nil, fmt.Errorf("load OIDC client secret: %w", err)
	}
	clientSecret := strings.TrimSpace(string(secret))
	if clientSecret == "" || len(clientSecret) > 8192 || strings.IndexByte(clientSecret, 0) >= 0 {
		return nil, errors.New("OIDC client secret is invalid")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	provider, err := oidc.NewProvider(ctx, config.Issuer)
	if err != nil {
		return nil, fmt.Errorf("discover OIDC provider: %w", err)
	}
	standard := &standardOIDCProvider{
		oauth: oauth2.Config{
			ClientID: config.ClientID, ClientSecret: clientSecret,
			Endpoint: provider.Endpoint(), RedirectURL: publicOrigin + "/auth/oidc/callback",
			Scopes: []string{oidc.ScopeOpenID, "profile", "email"},
		},
		verifier: provider.Verifier(&oidc.Config{ClientID: config.ClientID}),
	}
	domains := make(map[string]struct{}, len(config.AllowedEmailDomains))
	for _, domain := range config.AllowedEmailDomains {
		domains[domain] = struct{}{}
	}
	return &oidcRuntime{provider: standard, issuer: config.Issuer, projectID: config.ProjectID, displayName: config.DisplayName, allowedEmailDomains: domains}, nil
}

func (provider *standardOIDCProvider) LoginURL(state, verifier string) string {
	return provider.oauth.AuthCodeURL(state, oauth2.S256ChallengeOption(verifier))
}

func (provider *standardOIDCProvider) Exchange(context context.Context, code, verifier string) (enterpriseIdentity, error) {
	token, err := provider.oauth.Exchange(context, code, oauth2.VerifierOption(verifier))
	if err != nil {
		return enterpriseIdentity{}, err
	}
	rawIDToken, ok := token.Extra("id_token").(string)
	if !ok || rawIDToken == "" {
		return enterpriseIdentity{}, errors.New("OIDC response has no ID token")
	}
	idToken, err := provider.verifier.Verify(context, rawIDToken)
	if err != nil {
		return enterpriseIdentity{}, err
	}
	var claims oidcIdentityClaims
	if err := idToken.Claims(&claims); err != nil || claims.Subject == "" || claims.Email == "" || !claims.EmailVerified {
		return enterpriseIdentity{}, errors.New("OIDC identity has no verified email")
	}
	return enterpriseIdentity{Subject: claims.Subject, Email: claims.Email, Name: claims.Name}, nil
}

func (server *Server) authOptions(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet {
		writeError(writer, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	response := struct {
		OIDC *struct {
			DisplayName string `json:"display_name"`
			StartURL    string `json:"start_url"`
		} `json:"oidc,omitempty"`
	}{}
	if server.oidc != nil {
		response.OIDC = &struct {
			DisplayName string `json:"display_name"`
			StartURL    string `json:"start_url"`
		}{DisplayName: server.oidc.displayName, StartURL: "/auth/oidc/start"}
	}
	writeJSON(writer, http.StatusOK, response)
}

func (server *Server) beginOIDC(writer http.ResponseWriter, request *http.Request, requestID string) {
	if request.Method != http.MethodGet {
		writeError(writer, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	if server.oidc == nil {
		writeError(writer, http.StatusNotFound, "not_found")
		return
	}
	state, err := randomURLToken(32)
	if err != nil {
		writeError(writer, http.StatusInternalServerError, "internal_error")
		return
	}
	verifier := oauth2.GenerateVerifier()
	claims := oidcFlowClaims{State: state, Verifier: verifier, ExpiresAt: server.now().UTC().Add(oidcFlowTTL).Unix()}
	payload, err := json.Marshal(claims)
	if err != nil {
		writeError(writer, http.StatusInternalServerError, "internal_error")
		return
	}
	encoded := base64.RawURLEncoding.EncodeToString(payload)
	value := encoded + "." + base64.RawURLEncoding.EncodeToString(server.sign(encoded))
	server.setOIDCFlowCookie(writer, value, time.Unix(claims.ExpiresAt, 0))
	server.audit(requestID, server.oidc.projectID, "", request.Method, request.URL.Path, "oidc_started")
	http.Redirect(writer, request, server.oidc.provider.LoginURL(state, verifier), http.StatusFound)
}

func (server *Server) finishOIDC(writer http.ResponseWriter, request *http.Request, requestID string) {
	if request.Method != http.MethodGet || server.oidc == nil {
		writeError(writer, http.StatusNotFound, "not_found")
		return
	}
	flow, err := server.readOIDCFlow(request)
	server.clearOIDCFlowCookie(writer)
	state := request.URL.Query().Get("state")
	code := request.URL.Query().Get("code")
	if err != nil || state == "" || code == "" || len(code) > 8192 || state != flow.State {
		server.audit(requestID, server.oidc.projectID, "", request.Method, request.URL.Path, "oidc_denied")
		server.redirectAuthError(writer, request, "oidc_denied")
		return
	}
	identity, err := server.oidc.provider.Exchange(request.Context(), code, flow.Verifier)
	if err != nil || !server.oidc.acceptsEmail(identity.Email) || identity.Subject == "" {
		server.audit(requestID, server.oidc.projectID, "", request.Method, request.URL.Path, "oidc_denied")
		server.redirectAuthError(writer, request, "oidc_denied")
		return
	}
	project, exists := server.projects[server.oidc.projectID]
	if !exists {
		writeError(writer, http.StatusInternalServerError, "internal_error")
		return
	}
	userID := oidcUserID(server.oidc.issuer, identity.Subject)
	name := strings.TrimSpace(identity.Name)
	if name == "" || len(name) > 256 || strings.IndexByte(name, 0) >= 0 || !utf8.ValidString(name) {
		name = identity.Email
	}
	role, err := server.resolveWorkspaceRole(request.Context(), project, userID, name, false)
	if err != nil {
		server.redirectAuthError(writer, request, "workspace_membership_required")
		return
	}
	value, claims, err := server.issueSession(project, userID, name, "oidc", role)
	if err != nil {
		writeError(writer, http.StatusInternalServerError, "internal_error")
		return
	}
	server.setSessionCookie(writer, value, time.Unix(claims.ExpiresAt, 0))
	server.audit(requestID, project.ID, userID, request.Method, request.URL.Path, "oidc_login")
	http.Redirect(writer, request, server.publicOrigin+"/", http.StatusFound)
}

func (runtime *oidcRuntime) acceptsEmail(email string) bool {
	email = strings.ToLower(strings.TrimSpace(email))
	if len(email) > 254 || strings.IndexByte(email, 0) >= 0 || !utf8.ValidString(email) {
		return false
	}
	index := strings.LastIndexByte(email, '@')
	if index <= 0 || index == len(email)-1 {
		return false
	}
	_, allowed := runtime.allowedEmailDomains[email[index+1:]]
	return allowed
}

func (server *Server) readOIDCFlow(request *http.Request) (oidcFlowClaims, error) {
	cookie, err := request.Cookie(server.oidcCookieName())
	if err != nil || len(cookie.Value) > 4096 {
		return oidcFlowClaims{}, errors.New("OIDC flow cookie is missing")
	}
	encoded, signature, err := splitSignedValue(cookie.Value)
	if err != nil || !hmac.Equal(signature, server.sign(encoded)) {
		return oidcFlowClaims{}, errors.New("OIDC flow signature is invalid")
	}
	payload, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil {
		return oidcFlowClaims{}, errors.New("OIDC flow payload is invalid")
	}
	var claims oidcFlowClaims
	if json.Unmarshal(payload, &claims) != nil || claims.ExpiresAt <= server.now().UTC().Unix() || claims.ExpiresAt > server.now().UTC().Add(oidcFlowTTL+time.Minute).Unix() || len(claims.State) != 43 || len(claims.Verifier) < 43 || len(claims.Verifier) > 128 {
		return oidcFlowClaims{}, errors.New("OIDC flow claims are invalid")
	}
	return claims, nil
}

func (server *Server) oidcCookieName() string {
	if strings.HasPrefix(server.cookieName, "__Host-") {
		return "__Host-zapvm_oidc"
	}
	return "zapvm_oidc"
}

func (server *Server) setOIDCFlowCookie(writer http.ResponseWriter, value string, expires time.Time) {
	http.SetCookie(writer, &http.Cookie{Name: server.oidcCookieName(), Value: value, Path: "/", Expires: expires, MaxAge: int(expires.Sub(server.now().UTC()).Seconds()), HttpOnly: true, Secure: server.secureCookie, SameSite: http.SameSiteLaxMode})
}

func (server *Server) clearOIDCFlowCookie(writer http.ResponseWriter) {
	http.SetCookie(writer, &http.Cookie{Name: server.oidcCookieName(), Value: "", Path: "/", Expires: time.Unix(1, 0), MaxAge: -1, HttpOnly: true, Secure: server.secureCookie, SameSite: http.SameSiteLaxMode})
}

func (server *Server) redirectAuthError(writer http.ResponseWriter, request *http.Request, code string) {
	http.Redirect(writer, request, server.publicOrigin+"/?auth_error="+code, http.StatusFound)
}

func oidcUserID(issuer, subject string) string {
	digest := sha256.Sum256([]byte(issuer + "\x00" + subject))
	return "oidc-" + hex.EncodeToString(digest[:12])
}

func randomURLToken(size int) (string, error) {
	value := make([]byte, size)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(value), nil
}

package webbff

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"
)

type sessionClaims struct {
	Version    int    `json:"v"`
	ProjectID  string `json:"p"`
	UserID     string `json:"u"`
	UserName   string `json:"n,omitempty"`
	AuthMethod string `json:"a,omitempty"`
	Role       string `json:"r"`
	CSRF       string `json:"c"`
	IssuedAt   int64  `json:"iat"`
	ExpiresAt  int64  `json:"exp"`
}

func (server *Server) issueSession(project ProjectRuntime, userID, userName, authMethod, role string) (string, sessionClaims, error) {
	if !canonicalName(userID) || len(userName) > 256 || strings.IndexByte(userName, 0) >= 0 || !utf8.ValidString(userName) || (authMethod != "token" && authMethod != "invite" && authMethod != "oidc") || !validSessionRole(role) {
		return "", sessionClaims{}, errors.New("session identity is invalid")
	}
	nonce := make([]byte, 32)
	if _, err := rand.Read(nonce); err != nil {
		return "", sessionClaims{}, err
	}
	now := server.now().UTC()
	claims := sessionClaims{
		Version: 1, ProjectID: project.ID, UserID: userID, UserName: userName, AuthMethod: authMethod, Role: role,
		CSRF: base64.RawURLEncoding.EncodeToString(nonce), IssuedAt: now.Unix(), ExpiresAt: now.Add(server.sessionTTL).Unix(),
	}
	payload, err := json.Marshal(claims)
	if err != nil {
		return "", sessionClaims{}, err
	}
	encoded := base64.RawURLEncoding.EncodeToString(payload)
	signature := server.sign(encoded)
	return encoded + "." + base64.RawURLEncoding.EncodeToString(signature), claims, nil
}

func (server *Server) authenticate(request *http.Request) (ProjectRuntime, sessionClaims, error) {
	cookie, err := request.Cookie(server.cookieName)
	if err != nil || len(cookie.Value) > 4096 {
		return ProjectRuntime{}, sessionClaims{}, errors.New("session cookie is required")
	}
	encoded, signature, err := splitSignedValue(cookie.Value)
	if err != nil || !hmac.Equal(signature, server.sign(encoded)) {
		return ProjectRuntime{}, sessionClaims{}, errors.New("session signature is invalid")
	}
	payload, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil || len(payload) > 2048 {
		return ProjectRuntime{}, sessionClaims{}, errors.New("session payload is invalid")
	}
	var claims sessionClaims
	if err := json.Unmarshal(payload, &claims); err != nil {
		return ProjectRuntime{}, sessionClaims{}, errors.New("session payload is invalid")
	}
	now := server.now().UTC().Unix()
	if claims.Version != 1 || claims.ExpiresAt <= now || claims.IssuedAt > now+60 || claims.ExpiresAt-claims.IssuedAt > int64(server.sessionTTL/time.Second) ||
		len(claims.CSRF) != 43 || !canonicalName(claims.UserID) || !validSessionRole(claims.Role) || len(claims.UserName) > 256 || strings.IndexByte(claims.UserName, 0) >= 0 || !utf8.ValidString(claims.UserName) {
		return ProjectRuntime{}, sessionClaims{}, errors.New("session claims are invalid")
	}
	project, exists := server.projects[claims.ProjectID]
	if !exists || ((claims.AuthMethod == "" || claims.AuthMethod == "token") && project.UserID != claims.UserID) ||
		(claims.AuthMethod != "" && claims.AuthMethod != "token" && claims.AuthMethod != "invite" && claims.AuthMethod != "oidc") {
		return ProjectRuntime{}, sessionClaims{}, errors.New("session project is invalid")
	}
	return project, claims, nil
}

func validSessionRole(role string) bool {
	switch role {
	case "owner", "admin", "operator", "member", "viewer":
		return true
	default:
		return false
	}
}

func (server *Server) sign(value string) []byte {
	return signValue(server.signingKey, value)
}

func signValue(signingKey []byte, value string) []byte {
	mac := hmac.New(sha256.New, signingKey)
	_, _ = mac.Write([]byte(value))
	return mac.Sum(nil)
}

func (server *Server) setSessionCookie(writer http.ResponseWriter, value string, expires time.Time) {
	maxAge := int(expires.Sub(server.now().UTC()).Seconds())
	http.SetCookie(writer, &http.Cookie{
		Name: server.cookieName, Value: value, Path: "/", Expires: expires, MaxAge: maxAge,
		HttpOnly: true, Secure: server.secureCookie, SameSite: http.SameSiteStrictMode,
	})
}

func (server *Server) clearSessionCookie(writer http.ResponseWriter) {
	http.SetCookie(writer, &http.Cookie{
		Name: server.cookieName, Value: "", Path: "/", Expires: time.Unix(1, 0), MaxAge: -1,
		HttpOnly: true, Secure: server.secureCookie, SameSite: http.SameSiteStrictMode,
	})
}

func matchAccessToken(projects map[string]ProjectRuntime, token string) (ProjectRuntime, bool) {
	digest := sha256.Sum256([]byte(token))
	var matched ProjectRuntime
	var found bool
	for _, project := range projects {
		if hmac.Equal(digest[:], project.TokenHash[:]) {
			matched = project
			found = true
		}
	}
	return matched, found
}

package webbff

import (
	"crypto/hmac"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/url"
	"time"
)

const maximumInviteTTL = 7 * 24 * time.Hour

type inviteClaims struct {
	Version   int    `json:"v"`
	ProjectID string `json:"p"`
	UserID    string `json:"u"`
	IssuedAt  int64  `json:"iat"`
	ExpiresAt int64  `json:"exp"`
	Nonce     string `json:"n"`
}

func IssueInviteURL(signingKey []byte, publicOrigin, projectID, userID string, now time.Time, ttl time.Duration) (string, error) {
	if len(signingKey) != 32 || !canonicalName(projectID) || !canonicalName(userID) || ttl < 5*time.Minute || ttl > maximumInviteTTL {
		return "", errors.New("invite authority, identity, or TTL is invalid")
	}
	origin, err := url.Parse(publicOrigin)
	if err != nil || origin.Scheme != "https" || origin.Host == "" || origin.User != nil || origin.RawQuery != "" || origin.Fragment != "" || (origin.Path != "" && origin.Path != "/") {
		return "", errors.New("invite public origin is invalid")
	}
	nonce := make([]byte, 24)
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	now = now.UTC()
	claims := inviteClaims{
		Version: 1, ProjectID: projectID, UserID: userID, IssuedAt: now.Unix(), ExpiresAt: now.Add(ttl).Unix(),
		Nonce: base64.RawURLEncoding.EncodeToString(nonce),
	}
	payload, err := json.Marshal(claims)
	if err != nil {
		return "", err
	}
	encoded := base64.RawURLEncoding.EncodeToString(payload)
	signature := signValue(signingKey, "invite:"+encoded)
	token := encoded + "." + base64.RawURLEncoding.EncodeToString(signature)
	origin.Path = "/"
	origin.Fragment = "invite=" + url.QueryEscape(token)
	return origin.String(), nil
}

func (server *Server) verifyInvite(token string) (ProjectRuntime, inviteClaims, error) {
	encoded, signature, err := splitSignedValue(token)
	if err != nil || !hmac.Equal(signature, signValue(server.signingKey, "invite:"+encoded)) {
		return ProjectRuntime{}, inviteClaims{}, errors.New("invite signature is invalid")
	}
	payload, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil || len(payload) > 2048 {
		return ProjectRuntime{}, inviteClaims{}, errors.New("invite payload is invalid")
	}
	var claims inviteClaims
	if err := json.Unmarshal(payload, &claims); err != nil {
		return ProjectRuntime{}, inviteClaims{}, errors.New("invite payload is invalid")
	}
	now := server.now().UTC().Unix()
	if claims.Version != 1 || !canonicalName(claims.ProjectID) || !canonicalName(claims.UserID) || len(claims.Nonce) != 32 ||
		claims.ExpiresAt <= now || claims.IssuedAt > now+60 || claims.ExpiresAt-claims.IssuedAt > int64(maximumInviteTTL/time.Second) {
		return ProjectRuntime{}, inviteClaims{}, errors.New("invite claims are invalid")
	}
	project, exists := server.projects[claims.ProjectID]
	if !exists {
		return ProjectRuntime{}, inviteClaims{}, errors.New("invite project is unavailable")
	}
	return project, claims, nil
}

func splitSignedValue(value string) (string, []byte, error) {
	separator := -1
	for index, character := range value {
		if character == '.' {
			if separator != -1 {
				return "", nil, errors.New("signed value is malformed")
			}
			separator = index
		}
	}
	if separator < 1 || separator == len(value)-1 {
		return "", nil, errors.New("signed value is malformed")
	}
	signature, err := base64.RawURLEncoding.DecodeString(value[separator+1:])
	if err != nil {
		return "", nil, err
	}
	return value[:separator], signature, nil
}

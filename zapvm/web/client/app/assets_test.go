package app

import (
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"
)

func TestWorkspaceAssetsExposeOnlyBuiltSameOriginFiles(t *testing.T) {
	html, err := assets.ReadFile("dist/index.html")
	if err != nil {
		t.Fatal(err)
	}
	text := string(html)
	if strings.Contains(text, "<script>") || !strings.Contains(text, "/assets/") {
		t.Fatal("React workspace must use external, built CSP-compatible assets")
	}
	for _, forbidden := range []string{"Project access token", "model-credential", "provider-url", "access_token"} {
		if strings.Contains(strings.ToLower(text), strings.ToLower(forbidden)) {
			t.Fatalf("workspace HTML exposes operator material %q", forbidden)
		}
	}
	if !PublicPath("/") || !PublicPath("/index.html") || !PublicPath("/new") || !PublicPath("/sessions/session-123") || !PublicPath("/admin") || !PublicPath("/admin/platform") || !PublicPath("/favicon.svg") || PublicPath("/app.js") || PublicPath("/../index.html") || PublicPath("/sessions/a/files") || PublicPath("/admin/computers") || PublicPath("/admin/computers/node-a") {
		t.Fatal("static public path allowlist is incorrect")
	}

	matcher := regexp.MustCompile(`(?:src|href)="(/assets/[^"]+)"`)
	for _, match := range matcher.FindAllStringSubmatch(text, -1) {
		if !PublicPath(match[1]) {
			t.Fatalf("built HTML references an unauthorised asset %s", match[1])
		}
		response := httptest.NewRecorder()
		Handler().ServeHTTP(response, httptest.NewRequest(http.MethodGet, match[1], nil))
		if response.Code != http.StatusOK || response.Body.Len() == 0 {
			t.Fatalf("asset %s failed to serve: %d", match[1], response.Code)
		}
	}

	response := httptest.NewRecorder()
	Handler().ServeHTTP(response, httptest.NewRequest(http.MethodHead, "/", nil))
	if response.Code != http.StatusOK || response.Body.Len() != 0 || !strings.Contains(response.Header().Get("Content-Type"), "text/html") {
		t.Fatalf("HEAD response is incorrect: status=%d body=%d content-type=%q", response.Code, response.Body.Len(), response.Header().Get("Content-Type"))
	}

	for _, deepLink := range []string{"/new", "/sessions/session-123", "/admin", "/admin/platform"} {
		response := httptest.NewRecorder()
		Handler().ServeHTTP(response, httptest.NewRequest(http.MethodGet, deepLink, nil))
		if response.Code != http.StatusOK || response.Body.String() != text || !strings.Contains(response.Header().Get("Content-Type"), "text/html") {
			t.Fatalf("deep link %s did not serve the application shell", deepLink)
		}
	}
}

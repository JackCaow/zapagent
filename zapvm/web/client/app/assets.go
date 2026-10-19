package app

import (
	"embed"
	"io/fs"
	"mime"
	"net/http"
	"path"
	"strconv"
	"strings"
)

// assets are generated from web/client/react with `npm run build`.
//
//go:embed all:dist
var assets embed.FS

var publicAssets = buildPublicAssets()

func buildPublicAssets() map[string]string {
	files := map[string]string{
		"/":           "dist/index.html",
		"/index.html": "dist/index.html",
	}
	_ = fs.WalkDir(assets, "dist", func(name string, entry fs.DirEntry, err error) error {
		if err != nil || entry.IsDir() || name == "dist/index.html" || strings.HasPrefix(name, "dist/.vite/") {
			return nil
		}
		files["/"+strings.TrimPrefix(name, "dist/")] = name
		return nil
	})
	return files
}

func Handler() http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		name, ok := publicAssetName(request.URL.Path)
		if !ok {
			http.NotFound(writer, request)
			return
		}
		data, err := assets.ReadFile(name)
		if err != nil {
			http.Error(writer, "internal error", http.StatusInternalServerError)
			return
		}
		contentType := mime.TypeByExtension(path.Ext(name))
		if contentType == "" {
			contentType = "application/octet-stream"
		}
		if (strings.HasPrefix(contentType, "text/") || strings.Contains(contentType, "javascript") || strings.Contains(contentType, "json")) && !strings.Contains(strings.ToLower(contentType), "charset=") {
			contentType += "; charset=utf-8"
		}
		writer.Header().Set("Content-Type", contentType)
		writer.Header().Set("Content-Length", strconv.Itoa(len(data)))
		writer.WriteHeader(http.StatusOK)
		if request.Method != http.MethodHead {
			_, _ = writer.Write(data)
		}
	})
}

func PublicPath(requestPath string) bool {
	_, ok := publicAssetName(requestPath)
	return ok
}

func publicAssetName(requestPath string) (string, bool) {
	if name, ok := publicAssets[requestPath]; ok {
		return name, true
	}
	if requestPath == "/new" || requestPath == "/new/" || requestPath == "/admin" || requestPath == "/admin/" || requestPath == "/admin/platform" || requestPath == "/admin/platform/" || sessionAppPath(requestPath) {
		return "dist/index.html", true
	}
	return "", false
}

func sessionAppPath(requestPath string) bool {
	value := strings.TrimSuffix(strings.TrimPrefix(requestPath, "/sessions/"), "/")
	if value == "" || len(value) > 200 || strings.Contains(value, "/") {
		return false
	}
	for _, character := range value {
		if (character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z') || (character >= '0' && character <= '9') || character == '-' || character == '_' || character == '.' || character == '~' {
			continue
		}
		return false
	}
	return true
}

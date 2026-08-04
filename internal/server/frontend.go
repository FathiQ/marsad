package server

import (
	"embed"
	"io/fs"
	"net/http"
	"strings"
)

// The frontend is compiled into the binary so that deploying Marsad is a single
// image with no sidecar and no static-asset bucket.
//
//go:embed all:assets
var assets embed.FS

// frontendHandler serves the embedded UI, falling back to index.html so client
// side routes survive a page reload.
func frontendHandler() http.Handler {
	sub, err := fs.Sub(assets, "assets")
	if err != nil {
		// Only reachable if the embed directive and this path disagree, which is
		// a build-time mistake, not a runtime condition.
		panic(err)
	}
	files := http.FS(sub)
	fileServer := http.FileServer(files)

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// An unknown path that is not an asset request is a client-side route.
		if r.URL.Path != "/" && !strings.Contains(pathBase(r.URL.Path), ".") {
			if _, err := fs.Stat(sub, strings.TrimPrefix(r.URL.Path, "/")); err != nil {
				r = r.Clone(r.Context())
				r.URL.Path = "/"
			}
		}
		fileServer.ServeHTTP(w, r)
	})
}

func pathBase(p string) string {
	if i := strings.LastIndex(p, "/"); i >= 0 {
		return p[i+1:]
	}
	return p
}

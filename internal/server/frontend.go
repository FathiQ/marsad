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

		w.Header().Set("Cache-Control", cacheControl(r.URL.Path))
		fileServer.ServeHTTP(w, r)
	})
}

// cacheControl decides how long a browser may keep something.
//
// An embed.FS gives the file server nothing to work with: every entry has a
// zero ModTime, so no Last-Modified and no ETag go out. With no Cache-Control
// either, a browser is left to invent its own policy — and an upgraded Marsad
// could go on serving the index it already had, which is indistinguishable
// from an upgrade that did not happen.
//
// Vite fingerprints everything under /assets, so those names change whenever
// their contents do and they can be kept forever. The index that points at
// them must not be, or the new names are never learned.
func cacheControl(path string) string {
	if strings.HasPrefix(path, "/assets/") {
		return "public, max-age=31536000, immutable"
	}
	return "no-cache"
}

func pathBase(p string) string {
	if i := strings.LastIndex(p, "/"); i >= 0 {
		return p[i+1:]
	}
	return p
}

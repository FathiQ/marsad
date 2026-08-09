package server

// CacheControlForTest exposes the cache policy to the external test package,
// which is where the rest of the server's tests live: they exercise Marsad
// through its HTTP surface, and this is the one decision that cannot be
// observed that way — only index.html is embedded outside a container build,
// so a request for a fingerprinted asset 404s and Go strips the header.
func CacheControlForTest(path string) string { return cacheControl(path) }

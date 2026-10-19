package api

import (
	"context"
	"crypto/subtle"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// MirrorPort is the loopback port inside the slot where a guest with a package mirror grant reaches
// the mirrors. It is part of the contract with the server (SLOT_MIRROR_GUEST_PORT in slotContract.ts).
const MirrorPort = 18771

// MirrorSocketName is the gateway's socket inside the slot's mirror volume, which the app mounts
// for this purpose alone; the control volume next to it stays read-only for the server.
const mirrorSocketPath = "/run/aman/mirror/mirror.sock"

// mirrorEcosystems are the only path prefixes the forwarder will carry.
var mirrorEcosystems = map[string]bool{"pypi": true, "npm": true, "go": true, "cargo": true}

// mirrorResponseCap backstops the gateway's own per-download cap: a single reply larger than this
// is cut off rather than streamed into the guest without bound.
const mirrorResponseCap = 2 << 30

// validMirrorToken reports whether token has the only shape a grant may take.
func validMirrorToken(token string) bool {
	if len(token) != 32 {
		return false
	}
	for _, c := range token {
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return false
		}
	}
	return true
}

// mirrorBase is the address package tools are pointed at for one grant.
func mirrorBase(token string) string {
	return fmt.Sprintf("http://127.0.0.1:%d/m/%s", MirrorPort, token)
}

// beginMirrorGrant opens the forwarder for one call; the returned function closes it. The slot runs
// one call at a time, so a single active grant is the whole state. An empty token opens nothing.
func (s *Server) beginMirrorGrant(token string) func() {
	if token == "" {
		return func() {}
	}
	s.mirrorMu.Lock()
	s.mirrorToken = token
	s.mirrorMu.Unlock()
	return func() {
		s.mirrorMu.Lock()
		if s.mirrorToken == token {
			s.mirrorToken = ""
		}
		s.mirrorMu.Unlock()
	}
}

// activeMirrorToken returns the grant in force, or "" when no call holds one.
func (s *Server) activeMirrorToken() string {
	s.mirrorMu.Lock()
	defer s.mirrorMu.Unlock()
	return s.mirrorToken
}

// StartMirrorForwarder serves the guest-facing mirror endpoint on the slot's loopback. It never
// fails startup: without a listener, granted calls fail at the tool, and nothing is exposed.
func (s *Server) StartMirrorForwarder() error {
	listener, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", MirrorPort))
	if err != nil {
		return fmt.Errorf("mirror forwarder listen: %w", err)
	}
	server := &http.Server{Handler: http.HandlerFunc(s.serveMirror), ReadHeaderTimeout: 30 * time.Second}
	go func() { _ = server.Serve(listener) }()
	return nil
}

// gatewaySocketPath resolves where the mirror gateway listens for this slot.
func (s *Server) gatewaySocketPath() string {
	if s.MirrorSocketPath != "" {
		return s.MirrorSocketPath
	}
	return mirrorSocketPath
}

// serveMirror carries one guest request to the mirror gateway and streams the reply back. The
// gateway re-checks the token and everything else; this handler only enforces the shape of the
// path, the active grant, and the method rule the design fixes: GET and HEAD, everything else 405.
func (s *Server) serveMirror(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		writeMirrorError(w, http.StatusMethodNotAllowed, "package mirrors only answer downloads")
		return
	}
	token, ecosystem, rest, ok := parseMirrorPath(r.URL.EscapedPath())
	if !ok {
		writeMirrorError(w, http.StatusNotFound, "no such package mirror")
		return
	}
	if r.URL.RawQuery != "" {
		rest += "?" + r.URL.RawQuery
	}
	active := s.activeMirrorToken()
	if active == "" || subtle.ConstantTimeCompare([]byte(token), []byte(active)) != 1 {
		writeMirrorError(w, http.StatusForbidden, "this sandbox has no package download grant")
		return
	}
	upstream, err := s.mirrorClient()
	if err != nil {
		writeMirrorError(w, http.StatusBadGateway, "the package mirrors are not reachable")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Minute)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, r.Method, "http://mirror/"+ecosystem+rest, nil)
	if err != nil {
		writeMirrorError(w, http.StatusBadGateway, "the package mirror request could not be built")
		return
	}
	req.Header.Set("X-Aman-Mirror-Token", token)
	for _, name := range []string{"Accept", "Range", "If-None-Match", "If-Modified-Since", "User-Agent"} {
		if value := r.Header.Get(name); value != "" {
			req.Header.Set(name, value)
		}
	}
	resp, err := upstream.Do(req)
	if err != nil {
		writeMirrorError(w, http.StatusBadGateway, "the package mirrors are not reachable")
		return
	}
	defer resp.Body.Close()
	for _, name := range []string{
		"Content-Type", "Content-Length", "ETag", "Last-Modified", "Cache-Control", "Accept-Ranges", "Content-Range",
	} {
		if value := resp.Header.Get(name); value != "" {
			w.Header().Set(name, value)
		}
	}
	w.WriteHeader(resp.StatusCode)
	if r.Method == http.MethodGet {
		_, _ = io.Copy(w, io.LimitReader(resp.Body, mirrorResponseCap))
	}
}

// mirrorClient builds the client that talks to the gateway over its control-volume socket.
func (s *Server) mirrorClient() (*http.Client, error) {
	socket := s.gatewaySocketPath()
	transport := &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			var dialer net.Dialer
			return dialer.DialContext(ctx, "unix", socket)
		},
		DisableKeepAlives: true,
	}
	return &http.Client{Transport: transport}, nil
}

// parseMirrorPath splits /m/<token>/<ecosystem>/<rest> and checks every segment of the rest: a
// segment must decode cleanly, must not hide a dot step or a backslash, and must not carry control
// characters. An encoded slash inside one segment (npm writes scoped names that way) stays as it
// is and goes to the gateway still encoded.
func parseMirrorPath(escaped string) (token, ecosystem, rest string, ok bool) {
	parts := strings.Split(strings.TrimPrefix(escaped, "/"), "/")
	if len(parts) < 3 || parts[0] != "m" {
		return "", "", "", false
	}
	token = parts[1]
	if !validMirrorToken(token) {
		return "", "", "", false
	}
	ecosystem = parts[2]
	if !mirrorEcosystems[ecosystem] {
		return "", "", "", false
	}
	rest = "/"
	if len(parts) > 3 {
		for _, segment := range parts[3:] {
			if segment == "" || !safeMirrorSegment(segment) {
				return "", "", "", false
			}
		}
		rest = "/" + strings.Join(parts[3:], "/")
	}
	return token, ecosystem, rest, true
}

// safeMirrorSegment checks one still-escaped path segment by what it decodes to.
func safeMirrorSegment(segment string) bool {
	decoded, err := url.PathUnescape(segment)
	if err != nil {
		return false
	}
	if strings.Contains(decoded, "\\") {
		return false
	}
	for _, piece := range strings.Split(decoded, "/") {
		if piece == "." || piece == ".." {
			return false
		}
	}
	for _, c := range decoded {
		if c < 0x20 || c == 0x7f {
			return false
		}
	}
	return true
}

func writeMirrorError(w http.ResponseWriter, status int, message string) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(status)
	_, _ = io.WriteString(w, message+"\n")
}

package api

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"time"
)

// SkillNetworkPort is the loopback port inside the slot where a guest with a skill network grant
// reaches the approved sites. It is part of the contract with the server
// (SLOT_SKILL_NETWORK_GUEST_PORT in slotContract.ts). Granted exec calls get this port as their
// HTTPS proxy; the forwarder behind it carries CONNECT calls only.
const SkillNetworkPort = 18772

// skillNetworkSocketPath is the gateway's socket inside the slot's mirror volume, beside the
// mirror gateway's socket; the app mounts that volume for the gateways alone.
const skillNetworkSocketPath = "/run/aman/mirror/skillnet.sock"

// skillNetworkProxyEnv is the proxy environment a granted exec call runs with. Loopback stays
// direct, so a tool reaching the slot's own services never goes through the gateway.
func skillNetworkProxyEnv() []string {
	proxy := fmt.Sprintf("http://127.0.0.1:%d", SkillNetworkPort)
	return []string{
		"HTTP_PROXY=" + proxy,
		"HTTPS_PROXY=" + proxy,
		"http_proxy=" + proxy,
		"https_proxy=" + proxy,
		"NO_PROXY=127.0.0.1,localhost",
		"no_proxy=127.0.0.1,localhost",
	}
}

// beginSkillNetworkGrant opens the forwarder for one call; the returned function closes it. The
// slot runs one call at a time, so a single active grant is the whole state. An empty token opens
// nothing.
func (s *Server) beginSkillNetworkGrant(token string) func() {
	if token == "" {
		return func() {}
	}
	s.skillNetMu.Lock()
	s.skillNetToken = token
	s.skillNetMu.Unlock()
	return func() {
		s.skillNetMu.Lock()
		if s.skillNetToken == token {
			s.skillNetToken = ""
		}
		s.skillNetMu.Unlock()
	}
}

// activeSkillNetworkToken returns the grant in force, or "" when no call holds one.
func (s *Server) activeSkillNetworkToken() string {
	s.skillNetMu.Lock()
	defer s.skillNetMu.Unlock()
	return s.skillNetToken
}

// StartSkillNetworkForwarder serves the guest-facing skill network endpoint on the slot's
// loopback. It never fails startup: without a listener, granted calls fail at the tool, and
// nothing is exposed.
func (s *Server) StartSkillNetworkForwarder() error {
	listener, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", SkillNetworkPort))
	if err != nil {
		return fmt.Errorf("skill network forwarder listen: %w", err)
	}
	server := &http.Server{Handler: http.HandlerFunc(s.serveSkillNetwork), ReadHeaderTimeout: 30 * time.Second}
	go func() { _ = server.Serve(listener) }()
	return nil
}

// skillNetworkGatewaySocketPath resolves where the skill network gateway listens for this slot.
func (s *Server) skillNetworkGatewaySocketPath() string {
	if s.SkillNetSocketPath != "" {
		return s.SkillNetSocketPath
	}
	return skillNetworkSocketPath
}

// serveSkillNetwork carries one guest CONNECT call to the skill network gateway and tunnels the
// connection back. The gateway re-checks the token and the site; this handler only enforces the
// grant in force and the one method rule: CONNECT, everything else 405. The guest never sees the
// token; its tools are simply pointed at this port for the duration of a granted call.
func (s *Server) serveSkillNetwork(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodConnect {
		w.Header().Set("Allow", "CONNECT")
		writeMirrorError(w, http.StatusMethodNotAllowed, "this address only carries secure connections for approved skills")
		return
	}
	authority := r.URL.Host
	if authority == "" {
		authority = r.Host
	}
	if authority == "" || strings.Contains(authority, "/") {
		writeMirrorError(w, http.StatusBadRequest, "the connection request did not name a site")
		return
	}
	token := s.activeSkillNetworkToken()
	if token == "" {
		writeMirrorError(w, http.StatusForbidden, "this sandbox has no skill network grant")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	var dialer net.Dialer
	upstream, err := dialer.DialContext(ctx, "unix", s.skillNetworkGatewaySocketPath())
	if err != nil {
		writeMirrorError(w, http.StatusBadGateway, "the skill network gateway is not reachable")
		return
	}
	defer upstream.Close()
	if _, err := fmt.Fprintf(upstream, "CONNECT %s HTTP/1.1\r\nHost: %s\r\nX-Aman-Skill-Network-Token: %s\r\n\r\n", authority, authority, token); err != nil {
		writeMirrorError(w, http.StatusBadGateway, "the skill network gateway is not reachable")
		return
	}
	buffered := bufio.NewReader(upstream)
	resp, err := http.ReadResponse(buffered, &http.Request{Method: http.MethodConnect})
	if err != nil {
		writeMirrorError(w, http.StatusBadGateway, "the skill network gateway is not reachable")
		return
	}
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		message := strings.TrimSpace(string(body))
		if message == "" {
			message = "the connection was refused"
		}
		writeMirrorError(w, resp.StatusCode, message)
		return
	}
	hijacker, ok := w.(http.Hijacker)
	if !ok {
		writeMirrorError(w, http.StatusInternalServerError, "the connection could not be carried")
		return
	}
	client, rw, err := hijacker.Hijack()
	if err != nil {
		return
	}
	defer client.Close()
	_, _ = rw.WriteString("HTTP/1.1 200 Connection Established\r\n\r\n")
	if err := rw.Flush(); err != nil {
		return
	}
	// The buffered reader may already hold bytes the gateway sent past its response; copy from
	// it, not the raw connection, so nothing is lost.
	go func() {
		_, _ = io.Copy(client, buffered)
	}()
	_, _ = io.Copy(upstream, client)
}

package api_test

import (
	"bufio"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const skillNetworkToken = "abcdef0123456789abcdef0123456789"

func TestExecWithSkillNetworkTokenSetsTheProxy(t *testing.T) {
	e := newEnv(t, true)
	rec := e.do("POST", "/v1/exec", execBody(func(m map[string]any) {
		m["skill_network_token"] = skillNetworkToken
	}))
	if rec.Code != 200 {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
	spec := e.runner.spec
	if !spec.SharedNetwork {
		t.Fatal("a call with a skill network grant must run in the slot's loopback namespace")
	}
	proxy := "http://127.0.0.1:18772"
	for _, name := range []string{"HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"} {
		got, ok := envValue(spec.Env, name)
		if !ok || got != proxy {
			t.Errorf("%s = %q (present %v), want %q", name, got, ok, proxy)
		}
	}
	if got, ok := envValue(spec.Env, "NO_PROXY"); !ok || !strings.Contains(got, "127.0.0.1") {
		t.Errorf("NO_PROXY = %q (present %v), want loopback kept direct", got, ok)
	}
	// The skill grant does not touch the package tools: without a mirror token they stay pinned.
	if got, ok := envValue(spec.Env, "PIP_NO_INDEX"); !ok || got != "1" {
		t.Errorf("PIP_NO_INDEX = %q (present %v), want 1: the skill grant is not a download grant", got, ok)
	}
}

func TestExecWithoutSkillNetworkTokenHasNoProxy(t *testing.T) {
	e := newEnv(t, true)
	rec := e.do("POST", "/v1/exec", execBody(nil))
	if rec.Code != 200 {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
	spec := e.runner.spec
	if spec.SharedNetwork {
		t.Fatal("a call without a grant must keep its isolated network")
	}
	for _, name := range []string{"HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"} {
		if _, ok := envValue(spec.Env, name); ok {
			t.Errorf("%s must not be set without a skill network grant", name)
		}
	}
}

func TestExecRejectsAMalformedSkillNetworkToken(t *testing.T) {
	e := newEnv(t, true)
	rec := e.do("POST", "/v1/exec", execBody(func(m map[string]any) {
		m["skill_network_token"] = "not-a-token"
	}))
	if rec.Code != 400 {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
}

// Run code has no skill network field at all: a run_code request carrying one is refused as
// malformed, so run_code stays fully offline even in a chat with a grant.
func TestRunCodeRefusesASkillNetworkToken(t *testing.T) {
	e := newEnv(t, true)
	rec := e.do("POST", "/v1/run_code", runReq(func(m map[string]any) {
		m["skill_network_token"] = skillNetworkToken
	}))
	if rec.Code != 400 || errCode(t, rec) != "invalid_request" {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
}

// connectRaw speaks one CONNECT call to the forwarder the way a guest tool would, over a raw
// connection, and reports the status line and, for a tunnel, the open connection.
func connectRaw(t *testing.T, authority string) (int, string, net.Conn, *bufio.Reader) {
	t.Helper()
	conn, err := net.DialTimeout("tcp", "127.0.0.1:18772", 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fmt.Fprintf(conn, "CONNECT %s HTTP/1.1\r\nHost: %s\r\n\r\n", authority, authority); err != nil {
		t.Fatal(err)
	}
	br := bufio.NewReader(conn)
	resp, err := http.ReadResponse(br, &http.Request{Method: http.MethodConnect})
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != 200 {
		body, _ := io.ReadAll(resp.Body)
		conn.Close()
		return resp.StatusCode, string(body), nil, nil
	}
	return resp.StatusCode, "", conn, br
}

// TestSkillNetworkForwarder runs a held exec so a grant is active, then speaks to the forwarder
// the way a guest would: CONNECT under the active grant is carried to the gateway socket with the
// token; the gateway's refusals come back as-is; everything else is refused.
func TestSkillNetworkForwarder(t *testing.T) {
	e := newEnv(t, true)
	gatewaySocket := filepath.Join(e.tmp, "skillnet.sock")
	type seen struct {
		authority string
		token     string
	}
	seenCh := make(chan seen, 8)
	ln, err := net.Listen("unix", gatewaySocket)
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go func(conn net.Conn) {
				defer conn.Close()
				br := bufio.NewReader(conn)
				req, err := http.ReadRequest(br)
				if err != nil {
					return
				}
				authority := req.URL.Host
				if authority == "" {
					authority = req.Host
				}
				seenCh <- seen{authority: authority, token: req.Header.Get("X-Aman-Skill-Network-Token")}
				if strings.Contains(authority, "refused") {
					body := "not one of the approved sites"
					fmt.Fprintf(conn, "HTTP/1.1 403 Refused\r\nContent-Type: text/plain\r\nContent-Length: %d\r\n\r\n%s", len(body), body)
					return
				}
				_, _ = io.WriteString(conn, "HTTP/1.1 200 Connection Established\r\n\r\n")
				// Echo whatever the tunnel sends, from the buffered reader so nothing is lost.
				_, _ = io.Copy(conn, br)
			}(conn)
		}
	}()
	e.srv.SkillNetSocketPath = gatewaySocket
	if err := e.srv.StartSkillNetworkForwarder(); err != nil {
		t.Fatal(err)
	}
	e.runner.hold = make(chan struct{})
	done := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		done <- e.do("POST", "/v1/exec", execBody(func(m map[string]any) {
			m["skill_network_token"] = skillNetworkToken
		}))
	}()
	// Wait until the held call's grant is active.
	deadline := time.Now().Add(5 * time.Second)
	for {
		conn, err := net.DialTimeout("tcp", "127.0.0.1:18772", time.Second)
		if err == nil {
			_ = conn.Close()
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the forwarder never started listening")
		}
		time.Sleep(25 * time.Millisecond)
	}
	deadline = time.Now().Add(5 * time.Second)
	for {
		code, _, conn, br := connectRaw(t, "github.com:443")
		if code == 200 {
			// The tunnel is live: bytes come back through the gateway echo.
			if _, err := conn.Write([]byte("through the tunnel")); err != nil {
				t.Fatal(err)
			}
			buf := make([]byte, len("through the tunnel"))
			if _, err := io.ReadFull(br, buf); err != nil {
				t.Fatal(err)
			}
			if string(buf) != "through the tunnel" {
				t.Fatalf("tunnel echoed %q", buf)
			}
			conn.Close()
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("the grant never opened the forwarder; last status %d", code)
		}
		time.Sleep(25 * time.Millisecond)
	}
	if got := <-seenCh; got.authority != "github.com:443" || got.token != skillNetworkToken {
		t.Fatalf("gateway saw %+v", got)
	}
	// The gateway's own refusal is relayed with its words.
	if code, body, _, _ := connectRaw(t, "refused.example.com:443"); code != 403 || !strings.Contains(body, "not one of the approved sites") {
		t.Errorf("a gateway refusal = %d %q, want 403 with the gateway's words", code, body)
	}
	// A plain request is not carried at all.
	plain, err := net.DialTimeout("tcp", "127.0.0.1:18772", 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := io.WriteString(plain, "GET http://github.com/ HTTP/1.1\r\nHost: github.com\r\n\r\n"); err != nil {
		t.Fatal(err)
	}
	resp, err := http.ReadResponse(bufio.NewReader(plain), &http.Request{Method: http.MethodGet})
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != 405 {
		t.Errorf("a plain GET = %d, want 405", resp.StatusCode)
	}
	plain.Close()
	close(e.runner.hold)
	rec := <-done
	if rec.Code != 200 {
		t.Fatalf("the held exec finished with %d %s", rec.Code, rec.Body.String())
	}
	// With the call over, the grant is closed again.
	if code, _, _, _ := connectRaw(t, "github.com:443"); code != 403 {
		t.Errorf("after the call the forwarder = %d, want 403", code)
	}
}

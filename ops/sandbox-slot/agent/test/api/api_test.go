package api_test

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"aman/slotagent/src/api"
	"aman/slotagent/src/attest"
	"aman/slotagent/src/guest"
)

const (
	runID     = "0123456789abcdef0123456789abcdef"
	sessionID = "fedcba9876543210fedcba9876543210"
)

type fakeAttestor struct{ ok bool }

func (f fakeAttestor) Collect() attest.Report {
	return attest.Report{OK: f.ok, Checks: []attest.Check{{Name: "apparmor", OK: f.ok, Detail: "wrong profile"}}}
}

// fakeRunner records the spec and optionally runs a hook that plays the guest.
type fakeRunner struct {
	mu   sync.Mutex
	spec guest.Spec
	opts guest.Options
	play func(guest.Spec)
	res  guest.Result
	hold chan struct{}
	// guardCause is what the disk guard answered when the fake guest finished writing.
	guardCause string
}

func (f *fakeRunner) Run(_ context.Context, spec guest.Spec, opts guest.Options) guest.Result {
	f.mu.Lock()
	f.spec, f.opts = spec, opts
	f.mu.Unlock()
	if f.hold != nil {
		<-f.hold
	}
	if f.play != nil {
		f.play(spec)
	}
	if opts.Guard != nil {
		f.guardCause = opts.Guard()
		if f.guardCause != "" {
			return guest.Result{Cause: f.guardCause, ExitCode: -1}
		}
	}
	return f.res
}

type env struct {
	srv    *api.Server
	runner *fakeRunner
	h      http.Handler
	tmp    string
}

func newEnv(t *testing.T, attestOK bool) *env {
	t.Helper()
	tmp := t.TempDir()
	runner := &fakeRunner{res: guest.Result{Cause: guest.Completed, Stdout: []byte("hi")}}
	srv := &api.Server{
		Attestor:  fakeAttestor{ok: attestOK},
		Runner:    runner,
		LeaseDir:  filepath.Join(tmp, "leases"),
		VolumeDir: tmp,
		TreeDir:   filepath.Join(tmp, "sessions"),
		RootFS:    "/rootfs",
		OOMKills:  func() int64 { return 0 },
	}
	return &env{srv: srv, runner: runner, h: srv.Handler(), tmp: tmp}
}

func (e *env) do(method, path string, body any) *httptest.ResponseRecorder {
	var raw []byte
	switch b := body.(type) {
	case string:
		raw = []byte(b)
	case nil:
	default:
		raw, _ = json.Marshal(b)
	}
	req := httptest.NewRequest(method, path, bytes.NewReader(raw))
	rec := httptest.NewRecorder()
	e.h.ServeHTTP(rec, req)
	return rec
}

func errCode(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	var b struct {
		Error struct{ Code string } `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &b); err != nil {
		t.Fatalf("not an error body: %s", rec.Body.String())
	}
	return b.Error.Code
}

func runReq(mod func(m map[string]any)) map[string]any {
	m := map[string]any{
		"run_id": runID, "argv": []string{"python3", "/ingress/main.py"},
		"files_in":   []map[string]string{{"name": "main.py", "content_base64": base64.StdEncoding.EncodeToString([]byte("print(1)"))}},
		"timeout_ms": 5000, "disk_mb": 10,
	}
	if mod != nil {
		mod(m)
	}
	return m
}

func TestHealthReportsAttestation(t *testing.T) {
	e := newEnv(t, true)
	rec := e.do("GET", "/v1/health", nil)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"busy":false`) {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
}

func TestHealthCountsSessionTrees(t *testing.T) {
	e := newEnv(t, true)
	content := base64.StdEncoding.EncodeToString([]byte("x"))
	e.do("POST", "/v1/fs_write", map[string]any{"session_id": sessionID, "path": "/workspace/a", "content_base64": content, "mode": 0o644})
	e.do("POST", "/v1/fs_write", map[string]any{"session_id": runID, "path": "/workspace/a", "content_base64": content, "mode": 0o644})
	rec := e.do("GET", "/v1/health", nil)
	if !strings.Contains(rec.Body.String(), `"sessions":2`) {
		t.Fatalf("%s", rec.Body.String())
	}
}

func TestRunCodeValidatesBeforeTouchingTheVolume(t *testing.T) {
	cases := map[string]func(map[string]any){
		"bad run id":        func(m map[string]any) { m["run_id"] = "../../x" },
		"unknown field":     func(m map[string]any) { m["image"] = "evil" },
		"traversal name":    func(m map[string]any) { m["files_in"] = []map[string]string{{"name": "../x", "content_base64": ""}} },
		"timeout too small": func(m map[string]any) { m["timeout_ms"] = 10 },
		"timeout too large": func(m map[string]any) { m["timeout_ms"] = 10_000_000 },
		"disk too large":    func(m map[string]any) { m["disk_mb"] = 1 << 30 },
		"empty argv":        func(m map[string]any) { m["argv"] = []string{} },
		"relative argv0":    func(m map[string]any) { m["argv"] = []string{"bin/sh"} },
		"nul in argv":       func(m map[string]any) { m["argv"] = []string{"sh", "a\x00b"} },
		"bad base64":        func(m map[string]any) { m["files_in"] = []map[string]string{{"name": "a", "content_base64": "!!"}} },
	}
	for name, mod := range cases {
		t.Run(name, func(t *testing.T) {
			e := newEnv(t, true)
			rec := e.do("POST", "/v1/run_code", runReq(mod))
			if rec.Code != 400 || errCode(t, rec) != "invalid_request" {
				t.Fatalf("%d %s", rec.Code, rec.Body.String())
			}
			if _, err := os.Stat(e.srv.LeaseDir); err == nil {
				entries, _ := os.ReadDir(e.srv.LeaseDir)
				if len(entries) != 0 {
					t.Fatal("nothing may be staged for a rejected request")
				}
			}
		})
	}
}

func TestTrailingDataIsRejected(t *testing.T) {
	e := newEnv(t, true)
	body, _ := json.Marshal(runReq(nil))
	rec := e.do("POST", "/v1/run_code", string(body)+`{"x":1}`)
	if rec.Code != 400 {
		t.Fatalf("%d", rec.Code)
	}
}

func TestRefusedAttestationStopsEveryCall(t *testing.T) {
	e := newEnv(t, false)
	for _, call := range []struct {
		path string
		body any
	}{
		{"/v1/run_code", runReq(nil)},
		{"/v1/exec", map[string]any{"session_id": sessionID, "argv": []string{"sh"}, "cwd": "/workspace", "env": map[string]string{}, "timeout_ms": 5000, "disk_mb": 10}},
	} {
		rec := e.do("POST", call.path, call.body)
		if rec.Code != 412 || errCode(t, rec) != "isolation_refused" || !strings.Contains(rec.Body.String(), "apparmor: wrong profile") {
			t.Fatalf("%s: %d %s", call.path, rec.Code, rec.Body.String())
		}
	}
	if e.runner.spec.ID != "" {
		t.Fatal("no guest may start when attestation fails")
	}
}

func TestRunCodeStagesInputsRunsAndCollectsOutputs(t *testing.T) {
	e := newEnv(t, true)
	e.runner.play = func(s guest.Spec) {
		for _, b := range s.Binds {
			switch b.Dest {
			case "/ingress":
				got, err := os.ReadFile(filepath.Join(b.Source, "main.py"))
				if err != nil || string(got) != "print(1)" || !b.ReadOnly {
					panic("ingress not staged read-only")
				}
			case "/egress":
				_ = os.WriteFile(filepath.Join(b.Source, "out.txt"), []byte("result"), 0o644)
			}
		}
	}
	rec := e.do("POST", "/v1/run_code", runReq(nil))
	if rec.Code != 200 {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
	var resp struct {
		Stdout       string `json:"stdout"`
		TerminatedBy string `json:"terminated_by"`
		FilesOut     []struct {
			Dir  string `json:"dir"`
			Name string `json:"name"`
		} `json:"files_out"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.Stdout != "hi" || resp.TerminatedBy != "completed" || len(resp.FilesOut) != 1 || resp.FilesOut[0].Name != "out.txt" {
		t.Fatalf("%+v", resp)
	}
	if e.runner.spec.UID != 0 || e.runner.opts.StreamCap != api.StreamCapBytes {
		t.Fatalf("spec=%+v opts=%+v", e.runner.spec, e.runner.opts)
	}
	have := map[string]bool{}
	for _, kv := range e.runner.spec.Env {
		have[kv] = true
		if strings.HasPrefix(kv, "AMAN_") || strings.Contains(kv, "TOKEN") {
			t.Fatalf("unexpected env %q", kv)
		}
	}
	// Optional toolchains write only to /tmp and never reach for the network.
	for _, want := range []string{"GOPROXY=off", "GOTOOLCHAIN=local", "GOCACHE=/tmp/go-cache", "CARGO_NET_OFFLINE=true", "CARGO_HOME=/tmp/cargo"} {
		if !have[want] {
			t.Errorf("the guest environment is missing %s", want)
		}
	}
	if entries, _ := os.ReadDir(e.srv.LeaseDir); len(entries) != 0 {
		t.Fatal("the lease directory must be removed afterwards")
	}
}

func TestSecondCallWhileOneRunsGetsBusy(t *testing.T) {
	e := newEnv(t, true)
	e.runner.hold = make(chan struct{})
	done := make(chan struct{})
	go func() { e.do("POST", "/v1/run_code", runReq(nil)); close(done) }()
	for {
		e.runner.mu.Lock()
		started := e.runner.spec.ID != ""
		e.runner.mu.Unlock()
		if started {
			break
		}
	}
	rec := e.do("POST", "/v1/run_code", runReq(func(m map[string]any) { m["run_id"] = strings.Repeat("a", 32) }))
	if rec.Code != 429 || errCode(t, rec) != "busy" {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
	health := e.do("GET", "/v1/health", nil)
	if !strings.Contains(health.Body.String(), `"busy":true`) {
		t.Fatal("health must say busy while a lease runs")
	}
	close(e.runner.hold)
	<-done
}

func TestTerminationsMapOntoReportedCauses(t *testing.T) {
	cases := map[string]guest.Result{
		"timeout":         {Cause: guest.Timeout, ExitCode: -1},
		"output_exceeded": {Cause: guest.OutputExceeded, ExitCode: -1},
		"disk_exceeded":   {Cause: "disk_exceeded", ExitCode: -1},
		"killed":          {Cause: guest.Killed, ExitCode: -1},
		"internal":        {Cause: guest.Internal, ExitCode: 128, InternalError: "boom"},
	}
	for want, res := range cases {
		e := newEnv(t, true)
		e.runner.res = res
		rec := e.do("POST", "/v1/run_code", runReq(nil))
		if !strings.Contains(rec.Body.String(), `"terminated_by":"`+want+`"`) {
			t.Errorf("%s: %s", want, rec.Body.String())
		}
	}
}

func execBody(mod func(map[string]any)) map[string]any {
	m := map[string]any{
		"session_id": sessionID, "argv": []string{"bash", "-c", "echo hi"}, "cwd": "/workspace/sub",
		"env": map[string]string{"DEBUG": "1"}, "timeout_ms": 5000, "disk_mb": 10,
	}
	if mod != nil {
		mod(m)
	}
	return m
}

func TestExecMountsOnlyTheSessionTree(t *testing.T) {
	e := newEnv(t, true)
	rec := e.do("POST", "/v1/exec", execBody(nil))
	if rec.Code != 200 {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
	s := e.runner.spec
	if len(s.Binds) != 1 || s.Binds[0].Dest != "/workspace" || s.Binds[0].Source != filepath.Join(e.srv.TreeDir, sessionID) || s.Binds[0].ReadOnly {
		t.Fatalf("binds = %+v", s.Binds)
	}
	if s.Cwd != "/workspace/sub" || !e.runner.opts.MergeStderr {
		t.Fatalf("cwd=%s merge=%v", s.Cwd, e.runner.opts.MergeStderr)
	}
}

func TestExecRejectsUnsafeInput(t *testing.T) {
	cases := map[string]func(map[string]any){
		"cwd outside workspace": func(m map[string]any) { m["cwd"] = "/etc" },
		"cwd traversal":         func(m map[string]any) { m["cwd"] = "/workspace/../etc" },
		"relative cwd":          func(m map[string]any) { m["cwd"] = "sub" },
		"bad session":           func(m map[string]any) { m["session_id"] = "../x" },
		"path override":         func(m map[string]any) { m["env"] = map[string]string{"PATH": "/tmp"} },
		"preload":               func(m map[string]any) { m["env"] = map[string]string{"LD_PRELOAD": "/x.so"} },
		"git exec path":         func(m map[string]any) { m["env"] = map[string]string{"GIT_EXEC_PATH": "/x"} },
		"unlisted name":         func(m map[string]any) { m["env"] = map[string]string{"MY_TOKEN": "x"} },
		"node options":          func(m map[string]any) { m["env"] = map[string]string{"NODE_OPTIONS": "--require /x"} },
		"bad env name":          func(m map[string]any) { m["env"] = map[string]string{"A=B": "x"} },
	}
	for name, mod := range cases {
		e := newEnv(t, true)
		rec := e.do("POST", "/v1/exec", execBody(mod))
		if rec.Code != 400 {
			t.Errorf("%s: %d %s", name, rec.Code, rec.Body.String())
		}
	}
}

func TestExecAllowsGitHardeningEnv(t *testing.T) {
	e := newEnv(t, true)
	rec := e.do("POST", "/v1/exec", execBody(func(m map[string]any) {
		m["env"] = map[string]string{"GIT_CONFIG_COUNT": "1", "GIT_CONFIG_KEY_0": "core.hooksPath", "GIT_CONFIG_VALUE_0": "/dev/null", "GIT_PAGER": "cat", "PAGER": "cat", "GIT_OPTIONAL_LOCKS": "0"}
	}))
	if rec.Code != 200 {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
}

func TestExecAllowsSkillsDirAtTheFixedPath(t *testing.T) {
	e := newEnv(t, true)
	rec := e.do("POST", "/v1/exec", execBody(func(m map[string]any) {
		m["env"] = map[string]string{"TFY_SKILLS_DIR": "/workspace/.aman/skills"}
	}))
	if rec.Code != 200 {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
}

func TestExecRefusesSkillsDirAtAnyOtherPath(t *testing.T) {
	for _, value := range []string{"", "/opt/tfy/skills", "/workspace/.aman/skills/", "/workspace/.aman/skills/../../etc", "/workspace/.aman/transfer"} {
		e := newEnv(t, true)
		rec := e.do("POST", "/v1/exec", execBody(func(m map[string]any) {
			m["env"] = map[string]string{"TFY_SKILLS_DIR": value}
		}))
		if rec.Code != 400 {
			t.Errorf("TFY_SKILLS_DIR=%q: %d %s", value, rec.Code, rec.Body.String())
		}
	}
}

func TestFilesRoundTripAndStayInsideTheTree(t *testing.T) {
	e := newEnv(t, true)
	content := base64.StdEncoding.EncodeToString([]byte("data"))
	if rec := e.do("POST", "/v1/fs_write", map[string]any{"session_id": sessionID, "path": "/workspace/a/b.txt", "content_base64": content, "mode": 0o644}); rec.Code != 204 {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
	rec := e.do("POST", "/v1/fs_read", map[string]any{"session_id": sessionID, "path": "/workspace/a/b.txt"})
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), content) {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
	if rec := e.do("POST", "/v1/fs_read", map[string]any{"session_id": sessionID, "path": "/workspace/missing"}); rec.Code != 404 || errCode(t, rec) != "not_found" {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
	for _, p := range []string{"/etc/passwd", "/workspace/../x", "relative"} {
		if rec := e.do("POST", "/v1/fs_write", map[string]any{"session_id": sessionID, "path": p, "content_base64": content, "mode": 0o644}); rec.Code != 400 {
			t.Errorf("%s: %d", p, rec.Code)
		}
	}
	if rec := e.do("POST", "/v1/fs_write", map[string]any{"session_id": sessionID, "path": "/workspace/x", "content_base64": content, "mode": 0o4755}); rec.Code != 400 {
		t.Errorf("setuid modes must be refused: %d", rec.Code)
	}
}

func TestDestroySessionRemovesTheTree(t *testing.T) {
	e := newEnv(t, true)
	e.do("POST", "/v1/fs_write", map[string]any{"session_id": sessionID, "path": "/workspace/a", "content_base64": "", "mode": 0o644})
	if rec := e.do("POST", "/v1/destroy_session", map[string]any{"session_id": sessionID}); rec.Code != 204 {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
	if _, err := os.Stat(filepath.Join(e.srv.TreeDir, sessionID)); !os.IsNotExist(err) {
		t.Fatal("the tree must be gone")
	}
}

func TestOOMKillsCountOnlyWhenTheCounterRisesAndTheGuestDied(t *testing.T) {
	e := newEnv(t, true)
	var kills int64
	e.srv.OOMKills = func() int64 { kills++; return kills }
	e.runner.res = guest.Result{Cause: guest.Completed, ExitCode: 137}
	rec := e.do("POST", "/v1/run_code", runReq(nil))
	if !strings.Contains(rec.Body.String(), `"terminated_by":"oom"`) {
		t.Fatalf("%s", rec.Body.String())
	}
}

func TestExecDiskGuardKillsAnOverQuotaGuestAndTheOvershootIsRemoved(t *testing.T) {
	e := newEnv(t, true)
	e.runner.play = func(s guest.Spec) {
		// 3 MiB of real data against a 1 MiB quota, plus a small file that should survive.
		_ = os.WriteFile(filepath.Join(s.Binds[0].Source, "flood"), bytes.Repeat([]byte{1}, 3<<20), 0o644)
		_ = os.WriteFile(filepath.Join(s.Binds[0].Source, "keep.txt"), []byte("ok"), 0o644)
	}
	rec := e.do("POST", "/v1/exec", execBody(func(m map[string]any) { m["disk_mb"] = 1 }))
	if !strings.Contains(rec.Body.String(), `"terminated_by":"disk_exceeded"`) {
		t.Fatalf("%s", rec.Body.String())
	}
	tree := filepath.Join(e.srv.TreeDir, sessionID)
	if _, err := os.Stat(filepath.Join(tree, "flood")); !os.IsNotExist(err) {
		t.Fatal("the overshoot must be removed, not left on the disk")
	}
	if _, err := os.Stat(filepath.Join(tree, "keep.txt")); err != nil {
		t.Fatal("files within the quota stay")
	}
}

func TestRunCodeDiskGuardAndFileSizeCap(t *testing.T) {
	e := newEnv(t, true)
	e.runner.play = func(s guest.Spec) {
		for _, b := range s.Binds {
			if b.Dest == "/scratch" {
				_ = os.WriteFile(filepath.Join(b.Source, "flood"), bytes.Repeat([]byte{1}, 3<<20), 0o644)
			}
		}
	}
	rec := e.do("POST", "/v1/run_code", runReq(func(m map[string]any) { m["disk_mb"] = 1 }))
	if !strings.Contains(rec.Body.String(), `"terminated_by":"disk_exceeded"`) {
		t.Fatalf("%s", rec.Body.String())
	}
	if e.runner.spec.MaxFileBytes != 1<<20 {
		t.Fatalf("a single file must be capped at the quota, got %d", e.runner.spec.MaxFileBytes)
	}
}

func TestCallsAreRefusedWhenTheVolumeIsAlmostFull(t *testing.T) {
	e := newEnv(t, true)
	e.srv.MinFreeBytes = 1 << 60
	for _, call := range []struct {
		path string
		body any
	}{{"/v1/run_code", runReq(nil)}, {"/v1/exec", execBody(nil)}} {
		rec := e.do("POST", call.path, call.body)
		if rec.Code != 507 || errCode(t, rec) != "storage_full" {
			t.Fatalf("%s: %d %s", call.path, rec.Code, rec.Body.String())
		}
	}
	if e.runner.spec.ID != "" {
		t.Fatal("no guest may start on a full volume")
	}
}

func TestRequestsWithDuplicateKeysAreRefused(t *testing.T) {
	e := newEnv(t, true)
	cases := map[string]string{
		"top level": `{"session_id":"` + sessionID + `","session_id":"` + strings.Repeat("a", 32) + `","argv":["true"],"cwd":"/workspace","env":{},"timeout_ms":5000,"disk_mb":10}`,
		"env":       `{"session_id":"` + sessionID + `","argv":["true"],"cwd":"/workspace","env":{"DEBUG":"1","DEBUG":"2"},"timeout_ms":5000,"disk_mb":10}`,
		"escaped":   `{"session_id":"` + sessionID + `","argv":["true"],"cwd":"/workspace","env":{"DEBUG":"1","DEB\u0055G":"2"},"timeout_ms":5000,"disk_mb":10}`,
	}
	for name, body := range cases {
		if rec := e.do("POST", "/v1/exec", body); rec.Code != 400 || !strings.Contains(rec.Body.String(), "duplicate key") {
			t.Errorf("%s: %d %s", name, rec.Code, rec.Body.String())
		}
	}
	// The same key in sibling objects and a value that looks like a key are fine.
	ok := `{"session_id":"` + sessionID + `","argv":["a","a"],"cwd":"/workspace","env":{"DEBUG":"DEBUG"},"timeout_ms":5000,"disk_mb":10}`
	if rec := e.do("POST", "/v1/exec", ok); rec.Code != 200 {
		t.Errorf("%d %s", rec.Code, rec.Body.String())
	}
}

func TestOversizedBodiesAreRefusedPerEndpoint(t *testing.T) {
	e := newEnv(t, true)
	big := strings.Repeat("a", 100<<10)
	if rec := e.do("POST", "/v1/fs_read", map[string]any{"session_id": sessionID, "path": "/workspace/" + big}); rec.Code != 400 {
		t.Fatalf("%d", rec.Code)
	}
	if rec := e.do("POST", "/v1/destroy_session", map[string]any{"session_id": sessionID, "padding": big}); rec.Code != 400 {
		t.Fatalf("%d", rec.Code)
	}
}

func TestSessionInUseAnswersBusyForFilesAndDestroy(t *testing.T) {
	e := newEnv(t, true)
	e.runner.hold = make(chan struct{})
	done := make(chan struct{})
	go func() { e.do("POST", "/v1/exec", execBody(nil)); close(done) }()
	for {
		e.runner.mu.Lock()
		started := e.runner.spec.ID != ""
		e.runner.mu.Unlock()
		if started {
			break
		}
	}
	content := base64.StdEncoding.EncodeToString([]byte("x"))
	calls := map[string]map[string]any{
		"/v1/fs_read":         {"session_id": sessionID, "path": "/workspace/a"},
		"/v1/fs_write":        {"session_id": sessionID, "path": "/workspace/a", "content_base64": content, "mode": 0o644},
		"/v1/destroy_session": {"session_id": sessionID},
	}
	for path, body := range calls {
		if rec := e.do("POST", path, body); rec.Code != 429 || errCode(t, rec) != "busy" {
			t.Errorf("%s: %d %s", path, rec.Code, rec.Body.String())
		}
	}
	// A different session on the same slot can still move files while the lease runs.
	other := strings.Repeat("b", 32)
	if rec := e.do("POST", "/v1/fs_write", map[string]any{"session_id": other, "path": "/workspace/a", "content_base64": content, "mode": 0o644}); rec.Code != 204 {
		t.Errorf("other session: %d %s", rec.Code, rec.Body.String())
	}
	close(e.runner.hold)
	<-done
}

func TestIdleSessionsAreSweptAndBusyOnesKept(t *testing.T) {
	e := newEnv(t, true)
	content := base64.StdEncoding.EncodeToString([]byte("x"))
	old, fresh := strings.Repeat("c", 32), strings.Repeat("d", 32)
	for _, id := range []string{old, fresh} {
		e.do("POST", "/v1/fs_write", map[string]any{"session_id": id, "path": "/workspace/a", "content_base64": content, "mode": 0o644})
	}
	past := time.Now().Add(-48 * time.Hour)
	if err := os.Chtimes(filepath.Join(e.srv.TreeDir, old), past, past); err != nil {
		t.Fatal(err)
	}
	if n := e.srv.SweepIdleSessions(24 * time.Hour); n != 1 {
		t.Fatalf("removed %d", n)
	}
	if _, err := os.Stat(filepath.Join(e.srv.TreeDir, old)); !os.IsNotExist(err) {
		t.Fatal("the idle tree must be gone")
	}
	if _, err := os.Stat(filepath.Join(e.srv.TreeDir, fresh)); err != nil {
		t.Fatal("a recent tree must stay")
	}
}

func TestExecTellsTheCallerWhichFilesWereDeletedToStayWithinTheLimit(t *testing.T) {
	e := newEnv(t, true)
	tree := filepath.Join(e.srv.TreeDir, sessionID)
	if err := os.MkdirAll(tree, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(tree, "huge.bin"), make([]byte, 3<<20), 0o644); err != nil {
		t.Fatal(err)
	}
	rec := e.do("POST", "/v1/exec", execBody(func(m map[string]any) { m["disk_mb"] = 1 }))
	var resp struct {
		Notices []string `json:"notices"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if len(resp.Notices) != 1 || !strings.Contains(resp.Notices[0], "huge.bin") || !strings.Contains(resp.Notices[0], "1 MB limit") {
		t.Fatalf("notices = %q", resp.Notices)
	}
	if _, err := os.Stat(filepath.Join(tree, "huge.bin")); !os.IsNotExist(err) {
		t.Fatal("the file must have been deleted")
	}
	rec = e.do("POST", "/v1/exec", execBody(nil))
	if !strings.Contains(rec.Body.String(), `"notices":[]`) {
		t.Fatalf("an ordinary call has an empty list, not null: %s", rec.Body.String())
	}
}

const mirrorToken = "0123456789abcdef0123456789abcdef"

func envValue(env []string, name string) (string, bool) {
	for _, entry := range env {
		if strings.HasPrefix(entry, name+"=") {
			return strings.TrimPrefix(entry, name+"="), true
		}
	}
	return "", false
}

func TestExecWithMirrorTokenPointsToolsAtTheMirror(t *testing.T) {
	e := newEnv(t, true)
	rec := e.do("POST", "/v1/exec", execBody(func(m map[string]any) {
		m["package_mirror_token"] = mirrorToken
	}))
	if rec.Code != 200 {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
	spec := e.runner.spec
	if !spec.SharedNetwork {
		t.Fatal("a call with a mirror grant must run in the slot's loopback namespace")
	}
	base := "http://127.0.0.1:18771/m/" + mirrorToken
	for name, want := range map[string]string{
		"PIP_INDEX_URL":                       base + "/pypi/simple",
		"npm_config_registry":                 base + "/npm",
		"GOPROXY":                             base + "/go",
		"CARGO_SOURCE_CRATES_IO_REPLACE_WITH": "aman-mirror",
		"CARGO_SOURCE_AMAN_MIRROR_REGISTRY":   "sparse+" + base + "/cargo",
		"npm_config_audit":                    "false",
		"npm_config_fund":                     "false",
	} {
		got, ok := envValue(spec.Env, name)
		if !ok || got != want {
			t.Errorf("%s = %q (present %v), want %q", name, got, ok, want)
		}
	}
	for _, name := range []string{"PIP_NO_INDEX", "CARGO_NET_OFFLINE"} {
		if _, ok := envValue(spec.Env, name); ok {
			t.Errorf("%s must not be set when mirrors are granted", name)
		}
	}
	if goproxy, _ := envValue(spec.Env, "GOPROXY"); strings.Contains(goproxy, "direct") {
		t.Errorf("GOPROXY must name the mirror only, got %q", goproxy)
	}
}

func TestExecWithoutMirrorTokenStaysOffline(t *testing.T) {
	e := newEnv(t, true)
	rec := e.do("POST", "/v1/exec", execBody(nil))
	if rec.Code != 200 {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
	spec := e.runner.spec
	if spec.SharedNetwork {
		t.Fatal("a call without a mirror grant must keep its isolated network")
	}
	for name, want := range map[string]string{
		"PIP_NO_INDEX":      "1",
		"GOPROXY":           "off",
		"CARGO_NET_OFFLINE": "true",
		"npm_config_audit":  "false",
		"npm_config_fund":   "false",
	} {
		got, ok := envValue(spec.Env, name)
		if !ok || got != want {
			t.Errorf("%s = %q (present %v), want %q", name, got, ok, want)
		}
	}
}

func TestExecRejectsAMalformedMirrorToken(t *testing.T) {
	e := newEnv(t, true)
	rec := e.do("POST", "/v1/exec", execBody(func(m map[string]any) {
		m["package_mirror_token"] = "not-a-token"
	}))
	if rec.Code != 400 {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
}

// TestMirrorForwarder runs a held exec so a grant is active, then speaks to the forwarder the way
// a guest would: only GET and HEAD for the granted token are carried to the gateway socket.
func TestMirrorForwarder(t *testing.T) {
	e := newEnv(t, true)
	gatewaySocket := filepath.Join(e.tmp, "mirror.sock")
	type seen struct {
		path  string
		token string
	}
	seenCh := make(chan seen, 8)
	ln, err := net.Listen("unix", gatewaySocket)
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	gateway := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenCh <- seen{path: r.URL.EscapedPath(), token: r.Header.Get("X-Aman-Mirror-Token")}
		_, _ = io.WriteString(w, "gateway answer")
	})}
	go func() { _ = gateway.Serve(ln) }()
	defer gateway.Close()
	e.srv.MirrorSocketPath = gatewaySocket
	if err := e.srv.StartMirrorForwarder(); err != nil {
		t.Fatal(err)
	}
	e.runner.hold = make(chan struct{})
	done := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		done <- e.do("POST", "/v1/exec", execBody(func(m map[string]any) {
			m["package_mirror_token"] = mirrorToken
		}))
	}()
	base := "http://127.0.0.1:18771/m/" + mirrorToken
	client := &http.Client{Timeout: 5 * time.Second}
	call := func(method, url string) (int, string) {
		req, err := http.NewRequest(method, url, nil)
		if err != nil {
			t.Fatal(err)
		}
		resp, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		body, _ := io.ReadAll(resp.Body)
		return resp.StatusCode, string(body)
	}
	// Wait until the held call's grant is active.
	deadline := time.Now().Add(5 * time.Second)
	for {
		code, _ := call("GET", base+"/npm/leftpad")
		if code == 200 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("the grant never opened the forwarder; last status %d", code)
		}
		time.Sleep(25 * time.Millisecond)
	}
	if got := <-seenCh; got.path != "/npm/leftpad" || got.token != mirrorToken {
		t.Fatalf("gateway saw %+v", got)
	}
	if code, _ := call("PUT", base+"/npm/leftpad"); code != 405 {
		t.Errorf("PUT to the mirror = %d, want 405", code)
	}
	if code, _ := call("POST", base+"/npm/leftpad/-/leftpad-1.0.0.tgz"); code != 405 {
		t.Errorf("POST to the mirror = %d, want 405", code)
	}
	other := "http://127.0.0.1:18771/m/ffffffffffffffffffffffffffffffff/npm/leftpad"
	if code, _ := call("GET", other); code != 403 {
		t.Errorf("another token = %d, want 403", code)
	}
	if code, _ := call("GET", base+"/npm/%2e%2e/secret"); code != 404 {
		t.Errorf("a dot step = %d, want 404", code)
	}
	if code, _ := call("GET", base+"/npm/..%2fsecret"); code != 404 {
		t.Errorf("an encoded dot step = %d, want 404", code)
	}
	code, body := call("GET", base+"/npm/@scope%2fpkg")
	if code != 200 || body != "gateway answer" {
		t.Fatalf("scoped name = %d %q", code, body)
	}
	if got := <-seenCh; got.path != "/npm/@scope%2fpkg" {
		t.Fatalf("gateway saw %q for the scoped name", got.path)
	}
	// A trailing slash is part of the address, not an empty step: PyPI project pages are
	// only ever requested with one, and the gateway wants the rest exactly as written.
	for _, path := range []string{"/pypi/simple/requests/", "/pypi/simple/", "/pypi/", "/npm/leftpad/"} {
		code, body := call("GET", base+path)
		if code != 200 || body != "gateway answer" {
			t.Errorf("GET %s = %d %q, want 200 from the gateway", path, code, body)
			continue
		}
		if got := <-seenCh; got.path != path {
			t.Errorf("gateway saw %q for %s", got.path, path)
		}
	}
	// A doubled slash inside the path is still refused.
	if code, _ := call("GET", base+"/pypi/simple//requests/"); code != 404 {
		t.Errorf("a doubled slash inside the path = %d, want 404", code)
	}
	if code, _ := call("GET", base+"/pypi//simple/requests/"); code != 404 {
		t.Errorf("a doubled slash after the ecosystem = %d, want 404", code)
	}
	close(e.runner.hold)
	rec := <-done
	if rec.Code != 200 {
		t.Fatalf("the held exec finished with %d %s", rec.Code, rec.Body.String())
	}
	// With the call over, the grant is closed again.
	if code, _ := call("GET", base+"/npm/leftpad"); code != 403 {
		t.Errorf("after the call the forwarder = %d, want 403", code)
	}
}

// TestMirrorForwarderLivePip is the live check for the mirror path: the real pip, talking to
// this real forwarder, backed by a real gateway on the socket in AMAN_E2E_MIRROR_SOCKET, whose
// grant token is in AMAN_E2E_MIRROR_TOKEN. It is skipped unless both are set, and it must run
// alone (go test -run TestMirrorForwarderLivePip): the forwarder's loopback port belongs to
// whichever server started it first in the process.
func TestMirrorForwarderLivePip(t *testing.T) {
	socket := os.Getenv("AMAN_E2E_MIRROR_SOCKET")
	token := os.Getenv("AMAN_E2E_MIRROR_TOKEN")
	if socket == "" || token == "" {
		t.Skip("set AMAN_E2E_MIRROR_SOCKET and AMAN_E2E_MIRROR_TOKEN to run the live mirror check")
	}
	if _, err := exec.LookPath("pip3"); err != nil {
		t.Skip("pip3 is not available")
	}
	e := newEnv(t, true)
	e.srv.MirrorSocketPath = socket
	if err := e.srv.StartMirrorForwarder(); err != nil {
		t.Fatal(err)
	}
	e.runner.hold = make(chan struct{})
	done := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		done <- e.do("POST", "/v1/exec", execBody(func(m map[string]any) {
			m["package_mirror_token"] = token
		}))
	}()
	defer func() {
		close(e.runner.hold)
		<-done
	}()
	base := "http://127.0.0.1:18771/m/" + token
	client := &http.Client{Timeout: 30 * time.Second}
	// Publishes are refused by the forwarder itself, before any grant question.
	for _, method := range []string{"PUT", "POST"} {
		for _, path := range []string{"/npm/leftpad", "/pypi/"} {
			req, err := http.NewRequest(method, base+path, nil)
			if err != nil {
				t.Fatal(err)
			}
			resp, err := client.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			resp.Body.Close()
			if resp.StatusCode != 405 {
				t.Errorf("%s %s through the forwarder = %d, want 405", method, path, resp.StatusCode)
			}
		}
	}
	// Wait for the grant, then confirm the project page pip asks for comes through whole.
	deadline := time.Now().Add(60 * time.Second)
	for {
		resp, err := client.Get(base + "/pypi/simple/six/")
		if err == nil {
			body, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			if resp.StatusCode == 200 && strings.Contains(string(body), "six-1.16.0") {
				break
			}
		}
		if time.Now().After(deadline) {
			t.Fatal("the PyPI project page never came through the forwarder")
		}
		time.Sleep(250 * time.Millisecond)
	}
	dir := t.TempDir()
	cmd := exec.Command("pip3", "download", "six==1.16.0", "--no-deps", "-d", dir)
	cmd.Env = append(os.Environ(), "PIP_INDEX_URL="+base+"/pypi/simple")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("pip download through the forwarder failed: %v\n%s", err, out)
	}
	if _, err := os.Stat(filepath.Join(dir, "six-1.16.0-py2.py3-none-any.whl")); err != nil {
		t.Fatalf("pip did not save the wheel: %v", err)
	}
}

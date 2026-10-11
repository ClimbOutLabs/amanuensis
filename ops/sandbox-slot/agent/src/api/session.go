package api

import (
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path"
	"regexp"
	"sort"
	"strings"
	"time"

	"aman/slotagent/src/guest"
	"aman/slotagent/src/lease"
	"aman/slotagent/src/tree"
)

const (
	maxEnvEntries  = 64
	maxEnvValueLen = 8 << 10
)

var envNamePattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]{0,63}$`)

// forbiddenEnv are names a caller may never set: they would change which programs run or undo the
// image's git hardening.
func forbiddenEnv(name string) bool {
	switch name {
	case "PATH", "BASH_ENV", "ENV", "HOME", "USER", "LOGNAME":
		return true
	}
	if strings.HasPrefix(name, "GIT_") {
		return !gitHardeningEnv(name)
	}
	return strings.HasPrefix(name, "LD_")
}

// gitHardeningEnv are the git variables the server's hardened-git wrapper sends: they only tighten git.
func gitHardeningEnv(name string) bool {
	switch name {
	case "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_COUNT", "GIT_ATTR_NOSYSTEM",
		"GIT_OPTIONAL_LOCKS", "GIT_PAGER", "GIT_TERMINAL_PROMPT":
		return true
	}
	return gitConfigPair.MatchString(name)
}

var gitConfigPair = regexp.MustCompile(`^GIT_CONFIG_(KEY|VALUE)_[0-9]{1,3}$`)

func validateEnv(env map[string]string) error {
	if len(env) > maxEnvEntries {
		return fmt.Errorf("env has more than %d entries", maxEnvEntries)
	}
	var denied []string
	for name, value := range env {
		if !envNamePattern.MatchString(name) {
			return fmt.Errorf("env name %q is not allowed", name)
		}
		if forbiddenEnv(name) {
			denied = append(denied, name)
		}
		if len(value) > maxEnvValueLen || strings.IndexByte(value, 0) >= 0 {
			return fmt.Errorf("env value for %q is too long or contains NUL", name)
		}
	}
	if len(denied) > 0 {
		sort.Strings(denied)
		return fmt.Errorf("env names are not allowed: %s", strings.Join(denied, ", "))
	}
	return nil
}

type execRequest struct {
	SessionID string            `json:"session_id"`
	Argv      []string          `json:"argv"`
	Cwd       string            `json:"cwd"`
	Env       map[string]string `json:"env"`
	TimeoutMS int               `json:"timeout_ms"`
	DiskMB    int               `json:"disk_mb"`
}

type execResponse struct {
	ExitCode      int    `json:"exit_code"`
	Output        string `json:"output"`
	TerminatedBy  string `json:"terminated_by"`
	InternalError string `json:"internal_error"`
	DurationMS    int64  `json:"duration_ms"`
}

func (r *execRequest) validate() error {
	if !tree.ValidSessionID(r.SessionID) {
		return errors.New("session_id must be 32 lowercase hex characters")
	}
	if err := validateArgv(r.Argv); err != nil {
		return err
	}
	if _, err := tree.Relative(r.Cwd); err != nil {
		return fmt.Errorf("cwd: %w", err)
	}
	if err := validateEnv(r.Env); err != nil {
		return err
	}
	if r.TimeoutMS < MinTimeoutMS || r.TimeoutMS > MaxTimeoutMS {
		return fmt.Errorf("timeout_ms must be %d to %d", MinTimeoutMS, MaxTimeoutMS)
	}
	if r.DiskMB < 1 || r.DiskMB > MaxDiskMB {
		return fmt.Errorf("disk_mb must be 1 to %d", MaxDiskMB)
	}
	return nil
}

// acquire takes the slot's single lease, or answers 429 and reports false.
func (s *Server) acquire(w http.ResponseWriter) bool {
	select {
	case s.sem <- struct{}{}:
		return true
	default:
		writeError(w, http.StatusTooManyRequests, ErrBusy, "this slot is running another call")
		return false
	}
}

// attestOrRefuse re-attests the cell before a lease; a failing cell answers 412 and reports false.
func (s *Server) attestOrRefuse(w http.ResponseWriter) bool {
	report := s.Attestor.Collect()
	s.mu.Lock()
	s.last = report
	s.mu.Unlock()
	if !report.OK {
		writeError(w, http.StatusPreconditionFailed, ErrIsolationRefused, failedChecks(report))
		return false
	}
	return true
}

func (s *Server) exec(w http.ResponseWriter, r *http.Request) {
	var req execRequest
	if err := decodeStrict(r, w, &req); err != nil {
		writeError(w, http.StatusBadRequest, ErrInvalidRequest, err.Error())
		return
	}
	if err := req.validate(); err != nil {
		writeError(w, http.StatusBadRequest, ErrInvalidRequest, err.Error())
		return
	}
	if !s.acquire(w) {
		return
	}
	defer func() { <-s.sem }()
	if !s.attestOrRefuse(w) {
		return
	}
	root, err := tree.Ensure(s.TreeDir, req.SessionID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, ErrInternal, "the session tree could not be prepared")
		return
	}
	env := guestEnv()
	for name, value := range req.Env {
		env = append(env, name+"="+value)
	}
	spec := guest.Spec{
		// Unique per call, so a guest whose cleanup stalled can never block the next call of the session.
		ID:     fmt.Sprintf("exec-%s-%d", req.SessionID[:12], time.Now().UnixNano()),
		RootFS: s.RootFS,
		Argv:   req.Argv,
		Env:    env,
		Cwd:    path.Clean(req.Cwd),
		UID:    guestUID,
		GID:    guestGID,
		Binds:  []guest.Bind{{Dest: tree.GuestRoot, Source: root}},
		Tmpfs:  []guest.Tmpfs{{Dest: "/tmp", SizeMB: guestTmpMB}},
	}
	limit := int64(req.DiskMB) << 20
	spec.MaxFileBytes = limit
	// A tree left over its limit by an earlier overshoot is trimmed before anything new runs in it.
	lease.Reclaim(root, limit)
	watch, err := newDiskWatch(s.VolumeDir, s.MinFreeBytes, limit, root)
	if err != nil {
		writeStorageError(w, err)
		return
	}
	started := time.Now()
	oomBefore := s.OOMKills()
	res := s.Runner.Run(r.Context(), spec, guest.Options{
		Timeout:       time.Duration(req.TimeoutMS) * time.Millisecond,
		StreamCap:     StreamCapBytes,
		MergeStderr:   true,
		Guard:         watch.guard,
		GuardInterval: guardIntervalMS * time.Millisecond,
	})
	// Whatever a fast writer got in before the kill is removed, largest files first, so the overshoot never stays.
	lease.Reclaim(root, limit)
	writeJSON(w, http.StatusOK, execResponse{
		ExitCode:      res.ExitCode,
		Output:        string(res.Stdout),
		TerminatedBy:  terminationFor(res, s.OOMKills() > oomBefore),
		InternalError: res.InternalError,
		DurationMS:    time.Since(started).Milliseconds(),
	})
}

type fsReadRequest struct {
	SessionID string `json:"session_id"`
	Path      string `json:"path"`
}

type fsReadResponse struct {
	ContentBase64 string `json:"content_base64"`
	SizeBytes     int    `json:"size_bytes"`
}

type fsWriteRequest struct {
	SessionID     string `json:"session_id"`
	Path          string `json:"path"`
	ContentBase64 string `json:"content_base64"`
	Mode          int    `json:"mode"`
}

type destroyRequest struct {
	SessionID string `json:"session_id"`
}

func fsError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, os.ErrNotExist):
		writeError(w, http.StatusNotFound, ErrNotFound, "no such file")
	default:
		writeError(w, http.StatusBadRequest, ErrInvalidRequest, err.Error())
	}
}

func (s *Server) fsRead(w http.ResponseWriter, r *http.Request) {
	var req fsReadRequest
	if err := decodeStrict(r, w, &req); err != nil || !tree.ValidSessionID(req.SessionID) {
		writeError(w, http.StatusBadRequest, ErrInvalidRequest, "session_id and path are required")
		return
	}
	b, err := tree.Read(tree.Root(s.TreeDir, req.SessionID), req.Path)
	if err != nil {
		fsError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, fsReadResponse{ContentBase64: base64.StdEncoding.EncodeToString(b), SizeBytes: len(b)})
}

func (s *Server) fsWrite(w http.ResponseWriter, r *http.Request) {
	var req fsWriteRequest
	if err := decodeStrict(r, w, &req); err != nil || !tree.ValidSessionID(req.SessionID) {
		writeError(w, http.StatusBadRequest, ErrInvalidRequest, "session_id, path and content_base64 are required")
		return
	}
	if req.Mode < 0o400 || req.Mode > 0o755 {
		writeError(w, http.StatusBadRequest, ErrInvalidRequest, "mode must be between 0400 and 0755")
		return
	}
	content, err := lease.DecodeBase64(req.ContentBase64)
	if err != nil {
		writeError(w, http.StatusBadRequest, ErrInvalidRequest, "content_base64 is not canonical base64")
		return
	}
	root, err := tree.Ensure(s.TreeDir, req.SessionID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, ErrInternal, "the session tree could not be prepared")
		return
	}
	if err := tree.Write(root, req.Path, content, os.FileMode(req.Mode)); err != nil {
		fsError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) destroySession(w http.ResponseWriter, r *http.Request) {
	var req destroyRequest
	if err := decodeStrict(r, w, &req); err != nil || !tree.ValidSessionID(req.SessionID) {
		writeError(w, http.StatusBadRequest, ErrInvalidRequest, "session_id is required")
		return
	}
	// A running lease holds the semaphore, so a tree is never removed under a guest.
	if !s.acquire(w) {
		return
	}
	defer func() { <-s.sem }()
	if err := tree.Destroy(s.TreeDir, req.SessionID); err != nil {
		writeError(w, http.StatusInternalServerError, ErrInternal, "the session tree could not be removed")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

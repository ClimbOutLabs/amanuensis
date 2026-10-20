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

// allowedEnv are the only names a caller may set. The guest's PATH, HOME and library paths stay under the
// agent's control, and git configuration only arrives as the hardening the server's wrapper sends.
var allowedEnv = map[string]bool{
	"LANG": true, "TZ": true, "TERM": true, "COLUMNS": true, "LINES": true, "NO_COLOR": true,
	"FORCE_COLOR": true, "CI": true, "DEBUG": true, "NODE_ENV": true,
	"PYTHONUNBUFFERED": true, "PYTHONIOENCODING": true, "PYTHONUTF8": true, "PYTHONHASHSEED": true,
	"PYTHONPATH": true, "NODE_PATH": true,
	// The host asks for plain output with PAGER=cat, as it does with GIT_PAGER.
	"PAGER":               true,
	"GIT_CONFIG_NOSYSTEM": true, "GIT_CONFIG_GLOBAL": true, "GIT_CONFIG_COUNT": true,
	"GIT_CONFIG_PARAMETERS": true, "GIT_ATTR_NOSYSTEM": true, "GIT_OPTIONAL_LOCKS": true,
	"GIT_PAGER": true, "GIT_TERMINAL_PROMPT": true,
	"GIT_AUTHOR_NAME": true, "GIT_AUTHOR_EMAIL": true, "GIT_AUTHOR_DATE": true,
	"GIT_COMMITTER_NAME": true, "GIT_COMMITTER_EMAIL": true, "GIT_COMMITTER_DATE": true,
}

var allowedEnvPattern = regexp.MustCompile(`^(LC_[A-Z_]{1,32}|GIT_CONFIG_(KEY|VALUE)_[0-9]{1,3})$`)

// skillsDirEnv may be set only to skillsDirPath, the fixed directory the host copies skills into.
const (
	skillsDirEnv  = "TFY_SKILLS_DIR"
	skillsDirPath = "/workspace/.aman/skills"
)

func envNameAllowed(name string) bool { return allowedEnv[name] || allowedEnvPattern.MatchString(name) }

func validateEnv(env map[string]string) error {
	if len(env) > maxEnvEntries {
		return fmt.Errorf("env has more than %d entries", maxEnvEntries)
	}
	var denied []string
	for name, value := range env {
		if !envNamePattern.MatchString(name) {
			return fmt.Errorf("env name %q is not allowed", name)
		}
		if name == skillsDirEnv {
			if value != skillsDirPath {
				return fmt.Errorf("env %s must be %s", skillsDirEnv, skillsDirPath)
			}
			continue
		}
		if !envNameAllowed(name) {
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
	// PackageMirrorToken grants this call the package mirrors; empty keeps the guest offline.
	PackageMirrorToken string `json:"package_mirror_token"`
}

type execResponse struct {
	ExitCode      int    `json:"exit_code"`
	Output        string `json:"output"`
	TerminatedBy  string `json:"terminated_by"`
	InternalError string `json:"internal_error"`
	// Notices are things the server should tell the person, such as files deleted to stay within the limit.
	Notices    []string `json:"notices"`
	DurationMS int64    `json:"duration_ms"`
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
	if r.PackageMirrorToken != "" && !validMirrorToken(r.PackageMirrorToken) {
		return errors.New("package_mirror_token must be 32 lowercase hex characters")
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
	if err := decodeStrict(r, w, &req, execBodyBytes); err != nil {
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
	if !s.lockSession(w, req.SessionID) {
		return
	}
	defer s.sessions.unlock(req.SessionID)
	root, err := tree.Ensure(s.TreeDir, req.SessionID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, ErrInternal, "the session tree could not be prepared")
		return
	}
	env := guestEnv(req.PackageMirrorToken)
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
		SharedNetwork: req.PackageMirrorToken != "",
	}
	limit := int64(req.DiskMB) << 20
	spec.MaxFileBytes = limit
	spec.MaxProcesses = guestMaxProcesses
	// A tree left over its limit by an earlier overshoot is trimmed before anything new runs in it.
	notices := reclaimNotice(lease.Reclaim(root, limit), req.DiskMB, nil)
	watch, err := newDiskWatch(s.VolumeDir, s.MinFreeBytes, limit, root)
	if err != nil {
		writeStorageError(w, err)
		return
	}
	started := time.Now()
	oomBefore := s.OOMKills()
	endGrant := s.beginMirrorGrant(req.PackageMirrorToken)
	res := s.Runner.Run(r.Context(), spec, guest.Options{
		Timeout:       time.Duration(req.TimeoutMS) * time.Millisecond,
		StreamCap:     StreamCapBytes,
		MergeStderr:   true,
		Guard:         watch.guard,
		GuardInterval: guardIntervalMS * time.Millisecond,
	})
	endGrant()
	// Whatever a fast writer got in before the kill is removed, largest files first, so the overshoot never stays.
	notices = reclaimNotice(lease.Reclaim(root, limit), req.DiskMB, notices)
	writeJSON(w, http.StatusOK, execResponse{
		ExitCode:      res.ExitCode,
		Output:        string(res.Stdout),
		TerminatedBy:  terminationFor(res, s.OOMKills() > oomBefore),
		InternalError: res.InternalError,
		Notices:       notices,
		DurationMS:    time.Since(started).Milliseconds(),
	})
}

// reclaimNotice appends the sentence about deleted files, if any, to the call's notices; never nil.
func reclaimNotice(r lease.Reclaimed, limitMB int, notices []string) []string {
	if notices == nil {
		notices = []string{}
	}
	if text := r.Notice(limitMB); text != "" {
		notices = append(notices, text)
	}
	return notices
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
	if err := decodeStrict(r, w, &req, smallBodyBytes); err != nil || !tree.ValidSessionID(req.SessionID) {
		writeError(w, http.StatusBadRequest, ErrInvalidRequest, "session_id and path are required")
		return
	}
	if !s.lockSession(w, req.SessionID) {
		return
	}
	defer s.sessions.unlock(req.SessionID)
	b, err := tree.Read(tree.Root(s.TreeDir, req.SessionID), req.Path)
	if err != nil {
		fsError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, fsReadResponse{ContentBase64: base64.StdEncoding.EncodeToString(b), SizeBytes: len(b)})
}

func (s *Server) fsWrite(w http.ResponseWriter, r *http.Request) {
	var req fsWriteRequest
	if err := decodeStrict(r, w, &req, fsWriteBodyBytes); err != nil || !tree.ValidSessionID(req.SessionID) {
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
	if !s.lockSession(w, req.SessionID) {
		return
	}
	defer s.sessions.unlock(req.SessionID)
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
	if err := decodeStrict(r, w, &req, smallBodyBytes); err != nil || !tree.ValidSessionID(req.SessionID) {
		writeError(w, http.StatusBadRequest, ErrInvalidRequest, "session_id is required")
		return
	}
	// A running lease holds the semaphore, so a tree is never removed under a guest.
	if !s.acquire(w) {
		return
	}
	defer func() { <-s.sem }()
	if !s.lockSession(w, req.SessionID) {
		return
	}
	defer s.sessions.unlock(req.SessionID)
	if err := tree.Destroy(s.TreeDir, req.SessionID); err != nil {
		writeError(w, http.StatusInternalServerError, ErrInternal, "the session tree could not be removed")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

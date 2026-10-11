// Package api is the agent's HTTP surface on its Unix socket. Requests are decoded strictly: unknown
// fields, trailing data and out-of-range values are rejected before anything touches the volume.
package api

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"aman/slotagent/src/attest"
	"aman/slotagent/src/guest"
	"aman/slotagent/src/lease"
	"aman/slotagent/src/tree"
)

// Limits on a request.
const (
	MaxBodyBytes   = 192 << 20
	MinTimeoutMS   = 1_000
	MaxTimeoutMS   = 600_000
	MaxDiskMB      = 8_192
	MaxArgs        = 32
	MaxArgBytes    = 64 << 10
	StreamCapBytes = 4 << 20
	// Rootless runsc maps only the slot user to guest uid 0; creating files as any other guest uid fails.
	// The guest root has no capabilities, no network and a read-only root, and is not host root.
	guestUID   = 0
	guestGID   = 0
	guestTmpMB = 256
	// Per-guest process cap so a fork bomb hits EAGAIN before the slot pids limit.
	guestMaxProcesses = 128
)

// Termination causes reported for a run.
const (
	TermCompleted      = "completed"
	TermTimeout        = "timeout"
	TermOOM            = "oom"
	TermKilled         = "killed"
	TermInternal       = "internal"
	TermOutputExceeded = "output_exceeded"
	TermDiskExceeded   = "disk_exceeded"
)

// Error codes in the error envelope.
const (
	ErrInvalidRequest   = "invalid_request"
	ErrBusy             = "busy"
	ErrIsolationRefused = "isolation_refused"
	ErrInternal         = "internal"
	ErrNotFound         = "not_found"
	ErrStorageFull      = "storage_full"
)

// Runner runs one guest; guest.Runner is the real one.
type Runner interface {
	Run(ctx context.Context, spec guest.Spec, opts guest.Options) guest.Result
}

// Attestor produces the attestation report; attest.Collector is the real one.
type Attestor interface {
	Collect() attest.Report
}

// Server serves the agent API.
type Server struct {
	Attestor Attestor
	Runner   Runner
	// LeaseDir is where run_code leases are created, on the slot volume.
	LeaseDir string
	// VolumeDir is the mount point of the slot's workspace volume, whose free space is checked.
	VolumeDir string
	// MinFreeBytes is the free space the volume needs for a call to start; zero means 1 GiB.
	MinFreeBytes int64
	// TreeDir holds one workspace tree per session, on the slot volume.
	TreeDir string
	RootFS  string
	// OOMKills returns the slot cgroup's cumulative OOM kill count.
	OOMKills func() int64

	sem  chan struct{}
	once sync.Once
	mu   sync.Mutex
	last attest.Report
}

func (s *Server) init() { s.once.Do(func() { s.sem = make(chan struct{}, 1) }) }

// Handler returns the HTTP handler.
func (s *Server) Handler() http.Handler {
	s.init()
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/health", s.health)
	mux.HandleFunc("POST /v1/run_code", s.runCode)
	mux.HandleFunc("POST /v1/exec", s.exec)
	mux.HandleFunc("POST /v1/fs_read", s.fsRead)
	mux.HandleFunc("POST /v1/fs_write", s.fsWrite)
	mux.HandleFunc("POST /v1/destroy_session", s.destroySession)
	return mux
}

type errorBody struct {
	Error struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	var b errorBody
	b.Error.Code, b.Error.Message = code, message
	writeJSON(w, status, b)
}

func decodeStrict(r *http.Request, w http.ResponseWriter, dst any) error {
	r.Body = http.MaxBytesReader(w, r.Body, MaxBodyBytes)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		return err
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return errors.New("trailing data after the JSON body")
	}
	return nil
}

type healthResponse struct {
	Busy bool `json:"busy"`
	// Sessions is how many session trees this slot holds, so the server can place new chats on the emptiest slot.
	Sessions    int           `json:"sessions"`
	Attestation attest.Report `json:"attestation"`
}

func (s *Server) health(w http.ResponseWriter, _ *http.Request) {
	select {
	case s.sem <- struct{}{}:
		defer func() { <-s.sem }()
		report := s.Attestor.Collect()
		s.mu.Lock()
		s.last = report
		s.mu.Unlock()
		writeJSON(w, http.StatusOK, healthResponse{Busy: false, Sessions: tree.Count(s.TreeDir), Attestation: report})
	default:
		// A lease is running: its own attestation just passed, so report the last one.
		s.mu.Lock()
		report := s.last
		s.mu.Unlock()
		writeJSON(w, http.StatusOK, healthResponse{Busy: true, Sessions: tree.Count(s.TreeDir), Attestation: report})
	}
}

type fileIn struct {
	Name          string `json:"name"`
	ContentBase64 string `json:"content_base64"`
}

type runCodeRequest struct {
	RunID     string   `json:"run_id"`
	Argv      []string `json:"argv"`
	FilesIn   []fileIn `json:"files_in"`
	TimeoutMS int      `json:"timeout_ms"`
	DiskMB    int      `json:"disk_mb"`
}

type fileOut struct {
	Dir           string `json:"dir"`
	Name          string `json:"name"`
	ContentBase64 string `json:"content_base64"`
}

type runCodeResponse struct {
	ExitCode      int       `json:"exit_code"`
	Stdout        string    `json:"stdout"`
	Stderr        string    `json:"stderr"`
	TerminatedBy  string    `json:"terminated_by"`
	InternalError string    `json:"internal_error"`
	FilesOut      []fileOut `json:"files_out"`
	Warnings      []string  `json:"warnings"`
	DurationMS    int64     `json:"duration_ms"`
}

func (r *runCodeRequest) validate() error {
	if !lease.ValidRunID(r.RunID) {
		return errors.New("run_id must be 32 lowercase hex characters")
	}
	if err := validateArgv(r.Argv); err != nil {
		return err
	}
	if r.TimeoutMS < MinTimeoutMS || r.TimeoutMS > MaxTimeoutMS {
		return fmt.Errorf("timeout_ms must be %d to %d", MinTimeoutMS, MaxTimeoutMS)
	}
	if r.DiskMB < 1 || r.DiskMB > MaxDiskMB {
		return fmt.Errorf("disk_mb must be 1 to %d", MaxDiskMB)
	}
	if len(r.FilesIn) > lease.MaxInputFiles {
		return fmt.Errorf("files_in has more than %d entries", lease.MaxInputFiles)
	}
	return nil
}

func validateArgv(argv []string) error {
	if len(argv) == 0 || len(argv) > MaxArgs {
		return fmt.Errorf("argv must have 1 to %d entries", MaxArgs)
	}
	total := 0
	for _, a := range argv {
		total += len(a)
		if len(a) > MaxArgBytes || total > 2*MaxArgBytes || strings.IndexByte(a, 0) >= 0 {
			return errors.New("argv entry is too long or contains NUL")
		}
	}
	if argv[0] == "" || (argv[0][0] != '/' && strings.ContainsRune(argv[0], '/')) {
		return errors.New("argv[0] must be a program name or an absolute path")
	}
	return nil
}

// guestEnv is the whole guest environment. Nothing from the agent's own environment is passed.
func guestEnv() []string {
	return []string{
		"PATH=/usr/local/bin:/usr/bin:/bin",
		"LANG=C.UTF-8",
		"HOME=/scratch",
		"USER=root",
		"LOGNAME=root",
		"TMPDIR=/tmp",
		"PIP_NO_INDEX=1",
		"npm_config_registry=http://127.0.0.1:1/",
		"MPLCONFIGDIR=/tmp/matplotlib",
		"PYTHONDONTWRITEBYTECODE=1",
		"GIT_CONFIG_NOSYSTEM=1",
		"GIT_CONFIG_GLOBAL=/dev/null",
		"GIT_CONFIG_COUNT=0",
		"GIT_ATTR_NOSYSTEM=1",
	}
}

func failedChecks(r attest.Report) string {
	var parts []string
	for _, c := range r.Checks {
		if !c.OK {
			parts = append(parts, c.Name+": "+c.Detail)
		}
	}
	return strings.Join(parts, "; ")
}

func (s *Server) runCode(w http.ResponseWriter, r *http.Request) {
	var req runCodeRequest
	if err := decodeStrict(r, w, &req); err != nil {
		writeError(w, http.StatusBadRequest, ErrInvalidRequest, err.Error())
		return
	}
	if err := req.validate(); err != nil {
		writeError(w, http.StatusBadRequest, ErrInvalidRequest, err.Error())
		return
	}
	files := make([]lease.File, 0, len(req.FilesIn))
	for _, f := range req.FilesIn {
		b, err := lease.DecodeBase64(f.ContentBase64)
		if err != nil {
			writeError(w, http.StatusBadRequest, ErrInvalidRequest, fmt.Sprintf("files_in %q is not canonical base64", f.Name))
			return
		}
		files = append(files, lease.File{Name: f.Name, Bytes: b})
	}

	select {
	case s.sem <- struct{}{}:
		defer func() { <-s.sem }()
	default:
		writeError(w, http.StatusTooManyRequests, ErrBusy, "this slot is running another call")
		return
	}

	report := s.Attestor.Collect()
	s.mu.Lock()
	s.last = report
	s.mu.Unlock()
	if !report.OK {
		writeError(w, http.StatusPreconditionFailed, ErrIsolationRefused, failedChecks(report))
		return
	}

	dirs, err := lease.Create(s.LeaseDir, req.RunID, files)
	defer func() { _ = lease.Remove(filepath.Join(s.LeaseDir, req.RunID)) }()
	if err != nil {
		writeError(w, http.StatusBadRequest, ErrInvalidRequest, err.Error())
		return
	}

	spec := guest.Spec{
		ID:     fmt.Sprintf("lease-%s-%d", req.RunID[:12], time.Now().UnixNano()),
		RootFS: s.RootFS,
		Argv:   req.Argv,
		Env:    guestEnv(),
		Cwd:    "/scratch",
		UID:    guestUID,
		GID:    guestGID,
		Binds: []guest.Bind{
			{Dest: "/ingress", Source: dirs.Ingress, ReadOnly: true},
			{Dest: "/scratch", Source: dirs.Scratch},
			{Dest: "/egress", Source: dirs.Egress},
		},
		Tmpfs: []guest.Tmpfs{{Dest: "/tmp", SizeMB: guestTmpMB}},
	}
	limit := int64(req.DiskMB) << 20
	spec.MaxFileBytes = limit
	spec.MaxProcesses = guestMaxProcesses
	watch, err := newDiskWatch(s.VolumeDir, s.MinFreeBytes, limit, dirs.Scratch, dirs.Egress)
	if err != nil {
		writeStorageError(w, err)
		return
	}
	started := time.Now()
	oomBefore := s.OOMKills()
	res := s.Runner.Run(r.Context(), spec, guest.Options{
		Timeout:       time.Duration(req.TimeoutMS) * time.Millisecond,
		StreamCap:     StreamCapBytes,
		Guard:         watch.guard,
		GuardInterval: guardIntervalMS * time.Millisecond,
	})
	oomed := s.OOMKills() > oomBefore

	resp := runCodeResponse{
		ExitCode:      res.ExitCode,
		Stdout:        string(res.Stdout),
		Stderr:        string(res.Stderr),
		TerminatedBy:  terminationFor(res, oomed),
		InternalError: res.InternalError,
		FilesOut:      []fileOut{},
		Warnings:      []string{},
		DurationMS:    time.Since(started).Milliseconds(),
	}
	if res.Cause != guest.Internal {
		outs, warnings := lease.Collect(dirs)
		for _, o := range outs {
			resp.FilesOut = append(resp.FilesOut, fileOut{Dir: o.Dir, Name: o.Name, ContentBase64: base64.StdEncoding.EncodeToString(o.Bytes)})
		}
		resp.Warnings = append(resp.Warnings, warnings...)
	}
	writeJSON(w, http.StatusOK, resp)
}

func terminationFor(res guest.Result, oomed bool) string {
	switch res.Cause {
	case guest.Completed:
		if oomed && res.ExitCode == 137 {
			return TermOOM
		}
		return TermCompleted
	case guest.Timeout:
		return TermTimeout
	case guest.OutputExceeded:
		return TermOutputExceeded
	case guest.Killed:
		return TermKilled
	case TermDiskExceeded:
		return TermDiskExceeded
	default:
		return TermInternal
	}
}

// CgroupOOMKills reads the cumulative OOM kill counter of this slot's cgroup, or zero when unreadable.
func CgroupOOMKills(cgroupRoot string) func() int64 {
	return func() int64 {
		for _, path := range []string{
			filepath.Join(cgroupRoot, "memory.events"),
			filepath.Join(cgroupRoot, "memory", "memory.oom_control"),
		} {
			b, err := os.ReadFile(path)
			if err != nil {
				continue
			}
			for _, line := range strings.Split(string(b), "\n") {
				fields := strings.Fields(line)
				if len(fields) == 2 && fields[0] == "oom_kill" {
					n, _ := strconv.ParseInt(fields[1], 10, 64)
					return n
				}
			}
		}
		return 0
	}
}

func writeStorageError(w http.ResponseWriter, err error) {
	if errors.Is(err, errStorageFull) {
		writeError(w, http.StatusInsufficientStorage, ErrStorageFull, err.Error())
		return
	}
	writeError(w, http.StatusInternalServerError, ErrInternal, "the slot storage could not be checked")
}

// Command aman-slot-agent is PID 1 of a sandbox slot. It serves a small typed API on a Unix socket and
// runs each call in a fresh gVisor guest.
package main

import (
	"context"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"aman/slotagent/src/api"
	"aman/slotagent/src/attest"
	"aman/slotagent/src/guest"
	"aman/slotagent/src/lease"
	"aman/slotagent/src/reaper"
)

const (
	agentVersion = "0.3.0"
	socketPath   = "/run/aman/agent.sock"
	volumeDir    = "/workspace"
	leaseDir     = "/workspace/.leases"
	treeDir      = "/workspace/sessions"
	rootFS       = "/rootfs"
	runscPath    = "/usr/local/bin/runsc"
	runscState   = "/run/runsc"
	bundleDir    = "/tmp/aman-bundles"
	cgroupRoot   = "/sys/fs/cgroup"
	canaryEvery  = 10 * time.Minute
	// A session tree the server never deleted is removed after this long unused.
	sessionIdleTTL   = 30 * 24 * time.Hour
	sessionSweepEach = 6 * time.Hour
)

func main() {
	log.SetFlags(log.LstdFlags | log.LUTC)
	if len(os.Args) == 2 && os.Args[1] == "healthcheck" {
		report, err := api.Probe(socketPath)
		for _, c := range report.Checks {
			status := "ok  "
			if !c.OK {
				status = "FAIL"
			}
			fmt.Printf("%s %s: %s\n", status, c.Name, c.Detail)
		}
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}
	if err := run(); err != nil {
		log.Printf("fatal: %v", err)
		os.Exit(1)
	}
}

// quotaEnv names the size in bytes of the fixed disk the host backed the workspace with; unset means the
// platform has none.
const quotaEnv = "AMAN_WORKSPACE_QUOTA_BYTES"

// diskModeEnv says "vm" when Docker runs in a virtual machine whose disk bounds the workspaces, and "none"
// otherwise; the quota variable above takes precedence.
const diskModeEnv = "AMAN_WORKSPACE_DISK_MODE"

func workspaceQuota() (int64, error) {
	raw := os.Getenv(quotaEnv)
	if raw == "" {
		return 0, nil
	}
	n, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || n <= 0 {
		return 0, fmt.Errorf("%s must be a positive number of bytes, got %q", quotaEnv, raw)
	}
	return n, nil
}

func run() error {
	quota, err := workspaceQuota()
	if err != nil {
		return err
	}
	rp := reaper.New()
	rp.Start()

	runner := &guest.Runner{Reaper: rp, Runsc: runscPath, StateDir: runscState, BundleDir: bundleDir}
	collector := &attest.Collector{
		AgentVersion: agentVersion,
		Proc:         "/proc",
		Sys:          "/sys",
		Cgroup:       cgroupRoot,
		RootProbe:    "/.aman-rw-probe",
		DockerSocks:  []string{"/var/run/docker.sock", "/run/docker.sock"},
		PID:          os.Getpid(),
		Platform:     "systrap",
		Workspace:    volumeDir,

		WorkspaceQuotaBytes: quota,
		ConfiguredDiskMode:  os.Getenv(diskModeEnv),
		CanaryEvery:         canaryEvery,
		Runsc: func() (string, error) {
			out, code, err := rp.Output(runscPath, []string{runscPath, "--version"}, 10*time.Second)
			if err != nil {
				return "", fmt.Errorf("runsc --version: %w", err)
			}
			if code != 0 {
				return "", fmt.Errorf("runsc --version exited %d", code)
			}
			first, _, _ := strings.Cut(string(out), "\n")
			return strings.TrimSpace(first), nil
		},
		Canary: func() error {
			res := runner.Run(context.Background(), guest.Spec{
				ID: fmt.Sprintf("canary-%d", time.Now().UnixNano()), RootFS: rootFS,
				Argv: []string{"/usr/bin/true"}, Env: []string{"PATH=/usr/bin:/bin"}, Cwd: "/", UID: 0, GID: 0,
			}, guest.Options{Timeout: 60 * time.Second, StreamCap: 64 << 10})
			if res.Cause != guest.Completed || res.ExitCode != 0 {
				return fmt.Errorf("canary %s exit %d: %s %s", res.Cause, res.ExitCode, res.InternalError, firstLine(res.Stderr))
			}
			return nil
		},
	}

	lease.Sweep(leaseDir)
	if err := os.MkdirAll(leaseDir, 0o755); err != nil {
		return fmt.Errorf("lease dir: %w", err)
	}

	srv := &api.Server{
		Attestor:  collector,
		Runner:    runner,
		LeaseDir:  leaseDir,
		VolumeDir: volumeDir,
		TreeDir:   treeDir,
		RootFS:    rootFS,
		OOMKills:  api.CgroupOOMKills(cgroupRoot),
	}

	_ = os.Remove(socketPath)
	ln, err := net.Listen("unix", socketPath)
	if err != nil {
		return fmt.Errorf("listen: %w", err)
	}
	// The socket directory is a volume shared only with the app; the server user differs from the slot user.
	if err := os.Chmod(socketPath, 0o666); err != nil {
		return fmt.Errorf("chmod socket: %w", err)
	}

	baseCtx, cancelAll := context.WithCancel(context.Background())
	httpSrv := &http.Server{
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		// The longest legitimate body is a 128 MiB transfer over a local socket; a call may run for
		// MaxTimeoutMS before its reply is written.
		ReadTimeout:  5 * time.Minute,
		WriteTimeout: 15 * time.Minute,
		IdleTimeout:  2 * time.Minute,
		BaseContext:  func(net.Listener) context.Context { return baseCtx },
	}

	// Attest once at start so a refused slot is visible in the logs before any call arrives.
	go func() {
		report := collector.Collect()
		if report.OK {
			log.Printf("attestation ok: %s", report.Facts.RunscVersion)
			return
		}
		for _, c := range report.Checks {
			if !c.OK {
				log.Printf("attestation FAILED %s: %s", c.Name, c.Detail)
			}
		}
	}()

	go func() {
		for {
			if n := srv.SweepIdleSessions(sessionIdleTTL); n > 0 {
				log.Printf("removed %d idle session trees", n)
			}
			select {
			case <-baseCtx.Done():
				return
			case <-time.After(sessionSweepEach):
			}
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGTERM, syscall.SIGINT)
	serveErr := make(chan error, 1)
	go func() { serveErr <- httpSrv.Serve(ln) }()

	select {
	case sig := <-stop:
		log.Printf("received %v, shutting down", sig)
		cancelAll()
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		_ = httpSrv.Shutdown(ctx)
		_ = os.Remove(socketPath)
		return nil
	case err := <-serveErr:
		cancelAll()
		return err
	}
}

func firstLine(b []byte) string {
	s, _, _ := strings.Cut(string(b), "\n")
	return s
}

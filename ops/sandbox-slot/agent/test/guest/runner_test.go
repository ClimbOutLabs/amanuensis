package guest_test

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"aman/slotagent/src/guest"
	"aman/slotagent/src/reaper"
)

// fakeRunsc stands in for runsc: `run` executes the guest "program" taken from the bundle's config.json
// args with sh, `delete` kills nothing. It lets the runner's timeout, output and kill logic be tested
// without gVisor.
const fakeRunsc = `#!/bin/sh
for a in "$@"; do last="$a"; done
cmd=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    run) mode=run ;;
    delete) mode=delete ;;
    --bundle) bundle="$2"; shift ;;
  esac
  shift
done
if [ "$mode" = delete ]; then exit 0; fi
script="$(sed -n 's/.*"args":\["sh","-c","\([^"]*\)".*/\1/p' "$bundle/config.json")"
exec sh -c "$script"
`

func newRunner(t *testing.T) (*guest.Runner, func()) {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "runsc")
	if err := os.WriteFile(path, []byte(fakeRunsc), 0o755); err != nil {
		t.Fatal(err)
	}
	rp := reaper.New()
	rp.Start()
	return &guest.Runner{Reaper: rp, Runsc: path, StateDir: filepath.Join(dir, "state"), BundleDir: filepath.Join(dir, "bundles")}, rp.Stop
}

func spec(id, script string) guest.Spec {
	return guest.Spec{ID: id, RootFS: "/rootfs", Cwd: "/", Argv: []string{"sh", "-c", script}}
}

func TestCompletedRunReturnsOutputAndExitCode(t *testing.T) {
	r, stop := newRunner(t)
	defer stop()
	res := r.Run(context.Background(), spec("a1", "echo out; echo err >&2; exit 5"), guest.Options{Timeout: 5 * time.Second, StreamCap: 1 << 20})
	if res.Cause != guest.Completed || res.ExitCode != 5 || string(res.Stdout) != "out\n" || string(res.Stderr) != "err\n" {
		t.Fatalf("%+v", res)
	}
}

func TestMergedStderrKeepsOrder(t *testing.T) {
	r, stop := newRunner(t)
	defer stop()
	res := r.Run(context.Background(), spec("a2", "echo 1; echo 2 >&2; echo 3"), guest.Options{Timeout: 5 * time.Second, StreamCap: 1 << 20, MergeStderr: true})
	if string(res.Stdout) != "1\n2\n3\n" || len(res.Stderr) != 0 {
		t.Fatalf("%q %q", res.Stdout, res.Stderr)
	}
}

func TestTimeoutKillsTheRun(t *testing.T) {
	r, stop := newRunner(t)
	defer stop()
	start := time.Now()
	res := r.Run(context.Background(), spec("a3", "echo started; sleep 30"), guest.Options{Timeout: 400 * time.Millisecond, StreamCap: 1 << 20})
	if res.Cause != guest.Timeout || time.Since(start) > 10*time.Second || string(res.Stdout) != "started\n" {
		t.Fatalf("%+v after %v", res, time.Since(start))
	}
}

func TestOutputPastTheCapKillsTheRun(t *testing.T) {
	r, stop := newRunner(t)
	defer stop()
	res := r.Run(context.Background(), spec("a4", "yes x"), guest.Options{Timeout: 10 * time.Second, StreamCap: 4096})
	if res.Cause != guest.OutputExceeded || len(res.Stdout) != 4096 {
		t.Fatalf("cause=%s len=%d", res.Cause, len(res.Stdout))
	}
}

func TestGuardKillsTheRunWithItsReason(t *testing.T) {
	r, stop := newRunner(t)
	defer stop()
	res := r.Run(context.Background(), spec("a5", "sleep 30"), guest.Options{
		Timeout: 20 * time.Second, StreamCap: 1 << 20, GuardInterval: 50 * time.Millisecond,
		Guard: func() string { return "disk_exceeded" },
	})
	if res.Cause != "disk_exceeded" {
		t.Fatalf("%+v", res)
	}
}

func TestCancellationKillsTheRun(t *testing.T) {
	r, stop := newRunner(t)
	defer stop()
	ctx, cancel := context.WithCancel(context.Background())
	go func() { time.Sleep(200 * time.Millisecond); cancel() }()
	res := r.Run(ctx, spec("a6", "sleep 30"), guest.Options{Timeout: 20 * time.Second, StreamCap: 1 << 20})
	if res.Cause != guest.Killed {
		t.Fatalf("%+v", res)
	}
}

func TestRuntimeFailureIsNotMistakenForTheProgramExitingWith128(t *testing.T) {
	r, stop := newRunner(t)
	defer stop()
	// The program really exits 128: still a completed run.
	res := r.Run(context.Background(), spec("a7", "exit 128"), guest.Options{Timeout: 5 * time.Second, StreamCap: 1 << 20})
	if res.Cause != guest.Completed || res.ExitCode != 128 {
		t.Fatalf("%+v", res)
	}
	// The runtime fails: exit 128 with its own error line.
	res = r.Run(context.Background(), spec("a8", "echo 'running container: creating container: boom' >&2; exit 128"), guest.Options{Timeout: 5 * time.Second, StreamCap: 1 << 20})
	if res.Cause != guest.Internal || res.InternalError == "" {
		t.Fatalf("%+v", res)
	}
}

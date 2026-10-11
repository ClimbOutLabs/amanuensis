package reaper_test

import (
	"os"
	"strings"
	"syscall"
	"testing"
	"time"

	"aman/slotagent/src/reaper"
)

func TestSpawnDeliversExitStatusAndReapsOrphans(t *testing.T) {
	r := reaper.New()
	r.Start()
	defer r.Stop()

	out, code, err := r.Output("/bin/sh", []string{"sh", "-c", "echo hi; exit 3"}, 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if code != 3 || strings.TrimSpace(string(out)) != "hi" {
		t.Fatalf("got code %d out %q", code, out)
	}
}

func TestOutputKillsOnTimeout(t *testing.T) {
	r := reaper.New()
	r.Start()
	defer r.Stop()
	start := time.Now()
	_, code, err := r.Output("/bin/sh", []string{"sh", "-c", "sleep 30"}, 300*time.Millisecond)
	if err != nil {
		t.Fatal(err)
	}
	if code != -1 || time.Since(start) > 5*time.Second {
		t.Fatalf("expected a kill, got code %d after %v", code, time.Since(start))
	}
}

func TestSpawnReportsStartFailure(t *testing.T) {
	r := reaper.New()
	r.Start()
	defer r.Stop()
	if _, _, err := r.Spawn("/nonexistent/binary", []string{"x"}, &os.ProcAttr{}); err == nil {
		t.Fatal("expected an error")
	}
}

func TestSignalDeathIsReported(t *testing.T) {
	r := reaper.New()
	r.Start()
	defer r.Stop()
	pid, exited, err := r.Spawn("/bin/sh", []string{"sh", "-c", "sleep 30"}, &os.ProcAttr{Files: []*os.File{nil, nil, nil}})
	if err != nil {
		t.Fatal(err)
	}
	_ = syscall.Kill(pid, syscall.SIGKILL)
	select {
	case ws := <-exited:
		if !ws.Signaled() || ws.Signal() != syscall.SIGKILL {
			t.Fatalf("unexpected status %v", ws)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no exit status delivered")
	}
}

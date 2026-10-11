package reaper_test

import (
	"os"
	"strconv"
	"strings"

	"testing"
	"time"

	"aman/slotagent/src/reaper"
)

func TestSpawnDeliversExitStatus(t *testing.T) {
	r := reaper.New()
	r.Start()
	defer r.Stop()
	_, exited, err := r.Spawn("/bin/sh", []string{"sh", "-c", "exit 7"}, &os.ProcAttr{})
	if err != nil {
		t.Fatal(err)
	}
	select {
	case status := <-exited:
		if !status.Exited() || status.ExitStatus() != 7 {
			t.Fatalf("status = %v, want exit 7", status)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no exit status delivered")
	}
}

func TestFastExitIsNotLost(t *testing.T) {
	r := reaper.New()
	r.Start()
	defer r.Stop()
	for i := 0; i < 50; i++ {
		_, exited, err := r.Spawn("/bin/true", []string{"true"}, &os.ProcAttr{})
		if err != nil {
			t.Fatal(err)
		}
		select {
		case <-exited:
		case <-time.After(5 * time.Second):
			t.Fatalf("exit %d was lost", i)
		}
	}
}

func TestOrphanedGrandchildIsReaped(t *testing.T) {
	r := reaper.New()
	r.Start()
	defer r.Stop()
	// The shell exits at once and leaves a short-lived orphan that is re-parented to this process.
	_, exited, err := r.Spawn("/bin/sh", []string{"sh", "-c", "sleep 0.2 &"}, &os.ProcAttr{})
	if err != nil {
		t.Fatal(err)
	}
	<-exited
	// A zombie would keep answering signal 0; a reaped process stops existing.
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		out, _, _ := r.Output("/bin/sh", []string{"sh", "-c", "ps -o stat= --ppid " + strconv.Itoa(os.Getpid()) + " | grep -c Z || true"}, 5*time.Second)
		if strings.TrimSpace(string(out)) == "0" {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatal("a zombie child was left behind")
}

func TestOutputCapturesBothStreamsAndExitCode(t *testing.T) {
	r := reaper.New()
	r.Start()
	defer r.Stop()
	out, code, err := r.Output("/bin/sh", []string{"sh", "-c", "echo a; echo b >&2; exit 3"}, 5*time.Second)
	if err != nil || code != 3 || !strings.Contains(string(out), "a") || !strings.Contains(string(out), "b") {
		t.Fatalf("out=%q code=%d err=%v", out, code, err)
	}
}

func TestOutputKillsOnTimeout(t *testing.T) {
	r := reaper.New()
	r.Start()
	defer r.Stop()
	start := time.Now()
	_, code, _ := r.Output("/bin/sleep", []string{"sleep", "30"}, 300*time.Millisecond)
	if time.Since(start) > 5*time.Second || code == 0 {
		t.Fatalf("not killed promptly: %v code=%d", time.Since(start), code)
	}
}

func TestSpawnReportsAMissingProgram(t *testing.T) {
	r := reaper.New()
	r.Start()
	defer r.Stop()
	if _, _, err := r.Spawn("/no/such/program", []string{"x"}, &os.ProcAttr{}); err == nil {
		t.Fatal("expected an error")
	}
}

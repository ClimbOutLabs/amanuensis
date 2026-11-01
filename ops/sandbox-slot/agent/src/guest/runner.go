package guest

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"syscall"
	"time"

	"aman/slotagent/src/reaper"
)

// Termination causes reported to the server.
const (
	Completed      = "completed"
	Timeout        = "timeout"
	Killed         = "killed"
	OutputExceeded = "output_exceeded"
	Internal       = "internal"
)

// Runner starts guests with runsc.
type Runner struct {
	Reaper   *reaper.Reaper
	Runsc    string
	StateDir string
	// BundleDir is the parent of the per-guest bundle directories.
	BundleDir string
}

// Options bound one run.
type Options struct {
	Timeout time.Duration
	// StreamCap is the most bytes kept from each of stdout and stderr; past it the guest is killed.
	StreamCap int
	// Guard is polled while the guest runs; a non-empty answer kills the guest and becomes the cause.
	Guard         func() string
	GuardInterval time.Duration
	// MergeStderr sends the guest's stderr into the stdout stream, keeping the order of interleaved output.
	MergeStderr bool
}

// Result is how a run ended. ExitCode is only meaningful when Cause is Completed.
type Result struct {
	ExitCode      int
	Stdout        []byte
	Stderr        []byte
	Cause         string
	InternalError string
}

// infraPrefix is what runsc prints when it fails before or around the guest. Exit code 128 alone is
// ambiguous with a guest that exits 128, so both must match.
const infraPrefix = "running container:"

func (r *Runner) runscArgs(tail ...string) []string {
	return r.runscArgsNetwork(false, tail...)
}

// runscArgsNetwork picks the guest's network: an isolated loopback-only stack by default, or the
// slot's own namespace for a mirror-granted call, whose only interface is that same loopback.
func (r *Runner) runscArgsNetwork(shared bool, tail ...string) []string {
	network := "--network=none"
	if shared {
		network = "--network=host"
	}
	base := []string{
		r.Runsc, "--root", r.StateDir, "--rootless", network,
		"--platform=systrap", "--overlay2=root:memory",
	}
	return append(base, tail...)
}

type captured struct {
	mu       sync.Mutex
	buf      []byte
	cap      int
	exceeded bool
}

func (c *captured) write(p []byte) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	room := c.cap - len(c.buf)
	if len(p) > room {
		c.buf = append(c.buf, p[:room]...)
		c.exceeded = true
		return false
	}
	c.buf = append(c.buf, p...)
	return true
}

func (c *captured) bytes() []byte {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]byte(nil), c.buf...)
}

func (c *captured) over() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.exceeded
}

func drain(f *os.File, c *captured, onExceed func(), wg *sync.WaitGroup) {
	defer wg.Done()
	defer f.Close()
	chunk := make([]byte, 32*1024)
	for {
		n, err := f.Read(chunk)
		if n > 0 && !c.write(chunk[:n]) {
			onExceed()
			// Keep reading so the writer is never blocked on a full pipe while it is being killed.
			for {
				if _, e := f.Read(chunk); e != nil {
					return
				}
			}
		}
		if err != nil {
			return
		}
	}
}

// Run executes the guest described by spec and always removes it afterwards.
func (r *Runner) Run(ctx context.Context, spec Spec, opts Options) Result {
	bundle := filepath.Join(r.BundleDir, spec.ID)
	if err := os.MkdirAll(bundle, 0o700); err != nil {
		return Result{Cause: Internal, InternalError: fmt.Sprintf("bundle dir: %v", err)}
	}
	defer os.RemoveAll(bundle)
	cfg, err := BuildConfig(spec)
	if err != nil {
		return Result{Cause: Internal, InternalError: err.Error()}
	}
	if err := os.WriteFile(filepath.Join(bundle, "config.json"), cfg, 0o600); err != nil {
		return Result{Cause: Internal, InternalError: fmt.Sprintf("write config: %v", err)}
	}

	devnull, err := os.Open(os.DevNull)
	if err != nil {
		return Result{Cause: Internal, InternalError: err.Error()}
	}
	defer devnull.Close()
	outR, outW, err := os.Pipe()
	if err != nil {
		return Result{Cause: Internal, InternalError: err.Error()}
	}
	errR, errW := outR, outW
	if !opts.MergeStderr {
		errR, errW, err = os.Pipe()
		if err != nil {
			outR.Close()
			outW.Close()
			return Result{Cause: Internal, InternalError: err.Error()}
		}
	}

	// The Sentry can crash (for example when the host refuses it a thread) and exit 2, which looks like
	// the program exiting 2; its panic log is the only reliable tell.
	panicLog := filepath.Join(bundle, "panic.log")
	argv := r.runscArgsNetwork(spec.SharedNetwork, "--panic-log="+panicLog, "run", "--bundle", bundle, spec.ID)
	pid, exited, err := r.Reaper.Spawn(r.Runsc, argv, &os.ProcAttr{
		Env:   []string{"PATH=/usr/local/bin:/usr/bin:/bin", "HOME=/tmp"},
		Files: []*os.File{devnull, outW, errW},
		Sys:   &syscall.SysProcAttr{Setpgid: true},
	})
	outW.Close()
	if !opts.MergeStderr {
		errW.Close()
	}
	if err != nil {
		outR.Close()
		if !opts.MergeStderr {
			errR.Close()
		}
		return Result{Cause: Internal, InternalError: fmt.Sprintf("start runsc: %v", err)}
	}

	var stdout, stderr captured
	stdout.cap, stderr.cap = opts.StreamCap, opts.StreamCap
	var killReason struct {
		sync.Mutex
		value string
	}
	setReason := func(v string) {
		killReason.Lock()
		if killReason.value == "" {
			killReason.value = v
		}
		killReason.Unlock()
	}
	getReason := func() string {
		killReason.Lock()
		defer killReason.Unlock()
		return killReason.value
	}
	var killOnce sync.Once
	kill := func() {
		killOnce.Do(func() {
			reaper.KillGroup(pid)
			r.deleteGuest(spec.ID)
		})
	}

	var readers sync.WaitGroup
	exceed := func() { setReason(OutputExceeded); kill() }
	readers.Add(1)
	go drain(outR, &stdout, exceed, &readers)
	if !opts.MergeStderr {
		readers.Add(1)
		go drain(errR, &stderr, exceed, &readers)
	}

	timer := time.NewTimer(opts.Timeout)
	defer timer.Stop()
	interval := opts.GuardInterval
	if interval <= 0 {
		interval = 500 * time.Millisecond
	}
	guardTick := time.NewTicker(interval)
	defer guardTick.Stop()

	var status syscall.WaitStatus
loop:
	for {
		select {
		case status = <-exited:
			break loop
		case <-timer.C:
			setReason(Timeout)
			kill()
		case <-ctx.Done():
			setReason(Killed)
			kill()
		case <-guardTick.C:
			if opts.Guard != nil {
				if why := opts.Guard(); why != "" {
					setReason(why)
					kill()
				}
			}
		}
	}
	// A guest can leave the sandbox process behind when runsc is killed; delete is idempotent.
	r.deleteGuest(spec.ID)
	readers.Wait()

	res := Result{Stdout: stdout.bytes(), Stderr: stderr.bytes(), Cause: Completed}
	if why := getReason(); why != "" {
		res.Cause = why
		res.ExitCode = -1
		return res
	}
	switch {
	case status.Exited():
		res.ExitCode = status.ExitStatus()
	case status.Signaled():
		res.ExitCode = 128 + int(status.Signal())
	default:
		res.ExitCode = -1
	}
	if info, statErr := os.Stat(panicLog); statErr == nil {
		if info.Size() > 0 {
			res.Cause = Internal
			res.InternalError = "the sandbox runtime crashed while running the program"
			return res
		}
	}
	diagnostics := res.Stderr
	if opts.MergeStderr {
		diagnostics = res.Stdout
	}
	if res.ExitCode == 128 && hasLinePrefix(diagnostics, infraPrefix) {
		res.Cause = Internal
		res.InternalError = "the sandbox runtime failed to start the program"
	}
	return res
}

func hasLinePrefix(b []byte, prefix string) bool {
	start := 0
	for i := 0; i <= len(b); i++ {
		if i == len(b) || b[i] == '\n' {
			line := b[start:i]
			if len(line) >= len(prefix) && string(line[:len(prefix)]) == prefix {
				return true
			}
			start = i + 1
		}
	}
	return false
}

// deleteGuest removes the guest and anything left of its sandbox. It never fails the caller.
func (r *Runner) deleteGuest(id string) {
	devnull, err := os.OpenFile(os.DevNull, os.O_RDWR, 0)
	if err != nil {
		return
	}
	defer devnull.Close()
	_, exited, err := r.Reaper.Spawn(r.Runsc, r.runscArgs("delete", "--force", id), &os.ProcAttr{
		Env:   []string{"PATH=/usr/local/bin:/usr/bin:/bin", "HOME=/tmp"},
		Files: []*os.File{devnull, devnull, devnull},
		Sys:   &syscall.SysProcAttr{Setpgid: true},
	})
	if err != nil {
		return
	}
	select {
	case <-exited:
	case <-time.After(15 * time.Second):
	}
}

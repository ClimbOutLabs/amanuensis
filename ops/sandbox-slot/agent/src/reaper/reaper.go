// Package reaper makes the agent a safe PID 1: it reaps every child, and hands the exit status of the
// children it started to their waiters. os/exec cannot be used next to a reaper that calls wait4(-1),
// because the two race for the same exit status.
package reaper

import (
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"
)

// Reaper owns wait4 for the whole process.
type Reaper struct {
	mu      sync.Mutex
	waiters map[int]chan syscall.WaitStatus
	stop    chan struct{}
	done    chan struct{}
}

// New returns a reaper that is not yet running.
func New() *Reaper {
	return &Reaper{
		waiters: make(map[int]chan syscall.WaitStatus),
		stop:    make(chan struct{}),
		done:    make(chan struct{}),
	}
}

// Start begins reaping. It wakes on SIGCHLD and on a slow tick, so a lost signal only delays a reap.
func (r *Reaper) Start() {
	sigs := make(chan os.Signal, 1)
	signal.Notify(sigs, syscall.SIGCHLD)
	go func() {
		defer close(r.done)
		defer signal.Stop(sigs)
		tick := time.NewTicker(time.Second)
		defer tick.Stop()
		for {
			r.drain()
			select {
			case <-r.stop:
				return
			case <-sigs:
			case <-tick.C:
			}
		}
	}()
}

// Stop ends the reaping goroutine.
func (r *Reaper) Stop() {
	close(r.stop)
	<-r.done
}

func (r *Reaper) drain() {
	for {
		var status syscall.WaitStatus
		pid, err := syscall.Wait4(-1, &status, syscall.WNOHANG, nil)
		if err == syscall.EINTR {
			continue
		}
		if err != nil || pid <= 0 {
			return
		}
		// Taking the lock here waits for a Spawn that is still registering this pid.
		r.mu.Lock()
		ch, ok := r.waiters[pid]
		delete(r.waiters, pid)
		r.mu.Unlock()
		if ok {
			ch <- status
		}
	}
}

// Spawn starts a process and returns its pid and a channel that receives its exit status once.
func (r *Reaper) Spawn(path string, argv []string, attr *os.ProcAttr) (int, <-chan syscall.WaitStatus, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	proc, err := os.StartProcess(path, argv, attr)
	if err != nil {
		return 0, nil, err
	}
	ch := make(chan syscall.WaitStatus, 1)
	r.waiters[proc.Pid] = ch
	// The reaper, not this handle, collects the exit status.
	_ = proc.Release()
	return proc.Pid, ch, nil
}

// Output runs a short command and returns its combined stdout and stderr and exit code.
func (r *Reaper) Output(path string, argv []string, timeout time.Duration) ([]byte, int, error) {
	devnull, err := os.Open(os.DevNull)
	if err != nil {
		return nil, -1, err
	}
	defer devnull.Close()
	rd, wr, err := os.Pipe()
	if err != nil {
		return nil, -1, err
	}
	pid, exited, err := r.Spawn(path, argv, &os.ProcAttr{
		Env:   []string{"PATH=/usr/local/bin:/usr/bin:/bin", "HOME=/tmp"},
		Files: []*os.File{devnull, wr, wr},
		Sys:   &syscall.SysProcAttr{Setpgid: true},
	})
	wr.Close()
	if err != nil {
		rd.Close()
		return nil, -1, err
	}
	var buf []byte
	done := make(chan struct{})
	go func() {
		defer close(done)
		defer rd.Close()
		chunk := make([]byte, 4096)
		for len(buf) < 64*1024 {
			n, e := rd.Read(chunk)
			buf = append(buf, chunk[:n]...)
			if e != nil {
				return
			}
		}
		for {
			if _, e := rd.Read(chunk); e != nil {
				return
			}
		}
	}()
	var status syscall.WaitStatus
	select {
	case status = <-exited:
	case <-time.After(timeout):
		_ = syscall.Kill(-pid, syscall.SIGKILL)
		status = <-exited
	}
	<-done
	if status.Exited() {
		return buf, status.ExitStatus(), nil
	}
	return buf, -1, nil
}

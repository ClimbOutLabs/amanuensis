package attest_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"aman/slotagent/src/attest"
)

const goodStatus = "Name:\tagent\nUid:\t65532\t65532\t65532\t65532\nGid:\t65532\t65532\t65532\t65532\nCapPrm:\t0000000000000000\nCapEff:\t0000000000000000\nCapBnd:\t0000000000000000\nNoNewPrivs:\t1\nSeccomp:\t2\n"

type world struct {
	t    *testing.T
	root string
}

func newWorld(t *testing.T) *world {
	w := &world{t: t, root: t.TempDir()}
	w.write("proc/self/status", goodStatus)
	w.write("proc/net/dev", "Inter-|   Receive\n face |bytes\n    lo: 0 0\n")
	// A file, so creating a directory below it fails for root as well, as the read-only real /proc/fs does.
	w.write("proc/fs", "")
	w.mountinfo("ro")
	w.write("proc/sys/kernel/osrelease", "6.8.0\n")
	w.write("proc/self/attr/current", "unconfined\n")
	w.write("cgroup/cgroup.controllers", "memory pids\n")
	w.write("cgroup/memory.max", "2147483648\n")
	w.write("cgroup/pids.max", "512\n")
	return w
}

func (w *world) mountinfo(options string) {
	w.write("proc/self/mountinfo", "10 9 0:5 / "+filepath.Join(w.root, "proc/fs")+" "+options+",nosuid - proc proc rw\n")
}

func (w *world) write(rel, content string) {
	p := filepath.Join(w.root, rel)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		w.t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		w.t.Fatal(err)
	}
}

func (w *world) collector() *attest.Collector {
	return &attest.Collector{
		AgentVersion: "t",
		Proc:         filepath.Join(w.root, "proc"),
		Sys:          filepath.Join(w.root, "sys"),
		Cgroup:       filepath.Join(w.root, "cgroup"),
		RootProbe:    "/proc/nonexistent/probe",
		DockerSocks:  []string{filepath.Join(w.root, "docker.sock")},
		PID:          1,
		RootFlags:    func() (int64, error) { return 1, nil },
		Runsc:        func() (string, error) { return "release-test", nil },
		Canary:       func() error { return nil },
		Platform:     "systrap",
	}
}

func check(r attest.Report, name string) attest.Check {
	for _, c := range r.Checks {
		if c.Name == name {
			return c
		}
	}
	return attest.Check{Name: name, OK: false, Detail: "missing from report"}
}

func TestHardenedCellPasses(t *testing.T) {
	r := newWorld(t).collector().Collect()
	if !r.OK {
		t.Fatalf("expected ok, got %+v", r.Checks)
	}
	if len(r.Checks) != 12 {
		t.Fatalf("expected 12 checks, got %d", len(r.Checks))
	}
}

func TestEachMissingGuaranteeFailsClosed(t *testing.T) {
	cases := []struct {
		name   string
		check  string
		mutate func(*world, *attest.Collector)
	}{
		{"not pid 1", attest.CheckPID1, func(_ *world, c *attest.Collector) { c.PID = 42 }},
		{"root uid", attest.CheckIdentity, func(w *world, _ *attest.Collector) {
			w.write("proc/self/status", strings.Replace(goodStatus, "Uid:\t65532\t65532\t65532\t65532", "Uid:\t0\t0\t0\t0", 1))
		}},
		{"one id differs", attest.CheckIdentity, func(w *world, _ *attest.Collector) {
			w.write("proc/self/status", strings.Replace(goodStatus, "Gid:\t65532\t65532\t65532\t65532", "Gid:\t65532\t65532\t65532\t0", 1))
		}},
		{"capability held", attest.CheckCapabilities, func(w *world, _ *attest.Collector) {
			w.write("proc/self/status", strings.Replace(goodStatus, "CapEff:\t0000000000000000", "CapEff:\t0000000000000001", 1))
		}},
		{"bounding set not empty", attest.CheckCapabilities, func(w *world, _ *attest.Collector) {
			w.write("proc/self/status", strings.Replace(goodStatus, "CapBnd:\t0000000000000000", "CapBnd:\t000001ffffffffff", 1))
		}},
		{"new privs allowed", attest.CheckNoNewPrivs, func(w *world, _ *attest.Collector) {
			w.write("proc/self/status", strings.Replace(goodStatus, "NoNewPrivs:\t1", "NoNewPrivs:\t0", 1))
		}},
		{"no seccomp", attest.CheckSeccomp, func(w *world, _ *attest.Collector) {
			w.write("proc/self/status", strings.Replace(goodStatus, "Seccomp:\t2", "Seccomp:\t0", 1))
		}},
		{"root mounted writable", attest.CheckReadOnlyRoot, func(_ *world, c *attest.Collector) {
			c.RootFlags = func() (int64, error) { return 0, nil }
		}},
		{"root flags unreadable", attest.CheckReadOnlyRoot, func(_ *world, c *attest.Collector) {
			c.RootFlags = func() (int64, error) { return 0, os.ErrPermission }
		}},
		{"read-only root that accepts a write", attest.CheckReadOnlyRoot, func(w *world, c *attest.Collector) {
			c.RootProbe = filepath.Join(w.root, "rw-probe")
		}},
		{"no /proc/fs mount at all", attest.CheckProcFS, func(w *world, _ *attest.Collector) {
			w.write("proc/self/mountinfo", "10 9 0:5 / /proc/other ro - proc proc rw\n")
		}},
		{"second interface", attest.CheckNetwork, func(w *world, _ *attest.Collector) {
			w.write("proc/net/dev", "Inter-|   Receive\n face |bytes\n    lo: 0 0\n  eth0: 1 1\n")
		}},
		{"docker socket", attest.CheckNoDockerSocket, func(w *world, _ *attest.Collector) { w.write("docker.sock", "") }},
		{"memory unlimited", attest.CheckCgroupLimits, func(w *world, _ *attest.Collector) { w.write("cgroup/memory.max", "max\n") }},
		{"memory differs from the compose limit", attest.CheckCgroupLimits, func(w *world, _ *attest.Collector) { w.write("cgroup/memory.max", "4294967296\n") }},
		{"pids differ from the compose limit", attest.CheckCgroupLimits, func(w *world, _ *attest.Collector) { w.write("cgroup/pids.max", "4096\n") }},
		{"pids unlimited", attest.CheckCgroupLimits, func(w *world, _ *attest.Collector) { w.write("cgroup/pids.max", "max\n") }},
		{"limits missing", attest.CheckCgroupLimits, func(w *world, _ *attest.Collector) {
			_ = os.Remove(filepath.Join(w.root, "cgroup/pids.max"))
		}},
		{"proc/fs accepts writes", attest.CheckProcFS, func(w *world, _ *attest.Collector) {
			_ = os.Remove(filepath.Join(w.root, "proc/fs"))
			if err := os.MkdirAll(filepath.Join(w.root, "proc/fs"), 0o755); err != nil {
				panic(err)
			}
		}},
		{"proc/fs writable mount", attest.CheckProcFS, func(w *world, _ *attest.Collector) {
			w.mountinfo("rw")
		}},
		{"runsc missing", attest.CheckRunsc, func(_ *world, c *attest.Collector) {
			c.Runsc = func() (string, error) { return "", os.ErrNotExist }
		}},
		{"canary fails", attest.CheckRunsc, func(_ *world, c *attest.Collector) {
			c.Canary = func() error { return os.ErrPermission }
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			w := newWorld(t)
			c := w.collector()
			tc.mutate(w, c)
			r := c.Collect()
			if r.OK {
				t.Fatal("the report must not be ok")
			}
			if got := check(r, tc.check); got.OK {
				t.Fatalf("%s should fail, got %+v", tc.check, got)
			}
		})
	}
}

func TestV1CgroupLimits(t *testing.T) {
	w := newWorld(t)
	_ = os.Remove(filepath.Join(w.root, "cgroup/cgroup.controllers"))
	w.write("cgroup/memory/memory.limit_in_bytes", "2147483648\n")
	w.write("cgroup/pids/pids.max", "512\n")
	r := w.collector().Collect()
	if c := check(r, attest.CheckCgroupLimits); !c.OK || r.Facts.Cgroup != "v1" {
		t.Fatalf("v1 limits should pass: %+v %s", c, r.Facts.Cgroup)
	}
	w.write("cgroup/memory/memory.limit_in_bytes", "9223372036854771712\n")
	if c := check(w.collector().Collect(), attest.CheckCgroupLimits); c.OK {
		t.Fatal("a v1 unlimited memory value must fail")
	}
}

func TestAppArmorIsRequiredWhereTheKernelHasIt(t *testing.T) {
	w := newWorld(t)
	w.write("sys/module/apparmor/parameters/enabled", "Y\n")
	c := check(w.collector().Collect(), attest.CheckAppArmor)
	if c.OK {
		t.Fatalf("unconfined on an AppArmor kernel must fail: %+v", c)
	}
	w.write("proc/self/attr/current", "docker-default (enforce)\n")
	if c := check(w.collector().Collect(), attest.CheckAppArmor); c.OK {
		t.Fatalf("the default docker profile must fail: %+v", c)
	}
	w.write("proc/self/attr/current", "aman-sandbox-slot (complain)\n")
	if c := check(w.collector().Collect(), attest.CheckAppArmor); c.OK {
		t.Fatalf("complain mode must fail: %+v", c)
	}
	w.write("proc/self/attr/current", "aman-sandbox-slot (enforce)\n")
	if c := check(w.collector().Collect(), attest.CheckAppArmor); !c.OK {
		t.Fatalf("the slot profile in enforce mode must pass: %+v", c)
	}
}

func TestAppArmorIsExcusedOnlyWhereTheKernelLacksIt(t *testing.T) {
	w := newWorld(t)
	c := check(w.collector().Collect(), attest.CheckAppArmor)
	if !c.OK || !strings.Contains(c.Detail, "no AppArmor on this platform") {
		t.Fatalf("a kernel without the module is excused and says so: %+v", c)
	}
	w.write("sys/module/apparmor/parameters/enabled", "N\n")
	if c := check(w.collector().Collect(), attest.CheckAppArmor); !c.OK {
		t.Fatalf("a disabled module is excused: %+v", c)
	}
}

func TestCanaryIsCachedOnlyWhenItPassed(t *testing.T) {
	w := newWorld(t)
	calls := 0
	c := w.collector()
	c.CanaryEvery = 1 << 40
	c.Canary = func() error {
		calls++
		if calls == 1 {
			return os.ErrPermission
		}
		return nil
	}
	if c.Collect().OK {
		t.Fatal("first run must fail")
	}
	if !c.Collect().OK {
		t.Fatal("a failed canary must run again")
	}
	c.Collect()
	if calls != 2 {
		t.Fatalf("a passing canary should be cached, calls=%d", calls)
	}
}

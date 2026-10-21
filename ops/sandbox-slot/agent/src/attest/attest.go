// Package attest lets the agent prove, from facts the kernel reports, that its own cell is hardened.
// Every check must pass before a guest may start; anything else is reported and fails closed.
package attest

import (
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// Expected identity and profile names.
const (
	SlotUID         = 65532
	SlotGID         = 65532
	AppArmorProfile = "aman-sandbox-slot"
	// ExpectedMemoryBytes and ExpectedPidsLimit are the limits the slot compose file sets; any other value
	// means the slot was started with different settings than the ones the guest caps were sized for.
	ExpectedMemoryBytes = 2 << 30
	ExpectedPidsLimit   = 512
)

// Check names. The server requires exactly this set.
const (
	CheckPID1           = "pid1"
	CheckIdentity       = "identity"
	CheckCapabilities   = "capabilities"
	CheckNoNewPrivs     = "no_new_privs"
	CheckSeccomp        = "seccomp"
	CheckReadOnlyRoot   = "read_only_root"
	CheckNetwork        = "network"
	CheckNoDockerSocket = "no_docker_socket"
	CheckCgroupLimits   = "cgroup_limits"
	CheckAppArmor       = "apparmor"
	CheckProcFS         = "proc_fs"
	CheckWorkspaceQuota = "workspace_quota"
	CheckRunsc          = "runsc"
)

// Result of one check.
type Check struct {
	Name   string `json:"name"`
	OK     bool   `json:"ok"`
	Detail string `json:"detail"`
}

// Facts are recorded for diagnosis and never decide a check.
type Facts struct {
	Kernel       string `json:"kernel"`
	Arch         string `json:"arch"`
	PageSize     int    `json:"page_size"`
	Cgroup       string `json:"cgroup"`
	AppArmor     string `json:"apparmor"`
	RunscVersion string `json:"runsc_version"`
	Platform     string `json:"platform"`
	// DiskMode says what bounds the workspace disk: "hard" (a fixed-size disk of this slot's own), "vm" (the
	// Docker virtual machine's disk) or "none" (nothing but the host filesystem).
	DiskMode string `json:"disk_mode"`
	// WorkspaceBytes is the size of the filesystem the workspace is on; for "hard" it is the slot's whole disk.
	WorkspaceBytes int64 `json:"workspace_bytes"`
}

// Report is the agent's attestation.
type Report struct {
	Schema       int     `json:"schema"`
	AgentVersion string  `json:"agent_version"`
	OK           bool    `json:"ok"`
	CheckedAt    string  `json:"checked_at"`
	Checks       []Check `json:"checks"`
	Facts        Facts   `json:"facts"`
}

// NetIface is the state of one network interface.
type NetIface struct {
	Up        bool
	Addresses int
}

// Collector reads the cell. Paths are fields so tests can point them at fixtures.
type Collector struct {
	AgentVersion string
	Proc         string
	Sys          string
	Cgroup       string
	// RootProbe is a path in the root filesystem where creating a file must fail.
	RootProbe   string
	DockerSocks []string
	PID         int
	// Runsc returns the runtime version string.
	Runsc func() (string, error)
	// RootFlags returns the statfs flags of the root filesystem; nil reads them from the kernel.
	RootFlags func() (int64, error)
	// Workspace is the slot's workspace mount, and WorkspaceQuotaBytes the size of the fixed disk the host
	// backed it with; zero means this platform has no per-slot disk (the Docker VM's disk bounds it).
	Workspace           string
	WorkspaceQuotaBytes int64
	// ConfiguredDiskMode is what the operator declared when there is no per-slot disk: "vm" or "none".
	ConfiguredDiskMode string
	// Statfs returns the filesystem type and size in bytes of a path; nil reads them from the kernel.
	Statfs func(path string) (fsType int64, sizeBytes int64, err error)
	// InterfaceInfo reports whether a named interface is up and how many addresses it holds; nil reads the kernel.
	InterfaceInfo func(name string) (NetIface, error)
	// Canary starts a real guest running a trivial program.
	Canary func() error
	// CanaryEvery bounds how often the canary runs; zero runs it every time.
	CanaryEvery time.Duration
	Platform    string

	mu         sync.Mutex
	canaryAt   time.Time
	canaryErr  error
	canaryDone bool
}

func readTrim(path string) (string, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(b)), nil
}

func statusField(status, key string) string {
	for _, line := range strings.Split(status, "\n") {
		if strings.HasPrefix(line, key+":") {
			return strings.TrimSpace(strings.TrimPrefix(line, key+":"))
		}
	}
	return ""
}

func pass(name, detail string) Check { return Check{Name: name, OK: true, Detail: detail} }
func fail(name, detail string) Check { return Check{Name: name, OK: false, Detail: detail} }

// Collect runs every check. The canary is repeated only when it is older than CanaryEvery or failed.
func (c *Collector) Collect() Report {
	status, statusErr := readTrim(filepath.Join(c.Proc, "self", "status"))
	var checks []Check
	checks = append(checks, c.checkPID1())
	checks = append(checks, c.checkIdentity(status, statusErr))
	checks = append(checks, c.checkCapabilities(status, statusErr))
	checks = append(checks, c.checkField(CheckNoNewPrivs, status, statusErr, "NoNewPrivs", "1"))
	checks = append(checks, c.checkField(CheckSeccomp, status, statusErr, "Seccomp", "2"))
	checks = append(checks, c.checkReadOnlyRoot())
	checks = append(checks, c.checkNetwork())
	checks = append(checks, c.checkDockerSocket())
	cg, cgCheck := c.checkCgroupLimits()
	checks = append(checks, cgCheck)
	aa, aaCheck := c.checkAppArmor()
	checks = append(checks, aaCheck)
	checks = append(checks, c.checkProcFS())
	checks = append(checks, c.checkWorkspaceQuota())
	version, runscCheck := c.checkRunsc()
	checks = append(checks, runscCheck)

	ok := true
	for _, ch := range checks {
		ok = ok && ch.OK
	}
	kernel, _ := readTrim(filepath.Join(c.Proc, "sys", "kernel", "osrelease"))
	return Report{
		Schema:       1,
		AgentVersion: c.AgentVersion,
		OK:           ok,
		CheckedAt:    time.Now().UTC().Format(time.RFC3339),
		Checks:       checks,
		Facts: Facts{
			Kernel: kernel, Arch: runtime.GOARCH, PageSize: os.Getpagesize(),
			Cgroup: cg, AppArmor: aa, RunscVersion: version, Platform: c.Platform,
			DiskMode: c.diskMode(), WorkspaceBytes: c.workspaceBytes(),
		},
	}
}

func (c *Collector) checkPID1() Check {
	if c.PID == 1 {
		return pass(CheckPID1, "agent is PID 1")
	}
	return fail(CheckPID1, fmt.Sprintf("agent is PID %d, not 1", c.PID))
}

func (c *Collector) checkIdentity(status string, err error) Check {
	if err != nil {
		return fail(CheckIdentity, "cannot read process status")
	}
	for _, key := range []string{"Uid", "Gid"} {
		want := strconv.Itoa(SlotUID)
		if key == "Gid" {
			want = strconv.Itoa(SlotGID)
		}
		fields := strings.Fields(statusField(status, key))
		if len(fields) != 4 {
			return fail(CheckIdentity, key+" line is malformed")
		}
		for _, f := range fields {
			if f != want {
				return fail(CheckIdentity, fmt.Sprintf("%s is %s, want %s", key, strings.Join(fields, " "), want))
			}
		}
	}
	return pass(CheckIdentity, "uid and gid 65532")
}

func (c *Collector) checkCapabilities(status string, err error) Check {
	if err != nil {
		return fail(CheckCapabilities, "cannot read process status")
	}
	for _, key := range []string{"CapEff", "CapPrm", "CapBnd"} {
		v := statusField(status, key)
		if v == "" || strings.Trim(v, "0") != "" {
			return fail(CheckCapabilities, fmt.Sprintf("%s is %q, want all zero", key, v))
		}
	}
	return pass(CheckCapabilities, "no capabilities")
}

func (c *Collector) checkField(name, status string, err error, key, want string) Check {
	if err != nil {
		return fail(name, "cannot read process status")
	}
	got := statusField(status, key)
	if got != want {
		return fail(name, fmt.Sprintf("%s is %q, want %q", key, got, want))
	}
	return pass(name, fmt.Sprintf("%s %s", key, got))
}

// stRdonly is ST_RDONLY, the statfs flag of a read-only mount.
const stRdonly = 1

// checkReadOnlyRoot reads the mount flag of the root filesystem; a write attempt alone proves nothing, since
// the slot user cannot write to a root-owned directory even on a writable mount.
func (c *Collector) checkReadOnlyRoot() Check {
	flags, err := c.rootFlags()
	if err != nil {
		return fail(CheckReadOnlyRoot, "cannot read the root filesystem flags: "+err.Error())
	}
	if flags&stRdonly == 0 {
		return fail(CheckReadOnlyRoot, "the root filesystem is mounted writable")
	}
	f, err := os.OpenFile(c.RootProbe, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err == nil {
		f.Close()
		_ = os.Remove(c.RootProbe)
		return fail(CheckReadOnlyRoot, "the root filesystem is mounted read-only but accepted a write")
	}
	return pass(CheckReadOnlyRoot, "root filesystem is a read-only mount")
}

func (c *Collector) rootFlags() (int64, error) {
	if c.RootFlags != nil {
		return c.RootFlags()
	}
	var st syscall.Statfs_t
	if err := syscall.Statfs("/", &st); err != nil {
		return 0, err
	}
	return int64(st.Flags), nil
}

// fallbackTunnelDevices are created down and unaddressed in every new network namespace by kernels with the tunnel
// drivers built in (Docker Desktop's); they carry no traffic until someone configures them.
var fallbackTunnelDevices = map[string]bool{
	"gre0": true, "gretap0": true, "erspan0": true, "ip_vti0": true, "ip6_vti0": true,
	"sit0": true, "tunl0": true, "ip6tnl0": true, "ip6gre0": true,
}

func (c *Collector) interfaceInfo(name string) (NetIface, error) {
	if c.InterfaceInfo != nil {
		return c.InterfaceInfo(name)
	}
	iface, err := net.InterfaceByName(name)
	if err != nil {
		return NetIface{}, err
	}
	addrs, err := iface.Addrs()
	if err != nil {
		return NetIface{}, err
	}
	return NetIface{Up: iface.Flags&net.FlagUp != 0, Addresses: len(addrs)}, nil
}

// routeTable locates the interface column of a /proc/net route table; skip is its number of header lines.
type routeTable struct {
	path   string
	skip   int
	column int
}

// routeInterfaces lists the interface of every route in a route table.
func routeInterfaces(t routeTable) ([]string, error) {
	raw, err := os.ReadFile(t.path)
	if err != nil {
		return nil, err
	}
	var names []string
	for i, line := range strings.Split(string(raw), "\n") {
		fields := strings.Fields(line)
		if i < t.skip || len(fields) == 0 {
			continue
		}
		if len(fields) <= t.column {
			return nil, errors.New("unreadable route line")
		}
		names = append(names, fields[t.column])
	}
	return names, nil
}

func (c *Collector) checkNetwork() Check {
	raw, err := os.ReadFile(filepath.Join(c.Proc, "net", "dev"))
	if err != nil {
		return fail(CheckNetwork, "cannot read interfaces")
	}
	var names, offenders, idle []string
	hasLo := false
	lines := strings.Split(string(raw), "\n")
	for i, line := range lines {
		if i < 2 || strings.TrimSpace(line) == "" {
			continue
		}
		name, _, found := strings.Cut(line, ":")
		if !found {
			continue
		}
		names = append(names, strings.TrimSpace(name))
	}
	sort.Strings(names)
	for _, name := range names {
		switch {
		case name == "lo":
			hasLo = true
		case !fallbackTunnelDevices[name]:
			offenders = append(offenders, name)
		default:
			info, err := c.interfaceInfo(name)
			if err != nil {
				offenders = append(offenders, name+" (unreadable)")
			} else if info.Up {
				offenders = append(offenders, name+" (up)")
			} else if info.Addresses > 0 {
				offenders = append(offenders, name+" (has an address)")
			} else {
				idle = append(idle, name)
			}
		}
	}
	if len(offenders) > 0 {
		return fail(CheckNetwork, "interfaces: "+strings.Join(offenders, " "))
	}
	if !hasLo {
		return fail(CheckNetwork, "no loopback interface")
	}
	// With nothing but lo and idle tunnel devices left, a route that leaves through any other interface would still
	// be a way out.
	routes, err := routeInterfaces(routeTable{path: filepath.Join(c.Proc, "net", "route"), skip: 1, column: 0})
	if err != nil {
		return fail(CheckNetwork, "cannot read routes")
	}
	routes6, err := routeInterfaces(routeTable{path: filepath.Join(c.Proc, "net", "ipv6_route"), skip: 0, column: 9})
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return fail(CheckNetwork, "cannot read routes")
	}
	for _, name := range append(routes, routes6...) {
		if name != "lo" {
			return fail(CheckNetwork, "route via "+name)
		}
	}
	if len(idle) == 0 {
		return pass(CheckNetwork, "only lo")
	}
	return pass(CheckNetwork, "only lo and idle tunnel devices: "+strings.Join(idle, " "))
}

func (c *Collector) checkDockerSocket() Check {
	for _, p := range c.DockerSocks {
		if _, err := os.Lstat(p); err == nil {
			return fail(CheckNoDockerSocket, p+" exists")
		}
	}
	return pass(CheckNoDockerSocket, "no docker socket")
}

const unlimitedBytes = int64(1) << 50

func numeric(path string) (int64, string) {
	v, err := readTrim(path)
	if err != nil {
		return 0, "missing"
	}
	n, err := strconv.ParseInt(v, 10, 64)
	if err != nil {
		return 0, v
	}
	return n, ""
}

func (c *Collector) checkCgroupLimits() (string, Check) {
	var memPath, pidsPath, version string
	if _, err := os.Stat(filepath.Join(c.Cgroup, "cgroup.controllers")); err == nil {
		version, memPath, pidsPath = "v2", filepath.Join(c.Cgroup, "memory.max"), filepath.Join(c.Cgroup, "pids.max")
	} else {
		version = "v1"
		memPath = filepath.Join(c.Cgroup, "memory", "memory.limit_in_bytes")
		pidsPath = filepath.Join(c.Cgroup, "pids", "pids.max")
	}
	mem, memWhy := numeric(memPath)
	if memWhy != "" || mem <= 0 || mem >= unlimitedBytes {
		return version, fail(CheckCgroupLimits, "memory limit is not set ("+orDefault(memWhy, strconv.FormatInt(mem, 10))+")")
	}
	if mem != ExpectedMemoryBytes {
		return version, fail(CheckCgroupLimits, fmt.Sprintf("memory limit is %d MiB, want %d MiB", mem>>20, int64(ExpectedMemoryBytes)>>20))
	}
	pids, pidsWhy := numeric(pidsPath)
	if pidsWhy != "" || pids <= 0 {
		return version, fail(CheckCgroupLimits, "pids limit is not set ("+orDefault(pidsWhy, strconv.FormatInt(pids, 10))+")")
	}
	if pids != ExpectedPidsLimit {
		return version, fail(CheckCgroupLimits, fmt.Sprintf("pids limit is %d, want %d", pids, ExpectedPidsLimit))
	}
	return version, pass(CheckCgroupLimits, fmt.Sprintf("cgroup %s memory %d MiB, pids %d", version, mem>>20, pids))
}

func orDefault(v, d string) string {
	if v == "" {
		return d
	}
	return v
}

// checkAppArmor requires the slot profile wherever the kernel has AppArmor, decided from the kernel
// rather than from a setting the operator could omit. Only a positive "not present" excuses it.
func (c *Collector) checkAppArmor() (string, Check) {
	enabled, err := readTrim(filepath.Join(c.Sys, "module", "apparmor", "parameters", "enabled"))
	if err != nil && os.IsNotExist(err) {
		return "none", pass(CheckAppArmor, "no AppArmor on this platform")
	}
	if err == nil && !strings.HasPrefix(enabled, "Y") {
		return "none", pass(CheckAppArmor, "no AppArmor on this platform")
	}
	current, readErr := readTrim(filepath.Join(c.Proc, "self", "attr", "current"))
	want := AppArmorProfile + " (enforce)"
	if readErr != nil {
		return "unknown", fail(CheckAppArmor, "AppArmor is on but the profile cannot be read")
	}
	if current != want {
		return current, fail(CheckAppArmor, fmt.Sprintf("AppArmor profile is %q, want %q", current, want))
	}
	return current, pass(CheckAppArmor, current)
}

// checkProcFS requires the real /proc/fs to be a read-only mount of its own, which the container runtime
// sets up. AppArmor lets runsc write below /proc/fs inside its private namespace, so the mount is what
// keeps the real directory from being written, and it must be present, not merely absent of writes.
func (c *Collector) checkProcFS() Check {
	mi, err := os.ReadFile(filepath.Join(c.Proc, "self", "mountinfo"))
	if err != nil {
		return fail(CheckProcFS, "cannot read mountinfo")
	}
	mountPoint := filepath.Join(c.Proc, "fs")
	found := false
	for _, line := range strings.Split(string(mi), "\n") {
		fields := strings.Fields(line)
		if len(fields) > 5 && fields[4] == mountPoint {
			found = true
			if !strings.Contains(","+fields[5]+",", ",ro,") {
				return fail(CheckProcFS, "/proc/fs is mounted writable")
			}
		}
	}
	if !found {
		return fail(CheckProcFS, "/proc/fs is not a read-only mount of its own")
	}
	// A name the AppArmor profile allows, so only the mount can be what refuses it.
	probe := filepath.Join(mountPoint, "root")
	if err := os.Mkdir(probe, 0o700); err == nil {
		_ = os.Remove(probe)
		return fail(CheckProcFS, "the real /proc/fs accepted a write")
	}
	return pass(CheckProcFS, "/proc/fs is a read-only mount and refuses writes")
}

func (c *Collector) checkRunsc() (string, Check) {
	version, err := c.Runsc()
	if err != nil {
		return "", fail(CheckRunsc, "runsc cannot run: "+err.Error())
	}
	if err := c.canary(); err != nil {
		return version, fail(CheckRunsc, version+" cannot start a guest: "+err.Error())
	}
	return version, pass(CheckRunsc, version+" started a guest")
}

func (c *Collector) canary() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.canaryDone && c.canaryErr == nil && c.CanaryEvery > 0 && time.Since(c.canaryAt) < c.CanaryEvery {
		return nil
	}
	c.canaryErr = c.Canary()
	c.canaryAt = time.Now()
	c.canaryDone = true
	return c.canaryErr
}

// ext4SuperMagic is the statfs type of an ext4 filesystem.
const ext4SuperMagic = 0xEF53

// checkWorkspaceQuota proves the workspace is the fixed-size disk the host set up, not the host's own
// filesystem: when a disk size is configured, the workspace must be an ext4 filesystem no larger than it
// and not much smaller. Without a configured size it records that no hard limit exists here.
func (c *Collector) checkWorkspaceQuota() Check {
	if c.WorkspaceQuotaBytes <= 0 {
		return pass(CheckWorkspaceQuota, "no per-slot disk on this platform; the Docker VM's disk bounds the workspaces")
	}
	fsType, size, err := c.statfs(c.Workspace)
	if err != nil {
		return fail(CheckWorkspaceQuota, "cannot read the workspace filesystem: "+err.Error())
	}
	if fsType != ext4SuperMagic {
		return fail(CheckWorkspaceQuota, fmt.Sprintf("the workspace is not the slot's ext4 disk (filesystem type %#x)", fsType))
	}
	if size > c.WorkspaceQuotaBytes || size < c.WorkspaceQuotaBytes/2 {
		return fail(CheckWorkspaceQuota, fmt.Sprintf("the workspace is %d MiB, not the configured %d MiB disk", size>>20, c.WorkspaceQuotaBytes>>20))
	}
	return pass(CheckWorkspaceQuota, fmt.Sprintf("workspace is a %d MiB disk", size>>20))
}

func (c *Collector) statfs(path string) (int64, int64, error) {
	if c.Statfs != nil {
		return c.Statfs(path)
	}
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return 0, 0, err
	}
	return int64(st.Type), int64(st.Blocks) * int64(st.Bsize), nil
}

func (c *Collector) diskMode() string {
	switch {
	case c.WorkspaceQuotaBytes > 0:
		return "hard"
	case c.ConfiguredDiskMode == "vm":
		return "vm"
	default:
		return "none"
	}
}

func (c *Collector) workspaceBytes() int64 {
	if c.Workspace == "" {
		return 0
	}
	_, size, err := c.statfs(c.Workspace)
	if err != nil {
		return 0
	}
	return size
}

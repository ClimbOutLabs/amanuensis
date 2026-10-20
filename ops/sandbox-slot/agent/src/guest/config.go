// Package guest builds the OCI bundle for one gVisor guest and runs it to completion.
package guest

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
)

// Bind maps a directory of the slot into the guest.
type Bind struct {
	Dest     string
	Source   string
	ReadOnly bool
}

// Tmpfs is a memory-backed guest directory.
type Tmpfs struct {
	Dest   string
	SizeMB int
}

// Spec describes one guest. The guest root is always read-only.
type Spec struct {
	ID     string
	RootFS string
	Argv   []string
	Env    []string
	Cwd    string
	UID    uint32
	GID    uint32
	Binds  []Bind
	Tmpfs  []Tmpfs
	// SharedNetwork runs the guest in the slot's own network namespace instead of an isolated one.
	// The slot's namespace holds only loopback (the agent attests to that, and the compose file gives
	// the slot no other network), so the guest can reach the agent's loopback mirror forwarder and
	// nothing else. Set only for a call carrying a package mirror grant.
	SharedNetwork bool
	// MaxFileBytes caps the size of any one file a guest process writes (RLIMIT_FSIZE); zero means no cap.
	MaxFileBytes int64
	// MaxProcesses caps the processes the guest can create (RLIMIT_NPROC); zero means no cap.
	MaxProcesses int
}

type ociUser struct {
	UID uint32 `json:"uid"`
	GID uint32 `json:"gid"`
}

type ociCaps struct {
	Bounding    []string `json:"bounding"`
	Effective   []string `json:"effective"`
	Permitted   []string `json:"permitted"`
	Inheritable []string `json:"inheritable"`
}

type ociRlimit struct {
	Type string `json:"type"`
	Hard uint64 `json:"hard"`
	Soft uint64 `json:"soft"`
}

type ociProcess struct {
	Terminal        bool        `json:"terminal"`
	User            ociUser     `json:"user"`
	Args            []string    `json:"args"`
	Env             []string    `json:"env"`
	Cwd             string      `json:"cwd"`
	NoNewPrivileges bool        `json:"noNewPrivileges"`
	Capabilities    ociCaps     `json:"capabilities"`
	Rlimits         []ociRlimit `json:"rlimits,omitempty"`
}

type ociRoot struct {
	Path     string `json:"path"`
	Readonly bool   `json:"readonly"`
}

type ociMount struct {
	Destination string   `json:"destination"`
	Type        string   `json:"type"`
	Source      string   `json:"source"`
	Options     []string `json:"options,omitempty"`
}

type ociNamespace struct {
	Type string `json:"type"`
}

type ociLinux struct {
	Namespaces []ociNamespace `json:"namespaces"`
}

type ociConfig struct {
	OCIVersion string     `json:"ociVersion"`
	Process    ociProcess `json:"process"`
	Root       ociRoot    `json:"root"`
	Hostname   string     `json:"hostname"`
	Mounts     []ociMount `json:"mounts"`
	Linux      ociLinux   `json:"linux"`
}

// BuildConfig renders the bundle's config.json. The argument list is JSON-encoded as data, never
// passed through a shell.
func BuildConfig(s Spec) ([]byte, error) {
	if len(s.Argv) == 0 {
		return nil, errors.New("guest: empty argv")
	}
	if s.RootFS == "" || s.Cwd == "" {
		return nil, errors.New("guest: rootfs and cwd are required")
	}
	mounts := []ociMount{
		{Destination: "/proc", Type: "proc", Source: "proc"},
	}
	for _, t := range s.Tmpfs {
		mounts = append(mounts, ociMount{
			Destination: t.Dest, Type: "tmpfs", Source: "tmpfs",
			Options: []string{"nosuid", "nodev", fmt.Sprintf("size=%sm", strconv.Itoa(t.SizeMB))},
		})
	}
	for _, b := range s.Binds {
		mode := "rw"
		if b.ReadOnly {
			mode = "ro"
		}
		mounts = append(mounts, ociMount{
			Destination: b.Dest, Type: "bind", Source: b.Source,
			Options: []string{"rbind", "nosuid", "nodev", mode},
		})
	}
	var rlimits []ociRlimit
	if s.MaxFileBytes > 0 {
		rlimits = append(rlimits, ociRlimit{Type: "RLIMIT_FSIZE", Hard: uint64(s.MaxFileBytes), Soft: uint64(s.MaxFileBytes)})
	}
	if s.MaxProcesses > 0 {
		rlimits = append(rlimits, ociRlimit{Type: "RLIMIT_NPROC", Hard: uint64(s.MaxProcesses), Soft: uint64(s.MaxProcesses)})
	}
	cfg := ociConfig{
		OCIVersion: "1.0.2",
		Process: ociProcess{
			User:            ociUser{UID: s.UID, GID: s.GID},
			Args:            s.Argv,
			Env:             s.Env,
			Cwd:             s.Cwd,
			NoNewPrivileges: true,
			Capabilities:    ociCaps{Bounding: []string{}, Effective: []string{}, Permitted: []string{}, Inheritable: []string{}},
			Rlimits:         rlimits,
		},
		Root:     ociRoot{Path: s.RootFS, Readonly: true},
		Hostname: "sandbox",
		Mounts:   mounts,
		Linux: ociLinux{Namespaces: []ociNamespace{
			{Type: "pid"}, {Type: "mount"}, {Type: "ipc"}, {Type: "uts"}, {Type: "network"},
		}},
	}
	var out bytes.Buffer
	enc := json.NewEncoder(&out)
	// Arguments are data; HTML escaping would only make the file harder to read.
	enc.SetEscapeHTML(false)
	if err := enc.Encode(cfg); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

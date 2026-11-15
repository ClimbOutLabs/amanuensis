package guest_test

import (
	"encoding/json"
	"strings"
	"testing"

	"aman/slotagent/src/guest"
)

func TestBuildConfigIsDataNotShell(t *testing.T) {
	spec := guest.Spec{
		ID: "g1", RootFS: "/rootfs", Cwd: "/scratch", UID: 0, GID: 0,
		Argv:  []string{"python3", `-c`, "print('a\"b')\n$(rm -rf /)"},
		Env:   []string{"A=1"},
		Binds: []guest.Bind{{Dest: "/ingress", Source: "/x/in", ReadOnly: true}, {Dest: "/scratch", Source: "/x/s"}},
		Tmpfs: []guest.Tmpfs{{Dest: "/tmp", SizeMB: 64}},
	}
	raw, err := guest.BuildConfig(spec)
	if err != nil {
		t.Fatal(err)
	}
	var cfg struct {
		Process struct {
			Args            []string `json:"args"`
			NoNewPrivileges bool     `json:"noNewPrivileges"`
			Capabilities    struct {
				Bounding []string `json:"bounding"`
			} `json:"capabilities"`
		} `json:"process"`
		Root struct {
			Readonly bool `json:"readonly"`
		} `json:"root"`
		Mounts []struct {
			Destination string   `json:"destination"`
			Options     []string `json:"options"`
		} `json:"mounts"`
	}
	if err := json.Unmarshal(raw, &cfg); err != nil {
		t.Fatal(err)
	}
	if cfg.Process.Args[2] != spec.Argv[2] {
		t.Errorf("argument changed in transit: %q", cfg.Process.Args[2])
	}
	if !cfg.Process.NoNewPrivileges || !cfg.Root.Readonly || len(cfg.Process.Capabilities.Bounding) != 0 {
		t.Error("the guest must have no new privileges, a read-only root and no capabilities")
	}
	var roIngress bool
	for _, m := range cfg.Mounts {
		if m.Destination == "/ingress" {
			for _, o := range m.Options {
				roIngress = roIngress || o == "ro"
			}
		}
	}
	if !roIngress {
		t.Error("/ingress must be mounted read-only")
	}
}

func TestBuildConfigRequiresArgvAndRoot(t *testing.T) {
	if _, err := guest.BuildConfig(guest.Spec{RootFS: "/r", Cwd: "/"}); err == nil {
		t.Error("empty argv must fail")
	}
	if _, err := guest.BuildConfig(guest.Spec{Argv: []string{"x"}}); err == nil {
		t.Error("missing rootfs must fail")
	}
}

func TestBuildConfigCapsFileSizeWhenAskedTo(t *testing.T) {
	spec := guest.Spec{ID: "g", RootFS: "/rootfs", Cwd: "/", Argv: []string{"true"}, MaxFileBytes: 1 << 20}
	raw, err := guest.BuildConfig(spec)
	if err != nil {
		t.Fatal(err)
	}
	var cfg struct {
		Process struct {
			Rlimits []struct {
				Type string `json:"type"`
				Hard uint64 `json:"hard"`
				Soft uint64 `json:"soft"`
			} `json:"rlimits"`
		} `json:"process"`
	}
	if err := json.Unmarshal(raw, &cfg); err != nil {
		t.Fatal(err)
	}
	if len(cfg.Process.Rlimits) != 1 || cfg.Process.Rlimits[0].Type != "RLIMIT_FSIZE" || cfg.Process.Rlimits[0].Hard != 1<<20 || cfg.Process.Rlimits[0].Soft != 1<<20 {
		t.Fatalf("%+v", cfg.Process.Rlimits)
	}
	raw, _ = guest.BuildConfig(guest.Spec{ID: "g", RootFS: "/rootfs", Cwd: "/", Argv: []string{"true"}})
	if strings.Contains(string(raw), "rlimits") {
		t.Fatal("no cap, no rlimit")
	}
}

// A guest that asks for a network of its own gets an empty one, so a guest meant to share the slot's
// network, to reach the package mirror, must not ask for one. Every other guest must.
func TestBuildConfigGivesOnlyAnIsolatedGuestItsOwnNetwork(t *testing.T) {
	asksForOwnNetwork := func(shared bool) bool {
		spec := guest.Spec{ID: "g", RootFS: "/rootfs", Cwd: "/", Argv: []string{"true"}, SharedNetwork: shared}
		raw, err := guest.BuildConfig(spec)
		if err != nil {
			t.Fatal(err)
		}
		var cfg struct {
			Linux struct {
				Namespaces []struct {
					Type string `json:"type"`
				} `json:"namespaces"`
			} `json:"linux"`
		}
		if err := json.Unmarshal(raw, &cfg); err != nil {
			t.Fatal(err)
		}
		if len(cfg.Linux.Namespaces) < 4 {
			t.Fatalf("the other namespaces must stay: %+v", cfg.Linux.Namespaces)
		}
		for _, ns := range cfg.Linux.Namespaces {
			if ns.Type == "network" {
				return true
			}
		}
		return false
	}
	if !asksForOwnNetwork(false) {
		t.Error("a guest with no grant must get its own, empty network")
	}
	if asksForOwnNetwork(true) {
		t.Error("a guest that shares the slot's network must not ask for its own")
	}
}

package guest_test

import (
	"encoding/json"
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

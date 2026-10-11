package lease_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"aman/slotagent/src/lease"
)

const runID = "0123456789abcdef0123456789abcdef"

func TestValidName(t *testing.T) {
	good := []string{"a.txt", ".hidden", "a b", "..x", "x.."}
	bad := []string{"", ".", "..", "a/b", `a\b`, "a\x00b", strings.Repeat("x", 256)}
	for _, n := range good {
		if !lease.ValidName(n) {
			t.Errorf("%q should be valid", n)
		}
	}
	for _, n := range bad {
		if lease.ValidName(n) {
			t.Errorf("%q should be invalid", n)
		}
	}
}

func TestCreateStagesReadOnlyInputs(t *testing.T) {
	parent := t.TempDir()
	d, err := lease.Create(parent, runID, []lease.File{{Name: "in.txt", Bytes: []byte("data")}})
	if err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(filepath.Join(d.Ingress, "in.txt"))
	if err != nil || info.Mode().Perm() != 0o444 {
		t.Fatalf("input not staged read-only: %v %v", info, err)
	}
	for _, dir := range []string{d.Scratch, d.Egress} {
		if _, err := os.Stat(dir); err != nil {
			t.Fatal(err)
		}
	}
}

func TestCreateRejectsBadInput(t *testing.T) {
	cases := map[string][]lease.File{
		"traversal": {{Name: "../x", Bytes: nil}},
		"duplicate": {{Name: "a", Bytes: nil}, {Name: "a", Bytes: nil}},
		"too large": {{Name: "a", Bytes: make([]byte, lease.MaxFileBytes+1)}},
	}
	for name, files := range cases {
		if _, err := lease.Create(t.TempDir(), runID, files); err == nil {
			t.Errorf("%s: expected an error", name)
		}
	}
	if _, err := lease.Create(t.TempDir(), "not-hex", nil); err == nil {
		t.Error("expected an error for a bad run id")
	}
}

func TestCollectSkipsSymlinksDirsAndReportsWarnings(t *testing.T) {
	d, err := lease.Create(t.TempDir(), runID, nil)
	if err != nil {
		t.Fatal(err)
	}
	secret := filepath.Join(t.TempDir(), "secret")
	if err := os.WriteFile(secret, []byte("host secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	must(os.WriteFile(filepath.Join(d.Egress, "ok.txt"), []byte("ok"), 0o644))
	must(os.Symlink(secret, filepath.Join(d.Egress, "link")))
	must(os.Mkdir(filepath.Join(d.Scratch, "sub"), 0o755))
	must(os.WriteFile(filepath.Join(d.Scratch, "s.txt"), []byte("s"), 0o644))

	out, warnings := lease.Collect(d)
	names := map[string]string{}
	for _, o := range out {
		names[o.Dir+"/"+o.Name] = string(o.Bytes)
	}
	if len(names) != 2 || names["egress/ok.txt"] != "ok" || names["scratch/s.txt"] != "s" {
		t.Fatalf("unexpected outputs %v", names)
	}
	if len(warnings) != 2 {
		t.Fatalf("expected a warning for the link and the directory, got %v", warnings)
	}
}

func TestUsageCountsAllocatedBlocksNotFileSize(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "a"), make([]byte, 100_000), 0o644); err != nil {
		t.Fatal(err)
	}
	bytes, entries := lease.Usage(dir)
	if bytes < 100_000 || bytes > 110_000 || entries != 2 {
		t.Fatalf("got %d bytes %d entries", bytes, entries)
	}
	// A sparse file with a huge size but no data takes (almost) no space and must not count as full.
	sparse, err := os.Create(filepath.Join(dir, "sparse"))
	if err != nil {
		t.Fatal(err)
	}
	if err := sparse.Truncate(1 << 30); err != nil {
		t.Fatal(err)
	}
	sparse.Close()
	after, _ := lease.Usage(dir)
	if after-bytes > 1<<20 {
		t.Fatalf("a sparse file counted as %d bytes", after-bytes)
	}
}

func TestReclaimRemovesTheLargestFilesUntilWithinTheLimit(t *testing.T) {
	dir := t.TempDir()
	for name, size := range map[string]int{"big": 400_000, "mid": 200_000, "small": 20_000} {
		if err := os.WriteFile(filepath.Join(dir, name), make([]byte, size), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	files, freed := lease.Reclaim(dir, 250_000)
	if files != 1 || freed < 400_000 {
		t.Fatalf("removed %d files, %d bytes", files, freed)
	}
	if _, err := os.Stat(filepath.Join(dir, "big")); !os.IsNotExist(err) {
		t.Fatal("the largest file should go first")
	}
	if _, err := os.Stat(filepath.Join(dir, "small")); err != nil {
		t.Fatal("small files within the limit must stay")
	}
	if files, _ := lease.Reclaim(dir, 1<<30); files != 0 {
		t.Fatal("nothing to reclaim under the limit")
	}
}

func TestFilesystemUsedBytesReportsUsedAndFree(t *testing.T) {
	used, free, err := lease.FilesystemUsedBytes(t.TempDir())
	if err != nil || used <= 0 || free <= 0 {
		t.Fatalf("used=%d free=%d err=%v", used, free, err)
	}
}

func TestRemoveRestoresStrippedPermissions(t *testing.T) {
	root := filepath.Join(t.TempDir(), "tree")
	if err := os.MkdirAll(filepath.Join(root, "locked", "inner"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(filepath.Join(root, "locked"), 0); err != nil {
		t.Fatal(err)
	}
	if err := lease.Remove(root); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(root); !os.IsNotExist(err) {
		t.Fatal("tree still exists")
	}
}

func TestDecodeBase64IsStrict(t *testing.T) {
	if _, err := lease.DecodeBase64("aGk=\n"); err == nil {
		t.Error("whitespace should be rejected")
	}
	if b, err := lease.DecodeBase64("aGk="); err != nil || string(b) != "hi" {
		t.Errorf("got %q %v", b, err)
	}
}

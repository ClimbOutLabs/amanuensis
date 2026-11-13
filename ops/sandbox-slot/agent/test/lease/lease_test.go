package lease_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

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

func writeSized(t *testing.T, path string, size int) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, make([]byte, size), 0o644); err != nil {
		t.Fatal(err)
	}
}

func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func TestReclaimRemovesTheLargestFilesUntilWithinTheLimit(t *testing.T) {
	dir := t.TempDir()
	since := time.Now()
	for name, size := range map[string]int{"big": 400_000, "mid": 200_000, "small": 20_000} {
		writeSized(t, filepath.Join(dir, name), size)
	}
	got := lease.Reclaim(dir, 250_000, since)
	if got.Files != 1 || got.Bytes < 400_000 || len(got.Paths) != 1 || got.Paths[0] != "big" || got.Older {
		t.Fatalf("removed %+v", got)
	}
	notice := got.Notice(2048)
	for _, want := range []string{"2048 MB limit", "big", "that this command wrote", "run the command again"} {
		if !strings.Contains(notice, want) {
			t.Fatalf("the notice must say %q: %q", want, notice)
		}
	}
	if exists(filepath.Join(dir, "big")) {
		t.Fatal("the largest file should go first")
	}
	if !exists(filepath.Join(dir, "small")) {
		t.Fatal("small files within the limit must stay")
	}
	if got := lease.Reclaim(dir, 1<<30, since); got.Files != 0 || got.Notice(1) != "" {
		t.Fatal("nothing to reclaim under the limit")
	}
}

// A project's history is one large file. A build that overshoots must lose its own output, not that.
func TestReclaimKeepsWhatWasThereBeforeTheCommand(t *testing.T) {
	dir := t.TempDir()
	pack := filepath.Join(dir, "repo", ".git", "objects", "pack", "history.pack")
	source := filepath.Join(dir, "repo", "data.bin")
	writeSized(t, pack, 600_000)
	writeSized(t, source, 500_000)
	time.Sleep(20 * time.Millisecond)
	since := time.Now()
	for _, name := range []string{"out1.o", "out2.o", "out3.o"} {
		writeSized(t, filepath.Join(dir, "repo", "build", name), 300_000)
	}
	got := lease.Reclaim(dir, 1_500_000, since)
	if !exists(pack) || !exists(source) {
		t.Fatalf("files from before the command were deleted: %+v", got)
	}
	if got.Files == 0 || got.Older {
		t.Fatalf("only the command's own files should go: %+v", got)
	}
	for _, p := range got.Paths {
		if !strings.HasPrefix(p, filepath.Join("repo", "build")) {
			t.Fatalf("removed %q, which the command did not write", p)
		}
	}
}

// An unpacked archive carries old modification times; it still counts as written by the command.
func TestReclaimIsNotFooledByAnOldModificationTime(t *testing.T) {
	dir := t.TempDir()
	kept := filepath.Join(dir, "kept")
	writeSized(t, kept, 400_000)
	time.Sleep(20 * time.Millisecond)
	since := time.Now()
	unpacked := filepath.Join(dir, "unpacked")
	writeSized(t, unpacked, 300_000)
	old := time.Now().Add(-48 * time.Hour)
	if err := os.Chtimes(unpacked, old, old); err != nil {
		t.Fatal(err)
	}
	got := lease.Reclaim(dir, 500_000, since)
	if !exists(kept) || exists(unpacked) || got.Older {
		t.Fatalf("the file the command wrote should go, whatever its date: %+v", got)
	}
}

// Among the files a command wrote, git's own go last: a clone that overshoots loses its checkout first.
func TestReclaimGivesUpGitFilesLast(t *testing.T) {
	dir := t.TempDir()
	since := time.Now()
	pack := filepath.Join(dir, ".git", "objects", "pack", "new.pack")
	writeSized(t, pack, 600_000)
	writeSized(t, filepath.Join(dir, "a.bin"), 300_000)
	writeSized(t, filepath.Join(dir, "b.bin"), 300_000)
	got := lease.Reclaim(dir, 700_000, since)
	if !exists(pack) || got.Files != 2 {
		t.Fatalf("the plain files should go before git's: %+v", got)
	}
}

// Only a tree that was already over its limit before the command loses older files, and it says so.
func TestReclaimTouchesOlderFilesOnlyWhenNothingNewIsLeft(t *testing.T) {
	dir := t.TempDir()
	writeSized(t, filepath.Join(dir, ".git", "pack"), 400_000)
	writeSized(t, filepath.Join(dir, "old.bin"), 400_000)
	time.Sleep(20 * time.Millisecond)
	got := lease.Reclaim(dir, 500_000, time.Now())
	if !got.Older || exists(filepath.Join(dir, "old.bin")) || !exists(filepath.Join(dir, ".git", "pack")) {
		t.Fatalf("an older plain file should go before git's, and be reported as older: %+v", got)
	}
	if notice := got.Notice(1); !strings.Contains(notice, "in the workspace was deleted") {
		t.Fatalf("the notice must not blame the command: %q", notice)
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

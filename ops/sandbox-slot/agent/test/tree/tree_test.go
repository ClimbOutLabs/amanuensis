package tree_test

import (
	"os"
	"path/filepath"
	"testing"

	"aman/slotagent/src/tree"
)

const sid = "0123456789abcdef0123456789abcdef"

func TestRelative(t *testing.T) {
	ok := map[string][]string{
		"/workspace":            nil,
		"/workspace/a":          {"a"},
		"/workspace//a/./b":     {"a", "b"},
		"/workspace/a/b/c.txt":  {"a", "b", "c.txt"},
		"/workspace/.aman/x.md": {".aman", "x.md"},
	}
	for in, want := range ok {
		got, err := tree.Relative(in)
		if err != nil || len(got) != len(want) {
			t.Errorf("%q: got %v %v", in, got, err)
		}
	}
	for _, in := range []string{"", "a", "/etc/passwd", "/workspace/../etc", "/workspace/a/../../x", "/workspacex/a", "/workspace/a\x00b"} {
		if _, err := tree.Relative(in); err == nil {
			t.Errorf("%q should be rejected", in)
		}
	}
}

func TestWriteReadRoundTripCreatesParents(t *testing.T) {
	parent := t.TempDir()
	root, err := tree.Ensure(parent, sid)
	if err != nil {
		t.Fatal(err)
	}
	if err := tree.Write(root, "/workspace/a/b/c.txt", []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	b, err := tree.Read(root, "/workspace/a/b/c.txt")
	if err != nil || string(b) != "hello" {
		t.Fatalf("got %q %v", b, err)
	}
	entries, _ := os.ReadDir(filepath.Join(root, "a", "b"))
	if len(entries) != 1 {
		t.Fatalf("temp file left behind: %v", entries)
	}
}

func TestSymlinkOnPathIsNeverFollowed(t *testing.T) {
	parent := t.TempDir()
	root, _ := tree.Ensure(parent, sid)
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "secret"), []byte("host"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "escape")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(outside, "secret"), filepath.Join(root, "filelink")); err != nil {
		t.Fatal(err)
	}
	if _, err := tree.Read(root, "/workspace/escape/secret"); err == nil {
		t.Error("read through a directory link must fail")
	}
	if _, err := tree.Read(root, "/workspace/filelink"); err == nil {
		t.Error("read of a file link must fail")
	}
	if err := tree.Write(root, "/workspace/escape/new", []byte("x"), 0o644); err == nil {
		t.Error("write through a directory link must fail")
	}
	if err := tree.Write(root, "/workspace/filelink", []byte("x"), 0o644); err == nil {
		t.Error("write over a file link must fail")
	}
	if b, _ := os.ReadFile(filepath.Join(outside, "secret")); string(b) != "host" {
		t.Error("the target outside the tree was modified")
	}
	if _, err := os.Stat(filepath.Join(outside, "new")); err == nil {
		t.Error("a file was created outside the tree")
	}
}

func TestCapsAndDirectories(t *testing.T) {
	root, _ := tree.Ensure(t.TempDir(), sid)
	if err := tree.Write(root, "/workspace", []byte("x"), 0o644); err == nil {
		t.Error("writing the root must fail")
	}
	if err := tree.Write(root, "/workspace/big", make([]byte, tree.MaxWriteBytes+1), 0o644); err == nil {
		t.Error("oversized write must fail")
	}
	if err := os.Mkdir(filepath.Join(root, "d"), 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := tree.Read(root, "/workspace/d"); err == nil {
		t.Error("reading a directory must fail")
	}
	if err := os.WriteFile(filepath.Join(root, "big"), make([]byte, tree.MaxReadBytes+1), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := tree.Read(root, "/workspace/big"); err == nil {
		t.Error("oversized read must fail")
	}
}

func TestDestroyRemovesTree(t *testing.T) {
	parent := t.TempDir()
	root, _ := tree.Ensure(parent, sid)
	_ = tree.Write(root, "/workspace/x", []byte("1"), 0o644)
	if err := tree.Destroy(parent, sid); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(root); !os.IsNotExist(err) {
		t.Fatal("tree still exists")
	}
	if _, err := tree.Ensure(parent, "../x"); err == nil {
		t.Error("bad session id must be rejected")
	}
}

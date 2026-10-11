// Package tree owns per-session workspace trees on the slot volume. Every path comes from the server
// but is treated as untrusted: it is resolved one component at a time without following symlinks, so a
// link planted by model code can never lead the agent outside the tree.
package tree

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"

	"aman/slotagent/src/lease"
)

// GuestRoot is where a session tree appears inside a guest.
const GuestRoot = "/workspace"

// MaxReadBytes caps one file read.
const MaxReadBytes = 10 << 20

// MaxWriteBytes caps one file write.
const MaxWriteBytes = 25 << 20

// TransferDir holds repository tars and bundles the server moves in and out; they may be larger than
// ordinary files.
const TransferDir = GuestRoot + "/.aman/transfer/"

// MaxTransferBytes caps one file read or written below TransferDir.
const MaxTransferBytes = 128 << 20

// ReadLimit is the largest file Read accepts at guestPath.
func ReadLimit(guestPath string) int {
	if strings.HasPrefix(path.Clean(guestPath)+"/", TransferDir) {
		return MaxTransferBytes
	}
	return MaxReadBytes
}

// WriteLimit is the largest content Write accepts at guestPath.
func WriteLimit(guestPath string) int {
	if strings.HasPrefix(path.Clean(guestPath)+"/", TransferDir) {
		return MaxTransferBytes
	}
	return MaxWriteBytes
}

var sessionIDPattern = regexp.MustCompile(`^[0-9a-f]{32}$`)

// ValidSessionID reports whether id is a 32-character lowercase hex session id.
func ValidSessionID(id string) bool { return sessionIDPattern.MatchString(id) }

// Root returns the host path of a session's tree under the slot volume.
func Root(parent, sessionID string) string { return filepath.Join(parent, sessionID) }

// Ensure creates the tree directory if it does not exist.
func Ensure(parent, sessionID string) (string, error) {
	if !ValidSessionID(sessionID) {
		return "", errors.New("tree: invalid session id")
	}
	if err := os.MkdirAll(parent, 0o755); err != nil {
		return "", err
	}
	root := Root(parent, sessionID)
	if err := os.Mkdir(root, 0o755); err != nil && !os.IsExist(err) {
		return "", err
	}
	return root, nil
}

// Destroy removes a session's tree.
func Destroy(parent, sessionID string) error {
	if !ValidSessionID(sessionID) {
		return errors.New("tree: invalid session id")
	}
	return lease.Remove(Root(parent, sessionID))
}

// Relative converts a guest path into components below the tree root, or an error when the path is not
// absolute, not under GuestRoot, or contains a parent reference.
func Relative(guestPath string) ([]string, error) {
	if strings.IndexByte(guestPath, 0) >= 0 || len(guestPath) > 4096 {
		return nil, errors.New("tree: invalid path")
	}
	if !path.IsAbs(guestPath) {
		return nil, errors.New("tree: path must be absolute")
	}
	for _, part := range strings.Split(guestPath, "/") {
		if part == ".." {
			return nil, errors.New("tree: path must not contain ..")
		}
	}
	clean := path.Clean(guestPath)
	if clean == GuestRoot {
		return nil, nil
	}
	if !strings.HasPrefix(clean, GuestRoot+"/") {
		return nil, fmt.Errorf("tree: path must be under %s", GuestRoot)
	}
	return strings.Split(strings.TrimPrefix(clean, GuestRoot+"/"), "/"), nil
}

// openDir walks parts below rootFd without following symlinks, optionally creating directories.
func openDir(root string, parts []string, create bool) (int, error) {
	fd, err := syscall.Open(root, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if err != nil {
		return -1, err
	}
	for _, part := range parts {
		if create {
			if err := syscall.Mkdirat(fd, part, 0o755); err != nil && err != syscall.EEXIST {
				syscall.Close(fd)
				return -1, err
			}
		}
		next, err := openat(fd, part, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
		syscall.Close(fd)
		if err != nil {
			return -1, err
		}
		fd = next
	}
	return fd, nil
}

// Read returns a regular file's bytes, refusing symlinks anywhere on the path.
func Read(root, guestPath string) ([]byte, error) {
	parts, err := Relative(guestPath)
	if err != nil {
		return nil, err
	}
	if len(parts) == 0 {
		return nil, errors.New("tree: path is a directory")
	}
	dir, err := openDir(root, parts[:len(parts)-1], false)
	if err != nil {
		return nil, err
	}
	defer syscall.Close(dir)
	fd, err := openat(dir, parts[len(parts)-1], syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, err
	}
	f := os.NewFile(uintptr(fd), "file")
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, errors.New("tree: not a regular file")
	}
	limit := ReadLimit(guestPath)
	if info.Size() > int64(limit) {
		return nil, errors.New("tree: file is larger than the read cap")
	}
	b, err := io.ReadAll(io.LimitReader(f, int64(limit)+1))
	if err != nil {
		return nil, err
	}
	if len(b) > limit {
		return nil, errors.New("tree: file is larger than the read cap")
	}
	return b, nil
}

// Write replaces a file atomically (temp file and rename), creating parent directories.
func Write(root, guestPath string, content []byte, mode os.FileMode) error {
	parts, err := Relative(guestPath)
	if err != nil {
		return err
	}
	if len(parts) == 0 {
		return errors.New("tree: path is a directory")
	}
	if len(content) > WriteLimit(guestPath) {
		return errors.New("tree: content is larger than the write cap")
	}
	dir, err := openDir(root, parts[:len(parts)-1], true)
	if err != nil {
		return err
	}
	defer syscall.Close(dir)
	name := parts[len(parts)-1]
	if existing, err := lstatat(dir, name); err == nil && existing&syscall.S_IFMT != syscall.S_IFREG {
		return errors.New("tree: target exists and is not a regular file")
	}
	tmp := ".aman-tmp-" + randomSuffix()
	fd, err := openat(dir, tmp, syscall.O_WRONLY|syscall.O_CREAT|syscall.O_EXCL|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, uint32(mode.Perm()))
	if err != nil {
		return err
	}
	f := os.NewFile(uintptr(fd), tmp)
	if _, err := f.Write(content); err != nil {
		f.Close()
		_ = unlinkat(dir, tmp)
		return err
	}
	if err := f.Close(); err != nil {
		_ = unlinkat(dir, tmp)
		return err
	}
	if err := syscall.Renameat(dir, tmp, dir, name); err != nil {
		_ = unlinkat(dir, tmp)
		return err
	}
	return nil
}

// Count returns how many session trees exist under parent.
func Count(parent string) int {
	entries, err := os.ReadDir(parent)
	if err != nil {
		return 0
	}
	n := 0
	for _, e := range entries {
		if e.IsDir() && ValidSessionID(e.Name()) {
			n++
		}
	}
	return n
}

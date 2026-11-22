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
	"strconv"
	"strings"
	"syscall"
	"time"

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
	// The root's mtime is the tree's last use, which the idle sweep reads.
	now := time.Now()
	_ = os.Chtimes(root, now, now)
	return root, nil
}

// Destroy removes a session's tree and the quota recorded for it.
func Destroy(parent, sessionID string) error {
	if !ValidSessionID(sessionID) {
		return errors.New("tree: invalid session id")
	}
	err := lease.Remove(Root(parent, sessionID))
	_ = os.Remove(quotaPath(parent, sessionID))
	return err
}

// quotaPath is where a tree's promised quota is recorded: a small file beside the tree, never
// inside it, so guest code can neither read nor change the promise the volume made to the tree.
func quotaPath(parent, sessionID string) string {
	return filepath.Join(parent, sessionID+".quota")
}

// RecordQuota writes the quota a tree was promised, replacing any earlier record.
func RecordQuota(parent, sessionID string, quotaBytes int64) error {
	if !ValidSessionID(sessionID) {
		return errors.New("tree: invalid session id")
	}
	return os.WriteFile(quotaPath(parent, sessionID), []byte(strconv.FormatInt(quotaBytes, 10)), 0o644)
}

// RecordedQuota reads the quota recorded for a tree; the second result is false when there is no
// usable record, for instance for a tree made before quotas were recorded.
func RecordedQuota(parent, sessionID string) (int64, bool) {
	raw, err := os.ReadFile(quotaPath(parent, sessionID))
	if err != nil {
		return 0, false
	}
	quota, err := strconv.ParseInt(strings.TrimSpace(string(raw)), 10, 64)
	if err != nil || quota < 0 {
		return 0, false
	}
	return quota, true
}

// PromisedBytes returns how much of the volume the trees under parent have been promised between
// them: for each tree, the larger of the quota recorded for it and the space it already takes. A
// tree with no recorded quota counts the space it takes now, since its promise is unknown.
func PromisedBytes(parent string) int64 {
	var total int64
	for _, session := range Sessions(parent) {
		total += promisedBytes(parent, session.ID, session.Bytes)
	}
	return total
}

// PromisedBytesFor returns how much of the volume one tree has been promised: the larger of the
// quota recorded for it and the space it already takes. A tree with no recorded quota counts the
// space it takes now, since its promise is unknown.
func PromisedBytesFor(parent, sessionID string) int64 {
	bytes, _ := lease.Usage(Root(parent, sessionID))
	return promisedBytes(parent, sessionID, bytes)
}

// promisedBytes is one tree's promise from its measured size: the larger of that size and the
// quota recorded for the tree.
func promisedBytes(parent, sessionID string, bytes int64) int64 {
	promised := bytes
	if quota, ok := RecordedQuota(parent, sessionID); ok && quota > promised {
		promised = quota
	}
	return promised
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

// Session is one session tree's measured size and last use, for reporting to the server.
type Session struct {
	ID string
	// Bytes is the space the tree's files occupy on disk, allocated blocks counted, not file sizes.
	Bytes int64
	// Entries is how many files and folders the tree holds, the tree's own root counted.
	Entries  int
	LastUsed time.Time
}

// Sessions measures every session tree under parent. The measure is the disk guard's own: allocated
// bytes, counted without following symlinks, so a link planted in a tree cannot lead the walk outside it.
func Sessions(parent string) []Session {
	dirs, err := os.ReadDir(parent)
	if err != nil {
		return nil
	}
	var out []Session
	for _, e := range dirs {
		if !e.IsDir() || !ValidSessionID(e.Name()) {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		bytes, entries := lease.Usage(Root(parent, e.Name()))
		out = append(out, Session{ID: e.Name(), Bytes: bytes, Entries: entries, LastUsed: info.ModTime()})
	}
	return out
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

// IdleSessions lists trees whose last use is before cutoff.
func IdleSessions(parent string, cutoff time.Time) []string {
	entries, err := os.ReadDir(parent)
	if err != nil {
		return nil
	}
	var ids []string
	for _, e := range entries {
		if !e.IsDir() || !ValidSessionID(e.Name()) {
			continue
		}
		if info, err := e.Info(); err == nil && info.ModTime().Before(cutoff) {
			ids = append(ids, e.Name())
		}
	}
	return ids
}

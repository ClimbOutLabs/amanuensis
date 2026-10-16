package tree

import (
	"crypto/rand"
	"encoding/hex"
	"syscall"
)

// oPath is O_PATH, which the syscall package does not export; the value is the same on amd64 and arm64.
const oPath = 0x200000

func openat(dirfd int, name string, flags int, mode uint32) (int, error) {
	return syscall.Openat(dirfd, name, flags, mode)
}

func unlinkat(dirfd int, name string) error {
	return syscall.Unlinkat(dirfd, name)
}

// lstatat returns the file type bits of name without following a final symlink.
func lstatat(dirfd int, name string) (uint32, error) {
	fd, err := syscall.Openat(dirfd, name, oPath|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if err != nil {
		return 0, err
	}
	defer syscall.Close(fd)
	var st syscall.Stat_t
	if err := syscall.Fstat(fd, &st); err != nil {
		return 0, err
	}
	return uint32(st.Mode), nil
}

func randomSuffix() string {
	var b [8]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

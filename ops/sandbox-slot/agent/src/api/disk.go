package api

import (
	"errors"

	"aman/slotagent/src/lease"
	"aman/slotagent/src/tree"
)

const (
	// guardInterval is how often a running guest's disk use is checked; fast writers overshoot by at most
	// their write rate times this.
	guardIntervalMS = 100
	// defaultMinFreeBytes is the free space a slot volume must have for a call to start at all.
	defaultMinFreeBytes = 1 << 30
	// filesystemSlackBytes lets the volume-level check tolerate other slots writing on the same disk.
	filesystemSlackBytes = 256 << 20
)

var errStorageFull = errors.New("the slot storage is almost full")

// diskWatch enforces a workspace quota while a guest runs. It checks two things: the allocated size of
// the directories the guest can write, and how much the whole volume grew, which also catches data held by
// files the guest deleted but still has open.
type diskWatch struct {
	dirs      []string
	limit     int64
	volume    string
	startUsed int64
}

func newDiskWatch(volume string, minFree, limit int64, dirs ...string) (*diskWatch, error) {
	if minFree == 0 {
		minFree = defaultMinFreeBytes
	}
	used, free, err := lease.FilesystemUsedBytes(volume)
	if err != nil {
		return nil, err
	}
	if free < minFree {
		return nil, errStorageFull
	}
	return &diskWatch{dirs: dirs, limit: limit, volume: volume, startUsed: used}, nil
}

// checkCreateRoom answers whether a new session tree with this quota may be created on the volume.
// Two things must hold. What is free now must fit the tree's whole quota plus the free-space
// reserve. And the quotas already promised to the trees on the volume, plus this quota and the
// reserve, must fit in the volume itself: a quota is a promise, and an empty tree takes almost no
// space, so counting only free space would let any number of trees be promised against the same
// bytes. Counting promises in full at creation is what keeps the reserve real once every tree has
// grown into its quota, so a chat that already holds a tree can always start its call.
func (s *Server) checkCreateRoom(quotaBytes int64) error {
	minFree := s.MinFreeBytes
	if minFree == 0 {
		minFree = defaultMinFreeBytes
	}
	_, free, err := lease.FilesystemUsedBytes(s.VolumeDir)
	if err != nil {
		return err
	}
	if free < quotaBytes+minFree {
		return errStorageFull
	}
	total := s.VolumeBytes
	if total == 0 {
		total, err = lease.FilesystemTotalBytes(s.VolumeDir)
		if err != nil {
			return err
		}
	}
	if tree.PromisedBytes(s.TreeDir)+quotaBytes+minFree > total {
		return errStorageFull
	}
	return nil
}

// checkRaiseRoom answers whether an existing tree's promise may be recorded at quotaBytes. A
// recording at or below what the volume already counts for the tree, its recorded quota or the
// space it already takes, needs no room: that space is already spoken for. A rise is new
// promise, so it takes the creation accounting with the rise in place of a whole quota: what is
// free now must fit the rise plus the reserve, and the promises counted after the rise, plus
// the reserve, must fit in the volume itself. Without this check, raising the configured quota
// would rewrite every tree's record upward unchecked, and the reserve the creation check
// protected would be promised away one call at a time.
func (s *Server) checkRaiseRoom(sessionID string, quotaBytes int64) error {
	counted := tree.PromisedBytesFor(s.TreeDir, sessionID)
	rise := quotaBytes - counted
	if rise <= 0 {
		return nil
	}
	minFree := s.MinFreeBytes
	if minFree == 0 {
		minFree = defaultMinFreeBytes
	}
	_, free, err := lease.FilesystemUsedBytes(s.VolumeDir)
	if err != nil {
		return err
	}
	if free < rise+minFree {
		return errStorageFull
	}
	total := s.VolumeBytes
	if total == 0 {
		total, err = lease.FilesystemTotalBytes(s.VolumeDir)
		if err != nil {
			return err
		}
	}
	if tree.PromisedBytes(s.TreeDir)-counted+quotaBytes+minFree > total {
		return errStorageFull
	}
	return nil
}

// guard returns the termination cause when the guest is over its limit, or an empty string.
func (d *diskWatch) guard() string {
	bytes, entries := lease.Usage(d.dirs...)
	if bytes > d.limit || entries > lease.MaxTreeEntries {
		return TermDiskExceeded
	}
	if used, _, err := lease.FilesystemUsedBytes(d.volume); err == nil && used-d.startUsed > 2*d.limit+filesystemSlackBytes {
		return TermDiskExceeded
	}
	return ""
}

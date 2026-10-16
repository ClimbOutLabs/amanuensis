package api

import (
	"errors"

	"aman/slotagent/src/lease"
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

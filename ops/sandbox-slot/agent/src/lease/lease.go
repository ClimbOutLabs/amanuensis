// Package lease owns the on-volume directories of one run_code call: staging inputs, measuring disk
// use, collecting results and removing the tree.
package lease

import (
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"syscall"
)

// Transport bounds. The server applies the model-facing policy again; these protect the slot.
const (
	MaxInputFiles     = 256
	MaxInputBytes     = 128 << 20
	MaxFileBytes      = 25 << 20
	MaxOutputFiles    = 64
	MaxOutputBytes    = 100 << 20
	MaxTreeEntries    = 100_000
	maxNameBytes      = 255
	maxHarvestWarning = 32
)

var runIDPattern = regexp.MustCompile(`^[0-9a-f]{32}$`)

// ValidRunID reports whether id is a 32-character lowercase hex run id.
func ValidRunID(id string) bool { return runIDPattern.MatchString(id) }

// ValidName reports whether name is a plain file name: no separators, no NUL, not . or ..
func ValidName(name string) bool {
	if name == "" || name == "." || name == ".." || len(name) > maxNameBytes {
		return false
	}
	for i := 0; i < len(name); i++ {
		switch name[i] {
		case '/', '\\', 0:
			return false
		}
	}
	return true
}

// Dirs are the three guest-visible directories of a lease.
type Dirs struct {
	Root    string
	Ingress string
	Scratch string
	Egress  string
}

// File is one input file.
type File struct {
	Name  string
	Bytes []byte
}

// Create makes the lease directories under parent and stages the input files read-only.
// The directories are world-accessible inside the slot volume because the guest user maps to a
// different numeric id than the agent; the volume itself is private to the slot.
func Create(parent, runID string, files []File) (Dirs, error) {
	if !ValidRunID(runID) {
		return Dirs{}, errors.New("lease: invalid run id")
	}
	if len(files) > MaxInputFiles {
		return Dirs{}, fmt.Errorf("lease: more than %d input files", MaxInputFiles)
	}
	d := Dirs{Root: filepath.Join(parent, runID)}
	d.Ingress = filepath.Join(d.Root, "ingress")
	d.Scratch = filepath.Join(d.Root, "scratch")
	d.Egress = filepath.Join(d.Root, "egress")
	if err := os.MkdirAll(parent, 0o755); err != nil {
		return Dirs{}, err
	}
	if err := os.Mkdir(d.Root, 0o755); err != nil {
		return Dirs{}, err
	}
	for _, dir := range []string{d.Ingress, d.Scratch, d.Egress} {
		if err := os.Mkdir(dir, 0o777); err != nil {
			return Dirs{}, err
		}
		if err := os.Chmod(dir, 0o777); err != nil {
			return Dirs{}, err
		}
	}
	seen := make(map[string]bool, len(files))
	var total int64
	for _, f := range files {
		if !ValidName(f.Name) {
			return Dirs{}, fmt.Errorf("lease: invalid file name %q", f.Name)
		}
		if seen[f.Name] {
			return Dirs{}, fmt.Errorf("lease: duplicate file name %q", f.Name)
		}
		seen[f.Name] = true
		if len(f.Bytes) > MaxFileBytes {
			return Dirs{}, fmt.Errorf("lease: file %q is too large", f.Name)
		}
		total += int64(len(f.Bytes))
		if total > MaxInputBytes {
			return Dirs{}, errors.New("lease: input files are too large")
		}
		if err := os.WriteFile(filepath.Join(d.Ingress, f.Name), f.Bytes, 0o444); err != nil {
			return Dirs{}, err
		}
	}
	return d, nil
}

// DecodeBase64 decodes standard base64 and rejects non-canonical input.
func DecodeBase64(s string) ([]byte, error) {
	// The decoder silently skips line breaks; canonical input has none.
	if strings.ContainsAny(s, "\r\n") {
		return nil, errors.New("lease: base64 contains line breaks")
	}
	b, err := base64.StdEncoding.Strict().DecodeString(s)
	if err != nil {
		return nil, err
	}
	return b, nil
}

// Usage returns the disk bytes actually allocated and the entry count under dirs. Allocated blocks are
// counted, not file sizes, so a sparse file is not undercounted by its holes and a write that is still
// being flushed is not missed. Symlinks are counted, never followed.
func Usage(dirs ...string) (bytes int64, entries int) {
	for _, dir := range dirs {
		_ = filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
			if err != nil {
				return nil
			}
			entries++
			if entries > MaxTreeEntries {
				return filepath.SkipAll
			}
			if d.Type().IsRegular() {
				if info, e := d.Info(); e == nil {
					bytes += allocatedBytes(info)
				}
			}
			return nil
		})
	}
	return bytes, entries
}

// allocatedBytes is the space a file occupies on disk, falling back to its size where the platform does
// not report blocks.
func allocatedBytes(info fs.FileInfo) int64 {
	if st, ok := info.Sys().(*syscall.Stat_t); ok {
		return st.Blocks * 512
	}
	return info.Size()
}

// FilesystemUsedBytes returns the bytes in use on the filesystem holding path, and how many are free.
// It sees space held by files that were deleted while a guest still has them open, which a walk cannot.
func FilesystemUsedBytes(path string) (used, free int64, err error) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return 0, 0, err
	}
	block := int64(st.Bsize)
	return (int64(st.Blocks) - int64(st.Bfree)) * block, int64(st.Bavail) * block, nil
}

// Reclaimed describes what Reclaim removed.
type Reclaimed struct {
	Files int
	Bytes int64
	// Paths are the removed files relative to the tree, largest first, at most maxReclaimedNames of them.
	Paths []string
}

const maxReclaimedNames = 8

// Notice is a sentence for the person reading the call's output, or empty when nothing was removed.
func (r Reclaimed) Notice(limitMB int) string {
	if r.Files == 0 {
		return ""
	}
	names := strings.Join(r.Paths, ", ")
	if r.Files > len(r.Paths) {
		names += fmt.Sprintf(" and %d more", r.Files-len(r.Paths))
	}
	return fmt.Sprintf("The workspace went over its %d MB limit, so %d file%s (%d MB) were deleted, largest first: %s.",
		limitMB, r.Files, plural(r.Files), r.Bytes>>20, names)
}

func plural(n int) string {
	if n == 1 {
		return ""
	}
	return "s"
}

// Reclaim deletes regular files, largest first, until the tree is within limit bytes. It runs only when
// no guest is alive.
func Reclaim(root string, limit int64) Reclaimed {
	type entry struct {
		path string
		size int64
	}
	var all []entry
	var total int64
	_ = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil || !d.Type().IsRegular() {
			return nil
		}
		if info, e := d.Info(); e == nil {
			size := allocatedBytes(info)
			total += size
			all = append(all, entry{path, size})
		}
		return nil
	})
	var out Reclaimed
	if total <= limit {
		return out
	}
	sort.Slice(all, func(i, j int) bool { return all[i].size > all[j].size })
	for _, e := range all {
		if total <= limit {
			break
		}
		if os.Remove(e.path) == nil {
			total -= e.size
			out.Files++
			out.Bytes += e.size
			if len(out.Paths) < maxReclaimedNames {
				rel, err := filepath.Rel(root, e.path)
				if err != nil {
					rel = filepath.Base(e.path)
				}
				out.Paths = append(out.Paths, rel)
			}
		}
	}
	return out
}

// Output is one collected result file.
type Output struct {
	Dir   string
	Name  string
	Bytes []byte
}

// Collect reads the top-level regular files of the egress and scratch directories. Symlinks, nested
// entries and files over the caps are skipped with a warning. Egress is listed first.
func Collect(d Dirs) ([]Output, []string) {
	var out []Output
	var warnings []string
	warn := func(format string, args ...any) {
		if len(warnings) < maxHarvestWarning {
			warnings = append(warnings, fmt.Sprintf(format, args...))
		}
	}
	var total int64
	for _, src := range []struct{ label, dir string }{{"egress", d.Egress}, {"scratch", d.Scratch}} {
		entries, err := os.ReadDir(src.dir)
		if err != nil {
			warn("could not list %s", src.label)
			continue
		}
		sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
		for _, e := range entries {
			name := e.Name()
			if e.IsDir() {
				warn("Skipped result directory %q in %s: only top-level files are collected.", name, src.label)
				continue
			}
			if !e.Type().IsRegular() {
				warn("Skipped non-regular result file %q in %s.", name, src.label)
				continue
			}
			if len(out) >= MaxOutputFiles {
				warn("Stopped collecting result files at the transport file cap.")
				return out, warnings
			}
			b, why := readRegular(filepath.Join(src.dir, name), total)
			if why != "" {
				warn("Skipped result file %q in %s: %s.", name, src.label, why)
				continue
			}
			total += int64(len(b))
			out = append(out, Output{Dir: src.label, Name: name, Bytes: b})
		}
	}
	return out, warnings
}

// readRegular reads a file without following a symlink swapped in after the listing.
func readRegular(path string, already int64) ([]byte, string) {
	f, err := os.OpenFile(path, os.O_RDONLY|noFollow, 0)
	if err != nil {
		return nil, "it could not be opened"
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return nil, "it is not a regular file"
	}
	if info.Size() > MaxFileBytes {
		return nil, "it exceeds the per-file cap"
	}
	if already+info.Size() > MaxOutputBytes {
		return nil, "it would exceed the total transport cap"
	}
	b, err := io.ReadAll(io.LimitReader(f, MaxFileBytes+1))
	if err != nil || int64(len(b)) > MaxFileBytes {
		return nil, "it could not be read"
	}
	return b, ""
}

// Remove deletes a lease tree even after the guest stripped permissions inside it.
func Remove(root string) error {
	restore(root)
	return os.RemoveAll(root)
}

func restore(path string) {
	info, err := os.Lstat(path)
	if err != nil || !info.IsDir() {
		return
	}
	_ = os.Chmod(path, info.Mode().Perm()|0o700)
	entries, err := os.ReadDir(path)
	if err != nil {
		return
	}
	for _, e := range entries {
		if e.IsDir() {
			restore(filepath.Join(path, e.Name()))
		}
	}
}

// Sweep removes every lease tree under parent, for the leftovers of a crashed agent.
func Sweep(parent string) {
	entries, err := os.ReadDir(parent)
	if err != nil {
		return
	}
	for _, e := range entries {
		_ = Remove(filepath.Join(parent, e.Name()))
	}
}

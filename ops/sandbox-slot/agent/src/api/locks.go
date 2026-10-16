package api

import (
	"net/http"
	"sync"
	"time"

	"aman/slotagent/src/tree"
)

// sessionLocks keeps two calls from working on one session tree at once: an exec, a file transfer and a
// destroy each need the tree to themselves, and a second one is told to retry.
type sessionLocks struct {
	mu   sync.Mutex
	held map[string]struct{}
}

func (l *sessionLocks) tryLock(id string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if _, busy := l.held[id]; busy {
		return false
	}
	if l.held == nil {
		l.held = map[string]struct{}{}
	}
	l.held[id] = struct{}{}
	return true
}

func (l *sessionLocks) unlock(id string) {
	l.mu.Lock()
	delete(l.held, id)
	l.mu.Unlock()
}

// lockSession takes the session's lock, or answers 429 and reports false.
func (s *Server) lockSession(w http.ResponseWriter, id string) bool {
	if s.sessions.tryLock(id) {
		return true
	}
	writeError(w, http.StatusTooManyRequests, ErrBusy, "this session is in use by another call")
	return false
}

// SweepIdleSessions removes trees unused for ttl, for sessions the server never got to delete. It skips
// the pass while a lease runs and any tree that is in use.
func (s *Server) SweepIdleSessions(ttl time.Duration) int {
	s.init()
	select {
	case s.sem <- struct{}{}:
		defer func() { <-s.sem }()
	default:
		return 0
	}
	removed := 0
	for _, id := range tree.IdleSessions(s.TreeDir, time.Now().Add(-ttl)) {
		if !s.sessions.tryLock(id) {
			continue
		}
		if tree.Destroy(s.TreeDir, id) == nil {
			removed++
		}
		s.sessions.unlock(id)
	}
	return removed
}

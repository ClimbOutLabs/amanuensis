package api

import (
	"net/http"
	"sync"
	"time"

	"aman/slotagent/src/tree"
)

// defaultSessionsMaxAge is how long the sessions listing is served from the last walk before the
// trees are walked again. Walking every tree on every call would make a cheap question expensive
// on a slot holding many trees.
const defaultSessionsMaxAge = 30 * time.Second

// sessionsCache holds the last walk of the session trees.
type sessionsCache struct {
	mu     sync.Mutex
	walked time.Time
	list   []tree.Session
}

// sessionStats returns the latest walk of the session trees, walking again when the cached one is
// older than the server's limit. A walk tolerates trees changing under it; a listing may be one
// walk old, which is close enough for reporting who holds what.
func (s *Server) sessionStats() []tree.Session {
	maxAge := s.SessionsMaxAge
	if maxAge <= 0 {
		maxAge = defaultSessionsMaxAge
	}
	s.stats.mu.Lock()
	defer s.stats.mu.Unlock()
	if !s.stats.walked.IsZero() && time.Since(s.stats.walked) < maxAge {
		return s.stats.list
	}
	list := tree.Sessions(s.TreeDir)
	s.stats.list = list
	s.stats.walked = time.Now()
	return list
}

type sessionInfo struct {
	SessionID string `json:"session_id"`
	Bytes     int64  `json:"bytes"`
	Entries   int    `json:"entries"`
	LastUsed  string `json:"last_used"`
}

type sessionsResponse struct {
	Sessions []sessionInfo `json:"sessions"`
}

// sessionsList answers GET /v1/sessions: one entry per session tree this slot holds, with the
// space it takes. It never waits behind a running call: the answer comes from a cached walk,
// and the walk itself only reads.
func (s *Server) sessionsList(w http.ResponseWriter, _ *http.Request) {
	stats := s.sessionStats()
	resp := sessionsResponse{Sessions: make([]sessionInfo, 0, len(stats))}
	for _, st := range stats {
		resp.Sessions = append(resp.Sessions, sessionInfo{
			SessionID: st.ID,
			Bytes:     st.Bytes,
			Entries:   st.Entries,
			LastUsed:  st.LastUsed.UTC().Format(time.RFC3339),
		})
	}
	writeJSON(w, http.StatusOK, resp)
}

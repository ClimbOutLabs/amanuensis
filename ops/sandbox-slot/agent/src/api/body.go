package api

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
)

// Body limits per endpoint, so a small call cannot make the agent buffer a large one.
const (
	// runCodeBodyBytes holds the largest input set (128 MiB) as base64 plus the envelope.
	runCodeBodyBytes = 192 << 20
	// fsWriteBodyBytes holds the largest transfer file (128 MiB) as base64 plus the envelope.
	fsWriteBodyBytes = (128<<20)/3*4 + 64<<10
	execBodyBytes    = 4 << 20
	smallBodyBytes   = 64 << 10
)

// decodeStrict reads at most limit bytes and decodes exactly one JSON object: no unknown fields, no
// duplicate keys (the last one would silently win), and nothing after it.
func decodeStrict(r *http.Request, w http.ResponseWriter, dst any, limit int64) error {
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, limit))
	if err != nil {
		return err
	}
	if err := rejectDuplicateKeys(raw); err != nil {
		return err
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		return err
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return errors.New("trailing data after the JSON body")
	}
	return nil
}

// rejectDuplicateKeys scans the bytes without building values, so a large base64 string costs no copy.
// Malformed JSON is left to the decoder to report.
func rejectDuplicateKeys(b []byte) error {
	// A nil entry is an array; a map is an object with the keys seen so far.
	var stack []map[string]struct{}
	expectKey := false
	for i := 0; i < len(b); i++ {
		switch c := b[i]; c {
		case '{':
			stack = append(stack, map[string]struct{}{})
			expectKey = true
		case '[':
			stack = append(stack, nil)
			expectKey = false
		case '}', ']':
			if len(stack) > 0 {
				stack = stack[:len(stack)-1]
			}
			expectKey = false
		case ',':
			expectKey = len(stack) > 0 && stack[len(stack)-1] != nil
		case '"':
			end := i + 1
			for end < len(b) && b[end] != '"' {
				if b[end] == '\\' {
					end++
				}
				end++
			}
			if end >= len(b) {
				return nil
			}
			if expectKey {
				var key string
				if err := json.Unmarshal(b[i:end+1], &key); err != nil {
					return nil
				}
				seen := stack[len(stack)-1]
				if _, dup := seen[key]; dup {
					return fmt.Errorf("duplicate key %q", key)
				}
				seen[key] = struct{}{}
				expectKey = false
			}
			i = end
		}
	}
	return nil
}

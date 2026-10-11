package api

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"time"
)

// Probe asks a running agent for its attestation over its socket and reports whether it passed. It is
// what the container health check runs.
func Probe(socket string) error {
	client := &http.Client{
		Timeout: 90 * time.Second,
		Transport: &http.Transport{
			DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
				var d net.Dialer
				return d.DialContext(ctx, "unix", socket)
			},
		},
	}
	resp, err := client.Get("http://agent/v1/health")
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	var body healthResponse
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return err
	}
	if !body.Attestation.OK {
		return errors.New("attestation failed: " + failedChecks(body.Attestation))
	}
	return nil
}

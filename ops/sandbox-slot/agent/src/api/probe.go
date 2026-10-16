package api

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"time"

	"aman/slotagent/src/attest"
)

// Probe asks a running agent for its attestation over its socket. The report is returned even when it
// failed, so the container health check can print every check; the error says whether it passed.
func Probe(socket string) (attest.Report, error) {
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
		return attest.Report{}, err
	}
	defer resp.Body.Close()
	var body healthResponse
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return attest.Report{}, err
	}
	if !body.Attestation.OK {
		return body.Attestation, errors.New("attestation failed: " + failedChecks(body.Attestation))
	}
	return body.Attestation, nil
}

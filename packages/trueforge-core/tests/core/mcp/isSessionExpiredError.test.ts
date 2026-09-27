import { isSessionExpiredError } from '../../../src/core/mcp/remoteMcpClient';

// The exact rejection the gmail MCP server produces after a restart wipes its in-memory session
// table while the client still resumes the previous turn's session id (incident 2026-09-21).
const STALE_SESSION_REJECTION =
  'Streamable HTTP error: Error POSTing to endpoint: {"jsonrpc":"2.0","error":{"code":-32000,"message":"Bad Request: Server not initialized"},"id":null}';

describe('isSessionExpiredError', () => {
  describe('stale-session rejection after a server restart', () => {
    it('matches the exact -32000 "not initialized" rejection', () => {
      expect(isSessionExpiredError(new Error(STALE_SESSION_REJECTION))).toBe(true);
    });

    it('tolerates whitespace around the -32000 code', () => {
      const msg =
        'Streamable HTTP error: Error POSTing to endpoint: {"jsonrpc": "2.0", "error": {"code": -32000, "message": "server not initialized"}, "id": null}';
      expect(isSessionExpiredError(new Error(msg))).toBe(true);
    });

    it('is case-insensitive on the "not initialized" text', () => {
      const msg = '{"error": {"code": -32000, "message": "SERVER NOT INITIALIZED"}}';
      expect(isSessionExpiredError(new Error(msg))).toBe(true);
    });
  });

  describe('keeps the pre-existing session-expiry signals', () => {
    it('matches a numeric 404 error code', () => {
      const err = new Error('gone') as Error & { code: number };
      err.code = 404;
      expect(isSessionExpiredError(err)).toBe(true);
    });

    it('matches "HTTP 404" in the message', () => {
      expect(isSessionExpiredError(new Error('HTTP 404 session not found'))).toBe(true);
    });

    it('matches a message mentioning "session"', () => {
      expect(isSessionExpiredError(new Error('session expired or revoked'))).toBe(true);
    });
  });

  describe('does NOT misclassify genuine errors as session-expired', () => {
    it('rejects auth failures', () => {
      expect(isSessionExpiredError(new Error('HTTP 401 Unauthorized'))).toBe(false);
      const err = new Error('nope') as Error & { code: number };
      err.code = 401;
      expect(isSessionExpiredError(err)).toBe(false);
    });

    it('rejects server 500s', () => {
      expect(isSessionExpiredError(new Error('HTTP 500 Internal Server Error'))).toBe(false);
    });

    it('rejects malformed/unrelated errors', () => {
      expect(isSessionExpiredError(new Error('totally unrelated transport hiccup'))).toBe(false);
    });

    it('rejects -32000 with a different message (application-defined server error)', () => {
      const msg =
        'Streamable HTTP error: Error POSTing to endpoint: {"jsonrpc":"2.0","error":{"code":-32000,"message":"tool exploded"},"id":null}';
      expect(isSessionExpiredError(new Error(msg))).toBe(false);
    });

    it('rejects "not initialized" without the -32000 code', () => {
      expect(isSessionExpiredError(new Error('Error: transport not initialized'))).toBe(false);
    });

    it('rejects -32000 lookalike codes such as -320001', () => {
      const msg = '{"error": {"code": -320001, "message": "not initialized"}}';
      expect(isSessionExpiredError(new Error(msg))).toBe(false);
    });

    it('rejects non-Error values', () => {
      expect(isSessionExpiredError(null)).toBe(false);
      expect(isSessionExpiredError(undefined)).toBe(false);
      expect(isSessionExpiredError(STALE_SESSION_REJECTION)).toBe(false);
      expect(isSessionExpiredError({ message: STALE_SESSION_REJECTION })).toBe(false);
    });
  });
});

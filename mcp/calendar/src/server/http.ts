// SPDX-License-Identifier: Apache-2.0
// Copyright (c) ClimbOutLabs contributors.
// HTTP transport for the calendar MCP server.
//
// Wraps per-session MCP `Server` instances in a Node http.Server using the
// SDK's StreamableHTTPServerTransport. Bearer-token auth on /mcp; /health is
// open so reverse-proxy probes work without credentials.
//
// Authentication: the MCP client (e.g. TrueForge) completes Google OAuth on the
// user's behalf, stores the tokens, and forwards the Google access token as the
// HTTP bearer token (`Authorization: Bearer <token>`). The server validates that
// token against Google's tokeninfo endpoint, derives the granted scopes, and
// enforces them per tool. The server holds no Google credentials of its own in
// HTTP mode; local OAuth credentials are only used by the stdio transport.
//
// The server also publishes OAuth protected-resource metadata at
// `/.well-known/oauth-protected-resource` (RFC 9728) so the client can discover
// the authorization server and supported scopes.
//
// Per-session Server + Transport: each MCP session gets its own isolated
// Server/Transport pair (built via buildMcpServer()), so concurrent sessions
// never hit the "Server already initialized" failure. Sessions are tracked
// in a map keyed by the `mcp-session-id` the transport mints during
// initialize, and are reaped by idle TTL, an oldest-idle cap, and explicit
// DELETE termination so the map cannot grow without bound. If the bearer token
// changes on an existing session (e.g. the client refreshed it), the session
// pair is rebuilt so calls use the current token and scopes.

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import http from "node:http";
import { OAuth2Client } from "google-auth-library";
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { type ServerContext, buildMcpServer } from "./build.js";
import { SCOPE_MAP, scopeUrlToName } from "../core/scopes.js";
import { validateGoogleToken } from "../core/token-validation.js";

export interface HttpServerOptions {
  port: number;
  bind: string;
  /**
   * Public URL of this MCP endpoint (e.g. https://host/mcp), used as the
   * `resource` identifier in the protected-resource metadata. When omitted,
   * it is derived from the request Host header and the configured bind/port.
   */
  resourceUrl?: string;
  log?: (line: string) => void;
  // Idle session TTL in ms. Sessions with no activity for longer than this
  // are closed by the background sweeper. Defaults to 30 minutes.
  // Values <= 0 disable TTL eviction.
  sessionIdleTtlMs?: number;
  // How often the idle-session sweeper runs, in ms. Defaults to 5 minutes.
  sessionSweepIntervalMs?: number;
  // Maximum live sessions. When exceeded, the oldest-idle session is evicted
  // before a new pair is allocated. Defaults to 100. Values <= 0 mean no cap.
  maxSessions?: number;
}

export interface HttpServerHandle {
  close(): Promise<void>;
  port: number;
  url: string;
  /** Current number of live MCP sessions. Useful for observability and tests. */
  getSessionCount(): number;
}

const MAX_BODY_BYTES = 4 * 1024 * 1024; // 4 MB - generous for any MCP payload

const DEFAULT_SESSION_IDLE_TTL_MS = 30 * 60 * 1000;
const DEFAULT_SESSION_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_SESSIONS = 100;

interface SessionEntry {
  server: InstanceType<typeof McpServer>;
  transport: StreamableHTTPServerTransport;
  /** SHA-256 of the bearer token this session was built with. The token itself is never stored. */
  tokenHash: string;
  lastActivityMs: number;
}

/** True only for /mcp itself (with optional trailing path or query). */
function isMcpPath(url: string): boolean {
  return url === "/mcp" || url.startsWith("/mcp/") || url.startsWith("/mcp?");
}

/** SHA-256 hash of a bearer token, used to detect token changes. */
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Constant-time hash comparison to avoid leaking which bytes differ. */
function hashEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

/** Extract the bearer token from the Authorization header, or "" when absent/malformed. */
function bearerToken(req: http.IncomingMessage): string {
  const authHeader = (req.headers.authorization ?? "").trim();
  const match = /^Bearer\s+(\S+)$/i.exec(authHeader);
  return match ? (match[1] as string) : "";
}

/** Build a ServerContext for one HTTP session: the forwarded Google token plus its granted scopes. */
function sessionContext(token: string, scopes: string[]): ServerContext {
  const auth = new OAuth2Client();
  auth.setCredentials({ access_token: token });
  return { auth, scopes };
}

export async function startHttpServer(opts: HttpServerOptions): Promise<HttpServerHandle> {
  const log = opts.log ?? ((line: string) => process.stderr.write(`${line}\n`));

  const idleTtlMs = opts.sessionIdleTtlMs ?? DEFAULT_SESSION_IDLE_TTL_MS;
  const sweepIntervalMs = opts.sessionSweepIntervalMs ?? DEFAULT_SESSION_SWEEP_INTERVAL_MS;
  const maxSessions = opts.maxSessions ?? DEFAULT_MAX_SESSIONS;

  const sessions = new Map<string, SessionEntry>();

  const closeQuietly = async (transport: StreamableHTTPServerTransport): Promise<void> => {
    try {
      await transport.close();
    } catch (err) {
      log(`session_close_error: ${(err as Error).message}`);
    }
  };

  const terminateSession = async (sessionId: string): Promise<void> => {
    const entry = sessions.get(sessionId);
    if (!entry) return;
    sessions.delete(sessionId);
    await closeQuietly(entry.transport);
  };

  const sweepIdleSessions = async (): Promise<void> => {
    if (idleTtlMs <= 0) return;
    const now = Date.now();
    for (const [id, entry] of sessions) {
      if (now - entry.lastActivityMs > idleTtlMs) {
        log(`session_expire: idle session reaped (ttl=${idleTtlMs}ms)`);
        await terminateSession(id);
      }
    }
  };

  const evictOldestIdle = async (): Promise<void> => {
    let oldestId: string | undefined;
    let oldestActivity = Number.POSITIVE_INFINITY;
    for (const [id, entry] of sessions) {
      if (entry.lastActivityMs < oldestActivity) {
        oldestActivity = entry.lastActivityMs;
        oldestId = id;
      }
    }
    if (oldestId !== undefined) {
      log(`session_evict: at cap (${maxSessions}), evicting oldest idle session`);
      await terminateSession(oldestId);
    }
  };

  /** Allocate a fresh session pair bound to this bearer token and scopes. */
  const createSession = async (token: string, scopes: string[]): Promise<SessionEntry> => {
    if (maxSessions > 0 && sessions.size >= maxSessions) {
      await evictOldestIdle();
    }
    const server = buildMcpServer(sessionContext(token, scopes));
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });
    await server.connect(transport);
    return { server, transport, tokenHash: hashToken(token), lastActivityMs: Date.now() };
  };

  // Background reaper for idle sessions. unref'd so it never holds the
  // process open on its own (matters for tests and embedding hosts).
  const sweeper = setInterval(() => {
    void sweepIdleSessions().catch((err: unknown) => {
      log(`session_sweep_error: ${err instanceof Error ? err.message : String(err)}`);
    });
  }, sweepIntervalMs);
  sweeper.unref();

  // Set once close() begins; new requests are rejected with 503 so no new
  // sessions are created while transports are being torn down.
  let closing = false;

  const deriveResourceUrl = (req: http.IncomingMessage, actualPort: number): string => {
    if (opts.resourceUrl) return opts.resourceUrl;
    const proto =
      ((req.headers["x-forwarded-proto"] as string) ?? "http").split(",")[0]?.trim() || "http";
    const host = req.headers.host ?? `${opts.bind}:${actualPort}`;
    return `${proto}://${host}/mcp`;
  };

  const onRequest = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    try {
      const url = req.url ?? "/";
      const method = req.method ?? "GET";

      if (closing) {
        res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
        res.end("Server is shutting down.");
        return;
      }

      if (method === "GET" && (url === "/health" || url.startsWith("/health?"))) {
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ status: "ok", service: "calendar-mcp", sessions: sessions.size }));
        return;
      }

      // OAuth protected-resource metadata (RFC 9728). No auth: this is how the
      // MCP client learns where to send the user for authorization.
      if (method === "GET" && (url === "/.well-known/oauth-protected-resource" || url.startsWith("/.well-known/oauth-protected-resource?"))) {
        const addr = httpServer.address();
        const actualPort = typeof addr === "object" && addr ? addr.port : opts.port;
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(
          JSON.stringify({
            resource: deriveResourceUrl(req, actualPort),
            authorization_servers: ["https://accounts.google.com"],
            scopes_supported: Object.values(SCOPE_MAP),
            bearer_methods_supported: ["header"],
          }),
        );
        return;
      }

      if (!isMcpPath(url)) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("Not found. Use POST /mcp for MCP requests, GET /health for status.");
        return;
      }

      // Bearer auth: the forwarded Google access token. Validated against
      // Google's tokeninfo endpoint on every /mcp request (cached by token hash).
      const token = bearerToken(req);
      if (!token) {
        res.writeHead(401, {
          "content-type": "text/plain; charset=utf-8",
          "www-authenticate": 'Bearer realm="calendar-mcp", error="invalid_request", error_description="Authorization: Bearer <Google access token> required"',
        });
        res.end("Unauthorized. Provide the Google OAuth access token as Authorization: Bearer <token>.");
        return;
      }
      let scopes: string[];
      try {
        const validated = await validateGoogleToken(token);
        scopes = validated.scopes.map(scopeUrlToName);
      } catch (err) {
        res.writeHead(401, {
          "content-type": "text/plain; charset=utf-8",
          "www-authenticate": 'Bearer realm="calendar-mcp", error="invalid_token"',
        });
        res.end(`Unauthorized. ${(err as Error).message}`);
        return;
      }

      const sessionId = req.headers["mcp-session-id"] as string | undefined;

      // MCP session termination: DELETE with a session id tears the pair down.
      if (method === "DELETE") {
        const sid = req.headers["mcp-session-id"] as string | undefined;
        const doomed = sid ? sessions.get(sid) : undefined;
        if (!sid || !doomed) {
          res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
          res.end("Unknown or expired session.");
          return;
        }
        try {
          await doomed.transport.handleRequest(req, res);
        } finally {
          await terminateSession(sid);
        }
        return;
      }

      // Read body (POST) or pass through (GET - Streamable HTTP allows GET for SSE).
      let body: unknown;
      if (method === "POST") {
        body = await readJsonBody(req);
      }

      let entry = sessionId ? sessions.get(sessionId) : undefined;
      const isNewPair = !entry;
      if (entry) {
        // Mark activity at request START, not just when the request
        // completes - long-running requests must not be reaped by the idle
        // sweeper mid-flight.
        entry.lastActivityMs = Date.now();
        // The bearer token may have been refreshed since the session started.
        // Rebuild the pair so calls use the current token and scopes.
        if (!hashEquals(entry.tokenHash, hashToken(token))) {
          log("session_rebuild: bearer token changed, rebuilding session");
          await terminateSession(sessionId as string);
          entry = undefined;
        }
      }
      if (!entry) {
        entry = await createSession(token, scopes);
      }
      const activeEntry = entry;
      try {
        await activeEntry.transport.handleRequest(req, res, body);
      } finally {
        const assignedId = activeEntry.transport.sessionId;
        if (assignedId) {
          const existing = sessions.get(assignedId);
          if (existing) {
            existing.lastActivityMs = Date.now();
          } else {
            activeEntry.lastActivityMs = Date.now();
            sessions.set(assignedId, activeEntry);
          }
        } else if (isNewPair) {
          // Not an initialize (or initialize failed): this pair can never be
          // addressed again - close it now instead of leaking it.
          await closeQuietly(activeEntry.transport);
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Detailed diagnostics stay server-side; the wire response is generic
      // so internal paths / tokens never leak to the HTTP client.
      log(`http_error: ${message}`);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
        res.end("Internal server error.");
      } else {
        try {
          res.end();
        } catch {
          /* swallow */
        }
      }
    }
  };
  const httpServer = http.createServer((req, res) => {
    void onRequest(req, res);
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(opts.port, opts.bind, () => {
      httpServer.off("error", reject);
      resolve();
    });
  });

  const addr = httpServer.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : opts.port;
  const url = `http://${opts.bind}:${actualPort}`;
  log(`calendar-mcp HTTP server listening on ${url}`);
  log(`  POST ${url}/mcp     - MCP Streamable HTTP (Authorization: Bearer <Google access token> required)`);
  log(`  GET  ${url}/health  - health snapshot (no auth)`);
  log(`  GET  ${url}/.well-known/oauth-protected-resource - OAuth metadata (no auth)`);

  return {
    port: actualPort,
    url,
    getSessionCount: () => sessions.size,
    async close() {
      closing = true;
      clearInterval(sweeper);
      // Transports (MCP sessions) BEFORE the HTTP server: closing each
      // session transport cancels in-flight tool work and ends open SSE
      // streams. If the socket closed first, httpServer.close() would wait
      // on those long-lived keep-alive/SSE connections.
      for (const id of [...sessions.keys()]) {
        await terminateSession(id);
      }
      await new Promise<void>((resolve) =>
        httpServer.close(() => {
          resolve();
        }),
      );
    },
  };
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error(`Request body exceeds ${MAX_BODY_BYTES} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) {
        resolve(undefined);
        return;
      }
      const raw = Buffer.concat(chunks).toString("utf8");
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error(`Invalid JSON body: ${(err as Error).message}`));
      }
    });
    req.on("error", reject);
  });
}

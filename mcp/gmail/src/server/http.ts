// HTTP transport for Gmail-MCP-Server (Phase G).
//
// Wraps a configured MCP `Server` instance in a Node http.Server using the
// SDK's StreamableHTTPServerTransport. Bearer-token auth on /mcp; /health is
// open so reverse-proxy probes work without credentials.
//
// Single-tenant by design: one server process = one Gmail account, with
// credentials loaded once at startup via the standard chain
// (GMAIL_CREDENTIALS_JSON / GMAIL_CREDENTIALS_OP / file). Multi-tenant is a
// future Phase G2 if a real use case appears.
//
// TLS is delegated to a reverse proxy (Caddy / nginx / Cloudflare Tunnel /
// Cloud Run). The bind default is 127.0.0.1 so direct Internet exposure
// requires an explicit `--bind 0.0.0.0`.
//
// Per-session Server + Transport: each MCP session gets its own isolated
// Server/Transport pair (built via buildMcpServer()), which fixes the
// "Server already initialized" failure the old single shared transport hit
// on concurrent sessions. Sessions are tracked in a map keyed by the
// `mcp-session-id` the transport mints during initialize, and are reaped by
// idle TTL, an oldest-idle cap, and explicit DELETE termination so the map
// cannot grow without bound.

import { randomUUID } from "node:crypto";
import http from "node:http";
import { formatHealthText, readWatchdogState, snapshotHealth } from "@george43g/robustness";
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildMcpServer } from "./build.js";

export interface HttpServerOptions {
  port: number;
  bind: string;
  // Env var name to read the bearer token from. Server refuses to start if
  // the named env var is unset/empty.
  tokenEnv: string;
  // Counters for /health output.
  getCounters: () => { toolCalls: number; recentErrors: number };
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
  // MCP tool-name prefix applied to the per-session server (mirrors the
  // stdio transport's --tool-prefix / GMAIL_MCP_TOOL_PREFIX handling).
  toolPrefix?: string;
}

export interface HttpServerHandle {
  close(): Promise<void>;
  port: number;
  url: string;
  /** Current number of live MCP sessions. Useful for observability and tests. */
  getSessionCount(): number;
}

const MAX_BODY_BYTES = 4 * 1024 * 1024; // 4 MB — generous for any MCP payload

const DEFAULT_SESSION_IDLE_TTL_MS = 30 * 60 * 1000;
const DEFAULT_SESSION_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_SESSIONS = 100;

interface SessionEntry {
  server: InstanceType<typeof McpServer>;
  transport: StreamableHTTPServerTransport;
  lastActivityMs: number;
}

/** True only for /mcp itself (with optional trailing path or query). */
function isMcpPath(url: string): boolean {
  return url === "/mcp" || url.startsWith("/mcp/") || url.startsWith("/mcp?");
}

export async function startHttpServer(opts: HttpServerOptions): Promise<HttpServerHandle> {
  const log = opts.log ?? ((line: string) => process.stderr.write(`${line}\n`));

  const expectedToken = process.env[opts.tokenEnv];
  if (!expectedToken || expectedToken.trim().length === 0) {
    throw new Error(
      `HTTP mode requires ${opts.tokenEnv} to be set to a non-empty bearer token. ` +
        `Generate one with: openssl rand -hex 32`,
    );
  }

  const idleTtlMs = opts.sessionIdleTtlMs ?? DEFAULT_SESSION_IDLE_TTL_MS;
  const sweepIntervalMs = opts.sessionSweepIntervalMs ?? DEFAULT_SESSION_SWEEP_INTERVAL_MS;
  const maxSessions = opts.maxSessions ?? DEFAULT_MAX_SESSIONS;

  // Stateful transport: server hands out a session ID on initialize; clients
  // include it in `mcp-session-id` on subsequent requests. Required because
  // MCP semantics depend on initialize→tools/list→tools/call sharing state
  // (capabilities, AbortSignal plumbing). Stateless mode (sessionIdGenerator
  // undefined) loses initialize state between requests.
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
        const snap = snapshotHealth(opts.getCounters(), readWatchdogState());
        res.writeHead(snap.status === "unhealthy" ? 503 : 200, {
          "content-type": "text/plain; charset=utf-8",
        });
        res.end(formatHealthText(snap));
        return;
      }

      if (!isMcpPath(url)) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("Not found. Use POST /mcp for MCP requests, GET /health for status.");
        return;
      }

      // Bearer auth — required for every /mcp request.
      const authHeader = (req.headers.authorization ?? "").trim();
      const provided = authHeader.startsWith("Bearer ")
        ? authHeader.slice("Bearer ".length).trim()
        : "";
      if (!provided || !timingSafeEqual(provided, expectedToken)) {
        res.writeHead(401, {
          "content-type": "text/plain; charset=utf-8",
          "www-authenticate": 'Bearer realm="gmail-mcp"',
        });
        res.end("Unauthorized. Provide an Authorization: Bearer <token> header.");
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
          // Let the transport run its termination protocol and respond.
          await doomed.transport.handleRequest(req, res);
        } finally {
          await terminateSession(sid);
        }
        return;
      }

      // Read body (POST) or pass through (GET — Streamable HTTP allows GET for SSE).
      let body: unknown;
      if (method === "POST") {
        body = await readJsonBody(req);
      }

      let entry = sessionId ? sessions.get(sessionId) : undefined;
      const isNewPair = !entry;
      if (entry) {
        // Mark activity at request START, not just when the request
        // completes — long-running requests (tool calls with big fan-outs,
        // open SSE streams) must not be reaped by the idle sweeper
        // mid-flight.
        entry.lastActivityMs = Date.now();
      }
      if (!entry) {
        if (maxSessions > 0 && sessions.size >= maxSessions) {
          await evictOldestIdle();
        }
        const { server } = buildMcpServer({ toolPrefix: opts.toolPrefix ?? "" });
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
        });
        await server.connect(transport);
        entry = { server, transport, lastActivityMs: Date.now() };
        // Session ID is assigned during initialize; stored after handleRequest
        // below, once the transport has minted it.
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
          // addressed again — close it now instead of leaking it.
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
  log(`gmail-mcp HTTP server listening on ${url}`);
  log(`  POST ${url}/mcp     — MCP Streamable HTTP (Authorization: Bearer required)`);
  log(`  GET  ${url}/health  — health snapshot (no auth)`);

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

/**
 * Constant-time string comparison to prevent timing attacks on the bearer
 * token check. node:crypto.timingSafeEqual requires equal-length Buffers, so
 * we wrap that handling here.
 */
function timingSafeEqual(a: string, b: string): boolean {
  // Quick length check is fine — leaking length of the secret is acceptable.
  if (a.length !== b.length) return false;
  // node:crypto could be used; for simplicity in the hot path do a manual
  // constant-time compare. Loop runs in O(len) regardless of mismatch position.
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
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

// HTTP transport tests for src/server/http.ts.
//
// Covers gap items 12.9 (startHttpServer refuses to start without a token —
// SECURITY-relevant), 12.10 (/health 200 vs 503 branches), 12.13
// (timingSafeEqual constant-time correctness), and 12.14 (readJsonBody body
// cap + invalid-JSON rejection), plus the fork's per-session Server+Transport
// isolation (two concurrent initializes, session routing, DELETE termination,
// idle TTL eviction, session cap, orphan-pair cleanup). All HTTP exchanges use
// an ephemeral port (`port: 0`) so suites can run in parallel without
// collisions.

import http from "node:http";
import type { WatchdogState } from "@george43g/robustness";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type HttpServerHandle, startHttpServer } from "./http.js";

// Partial barrel mock: the /health route passes readWatchdogState() into the
// REAL snapshotHealth (injectable-state param, robustness 0.10.0), so tests
// drive the actual status ladder by mutating this synthetic state.
const mockState = vi.hoisted(
  (): WatchdogState => ({
    startedAt: Date.now(),
    eventLoopP99Ms: 0,
    eventLoopMaxMs: 0,
    eventLoopSustainedCount: 0,
    lastEventLoopSampleTs: Date.now(),
    rssMb: 0,
    heapMb: 0,
    heapHistory: [],
    lastActivityTs: Date.now(),
    killReason: null,
    memorySampled: false,
  }),
);

vi.mock("@george43g/robustness", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@george43g/robustness")>()),
  readWatchdogState: () => mockState,
}));

const TOKEN_ENV = "GMAIL_HTTP_TEST_TOKEN";
const TEST_TOKEN = "test-secret-do-not-share";

interface FetchResult {
  status: number;
  body: string;
  headers: Record<string, string>;
}

function requestHttp(
  port: number,
  method: string,
  path: string,
  opts: { headers?: Record<string, string>; body?: string } = {},
): Promise<FetchResult> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        headers: opts.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            if (typeof v === "string") headers[k] = v;
            else if (Array.isArray(v)) headers[k] = v.join(",");
          }
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
            headers,
          });
        });
      },
    );
    req.on("error", reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

function startTestServer(
  overrides: Partial<Parameters<typeof startHttpServer>[0]> = {},
): Promise<HttpServerHandle> {
  return startHttpServer({
    port: 0,
    bind: "127.0.0.1",
    tokenEnv: TOKEN_ENV,
    getCounters: () => ({ toolCalls: 0, recentErrors: 0 }),
    log: () => {},
    ...overrides,
  });
}

const initBody = (id: number): string =>
  JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "gmail-mcp-test", version: "0.0.0" },
    },
  });

const toolsListBody = (id: number): string =>
  JSON.stringify({ jsonrpc: "2.0", id, method: "tools/list", params: {} });

function mcpPost(port: number, body: string, sessionId?: string): Promise<FetchResult> {
  return requestHttp(port, "POST", "/mcp", {
    headers: {
      Authorization: `Bearer ${TEST_TOKEN}`,
      "content-type": "application/json",
      // Streamable HTTP requires both content types or the SDK answers 406.
      accept: "application/json, text/event-stream",
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body,
  });
}

function mcpDelete(port: number, sessionId: string): Promise<FetchResult> {
  return requestHttp(port, "DELETE", "/mcp", {
    headers: {
      Authorization: `Bearer ${TEST_TOKEN}`,
      "mcp-session-id": sessionId,
    },
  });
}

let handle: HttpServerHandle | undefined;

beforeEach(() => {
  mockState.killReason = null;
  mockState.eventLoopP99Ms = 0;
  process.env[TOKEN_ENV] = TEST_TOKEN;
});

afterEach(async () => {
  if (handle) {
    await handle.close();
    handle = undefined;
  }
  delete process.env[TOKEN_ENV];
  mockState.killReason = null;
});

describe("startHttpServer token requirement (12.9 — SECURITY)", () => {
  it("throws synchronously when the token env var is unset", async () => {
    delete process.env[TOKEN_ENV];
    await expect(
      startTestServer(),
    ).rejects.toThrow(/HTTP mode requires .* bearer token/);
  });

  it("throws when the token env var is set to whitespace only", async () => {
    process.env[TOKEN_ENV] = "   \t  ";
    await expect(
      startTestServer(),
    ).rejects.toThrow(/non-empty bearer token/);
  });
});

describe("/health endpoint (12.10)", () => {
  it("returns 200 when the watchdog reports healthy", async () => {
    handle = await startTestServer({
      getCounters: () => ({ toolCalls: 7, recentErrors: 0 }),
    });

    const res = await requestHttp(handle.port, "GET", "/health");
    expect(res.status).toBe(200);
    expect(res.body).toMatch(/Status: healthy/);
    expect(res.body).toContain("Tool calls: 7");
  });

  it("returns 503 when the watchdog has recorded a kill reason (unhealthy branch)", async () => {
    handle = await startTestServer();

    // Drive the unhealthy branch in the real snapshotHealth: any non-null
    // killReason forces status="unhealthy", which the HTTP layer maps to 503.
    mockState.killReason = "test_forced_kill";

    const res = await requestHttp(handle.port, "GET", "/health");
    expect(res.status).toBe(503);
    expect(res.body).toMatch(/Status: unhealthy/);
    expect(res.body).toContain("test_forced_kill");
  });
});

describe("/mcp bearer auth + readJsonBody (12.13 / 12.14)", () => {
  it("rejects oversized POST bodies before they reach the transport (12.14)", async () => {
    handle = await startTestServer();

    // 4 MB + 1 byte triggers the body cap in readJsonBody. The server
    // destroys the incoming request as soon as the cap is exceeded — the
    // client sees a socket hang-up rather than a clean 500, which is the
    // intended behaviour (do not echo arbitrary-size error bodies back).
    const huge = "a".repeat(4 * 1024 * 1024 + 1);
    let observed: { status: number; body: string } | Error;
    try {
      observed = await requestHttp(handle.port, "POST", "/mcp", {
        headers: {
          Authorization: `Bearer ${TEST_TOKEN}`,
          "content-type": "application/json",
          "content-length": String(huge.length),
        },
        body: huge,
      });
    } catch (err) {
      observed = err as Error;
    }

    if (observed instanceof Error) {
      // Socket-hang-up path — the most common outcome.
      expect(observed.message.toLowerCase()).toMatch(/socket|hang|econn|epipe|reset/);
    } else {
      // If the server raced and managed to write a 500 first, the body is
      // still the generic one — the byte-limit detail stays server-side.
      expect(observed.status).toBe(500);
      expect(observed.body).toBe("Internal server error.");
    }
  });

  it("rejects invalid JSON body with 500 (12.14)", async () => {
    handle = await startTestServer();

    const res = await requestHttp(handle.port, "POST", "/mcp", {
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        "content-type": "application/json",
      },
      body: "{not json at all",
    });

    expect(res.status).toBe(500);
    // Security L4: the wire body is generic — the parse detail stays in
    // server logs and never reaches the client.
    expect(res.body).toBe("Internal server error.");
  });

  it("rejects bearer tokens that differ only by one byte (12.13 constant-time compare)", async () => {
    handle = await startTestServer();

    // Same length as TEST_TOKEN, differs only in the final byte. timingSafeEqual
    // loops the full length regardless of mismatch position; what we assert
    // here is that the comparison is BYTE-EXACT (no prefix match, no slack).
    const wrong = `${TEST_TOKEN.slice(0, -1)}X`;
    expect(wrong.length).toBe(TEST_TOKEN.length);

    const res = await requestHttp(handle.port, "POST", "/mcp", {
      headers: {
        Authorization: `Bearer ${wrong}`,
        "content-type": "application/json",
      },
      body: "{}",
    });

    expect(res.status).toBe(401);
    expect(res.headers["www-authenticate"]).toContain("Bearer");
  });

  it("rejects bearer tokens of different length (12.13 length short-circuit)", async () => {
    handle = await startTestServer();

    // A prefix of the real token must NOT authenticate, even though every
    // compared byte matches. (timingSafeEqual short-circuits on length.)
    const prefix = TEST_TOKEN.slice(0, 5);
    expect(prefix.length).toBeLessThan(TEST_TOKEN.length);

    const res = await requestHttp(handle.port, "POST", "/mcp", {
      headers: {
        Authorization: `Bearer ${prefix}`,
        "content-type": "application/json",
      },
      body: "{}",
    });

    expect(res.status).toBe(401);
  });

  it("rejects /mcpfoo — the /mcp route match is exact, not a prefix", async () => {
    handle = await startTestServer();

    const res = await requestHttp(handle.port, "POST", "/mcpfoo", {
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        "content-type": "application/json",
      },
      body: "{}",
    });

    expect(res.status).toBe(404);
  });
});

describe("per-session Server+Transport isolation (fork patch)", () => {
  it("two concurrent initializes get distinct session ids — no 'already initialized' failure", async () => {
    handle = await startTestServer();

    const first = await mcpPost(handle.port, initBody(1));
    expect(first.status).toBe(200);
    const sidA = first.headers["mcp-session-id"];
    expect(sidA).toBeTruthy();

    // The regression this fork fixes: the old shared transport failed the
    // second initialize with "Invalid Request: Server already initialized".
    const second = await mcpPost(handle.port, initBody(2));
    expect(second.status).toBe(200);
    const sidB = second.headers["mcp-session-id"];
    expect(sidB).toBeTruthy();
    expect(sidB).not.toBe(sidA);

    expect(handle.getSessionCount()).toBe(2);
  });

  it("mcp-session-id routes follow-up requests to the same session", async () => {
    handle = await startTestServer();

    const init = await mcpPost(handle.port, initBody(1));
    const sid = init.headers["mcp-session-id"];
    expect(sid).toBeTruthy();

    const list = await mcpPost(handle.port, toolsListBody(2), sid);
    expect(list.status).toBe(200);
    expect(list.body).toContain('"tools"');
    // Still exactly one session — the follow-up reused the pair.
    expect(handle.getSessionCount()).toBe(1);
  });

  it("DELETE terminates the session", async () => {
    handle = await startTestServer();

    const init = await mcpPost(handle.port, initBody(1));
    const sid = init.headers["mcp-session-id"];
    expect(handle.getSessionCount()).toBe(1);

    const del = await mcpDelete(handle.port, sid);
    expect(del.status).toBeLessThan(300);
    expect(handle.getSessionCount()).toBe(0);

    // The terminated session id no longer routes to a live pair.
    const after = await mcpPost(handle.port, toolsListBody(2), sid);
    expect(after.status).toBeGreaterThanOrEqual(400);
  });

  it("DELETE on an unknown session returns 404", async () => {
    handle = await startTestServer();

    const del = await mcpDelete(handle.port, "does-not-exist");
    expect(del.status).toBe(404);
    expect(handle.getSessionCount()).toBe(0);
  });

  it("idle sessions are reaped by the TTL sweeper", async () => {
    handle = await startTestServer({
      sessionIdleTtlMs: 100,
      sessionSweepIntervalMs: 50,
    });

    const init = await mcpPost(handle.port, initBody(1));
    expect(init.status).toBe(200);
    expect(handle.getSessionCount()).toBe(1);

    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(handle.getSessionCount()).toBe(0);
  }, 10000);

  it("a stray non-initialize request without a session id leaves no session behind", async () => {
    handle = await startTestServer();

    // tools/list as the first request on a fresh pair: the SDK rejects it
    // (no valid session), and the server must close the orphaned pair rather
    // than leaking it.
    const stray = await mcpPost(handle.port, toolsListBody(1));
    expect(stray.status).toBeGreaterThanOrEqual(400);
    expect(handle.getSessionCount()).toBe(0);
  });

  it("the session cap evicts the oldest-idle session", async () => {
    handle = await startTestServer({
      maxSessions: 2,
      sessionIdleTtlMs: 0, // disable TTL eviction — this test is about the cap
    });

    const a = await mcpPost(handle.port, initBody(1));
    const sidA = a.headers["mcp-session-id"];
    await mcpPost(handle.port, initBody(2));
    expect(handle.getSessionCount()).toBe(2);

    // Third session over the cap: the oldest-idle (A) is evicted first.
    const c = await mcpPost(handle.port, initBody(3));
    expect(c.status).toBe(200);
    expect(handle.getSessionCount()).toBe(2);

    const listA = await mcpPost(handle.port, toolsListBody(4), sidA);
    expect(listA.status).toBeGreaterThanOrEqual(400);
  });
});

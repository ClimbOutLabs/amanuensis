import type { Logger } from 'winston';
import { McpConnectionError } from '../../../src/core/errors';
import type { RemoteMcpHeaders } from '../../../src/core/mcp/RemoteMCP';
import { RemoteMCP } from '../../../src/core/mcp/RemoteMCP';
import { connectRemoteMcp } from '../../../src/core/mcp/remoteMcpClient';
import { describeUnknownError } from '../../../src/core/util/errorLogFields';

// RemoteMCP connects itself via connectRemoteMcp; mock it so the reconnect-on-header-change
// behavior can be exercised without real networking. Mirrors remoteMcpServer.test.ts's harness.
jest.mock('../../../src/core/mcp/remoteMcpClient', () => {
  const actualUnknown: unknown = jest.requireActual('../../../src/core/mcp/remoteMcpClient');
  const actual = actualUnknown as typeof import('../../../src/core/mcp/remoteMcpClient');
  return { __esModule: true as const, ...actual, connectRemoteMcp: jest.fn() };
});

const mockConnect = connectRemoteMcp as jest.MockedFunction<typeof connectRemoteMcp>;

const infoLog = jest.fn();
const noopLogger = { info: infoLog, warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as unknown as Logger;

// Shared, mutable state backing the mocked connection: records the headers each connection was
// built with (not just a call count), so the test can assert which token a given call was served
// under - the exact thing that was silently stale before the fix.
interface FakeConnectionState {
  connectCalls: number;
  callToolCalls: number;
  closes: number;
  headersUsedByConnection: Record<string, string>[];
  sessionIdRequestedByConnection: (string | undefined)[];
}

function installFakeConnection(
  opts: { sessionId?: string | null; failFirstCallToolWith?: unknown; failListToolsWith?: unknown } = {},
): FakeConnectionState {
  const state: FakeConnectionState = {
    connectCalls: 0,
    callToolCalls: 0,
    closes: 0,
    headersUsedByConnection: [],
    sessionIdRequestedByConnection: [],
  };

  mockConnect.mockImplementation(params => {
    state.connectCalls += 1;
    state.headersUsedByConnection.push({ ...params.headers });
    state.sessionIdRequestedByConnection.push(params.sessionId);
    return Promise.resolve({
      transportType: 'streamable-http' as const,
      sessionId: opts.sessionId ?? 'sess-1',
      listTools: () => {
        if (opts.failListToolsWith !== undefined) {
          throw opts.failListToolsWith;
        }
        return Promise.resolve({ tools: [] });
      },
      callTool: callParams => {
        state.callToolCalls += 1;
        if (opts.failFirstCallToolWith !== undefined && state.callToolCalls === 1) {
          throw opts.failFirstCallToolWith;
        }
        return Promise.resolve({ content: [{ type: 'text', text: `called ${callParams.name}` }] });
      },
      close: () => {
        state.closes += 1;
        return Promise.resolve();
      },
    });
  });

  return state;
}

function makeRemote(headers: RemoteMcpHeaders, sessionId?: string): RemoteMCP {
  return new RemoteMCP({
    name: 'rotating-mcp',
    id: 'rotating-id-123',
    url: 'https://mcp.example.com/mcp',
    headers,
    logger: noopLogger,
    sessionId,
    requestTimeoutMs: 60_000,
    connectTimeoutMs: 5_000,
    signal: new AbortController().signal,
  });
}

describe('RemoteMCP header rotation reaches the live transport', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('reconnects mid-session when resolved headers change, resumes the session, and skips reconnecting when unchanged', async () => {
    const state = installFakeConnection({ sessionId: 'sess-1' });
    let token = 'token-A';
    const headers: RemoteMcpHeaders = () => Promise.resolve({ headers: { Authorization: `Bearer ${token}` } });
    const remote = makeRemote(headers);

    // Call 1: connects fresh, with no prior session to resume, under token A.
    const first = await remote.callTool({ name: 'read_thing', arguments: {} });
    if ('authRequired' in first) throw new Error('unexpected authRequired');
    expect(state.connectCalls).toBe(1);
    expect(state.headersUsedByConnection[0]).toEqual({ Authorization: 'Bearer token-A' });
    expect(state.sessionIdRequestedByConnection[0]).toBeUndefined();

    // Rotate the secret the resolver reads (e.g. ${file:}/${env:} content changed on disk).
    token = 'token-B';

    // Call 2: must be served over a connection built with token B - i.e. a reconnect happened -
    // and that reconnect must resume the stateful session (sess-1), not start a throwaway one.
    // No session-expiry error was ever thrown, so this is not the isSessionExpiredError retry path.
    const second = await remote.callTool({ name: 'read_thing', arguments: {} });
    if ('authRequired' in second) throw new Error('unexpected authRequired');
    expect(state.connectCalls).toBe(2);
    expect(state.headersUsedByConnection[1]).toEqual({ Authorization: 'Bearer token-B' });
    expect(state.sessionIdRequestedByConnection[1]).toBe('sess-1');
    expect(state.closes).toBe(1); // the token-A connection was closed before reconnecting

    const sessionExpiryLogged = infoLog.mock.calls.some(
      ([msg]: [unknown]) => typeof msg === 'string' && msg.includes('Session expired'),
    );
    expect(sessionExpiryLogged).toBe(false);
    expect(infoLog).toHaveBeenCalledWith(expect.stringContaining('Auth headers changed'));

    // Call 3: token unchanged from call 2 - no reconnect (connection count stays at 2).
    const third = await remote.callTool({ name: 'read_thing', arguments: {} });
    if ('authRequired' in third) throw new Error('unexpected authRequired');
    expect(state.connectCalls).toBe(2);
    expect(state.closes).toBe(1);
    expect(state.callToolCalls).toBe(3);
  });

  it('does not reconnect when a resolver returns an equal header set in a different key order', async () => {
    const state = installFakeConnection({ sessionId: 'sess-1' });
    let swapped = false;
    const headers: RemoteMcpHeaders = () =>
      Promise.resolve({
        headers: swapped
          ? { 'X-Static': 'unchanged', Authorization: 'Bearer same-token' }
          : { Authorization: 'Bearer same-token', 'X-Static': 'unchanged' },
      });
    const remote = makeRemote(headers);

    await remote.callTool({ name: 'read_thing', arguments: {} });
    expect(state.connectCalls).toBe(1);

    swapped = true;
    await remote.callTool({ name: 'read_thing', arguments: {} });
    expect(state.connectCalls).toBe(1);
    expect(state.closes).toBe(0);
  });
});

describe('RemoteMCP session-expiry self-heal after a server restart', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('resets the connection and re-initializes fresh when the server rejects the stale session (-32000)', async () => {
    // Incident 2026-09-21: the MCP server rebooted, wiping its in-memory session table, while the
    // previous turn's session id was persisted and resumed. The server rejects the resume with a
    // JSON-RPC -32000 "not initialized" error; the client must reset (dropping the dead session id)
    // and initialize fresh instead of failing that chat permanently.
    const staleSessionRejection = new Error(
      'Streamable HTTP error: Error POSTing to endpoint: {"jsonrpc":"2.0","error":{"code":-32000,"message":"Bad Request: Server not initialized"},"id":null}',
    );
    const state = installFakeConnection({ sessionId: 'sess-1', failFirstCallToolWith: staleSessionRejection });
    const remote = makeRemote(() => Promise.resolve({ headers: {} }), 'stale-sess');

    const response = await remote.callTool({ name: 'read_thing', arguments: {} });

    if ('authRequired' in response) throw new Error('unexpected authRequired');
    // The tool call succeeds on the retry: reset + fresh initialize self-healed.
    expect(response.result).toEqual({ content: [{ type: 'text', text: 'called read_thing' }] });
    // First connect resumed the persisted (now dead) session; the retry initializes fresh with no
    // session id instead of resuming the dead one again.
    expect(state.connectCalls).toBe(2);
    expect(state.sessionIdRequestedByConnection).toEqual(['stale-sess', undefined]);
    expect(state.callToolCalls).toBe(2); // first attempt failed, the retry was served
    expect(infoLog).toHaveBeenCalledWith(expect.stringContaining('Session expired'));
  });

  it('does NOT reset and retry on a genuine 500 (surfaces the error instead)', async () => {
    const genuineError = new Error('HTTP 500 Internal Server Error');
    const state = installFakeConnection({ sessionId: 'sess-1', failFirstCallToolWith: genuineError });
    const remote = makeRemote(() => Promise.resolve({ headers: {} }), 'sess-1');

    await expect(remote.callTool({ name: 'read_thing', arguments: {} })).rejects.toThrow(
      'HTTP 500 Internal Server Error',
    );

    // No session-expiry retry: exactly one connect, one failed call, and no "Session expired" log.
    expect(state.connectCalls).toBe(1);
    expect(state.callToolCalls).toBe(1);
    const sessionExpiryLogged = infoLog.mock.calls.some(
      ([msg]: [unknown]) => typeof msg === 'string' && msg.includes('Session expired'),
    );
    expect(sessionExpiryLogged).toBe(false);
  });

  it('does NOT reset and retry on an auth failure (surfaces the error instead)', async () => {
    const authError = new Error('HTTP 401 Unauthorized');
    const state = installFakeConnection({ sessionId: 'sess-1', failFirstCallToolWith: authError });
    const remote = makeRemote(() => Promise.resolve({ headers: {} }), 'sess-1');

    await expect(remote.callTool({ name: 'read_thing', arguments: {} })).rejects.toThrow('HTTP 401 Unauthorized');

    expect(state.connectCalls).toBe(1);
    expect(state.callToolCalls).toBe(1);
    const sessionExpiryLogged = infoLog.mock.calls.some(
      ([msg]: [unknown]) => typeof msg === 'string' && msg.includes('Session expired'),
    );
    expect(sessionExpiryLogged).toBe(false);
  });
});

/** The failure a dead server produces at the fetch layer: a bare "fetch failed" whose cause names the refusal. */
function connectionRefusedFailure(): TypeError {
  const cause = new Error('connect ECONNREFUSED 192.168.144.3:9557');
  Object.assign(cause, { code: 'ECONNREFUSED', address: '192.168.144.3', port: 9557 });
  return new TypeError('fetch failed', { cause });
}

async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected the call to fail');
    },
    (error: unknown) => error,
  );
}

describe('RemoteMCP transport failure wording', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('names the server and the cause when a tool call hits a dead server, instead of a bare fetch failed', async () => {
    const transportFailure = connectionRefusedFailure();
    const state = installFakeConnection({ sessionId: 'sess-1', failFirstCallToolWith: transportFailure });
    const remote = makeRemote(() => Promise.resolve({ headers: {} }), 'sess-1');

    const thrown = await captureRejection(remote.callTool({ name: 'send_email', arguments: {} }));

    if (!(thrown instanceof McpConnectionError)) throw new Error('expected an McpConnectionError');
    expect(thrown.statusCode).toBe(502);
    expect(thrown.cause).toBe(transportFailure);
    // The turn-fatal surface shows describeUnknownError's text: the server and the reason, in plain words.
    expect(describeUnknownError(thrown)).toBe(
      'The rotating-mcp server could not be reached: connection refused at 192.168.144.3:9557.',
    );
    expect(describeUnknownError(thrown)).not.toBe('fetch failed');
    // No reconnect or retry: exactly one connect and one failed call.
    expect(state.connectCalls).toBe(1);
    expect(state.callToolCalls).toBe(1);
  });

  it('names the server and the cause when listing tools hits a dead server', async () => {
    const transportFailure = connectionRefusedFailure();
    const state = installFakeConnection({ sessionId: 'sess-1', failListToolsWith: transportFailure });
    const remote = makeRemote(() => Promise.resolve({ headers: {} }), 'sess-1');

    const thrown = await captureRejection(remote.listTools());

    if (!(thrown instanceof McpConnectionError)) throw new Error('expected an McpConnectionError');
    expect(thrown.statusCode).toBe(502);
    expect(thrown.cause).toBe(transportFailure);
    expect(describeUnknownError(thrown)).toBe(
      'The rotating-mcp server could not be reached: connection refused at 192.168.144.3:9557.',
    );
    expect(state.connectCalls).toBe(1);
  });
});

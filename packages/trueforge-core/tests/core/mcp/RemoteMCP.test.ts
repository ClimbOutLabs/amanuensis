import type { Logger } from 'winston';
import type { RemoteMcpHeaders } from '../../../src/core/mcp/RemoteMCP';
import { RemoteMCP } from '../../../src/core/mcp/RemoteMCP';
import { connectRemoteMcp } from '../../../src/core/mcp/remoteMcpClient';

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

function installFakeConnection(opts: { sessionId?: string | null } = {}): FakeConnectionState {
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
      listTools: () => Promise.resolve({ tools: [] }),
      callTool: callParams => {
        state.callToolCalls += 1;
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

function makeRemote(headers: RemoteMcpHeaders): RemoteMCP {
  return new RemoteMCP({
    name: 'rotating-mcp',
    id: 'rotating-id-123',
    url: 'https://mcp.example.com/mcp',
    headers,
    logger: noopLogger,
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

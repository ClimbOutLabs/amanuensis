import type { GetMcpServerInput, McpServerRecord, UpsertMcpServerInput } from '../../../src/db/mcpServerStore';
import {
  getCalendarAccountState,
  registerCalendarConnectorForBoot,
  registerCalendarConnectorFromSavedAccountInBackground,
  removeCalendarAccount,
  syncCalendarConnectorWithAccount,
  type CalendarAccountState,
} from '../../../src/runtime/calendarAccount';
import { ConnectorAccountError } from '../../../src/runtime/connectorAccount';

const ACCOUNT_URL = 'http://calendar-caldav:9560';
const MCP_URL = 'http://calendar-caldav:9558/mcp';
const SECRET = 'test-account-secret-0123456789abcdef0123';
const CANARY = 'CANARY-APP-PASSWORD-7f3d9';

function makeStore() {
  const rows = new Map<string, UpsertMcpServerInput>();
  const asRecord = (input: UpsertMcpServerInput): McpServerRecord => ({
    id: 'id',
    tenant_id: input.tenant_id,
    name: input.name,
    manifest: input.manifest,
    first_party: input.first_party,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  });
  return {
    rows,
    store: {
      upsertServer: (input: UpsertMcpServerInput): Promise<McpServerRecord> => {
        rows.set(String(input.name), input);
        return Promise.resolve(asRecord(input));
      },
      getServer: (input: GetMcpServerInput): Promise<McpServerRecord | undefined> => {
        const row = rows.get(input.name);
        return Promise.resolve(row === undefined ? undefined : asRecord(row));
      },
      deleteServer: (input: { tenant_id: string; name: string }): Promise<boolean> =>
        Promise.resolve(rows.delete(input.name)),
    },
  };
}

const logger = { warn: jest.fn() };
/** The waits are skipped, and counted so the growth can be checked. */
const sleeps: number[] = [];
const sleep = (ms: number): Promise<void> => {
  sleeps.push(ms);
  return Promise.resolve();
};

function replyingWith(replies: (Response | Error)[]) {
  const queue = [...replies];
  return jest.fn(async () => {
    const next = queue.shift();
    if (next === undefined || next instanceof Error) {
      throw next ?? new Error('out of replies');
    }
    return next;
  });
}

const connectedReply = (signIn = 'ok') =>
  new Response(
    JSON.stringify({
      connected: true,
      url: 'https://nas.example.invalid/dav/',
      username: 'u',
      email: 'u@example.invalid',
      sign_in: signIn,
    }),
  );
const emptyReply = () => new Response(JSON.stringify({ connected: false }));

const bootDeps = (
  fetchImpl: typeof fetch,
  extra: { backoff?: { initialDelayMs: number; maxDelayMs: number; attempts: number } } = {},
) => ({
  accountUrl: ACCOUNT_URL,
  secret: SECRET,
  mcpUrl: MCP_URL,
  fetchImpl,
  tenant_id: 't1',
  logger,
  backoff: extra.backoff ?? { initialDelayMs: 100, maxDelayMs: 400, attempts: 3 },
  sleep,
});

describe('the Calendar connector follows the saved account', () => {
  beforeEach(() => {
    logger.warn.mockClear();
    sleeps.length = 0;
  });

  it('registers the connector at boot when an account is saved', async () => {
    const { rows, store } = makeStore();
    await registerCalendarConnectorFromSavedAccountInBackground({
      ...bootDeps(replyingWith([connectedReply()])),
      mcpServerStore: store,
    });
    expect(rows.get('Calendar')?.manifest).toMatchObject({ type: 'remote', url: MCP_URL });
    expect(rows.get('Calendar')?.first_party).toBe(true);
  });

  it('leaves the connector unregistered when no account is saved, and drops a stale registration', async () => {
    const { rows, store } = makeStore();
    const state: CalendarAccountState = {
      connected: true,
      sign_in: 'ok',
      account: { url: 'https://a.example.invalid/', username: 'u', email: 'u@example.invalid' },
    };
    await syncCalendarConnectorWithAccount({ state, mcpUrl: MCP_URL, mcpServerStore: store, tenant_id: 't1', logger });
    expect(rows.size).toBe(1);
    await registerCalendarConnectorFromSavedAccountInBackground({
      ...bootDeps(replyingWith([emptyReply()])),
      mcpServerStore: store,
    });
    expect(rows.size).toBe(0);
  });

  it('registers a saved account at boot even when its login is refused, and drops it only when none is saved', async () => {
    const { rows, store } = makeStore();
    await registerCalendarConnectorFromSavedAccountInBackground({
      ...bootDeps(replyingWith([connectedReply('refused')])),
      mcpServerStore: store,
    });
    expect(rows.size).toBe(1);
    await registerCalendarConnectorFromSavedAccountInBackground({
      ...bootDeps(replyingWith([emptyReply()])),
      mcpServerStore: store,
    });
    expect(rows.size).toBe(0);
  });

  it('asks again, waiting longer each time, while the sidecar is still starting', async () => {
    const { rows, store } = makeStore();
    const fetchImpl = replyingWith([new Error('connect refused'), new Error('connect refused'), connectedReply()]);
    await registerCalendarConnectorFromSavedAccountInBackground({ ...bootDeps(fetchImpl), mcpServerStore: store });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([100, 200]);
    expect(rows.size).toBe(1);
  });

  it('caps the wait and keeps trying well past thirty seconds', async () => {
    const { rows, store } = makeStore();
    const failures = Array.from({ length: 12 }, () => new Error('refused'));
    const fetchImpl = replyingWith([...failures, connectedReply()]);
    await registerCalendarConnectorFromSavedAccountInBackground({
      ...bootDeps(fetchImpl, { backoff: { initialDelayMs: 3000, maxDelayMs: 300_000, attempts: 20 } }),
      mcpServerStore: store,
    });
    expect(rows.size).toBe(1);
    expect(Math.max(...sleeps)).toBeLessThanOrEqual(300_000);
    expect(sleeps.reduce((total, ms) => total + ms, 0)).toBeGreaterThan(30_000);
    expect(sleeps.slice(0, 4)).toEqual([3000, 6000, 12_000, 24_000]);
  });

  it('says once, in plain words, that it is still trying, and never logs what the sidecar said', async () => {
    const { rows, store } = makeStore();
    await registerCalendarConnectorFromSavedAccountInBackground({
      ...bootDeps(replyingWith([new Error(`refused ${CANARY}`), new Error('refused'), new Error('refused')])),
      mcpServerStore: store,
    });
    expect(rows.size).toBe(0);
    const lines = logger.warn.mock.calls.map(call => String(call[0]));
    expect(lines.filter(line => line.includes('trying again'))).toHaveLength(1);
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(CANARY);
  });

  it('reads an agent answer that is not an account as the connector being unreachable', async () => {
    const deps = { accountUrl: ACCOUNT_URL, secret: SECRET, logger };
    await expect(
      getCalendarAccountState({
        ...deps,
        fetchImpl: replyingWith([new Response(JSON.stringify({ connected: true }))]),
      }),
    ).rejects.toBeInstanceOf(ConnectorAccountError);
    await expect(
      removeCalendarAccount({ ...deps, fetchImpl: replyingWith([new Response('{}', { status: 500 })]) }),
    ).rejects.toMatchObject({ failure: 'connector_unreachable' });
  });

  it('keeps the cause of a request that never reached the agent, without putting it in the message', async () => {
    const failure = await getCalendarAccountState({
      accountUrl: ACCOUNT_URL,
      secret: SECRET,
      logger,
      fetchImpl: replyingWith([new Error(`refused ${CANARY}`)]),
    }).catch((caught: unknown) => caught);
    expect(failure).toBeInstanceOf(ConnectorAccountError);
    expect(failure instanceof Error ? failure.message : '').not.toContain(CANARY);
    expect(failure instanceof Error ? failure.cause : undefined).toBeInstanceOf(Error);
  });
});

describe('the boot step for the Calendar connector', () => {
  beforeEach(() => logger.warn.mockClear());

  it('with an agent and its secret, asks the agent and registers from its answer', async () => {
    const { rows, store } = makeStore();
    const fetchImpl = replyingWith([connectedReply()]);
    await registerCalendarConnectorForBoot({
      accountUrl: ACCOUNT_URL,
      secret: SECRET,
      connectorUrl: undefined,
      mcpUrl: MCP_URL,
      fetchImpl,
      mcpServerStore: store,
      tenant_id: 't1',
      logger,
    });
    await new Promise(resolve => setImmediate(resolve));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(rows.size).toBe(1);
  });

  it('with no agent, registers the configured endpoint as it always did, and asks nobody', async () => {
    const { rows, store } = makeStore();
    const fetchImpl = jest.fn();
    await registerCalendarConnectorForBoot({
      accountUrl: undefined,
      secret: undefined,
      connectorUrl: MCP_URL,
      mcpUrl: MCP_URL,
      fetchImpl,
      mcpServerStore: store,
      tenant_id: 't1',
      logger,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(rows.get('Calendar')?.manifest).toMatchObject({ url: MCP_URL });
  });

  it('with an agent address but no secret, registers nothing and says why in one line', async () => {
    const { rows, store } = makeStore();
    const fetchImpl = jest.fn();
    await registerCalendarConnectorForBoot({
      accountUrl: ACCOUNT_URL,
      secret: undefined,
      connectorUrl: MCP_URL,
      mcpUrl: MCP_URL,
      fetchImpl,
      mcpServerStore: store,
      tenant_id: 't1',
      logger,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(rows.size).toBe(0);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('CALENDAR_ACCOUNT_SECRET'));
  });
});

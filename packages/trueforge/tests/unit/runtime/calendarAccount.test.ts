import type { McpServerRecord, UpsertMcpServerInput } from '../../../src/db/mcpServerStore';
import {
  CalendarAccountError,
  getCalendarAccountState,
  registerCalendarConnectorFromSavedAccountInBackground,
  removeCalendarAccount,
  syncCalendarConnectorWithAccount,
} from '../../../src/runtime/calendarAccount';

const ACCOUNT_URL = 'http://calendar-caldav:9560';
const MCP_URL = 'http://calendar-caldav:9558/mcp';
const CANARY = 'CANARY-APP-PASSWORD-7f3d9';

function makeStore() {
  const rows = new Map<string, UpsertMcpServerInput>();
  return {
    rows,
    store: {
      upsertServer: (input: UpsertMcpServerInput): Promise<McpServerRecord> => {
        rows.set(String(input.name), input);
        return Promise.resolve({
          id: 'id',
          tenant_id: input.tenant_id,
          name: input.name,
          manifest: input.manifest,
          first_party: input.first_party,
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
        });
      },
      deleteServer: (input: { tenant_id: string; name: string }): Promise<boolean> =>
        Promise.resolve(rows.delete(input.name)),
    },
  };
}

const logger = { warn: jest.fn() };

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

const connectedReply = () =>
  new Response(
    JSON.stringify({
      connected: true,
      url: 'https://nas.example.invalid/dav/',
      username: 'u',
      email: 'u@example.invalid',
      sign_in: 'ok',
    }),
  );
const emptyReply = () => new Response(JSON.stringify({ connected: false }));

describe('the Calendar connector follows the saved account', () => {
  beforeEach(() => logger.warn.mockClear());

  it('registers the connector at boot when an account is saved', async () => {
    const { rows, store } = makeStore();
    await registerCalendarConnectorFromSavedAccountInBackground({
      accountUrl: ACCOUNT_URL,
      mcpUrl: MCP_URL,
      fetchImpl: replyingWith([connectedReply()]),
      mcpServerStore: store,
      tenant_id: 't1',
      logger,
      retry: { attempts: 3, delayMs: 1 },
    });
    expect(rows.get('Calendar')?.manifest).toMatchObject({ type: 'remote', url: MCP_URL });
  });

  it('leaves the connector unregistered when no account is saved, and drops a stale registration', async () => {
    const { rows, store } = makeStore();
    await syncCalendarConnectorWithAccount({
      state: {
        connected: true,
        sign_in: 'ok',
        account: { url: 'https://a.example.invalid/', username: 'u', email: 'u@example.invalid' },
      },
      mcpUrl: MCP_URL,
      mcpServerStore: store,
      tenant_id: 't1',
      logger,
    });
    expect(rows.size).toBe(1);
    await registerCalendarConnectorFromSavedAccountInBackground({
      accountUrl: ACCOUNT_URL,
      mcpUrl: MCP_URL,
      fetchImpl: replyingWith([emptyReply()]),
      mcpServerStore: store,
      tenant_id: 't1',
      logger,
      retry: { attempts: 3, delayMs: 1 },
    });
    expect(rows.size).toBe(0);
  });

  it('asks again when the sidecar is still starting', async () => {
    const { rows, store } = makeStore();
    const fetchImpl = replyingWith([new Error('connect refused'), new Error('connect refused'), connectedReply()]);
    await registerCalendarConnectorFromSavedAccountInBackground({
      accountUrl: ACCOUNT_URL,
      mcpUrl: MCP_URL,
      fetchImpl,
      mcpServerStore: store,
      tenant_id: 't1',
      logger,
      retry: { attempts: 5, delayMs: 1 },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(rows.size).toBe(1);
  });

  it('gives up with one plain log line when the sidecar never answers, and registers nothing', async () => {
    const { rows, store } = makeStore();
    await registerCalendarConnectorFromSavedAccountInBackground({
      accountUrl: ACCOUNT_URL,
      mcpUrl: MCP_URL,
      fetchImpl: replyingWith([new Error(`refused ${CANARY}`), new Error('refused')]),
      mcpServerStore: store,
      tenant_id: 't1',
      logger,
      retry: { attempts: 2, delayMs: 1 },
    });
    expect(rows.size).toBe(0);
    expect(logger.warn).toHaveBeenLastCalledWith('Calendar connector could not be registered from the saved account');
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(CANARY);
  });

  it('does nothing without an account agent address', async () => {
    const { store } = makeStore();
    const fetchImpl = jest.fn();
    await registerCalendarConnectorFromSavedAccountInBackground({
      accountUrl: undefined,
      mcpUrl: MCP_URL,
      fetchImpl,
      mcpServerStore: store,
      tenant_id: 't1',
      logger,
      retry: { attempts: 2, delayMs: 1 },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reads an agent answer that is not an account as the connector being unreachable', async () => {
    await expect(
      getCalendarAccountState({
        accountUrl: ACCOUNT_URL,
        fetchImpl: replyingWith([new Response(JSON.stringify({ connected: true }))]),
        logger,
      }),
    ).rejects.toBeInstanceOf(CalendarAccountError);
    await expect(
      removeCalendarAccount({
        accountUrl: ACCOUNT_URL,
        fetchImpl: replyingWith([new Response('{}', { status: 500 })]),
        logger,
      }),
    ).rejects.toMatchObject({ failure: 'connector_unreachable' });
  });
});

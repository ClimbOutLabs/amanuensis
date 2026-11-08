import {
  CalendarConnectorSource,
  type CalendarAccountSnapshot,
} from '../../../../src/core/calendar/caldav/CalendarConnectorSource';
import type { CallToolResponse, ToolSource } from '../../../../src/core/mcp/IMCPServer';
import { isCallToolResponseResult, toolResultResponse } from '../../../../src/core/mcp/IMCPServer';

const ALICE = 'alice@example.invalid';
const BOB = 'bob@example.invalid';

function fakeInner() {
  const calls: { name: string; arguments: Record<string, unknown> | undefined }[] = [];
  const inner: ToolSource = {
    name: 'Calendar',
    id: 'Calendar',
    description: undefined,
    serverHost: undefined,
    listTools: async () => ({
      authRequired: {
        servers: [{ id: 'Calendar', name: 'Calendar', auth_url: 'https://auth.example.invalid' }],
      },
    }),
    toolCallInfo: async () => {
      throw new Error('not used');
    },
    callTool: async params => {
      calls.push({ name: params.name, arguments: params.arguments });
      return toolResultResponse({ text: JSON.stringify({ ok: true }), isError: false });
    },
  };
  return { inner, calls };
}

function sourceWith(snapshot: CalendarAccountSnapshot) {
  const { inner, calls } = fakeInner();
  const source = new CalendarConnectorSource({ inner, accounts: async () => snapshot });
  return { source, calls };
}

function errorText(response: CallToolResponse): string {
  return JSON.stringify(response);
}

describe('the calendar connector account guard', () => {
  it('passes a call naming an allowed account straight through', async () => {
    const { source, calls } = sourceWith({ names: [ALICE, BOB], default_name: ALICE, allowed: null });
    const response = await source.callTool({
      name: 'create_event',
      arguments: { calendar_id: `${BOB}|/dav/bob/work/`, summary: 'X' },
    });
    if (!isCallToolResponseResult(response)) throw new Error('expected the call to reach the connector');
    expect(response.result.isError).toBeFalsy();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.arguments?.['calendar_id']).toBe(`${BOB}|/dav/bob/work/`);
  });

  it('refuses a write naming an account outside the persona limit, and forwards nothing', async () => {
    const { source, calls } = sourceWith({ names: [ALICE, BOB], default_name: ALICE, allowed: [ALICE] });
    const response = await source.callTool({
      name: 'delete_event',
      arguments: { id: `${BOB}|evt-1` },
    });
    expect(errorText(response)).toContain('cannot use the Calendar account');
    expect(errorText(response)).toContain(ALICE);
    expect(calls).toHaveLength(0);
  });

  it('scopes a spanning read to the one usable account by naming it', async () => {
    const { source, calls } = sourceWith({ names: [ALICE, BOB], default_name: ALICE, allowed: [BOB] });
    await source.callTool({ name: 'list_events', arguments: {} });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.arguments?.['account']).toBe(BOB);
  });

  it('scopes a spanning read to a wider limit with the host scoping argument', async () => {
    const { source, calls } = sourceWith({
      names: [ALICE, BOB, 'carol@example.invalid'],
      default_name: ALICE,
      allowed: [ALICE, BOB],
    });
    await source.callTool({ name: 'search_events', arguments: { query: 'dentist' } });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.arguments?.['limit_accounts']).toEqual([ALICE, BOB]);
  });

  it('leaves a spanning read untouched when the persona may use every account', async () => {
    const { source, calls } = sourceWith({ names: [ALICE, BOB], default_name: ALICE, allowed: null });
    await source.callTool({ name: 'list_events', arguments: {} });
    expect(calls[0]?.arguments).toEqual({});
  });

  it('refuses everything when the persona may use no account', async () => {
    const { source, calls } = sourceWith({ names: [ALICE, BOB], default_name: ALICE, allowed: [] });
    const response = await source.callTool({ name: 'list_calendars', arguments: {} });
    expect(errorText(response)).toContain('cannot use any of the connected Calendar accounts');
    expect(calls).toHaveLength(0);
  });

  it('passes calls through untouched when no account is connected', async () => {
    const { source, calls } = sourceWith({ names: [], default_name: null, allowed: null });
    await source.callTool({ name: 'list_calendars', arguments: {} });
    expect(calls).toHaveLength(1);
  });
});

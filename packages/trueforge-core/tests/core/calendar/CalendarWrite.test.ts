import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { MAX_IDEOGRAPHIC_SELECTORS } from '../../../src/core/email/gmail/mimeText';
import type { ApprovalDecision } from '../../../src/core/events/schema';
import type { InternalEnrichedAssistantMessage, InternalToolCallInfo } from '../../../src/core/llm/LLMTypes';
import { allowsChatApproval, allowsToolGrant } from '../../../src/core/mcp/approvalGrant';
import { createToolCallMemoState, executeToolCalls } from '../../../src/core/mcp/executeToolCalls';
import type { AuditRecordInput } from '../../../src/core/permissions/audit';
import { defaultSentinelServices, type SentinelServices } from '../../../src/core/permissions/context';
import { checkHeldReplay, holdApprovalCalls } from '../../../src/core/permissions/heldActions';
import { DEMO_SEND_REFUSAL } from '../../../src/core/permissions/sendAllowlist';
import type { Route } from '../email/gmail/harness';
import { scriptedGoogle } from '../email/gmail/harness';
import { capturingLogger } from '../google/fakes';
import { build, EVENTS_PATH, json, text } from './harness';

const WRITE = ['gmail_read', 'calendar_read', 'calendar_write'] as const;

const DENTIST = { title: 'Dentist', start: '2026-10-19T09:00', end: '2026-10-19T10:00', location: '12 Main St' };

const STANDUP = {
  id: 'ev1',
  etag: '"e1"',
  status: 'confirmed',
  summary: 'Team sync',
  start: { dateTime: '2026-10-19T12:00:00Z' },
  end: { dateTime: '2026-10-19T12:30:00Z' },
  organizer: { email: 'ada@example.com', self: true },
  attendees: [{ email: 'ada@example.com', self: true }, { email: 'lin@example.com' }],
};

const insertRoute: Route = (url, init) =>
  init?.method === 'POST' && url.pathname === EVENTS_PATH ? json({ id: 'new1', status: 'confirmed' }) : undefined;

function eventRoutes(live: () => Record<string, unknown>): Route {
  return (url, init) => {
    if (url.pathname !== `${EVENTS_PATH}/ev1`) {
      return undefined;
    }
    return init?.method === 'PATCH' ? json({ ...live(), id: 'ev1' }) : json(live());
  };
}

function writes(urls: string[]): string[] {
  return urls.filter(entry => entry.includes(EVENTS_PATH) && !entry.startsWith('GET '));
}

type Built = Awaited<ReturnType<typeof build>>;

/** Classifies a call, then dispatches `sent` (the call as it reaches dispatch) under the owner's approval. */
async function approveThenDispatch(input: {
  built: Built;
  name: string;
  shown: Record<string, unknown>;
  sent?: Record<string, unknown>;
  beforeDispatch?: () => void;
  /** The call's info as the host stamped it, when it was not classified here (a held call being replayed). */
  infoOverride?: InternalToolCallInfo;
}) {
  const { tools, sentinel } = input.built;
  const info = input.infoOverride ?? (await tools.toolCallInfo({ name: input.name, arguments: input.shown }));
  expect(info.pre_dispatch_failure).toBeUndefined();
  expect(info.tier).toBe(3);
  input.beforeDispatch?.();
  const message: InternalEnrichedAssistantMessage = {
    role: 'assistant',
    content: null,
    tool_calls: [
      {
        id: 'call-1',
        type: 'function',
        function: { name: input.name, arguments: JSON.stringify(input.sent ?? input.shown) },
        tool_info: info,
      },
    ],
  };
  const result = await executeToolCalls({
    assistantMessage: message,
    toolMapping: new Map([[input.name, { toolSet: tools, originalToolName: input.name }]]),
    threadId: 'main',
    approvalDecisions: new Map<string, ApprovalDecision>([['call-1', { status: 'allow' }]]),
    memoState: createToolCallMemoState(),
    sentinel: {
      services: sentinel.services,
      identity: {
        tenant_id: sentinel.tenant_id,
        created_by: sentinel.created_by,
        conversation_id: sentinel.conversation_id,
        repository_id: null,
        workspace_cwd: null,
        agent_intent: null,
      },
    },
  });
  const outcome = result.toolCallResults[0];
  if (outcome === undefined) {
    throw new Error('expected one tool call result');
  }
  return outcome;
}

async function cardFor(built: Built, call: CallToolRequest['params']): Promise<InternalToolCallInfo> {
  return await built.tools.toolCallInfo(call);
}

describe('Calendar write tools', () => {
  it('are offered only when adding events was allowed, and the read tools then do not send people to Settings', async () => {
    const readOnly = await build({ routes: [] });
    const readTools = (await readOnly.tools.listTools()).result.tools;
    expect(readTools.map(tool => tool.name)).toEqual(['list_events', 'get_event']);
    expect(readTools[0]?.description).toContain('select Allow Aman to add events');

    const { tools } = await build({ routes: [], features: [...WRITE] });
    const all = (await tools.listTools()).result.tools;
    expect(all.map(tool => tool.name)).toEqual(['list_events', 'get_event', 'create_event', 'update_event']);
    expect(all[0]?.description).not.toContain('Allow Aman to add events');
    expect(await tools.toolCallInfo({ name: 'create_event', arguments: DENTIST })).toMatchObject({
      read_only_hint: false,
      destructive_hint: false,
      open_world_hint: true,
    });
  });
});

describe('the approval card', () => {
  it('shows a new event in full: calendar, title, local time, zone, length, place and every guest', async () => {
    const built = await build({ routes: [], features: [...WRITE], timeZone: 'America/New_York' });
    const info = await cardFor(built, {
      name: 'create_event',
      arguments: { ...DENTIST, attendees: ['lin@example.com', 'sam@example.com'], send_updates: 'all' },
    });
    expect(info).toMatchObject({ tier: 3, is_approval_required: true });
    expect(info.tier3_card?.calendar_event).toEqual({
      action: 'create',
      calendar: 'ada@example.com',
      title: 'Dentist',
      when: 'Monday, October 19, 2026, 9:00 am to 10:00 am',
      time_zone: 'America/New_York',
      duration: '1 hour',
      location: '12 Main St',
      description: '',
      attendees: ['lin@example.com', 'sam@example.com'],
      guests_emailed: true,
      one_of_repeating: false,
      before: null,
    });
    expect(info.tier3_card?.plain_what).toBe(
      'Add "Dentist" to your Google Calendar on Monday, October 19, 2026, 9:00 am to 10:00 am (America/New_York). Google emails lin@example.com and sam@example.com about it.',
    );
    expect(info.tier3_card?.cannot_be_undone).toContain("can't be unsent");
  });

  it('says guests are not emailed when the call chose not to', async () => {
    const built = await build({ routes: [], features: [...WRITE], timeZone: 'America/New_York' });
    const info = await cardFor(built, {
      name: 'create_event',
      arguments: { ...DENTIST, attendees: ['lin@example.com'], send_updates: 'none' },
    });
    expect(info.tier3_card?.calendar_event?.guests_emailed).toBe(false);
    expect(info.tier3_card?.plain_what).toContain('Guests: lin@example.com. Google does not email them.');
    expect(info.tier3_card?.cannot_be_undone).toBeNull();
  });

  it('shows a change as before and after, from the event as Google holds it now', async () => {
    const built = await build({
      routes: [eventRoutes(() => STANDUP)],
      features: [...WRITE],
      timeZone: 'America/New_York',
    });
    const info = await cardFor(built, {
      name: 'update_event',
      arguments: { event_id: 'ev1', start: '2026-10-20T14:00', send_updates: 'all' },
    });
    expect(info.tier3_card?.calendar_event).toMatchObject({
      action: 'change',
      title: 'Team sync',
      when: 'Tuesday, October 20, 2026, 2:00 pm to 2:30 pm',
      duration: '30 minutes',
      attendees: ['lin@example.com'],
      guests_emailed: true,
      before: { title: 'Team sync', when: 'Monday, October 19, 2026, 8:00 am to 8:30 am', duration: '30 minutes' },
    });
  });

  it('offers no card for event text with characters that do not show', async () => {
    const built = await build({ routes: [], features: [...WRITE], timeZone: 'America/New_York' });
    const info = await cardFor(built, {
      name: 'create_event',
      arguments: { ...DENTIST, location: 'Room\u202e 4' },
    });
    expect(info.pre_dispatch_failure?.message).toContain('Nothing was saved');
    expect(info.tier3_card ?? null).toBeNull();
  });
});

describe('time zones', () => {
  it("uses the calendar's own zone when the device names none", async () => {
    const built = await build({
      routes: [
        (url, init) =>
          init?.method !== 'POST' && url.pathname === EVENTS_PATH ? json({ timeZone: 'Europe/Lisbon' }) : undefined,
      ],
      features: [...WRITE],
      timeZone: undefined,
    });
    const info = await cardFor(built, { name: 'create_event', arguments: DENTIST });
    expect(info.tier3_card?.calendar_event?.time_zone).toBe('Europe/Lisbon');
  });

  it('never falls back to UTC: with no zone known, nothing is offered and the model is told to ask', async () => {
    const built = await build({
      routes: [url => (url.pathname === EVENTS_PATH ? json({}) : undefined)],
      features: [...WRITE],
      timeZone: undefined,
    });
    const info = await cardFor(built, { name: 'create_event', arguments: DENTIST });
    expect(info.pre_dispatch_failure?.message).toContain("doesn't know which time zone");
    expect(info.tier3_card ?? null).toBeNull();
  });

  it('uses a zone the call names over the device zone', async () => {
    const built = await build({ routes: [], features: [...WRITE], timeZone: 'America/New_York' });
    const info = await cardFor(built, { name: 'create_event', arguments: { ...DENTIST, time_zone: 'Asia/Tokyo' } });
    expect(info.tier3_card?.calendar_event?.time_zone).toBe('Asia/Tokyo');
  });
});

describe('an approved write at dispatch', () => {
  it('sends exactly the event on the card, once, with the email choice explicit', async () => {
    const built = await build({ routes: [insertRoute], features: [...WRITE], timeZone: 'America/New_York' });
    const outcome = await approveThenDispatch({ built, name: 'create_event', shown: DENTIST });
    expect(outcome.failure).toBe(false);
    expect(writes(built.google.urls)).toEqual([`POST ${EVENTS_PATH}?sendUpdates=none`]);
    expect(built.google.bodies).toEqual([
      {
        summary: 'Dentist',
        start: { dateTime: '2026-10-19T09:00:00-04:00', timeZone: 'America/New_York' },
        end: { dateTime: '2026-10-19T10:00:00-04:00', timeZone: 'America/New_York' },
        location: '12 Main St',
      },
    ]);
    expect(JSON.parse(outcome.rawContent)).toMatchObject({ event_id: 'new1', status: 'created' });
  });

  it('asks Google to email guests only when the approved call said so', async () => {
    const built = await build({ routes: [insertRoute], features: [...WRITE], timeZone: 'America/New_York' });
    await approveThenDispatch({
      built,
      name: 'create_event',
      shown: { ...DENTIST, attendees: ['lin@example.com'], send_updates: 'all' },
    });
    expect(writes(built.google.urls)).toEqual([`POST ${EVENTS_PATH}?sendUpdates=all`]);
    expect(built.google.bodies[0]).toMatchObject({ attendees: [{ email: 'lin@example.com' }] });
  });

  it('refuses arguments edited after approval, and writes nothing', async () => {
    const built = await build({ routes: [insertRoute], features: [...WRITE], timeZone: 'America/New_York' });
    const outcome = await approveThenDispatch({
      built,
      name: 'create_event',
      shown: DENTIST,
      sent: { ...DENTIST, attendees: ['someone@example.com'], send_updates: 'all' },
    });
    expect(outcome.failure).toBe(true);
    expect(outcome.rawContent).toContain('Approval invalid');
    expect(writes(built.google.urls)).toEqual([]);
  });

  it('refuses a change when the event changed in Google after the card, and writes nothing', async () => {
    let live: Record<string, unknown> = STANDUP;
    const built = await build({
      routes: [eventRoutes(() => live)],
      features: [...WRITE],
      timeZone: 'America/New_York',
    });
    const outcome = await approveThenDispatch({
      built,
      name: 'update_event',
      shown: { event_id: 'ev1', title: 'Team sync (online)', send_updates: 'none' },
      beforeDispatch: () => {
        live = { ...STANDUP, etag: '"e2"', location: 'Room 9' };
      },
    });
    expect(outcome.failure).toBe(true);
    expect(outcome.rawContent).toContain('Approval invalid');
    expect(writes(built.google.urls)).toEqual([]);
  });

  it('changes only the approved fields of the event shown', async () => {
    const built = await build({
      routes: [eventRoutes(() => STANDUP)],
      features: [...WRITE],
      timeZone: 'America/New_York',
    });
    const outcome = await approveThenDispatch({
      built,
      name: 'update_event',
      shown: { event_id: 'ev1', title: 'Team sync (online)', send_updates: 'none' },
    });
    expect(outcome.failure).toBe(false);
    expect(writes(built.google.urls)).toEqual([`PATCH ${EVENTS_PATH}/ev1?sendUpdates=none`]);
    expect(built.google.bodies).toEqual([{ summary: 'Team sync (online)' }]);
  });

  it('writes nothing for a call that reaches the tool without an approval', async () => {
    const built = await build({ routes: [insertRoute], features: [...WRITE], timeZone: 'America/New_York' });
    const response = await built.tools.callTool({ name: 'create_event', arguments: DENTIST });
    expect(text(response)).toContain('not approved');
    expect(writes(built.google.urls)).toEqual([]);
  });
});

describe('the write tool itself', () => {
  it('writes nothing when its arguments are not the ones approved, whatever route the call took', async () => {
    const built = await build({ routes: [insertRoute], features: [...WRITE], timeZone: 'America/New_York' });
    const info = await built.tools.toolCallInfo({ name: 'create_event', arguments: DENTIST });
    const response = await built.tools.callTool(
      { name: 'create_event', arguments: { ...DENTIST, title: 'Dentist and lunch' } },
      undefined,
      {
        admission_provenance: { source: 'user_approval', decision: 'allow' },
        approved_params: info.mint_canonical_params,
      },
    );
    expect(text(response)).toContain('changed after you approved them');
    expect(writes(built.google.urls)).toEqual([]);
  });
});

describe('a scheduled run', () => {
  it('holds a proposed event for the owner with its full card, and never writes it', async () => {
    const built = await build({
      routes: [insertRoute],
      features: [...WRITE],
      timeZone: 'America/New_York',
      unattended: true,
    });
    expect((await built.tools.listTools()).result.tools.map(tool => tool.name)).toContain('create_event');
    const args = { ...DENTIST, time_zone: 'America/New_York' };
    const info = await built.tools.toolCallInfo({ name: 'create_event', arguments: args });
    expect(info.pre_dispatch_failure).toBeUndefined();
    expect(info).toMatchObject({ tier: 3, is_approval_required: true });
    expect(info.tier3_card?.calendar_event?.title).toBe('Dentist');

    const held = holdApprovalCalls({
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call-1',
            type: 'function',
            function: { name: 'create_event', arguments: JSON.stringify(args) },
            tool_info: info,
          },
        ],
      },
      alreadyHeld: 0,
      isSubAgent: false,
    });
    expect(held.refused).toEqual([]);
    expect(held.message.tool_calls?.[0]?.tool_info.held_for_owner).toBeDefined();

    // Even a call that reached the tool with an approval's arguments writes nothing in a scheduled run.
    const response = await built.tools.callTool({ name: 'create_event', arguments: args }, undefined, {
      admission_provenance: { source: 'user_approval', decision: 'allow' },
      approved_params: info.mint_canonical_params,
    });
    expect(text(response)).toContain('Scheduled runs never change the calendar');
    expect(writes(built.google.urls)).toEqual([]);
  });

  it('asks the model to name the zone, so a held event keeps its times when the owner approves later', async () => {
    const built = await build({ routes: [], features: [...WRITE], timeZone: 'America/New_York', unattended: true });
    const info = await built.tools.toolCallInfo({ name: 'create_event', arguments: DENTIST });
    expect(info.pre_dispatch_failure?.message).toContain('pass time_zone (here it is America/New_York)');
  });
});

describe('a write Google may have acted on', () => {
  it('is never repeated after a server error, and says the event may have been saved', async () => {
    const built = await build({
      routes: [
        (url, init) => (init?.method === 'POST' && url.pathname === EVENTS_PATH ? json({ error: {} }, 503) : undefined),
      ],
      features: [...WRITE],
      timeZone: 'America/New_York',
    });
    const outcome = await approveThenDispatch({ built, name: 'create_event', shown: DENTIST });
    expect(outcome.rawContent).toContain('may or may not have been saved');
    expect(writes(built.google.urls)).toHaveLength(1);
  });
});

function recordingServices(): { services: SentinelServices; rows: AuditRecordInput[] } {
  const rows: AuditRecordInput[] = [];
  return {
    rows,
    services: {
      ...defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }),
      audit: {
        record: row => {
          rows.push(row);
          return Promise.resolve();
        },
      },
    },
  };
}

describe('the permissions log', () => {
  it('still reports a saved event as saved when its log row cannot be written, and logs that instead', async () => {
    const { logger, lines } = capturingLogger();
    const services: SentinelServices = {
      ...defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }),
      audit: {
        record: row => (row.outcome === 'ran' ? Promise.reject(new Error('audit store is down')) : Promise.resolve()),
      },
    };
    const built = await build({
      routes: [insertRoute],
      features: [...WRITE],
      timeZone: 'America/New_York',
      services,
      logger,
    });
    const outcome = await approveThenDispatch({ built, name: 'create_event', shown: DENTIST });
    expect(outcome.failure).toBe(false);
    expect(JSON.parse(outcome.rawContent)).toMatchObject({ event_id: 'new1', status: 'created' });
    expect(writes(built.google.urls)).toHaveLength(1);
    expect(lines.some(line => line.includes('Calendar write audit row could not be written'))).toBe(true);
  });

  it('records the write once Google saved it, with what was saved', async () => {
    const { services, rows } = recordingServices();
    const built = await build({ routes: [insertRoute], features: [...WRITE], timeZone: 'America/New_York', services });
    await approveThenDispatch({ built, name: 'create_event', shown: DENTIST });
    expect(rows.filter(row => row.outcome === 'ran')).toEqual([
      expect.objectContaining({
        tool_name: 'create_event',
        tier: 3,
        description:
          'Added to Google Calendar after the owner approved it: "Dentist" on Monday, October 19, 2026, 9:00 am to 10:00 am (America/New_York)',
      }),
    ]);
  });

  it('records a write Google did not confirm as not saved, never as a write', async () => {
    const { services, rows } = recordingServices();
    const built = await build({
      routes: [
        (url, init) => (init?.method === 'POST' && url.pathname === EVENTS_PATH ? json({ error: {} }, 503) : undefined),
      ],
      features: [...WRITE],
      timeZone: 'America/New_York',
      services,
    });
    await approveThenDispatch({ built, name: 'create_event', shown: DENTIST });
    expect(rows.some(row => row.outcome === 'ran')).toBe(false);
    expect(rows.filter(row => row.outcome === 'denied').map(row => row.description)).toEqual([
      expect.stringContaining('Google Calendar did not confirm saving "Dentist"'),
    ]);
  });
});

describe('durable approvals', () => {
  it('never offers approve-for-this-chat or always-allow for a calendar write', async () => {
    const built = await build({ routes: [], features: [...WRITE], timeZone: 'America/New_York' });
    const info = await built.tools.toolCallInfo({
      name: 'create_event',
      arguments: { ...DENTIST, attendees: ['lin@example.com'], send_updates: 'all' },
    });
    expect(info.tier_reason).toBe('calendar_write');
    expect(allowsChatApproval(info)).toBe(false);
    expect(allowsToolGrant(info)).toBe(false);
  });
});

describe('a held event the owner approves later', () => {
  const args = { ...DENTIST, time_zone: 'America/New_York' };

  async function holdThenAnswer(input: { expired: boolean }) {
    const services = defaultSentinelServices({ pinned_path: '/usr/bin:/bin' });
    const google = scriptedGoogle([insertRoute]);
    // The scheduled run classifies the call and holds it; nothing is written.
    const run = await build({ routes: [], features: [...WRITE], unattended: true, services, google, timeZone: 'UTC' });
    const heldInfo = await run.tools.toolCallInfo({ name: 'create_event', arguments: args });
    const heldCall = holdApprovalCalls({
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'held-1',
            type: 'function',
            function: { name: 'create_event', arguments: JSON.stringify(args) },
            tool_info: heldInfo,
          },
        ],
      },
      alreadyHeld: 0,
      isSubAgent: false,
    }).message.tool_calls?.[0];
    if (heldCall === undefined) {
      throw new Error('expected a held call');
    }
    const held = input.expired
      ? {
          ...heldCall.tool_info,
          held_for_owner: { expires_at: new Date(Date.now() - 1000).toISOString() },
        }
      : heldCall.tool_info;
    expect(writes(google.urls)).toEqual([]);

    // Later the owner approves it from Needs your OK, in a chat turn on a device in another zone.
    const owner = await build({ routes: [], features: [...WRITE], services, google, timeZone: 'Europe/Paris' });
    const fresh = await owner.tools.toolCallInfo({ name: 'create_event', arguments: args });
    const check = await checkHeldReplay({
      held,
      fresh,
      tokens: services.token_store,
      scope: { tenant_id: owner.sentinel.tenant_id, created_by: owner.sentinel.created_by },
    });
    if (!check.ok) {
      return { check, google };
    }
    const outcome = await approveThenDispatch({
      built: owner,
      name: 'create_event',
      shown: args,
      infoOverride: { ...fresh, approval_token_id: check.approval_token_id },
    });
    return { check, google, outcome };
  }

  it('writes it once, with exactly the request the held card showed', async () => {
    const { check, google, outcome } = await holdThenAnswer({ expired: false });
    expect(check.ok).toBe(true);
    expect(outcome?.failure).toBe(false);
    expect(writes(google.urls)).toEqual([`POST ${EVENTS_PATH}?sendUpdates=none`]);
    expect(google.bodies).toEqual([
      expect.objectContaining({
        start: { dateTime: '2026-10-19T09:00:00-04:00', timeZone: 'America/New_York' },
      }),
    ]);
  });

  it('never writes it once the hold has expired', async () => {
    const { check, google } = await holdThenAnswer({ expired: true });
    expect(check).toEqual({ ok: false, reason: 'expired' });
    expect(writes(google.urls)).toEqual([]);
  });
});

describe('on a demo instance', () => {
  const ALLOWED = 'guest@demo.example';

  function demoServices(): SentinelServices {
    return { ...defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }), demoSendAllowlist: [ALLOWED] };
  }

  async function demoBuild(routes: Route[] = [insertRoute]) {
    return await build({ routes, features: [...WRITE], timeZone: 'America/New_York', services: demoServices() });
  }

  it('refuses a new event with a guest off the send list even when Google would not email them', async () => {
    const built = await demoBuild();
    const info = await built.tools.toolCallInfo({
      name: 'create_event',
      arguments: { ...DENTIST, attendees: [ALLOWED, 'stranger@example.com'], send_updates: 'none' },
    });
    expect(info.pre_dispatch_failure?.message).toContain(DEMO_SEND_REFUSAL);
    expect(info.is_approval_required).not.toBe(true);
    expect(writes(built.google.urls)).toEqual([]);
  });

  it('asks as usual for guests on the send list, and for an event with no guests', async () => {
    const built = await demoBuild();
    for (const args of [{ ...DENTIST, attendees: [ALLOWED.toUpperCase()], send_updates: 'all' }, DENTIST]) {
      const info = await built.tools.toolCallInfo({ name: 'create_event', arguments: args });
      expect(info).toMatchObject({ tier: 3, is_approval_required: true });
      expect(info.pre_dispatch_failure).toBeUndefined();
    }
  });

  it('cannot add a guest through a change: update_event takes no attendees', async () => {
    const built = await demoBuild([eventRoutes(() => ({ ...STANDUP, attendees: [] }))]);
    const response = await built.tools.callTool({
      name: 'update_event',
      arguments: { event_id: 'ev1', title: 'x', attendees: ['stranger@example.com'], send_updates: 'all' },
    });
    expect(text(response)).toContain('Validation failed');
    expect(writes(built.google.urls)).toEqual([]);
  });

  it('refuses a change to an event that already has a guest off the send list, whatever send_updates is', async () => {
    const built = await demoBuild([eventRoutes(() => STANDUP)]);
    for (const send_updates of ['none', 'all']) {
      const info = await built.tools.toolCallInfo({
        name: 'update_event',
        arguments: { event_id: 'ev1', title: 'x', send_updates },
      });
      expect(info.pre_dispatch_failure?.message).toContain(DEMO_SEND_REFUSAL);
    }
    expect(writes(built.google.urls)).toEqual([]);
  });

  it('refuses at dispatch a write approved before the send list was set, and writes nothing', async () => {
    const services = defaultSentinelServices({ pinned_path: '/usr/bin:/bin' });
    const google = scriptedGoogle([insertRoute]);
    const before = await build({ routes: [], features: [...WRITE], timeZone: 'America/New_York', services, google });
    const args = { ...DENTIST, attendees: ['stranger@example.com'], send_updates: 'none' };
    const approvedInfo = await before.tools.toolCallInfo({ name: 'create_event', arguments: args });
    const demo = await build({
      routes: [],
      features: [...WRITE],
      timeZone: 'America/New_York',
      services: { ...services, demoSendAllowlist: [ALLOWED] },
      google,
    });
    const response = await demo.tools.callTool({ name: 'create_event', arguments: args }, undefined, {
      admission_provenance: { source: 'user_approval', decision: 'allow' },
      approved_params: approvedInfo.mint_canonical_params,
    });
    expect(text(response)).toContain(DEMO_SEND_REFUSAL);
    expect(writes(google.urls)).toEqual([]);
  });
});

describe('hidden text', () => {
  it('refuses event text with more ideographic variation selectors than a word needs, as a Gmail draft does', async () => {
    const built = await build({ routes: [insertRoute], features: [...WRITE], timeZone: 'America/New_York' });
    const selectors = '\u{E0100}'.repeat(MAX_IDEOGRAPHIC_SELECTORS + 1);
    for (const field of ['title', 'location', 'description']) {
      const info = await built.tools.toolCallInfo({
        name: 'create_event',
        arguments: { ...DENTIST, [field]: `漢${selectors}` },
      });
      expect(info.pre_dispatch_failure?.message).toContain('Nothing was saved');
    }
    const fine = await built.tools.toolCallInfo({
      name: 'create_event',
      arguments: { ...DENTIST, title: '漢\u{E0100}' },
    });
    expect(fine.pre_dispatch_failure).toBeUndefined();
  });
});

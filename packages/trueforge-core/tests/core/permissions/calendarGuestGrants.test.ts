import { caldavEventReviewFrom, type CaldavEventReview } from '../../../src/core/calendar/caldav/eventReview';
import type { CalendarWriteReview } from '../../../src/core/calendar/eventWrite';
import type { InternalToolCallInfo } from '../../../src/core/llm/LLMTypes';
import { allowsChatApproval, allowsToolGrant } from '../../../src/core/mcp/approvalGrant';
import { classifyTier, type ClassifyContext, type SentinelAction } from '../../../src/core/permissions/classifier';
import { defaultSentinelServices } from '../../../src/core/permissions/context';
import { TOOL_GRANT_REASON } from '../../../src/core/permissions/toolGrants';
import { createWebSearchTurnState } from '../../../src/core/permissions/webSearch';

const GOOGLE = 'google_calendar';
const CALDAV = 'Calendar';
const CONNECTOR = 'Team Calendar';

/** Builds a context with a standing grant recorded for each `[server, tool]` pair. */
async function ctxWithGrants(grants: [string, string][]): Promise<ClassifyContext> {
  const services = defaultSentinelServices({ pinned_path: '/usr/bin:/bin' });
  for (const [mcp_server_name, tool_name] of grants) {
    await services.tool_grants.recordToolGrant({
      tenant_id: 't1',
      created_by: 'u1',
      mcp_server_name,
      tool_name,
      mcp_server_host: null,
    });
  }
  return {
    services,
    tenant_id: 't1',
    created_by: 'u1',
    conversation_id: 'c1',
    repository_id: null,
    workspace_cwd: null,
    agent_intent: null,
    web_search: createWebSearchTurnState(),
  };
}

function review(overrides: Partial<CalendarWriteReview>): CalendarWriteReview {
  return {
    action: 'create',
    calendar: 'ada@example.com',
    title: 'Dentist',
    when: 'Mon Oct 19, 9:00 to 10:00 am',
    short_when: 'Mon Oct 19, 9:00 to 10:00 am',
    span_days: 1,
    already_created: false,
    time_zone: 'America/New_York',
    duration: '1 hour',
    location: '12 Main St',
    description: '',
    attendees: [],
    guests_emailed: false,
    one_of_repeating: false,
    before: null,
    incomplete_reason: null,
    ...overrides,
  };
}

function googleAction(tool_name: string, calendar_write: CalendarWriteReview): SentinelAction {
  return {
    tool_name,
    canonical_params: { title: calendar_write.title },
    tool_type: 'truefoundry-system',
    mcp_server_name: GOOGLE,
    mcp_hints: { read_only_hint: false, open_world_hint: false },
    calendar_write,
  };
}

function caldavAction(tool_name: string, canonical_params: Record<string, unknown> = {}): SentinelAction {
  return {
    tool_name,
    canonical_params,
    tool_type: 'mcp',
    mcp_server_name: CALDAV,
    mcp_first_party: true,
    mcp_hints: { read_only_hint: false, open_world_hint: false },
  };
}

const CALDAV_NO_GUESTS: CaldavEventReview = {
  id: 'ev1',
  title: 'Dentist',
  when: '22 Oct 2026, 14:00 (Europe/Berlin)',
  organizer: 'Ada',
  attendees: [],
};
const CALDAV_WITH_GUESTS: CaldavEventReview = { ...CALDAV_NO_GUESTS, attendees: ['Lin'] };
const CALDAV_GUESTS_UNKNOWN: CaldavEventReview = { ...CALDAV_NO_GUESTS, attendees: null };

const CREATE_ARGS = { calendar_id: 'primary', summary: 'Dentist', start: '2026-10-19T09:00' };
const UPDATE_ARGS = { id: 'ev1', summary: 'Dentist moved' };

describe('Google Calendar changes and standing grants', () => {
  it('asks by default for a new event with no guests, and lets an Always grant admit it without a card', async () => {
    const asks = await classifyTier(googleAction('create_event', review({})), await ctxWithGrants([]));
    expect(asks).toMatchObject({ tier: 3, reason: 'calendar_write' });

    const granted = await classifyTier(
      googleAction('create_event', review({})),
      await ctxWithGrants([[GOOGLE, 'create_event']]),
    );
    expect(granted).toMatchObject({ tier: 1, reason: TOOL_GRANT_REASON, card: null });
  });

  it('asks by default for a change to an event with no guests, and admits it under an Always grant', async () => {
    const change = review({
      action: 'change',
      before: { title: 'Dentist', when: 'x', short_when: 'x', duration: '1 hour', location: '' },
    });
    expect(await classifyTier(googleAction('update_event', change), await ctxWithGrants([]))).toMatchObject({
      tier: 3,
      reason: 'calendar_write',
    });
    expect(
      await classifyTier(googleAction('update_event', change), await ctxWithGrants([[GOOGLE, 'update_event']])),
    ).toMatchObject({ tier: 1, reason: TOOL_GRANT_REASON });
  });

  it('shows a card for a new event with guests even with an Always grant, and says why in plain words', async () => {
    const guests = review({ attendees: ['lin@example.com'], guests_emailed: true });
    const decision = await classifyTier(
      googleAction('create_event', guests),
      await ctxWithGrants([[GOOGLE, 'create_event']]),
    );
    expect(decision).toMatchObject({ tier: 3, reason: 'calendar_write_guests' });
    expect(decision.card?.plain_what).toContain(
      'This change sends an invitation to other people, so Aman always asks.',
    );
  });

  it('shows a card for a change to an event that already has guests, even with an Always grant', async () => {
    const guestChange = review({
      action: 'change',
      attendees: ['lin@example.com'],
      guests_emailed: true,
      before: { title: 'Dentist', when: 'x', short_when: 'x', duration: '1 hour', location: '' },
    });
    const decision = await classifyTier(
      googleAction('update_event', guestChange),
      await ctxWithGrants([[GOOGLE, 'update_event']]),
    );
    expect(decision).toMatchObject({ tier: 3, reason: 'calendar_write_guests' });
    expect(decision.card?.plain_what).toContain('reaches the other people invited to this event');
  });
});

describe('CalDAV changes and standing grants', () => {
  it('asks by default for a new event with no guests, and admits it under an Always grant', async () => {
    expect(await classifyTier(caldavAction('create_event', CREATE_ARGS), await ctxWithGrants([]))).toMatchObject({
      tier: 3,
      reason: 'caldav_calendar_change',
    });
    expect(
      await classifyTier(caldavAction('create_event', CREATE_ARGS), await ctxWithGrants([[CALDAV, 'create_event']])),
    ).toMatchObject({ tier: 1, reason: TOOL_GRANT_REASON });
  });

  it('asks by default for an update with no guests, and admits it under an Always grant', async () => {
    const update = { ...caldavAction('update_event', UPDATE_ARGS), caldav_event: CALDAV_NO_GUESTS };
    expect(await classifyTier(update, await ctxWithGrants([]))).toMatchObject({
      tier: 3,
      reason: 'caldav_calendar_change',
    });
    expect(await classifyTier(update, await ctxWithGrants([[CALDAV, 'update_event']]))).toMatchObject({
      tier: 1,
      reason: TOOL_GRANT_REASON,
    });
  });

  it('shows a card for an update to an event that has guests, even with an Always grant', async () => {
    const decision = await classifyTier(
      { ...caldavAction('update_event', UPDATE_ARGS), caldav_event: CALDAV_WITH_GUESTS },
      await ctxWithGrants([[CALDAV, 'update_event']]),
    );
    expect(decision).toMatchObject({ tier: 3, reason: 'caldav_calendar_guests' });
  });
});

describe('unknown guests always ask', () => {
  it('shows a card for a CalDAV delete whose guest list cannot be read, even with an Always grant', async () => {
    const delete_action = caldavAction('delete_event', { id: 'ev1', scope: 'this' });
    const withGrant = await ctxWithGrants([[CALDAV, 'delete_event']]);
    expect(await classifyTier(delete_action, withGrant)).toMatchObject({ tier: 3, reason: 'caldav_calendar_guests' });
  });

  it('shows a card for a CalDAV update whose guest list is unknown, even with an Always grant', async () => {
    const decision = await classifyTier(
      {
        ...caldavAction('update_event', UPDATE_ARGS),
        canonical_params: UPDATE_ARGS,
        caldav_event: CALDAV_GUESTS_UNKNOWN,
      },
      await ctxWithGrants([[CALDAV, 'update_event']]),
    );
    expect(decision).toMatchObject({ tier: 3, reason: 'caldav_calendar_guests' });
  });
});

describe('invitation replies and connector calendar tools', () => {
  it('shows a card for a CalDAV invitation reply, even with an Always grant', async () => {
    const decision = await classifyTier(
      caldavAction('respond_to_event', { id: 'ev1', response: 'accept', confirm_token: 'tok' }),
      await ctxWithGrants([[CALDAV, 'respond_to_event']]),
    );
    expect(decision).toMatchObject({ tier: 3, reason: 'caldav_invitation_reply' });
  });

  it('shows a card for a connector calendar tool even when it is first-party and read-only, and with an Always grant', async () => {
    const connector: SentinelAction = {
      tool_name: 'create_event',
      canonical_params: { summary: 'Team lunch' },
      tool_type: 'mcp',
      mcp_server_name: CONNECTOR,
      mcp_first_party: true,
      mcp_hints: { read_only_hint: true, open_world_hint: false },
    };
    const decision = await classifyTier(connector, await ctxWithGrants([[CONNECTOR, 'create_event']]));
    expect(decision).toMatchObject({ tier: 3, reason: 'connector_calendar_write' });
  });

  it.each(['add_attendee', 'update_attendees', 'invite_guests'])(
    'treats a connector tool named %s as a calendar change, even when it says it is read-only',
    async tool_name => {
      const connector: SentinelAction = {
        tool_name,
        canonical_params: { id: 'ev1' },
        tool_type: 'mcp',
        mcp_server_name: CONNECTOR,
        mcp_first_party: true,
        mcp_hints: { read_only_hint: true, open_world_hint: false },
      };
      const decision = await classifyTier(connector, await ctxWithGrants([[CONNECTOR, tool_name]]));
      expect(decision).toMatchObject({ tier: 3, reason: 'connector_calendar_write' });
    },
  );
});

/** A get_event answer as the CalDAV server sends it: a guest-free event leaves the attendees key out. */
function fetchedCaldavEvent(event: Record<string, unknown>): CaldavEventReview {
  return caldavEventReviewFrom({
    id: 'ev1',
    result: { event: { summary: 'Dentist', start: { value: '2026-10-22T14:00:00+02:00', all_day: false }, ...event } },
  });
}

describe('a fetched CalDAV event decides whether guests are reached', () => {
  const ORGANIZER = { name: 'Ada' };

  it('treats a parsed event with no guest lines as having no guests, so an Always grant admits its update and delete', async () => {
    const review = fetchedCaldavEvent({ organizer: ORGANIZER });
    const withGrant = await ctxWithGrants([
      [CALDAV, 'update_event'],
      [CALDAV, 'delete_event'],
    ]);
    const update = { ...caldavAction('update_event', UPDATE_ARGS), caldav_event: review };
    const deletion = { ...caldavAction('delete_event', { id: 'ev1', scope: 'this' }), caldav_event: review };
    expect(await classifyTier(update, withGrant)).toMatchObject({ tier: 1, card: null, reason: TOOL_GRANT_REASON });
    expect(await classifyTier(deletion, withGrant)).toMatchObject({ tier: 1, card: null, reason: TOOL_GRANT_REASON });
  });

  it('still asks for a guest-free event without a grant', async () => {
    const update = { ...caldavAction('update_event', UPDATE_ARGS), caldav_event: fetchedCaldavEvent({}) };
    expect(await classifyTier(update, await ctxWithGrants([]))).toMatchObject({
      tier: 3,
      reason: 'caldav_calendar_change',
    });
  });

  it('shows a card for an event with one guest, even with an Always grant', async () => {
    const review = fetchedCaldavEvent({ attendees: [{ email: 'lin@example.com' }] });
    const withGrant = await ctxWithGrants([
      [CALDAV, 'update_event'],
      [CALDAV, 'delete_event'],
    ]);
    const update = { ...caldavAction('update_event', UPDATE_ARGS), caldav_event: review };
    const deletion = { ...caldavAction('delete_event', { id: 'ev1', scope: 'this' }), caldav_event: review };
    expect(await classifyTier(update, withGrant)).toMatchObject({ tier: 3, reason: 'caldav_calendar_guests' });
    expect(await classifyTier(deletion, withGrant)).toMatchObject({ tier: 3, reason: 'caldav_calendar_guests' });
  });

  it('shows a card for an event that could not be parsed, even with an Always grant', async () => {
    const review = caldavEventReviewFrom({ id: 'ev1', result: { unexpected: true } });
    const update = { ...caldavAction('update_event', UPDATE_ARGS), caldav_event: review };
    const decision = await classifyTier(update, await ctxWithGrants([[CALDAV, 'update_event']]));
    expect(decision).toMatchObject({ tier: 3, reason: 'caldav_calendar_guests' });
    expect(decision.card?.plain_what).toContain('Aman could not check who is invited, so it always asks.');
  });
});

describe('which calendar changes a grant may cover', () => {
  function info(tier_reason: string): InternalToolCallInfo {
    return {
      type: 'truefoundry-system',
      mcp_server_id: GOOGLE,
      mcp_server_name: GOOGLE,
      original_tool_name: 'create_event',
      is_approval_required: true,
      tier: 3,
      tier_reason,
      effect: 'edit',
    };
  }

  it.each([
    ['calendar_write', true],
    ['caldav_calendar_change', true],
  ])('lets %s be covered by a chat or Always grant', (tier_reason, covered) => {
    expect(allowsChatApproval(info(tier_reason))).toBe(covered);
    expect(allowsToolGrant(info(tier_reason))).toBe(covered);
  });

  it.each(['calendar_write_guests', 'caldav_calendar_guests', 'caldav_invitation_reply', 'connector_calendar_write'])(
    'never lets %s be covered by a grant',
    tier_reason => {
      expect(allowsChatApproval(info(tier_reason))).toBe(false);
      expect(allowsToolGrant(info(tier_reason))).toBe(false);
    },
  );
});

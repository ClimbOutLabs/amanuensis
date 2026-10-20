import type { CalendarWriteReview } from '../../../src/core/calendar/eventWrite';
import { classifyTier, type ClassifyContext, type SentinelAction } from '../../../src/core/permissions/classifier';
import {
  defaultSentinelServices,
  forUnattendedRun,
  type SentinelServices,
} from '../../../src/core/permissions/context';
import { createWebSearchTurnState, hasReadPrivateData } from '../../../src/core/permissions/webSearch';

function makeCtx(
  services: SentinelServices = defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }),
): ClassifyContext {
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

function calendarAction(tool_name: string, server = 'google_calendar'): SentinelAction {
  return {
    tool_name,
    canonical_params: {},
    tool_type: 'truefoundry-system',
    mcp_server_name: server,
    mcp_hints: { read_only_hint: true, open_world_hint: true },
  };
}

describe('Calendar read classification', () => {
  it.each(['list_events', 'get_event'])('runs %s silently and flags it as a sensitive read', async name => {
    const ctx = makeCtx();
    const decision = await classifyTier(calendarAction(name), ctx);
    expect(decision).toMatchObject({
      tier: 1,
      reason: 'calendar_read',
      reason_detail: 'Read your calendar.',
      sensitive_read: true,
      card: null,
      auto_deny: null,
    });
    expect(hasReadPrivateData(ctx.web_search)).toBe(true);
  });

  it('reads in a scheduled run too', async () => {
    const decision = await classifyTier(
      calendarAction('list_events'),
      makeCtx(forUnattendedRun(defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }))),
    );
    expect(decision).toMatchObject({ tier: 1, sensitive_read: true, auto_deny: null });
  });

  it.each(['delete_event', 'quick_add', 'wipe_everything'])(
    'refuses %s: an unknown name fails closed without repeating it',
    async name => {
      const ctx = makeCtx();
      const decision = await classifyTier(calendarAction(name), ctx);
      expect(decision.reason_detail).toBe('Unknown calendar tool.');
      expect(decision.tier).not.toBe(1);
      expect(hasReadPrivateData(ctx.web_search)).toBe(false);
    },
  );

  it('does not give a connector tool of the same name the host path', async () => {
    const ctx = makeCtx();
    const decision = await classifyTier({ ...calendarAction('list_events', 'some_connector'), tool_type: 'mcp' }, ctx);
    expect(decision.reason).not.toBe('calendar_read');
    expect(hasReadPrivateData(ctx.web_search)).toBe(false);
  });

  it('is refused while offline', async () => {
    const services = {
      ...defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }),
      isOffline: () => Promise.resolve(true),
    };
    const decision = await classifyTier(calendarAction('list_events'), makeCtx(services));
    expect(decision.auto_deny).not.toBeNull();
  });
});

const REVIEW: CalendarWriteReview = {
  action: 'create',
  calendar: 'ada@example.com',
  title: 'Dentist',
  when: 'Monday, October 19, 2026, 9:00 am to 10:00 am',
  short_when: 'Mon Oct 19, 9:00 to 10:00 am',
  span_days: 1,
  already_created: false,
  time_zone: 'America/New_York',
  duration: '1 hour',
  location: '',
  description: '',
  attendees: [],
  guests_emailed: false,
  one_of_repeating: false,
  before: null,
  incomplete_reason: null,
};

function writeAction(review: CalendarWriteReview | undefined): SentinelAction {
  return {
    ...calendarAction('create_event'),
    canonical_params: { title: 'Dentist', review_hash: 'h1' },
    mcp_hints: { read_only_hint: false, destructive_hint: false, open_world_hint: true },
    calendar_write: review,
  };
}

describe('Calendar write classification', () => {
  it('always asks, with the event card and a token bound to the approved call', async () => {
    const ctx = makeCtx();
    const decision = await classifyTier(writeAction(REVIEW), ctx);
    expect(decision).toMatchObject({ tier: 3, reason: 'calendar_write', auto_deny: null, sensitive_read: false });
    expect(decision.card?.calendar_event?.title).toBe('Dentist');
    expect(decision.approval_token_id).not.toBeNull();
    expect(hasReadPrivateData(ctx.web_search)).toBe(false);
  });

  it('asks in a scheduled run too, so the run holds it for the owner instead of dropping it', async () => {
    const decision = await classifyTier(
      writeAction(REVIEW),
      makeCtx(forUnattendedRun(defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }))),
    );
    expect(decision).toMatchObject({ tier: 3, reason: 'calendar_write', auto_deny: null });
    expect(decision.card).not.toBeNull();
  });

  it('is refused when the event could not be shown', async () => {
    const decision = await classifyTier(writeAction(undefined), makeCtx());
    expect(decision.auto_deny).toBe('destination_unverifiable');
  });

  it('is refused while offline', async () => {
    const services = {
      ...defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }),
      isOffline: () => Promise.resolve(true),
    };
    const decision = await classifyTier(writeAction(REVIEW), makeCtx(services));
    expect(decision.auto_deny).toBe('offline_mode');
  });

  it('refuses a write whose guests would get something the card cannot show', async () => {
    const decision = await classifyTier(
      writeAction({ ...REVIEW, incomplete_reason: 'This event has a call link.' }),
      makeCtx(),
    );
    expect(decision).toMatchObject({ auto_deny: 'incomplete_send_card', reason_detail: 'This event has a call link.' });
  });

  it('runs the outbound secret guard over the event text when guests are emailed', async () => {
    const services = {
      ...defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }),
      outboundSecrets: () => Promise.resolve(['sk-synthetic-server-secret-0000']),
    };
    const leaking = {
      ...REVIEW,
      attendees: ['lin@example.com'],
      guests_emailed: true,
      description: 'Key: sk-synthetic-server-secret-0000',
    };
    expect((await classifyTier(writeAction(leaking), makeCtx(services))).auto_deny).toBe('outbound_guard');
    // Without an email to guests the text stays in the owner's own calendar.
    expect(
      (await classifyTier(writeAction({ ...leaking, guests_emailed: false }), makeCtx(services))).auto_deny,
    ).toBeNull();
  });
});

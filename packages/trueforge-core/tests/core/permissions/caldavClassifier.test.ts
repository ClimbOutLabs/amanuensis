import type { CaldavEventReview } from '../../../src/core/calendar/caldav/eventReview';
import { caldavResultNote } from '../../../src/core/permissions/caldavTier';
import { classifyTier, type ClassifyContext, type SentinelAction } from '../../../src/core/permissions/classifier';
import { defaultSentinelServices } from '../../../src/core/permissions/context';
import { createWebSearchTurnState } from '../../../src/core/permissions/webSearch';

function makeCtx(): ClassifyContext {
  return {
    services: defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }),
    tenant_id: 't1',
    created_by: 'u1',
    conversation_id: 'c1',
    repository_id: null,
    workspace_cwd: null,
    agent_intent: null,
    web_search: createWebSearchTurnState(),
  };
}

function caldavAction(
  tool_name: string,
  canonical_params: Record<string, unknown> = {},
  extra: Partial<SentinelAction> = {},
): SentinelAction {
  return {
    tool_name,
    canonical_params,
    tool_type: 'mcp',
    mcp_server_name: 'Calendar',
    mcp_first_party: true,
    mcp_hints: { read_only_hint: false, open_world_hint: false },
    ...extra,
  };
}

const DENTIST: CaldavEventReview = {
  id: 'ev1',
  title: 'Dentist',
  when: '22 Oct 2026, 14:00 (Europe/Berlin)',
  organizer: 'Office Admin',
  attendees: [],
};
const EVENT_ID = { id: 'ev1' };

describe('CalDAV read classification', () => {
  it.each(['list_calendars', 'list_events', 'get_event', 'search_events'])(
    'runs %s silently as a private read',
    async name => {
      const decision = await classifyTier(caldavAction(name, EVENT_ID), makeCtx());
      expect(decision).toMatchObject({ tier: 1, sensitive_read: true, card: null, auto_deny: null });
      expect(decision.reason_detail).toBe('Read your calendar.');
    },
  );

  it('marks the turn as having read private data', async () => {
    const ctx = makeCtx();
    await classifyTier(caldavAction('list_events'), ctx);
    expect(ctx.web_search.privateDataRead).toBe(true);
  });
});

describe('CalDAV respond_to_event', () => {
  it('is a silent check when there is no confirm token, because nothing changes yet', async () => {
    const decision = await classifyTier(
      caldavAction('respond_to_event', { ...EVENT_ID, response: 'ACCEPTED' }),
      makeCtx(),
    );
    expect(decision).toMatchObject({ tier: 1, card: null, reason: 'caldav_invitation_check' });
  });

  it('shows one card on the call that carries the token, naming the title and time', async () => {
    const decision = await classifyTier(
      caldavAction(
        'respond_to_event',
        { ...EVENT_ID, response: 'ACCEPTED', confirm_token: 'abc' },
        { caldav_event: DENTIST },
      ),
      makeCtx(),
    );
    expect(decision.tier).toBe(3);
    expect(decision.card?.plain_what).toBe(
      'Accept "Dentist", 22 Oct 2026, 14:00 (Europe/Berlin). The organizer, Office Admin, will be told. This reply goes to the event organizer, so Aman always asks.',
    );
    expect(decision.card?.cannot_be_undone).toBe("The reply to the organizer can't be unsent.");
    expect(decision.approval_token_id).toEqual(expect.any(String));
  });

  it('uses the right verb for a decline and a tentative answer', async () => {
    const declined = await classifyTier(
      caldavAction(
        'respond_to_event',
        { ...EVENT_ID, response: 'DECLINED', confirm_token: 'abc' },
        { caldav_event: DENTIST },
      ),
      makeCtx(),
    );
    const tentative = await classifyTier(
      caldavAction(
        'respond_to_event',
        { ...EVENT_ID, response: 'TENTATIVE', confirm_token: 'abc' },
        { caldav_event: DENTIST },
      ),
      makeCtx(),
    );
    expect(declined.card?.plain_what).toMatch(/^Decline "Dentist"/);
    expect(tentative.card?.plain_what).toMatch(/^Tentatively accept "Dentist"/);
  });

  it('shows the event id and says the title could not be read when the lookup failed', async () => {
    const decision = await classifyTier(
      caldavAction(
        'respond_to_event',
        { ...EVENT_ID, response: 'ACCEPTED', confirm_token: 'abc' },
        { caldav_event: null },
      ),
      makeCtx(),
    );
    expect(decision.card?.plain_what).toBe(
      'Accept the event with id ev1. Its title could not be read. The organizer will be told. Their name could not be read. This reply goes to the event organizer, so Aman always asks.',
    );
  });

  it('gives exactly one card across the two calls of one response', async () => {
    const ctx = makeCtx();
    const first = await classifyTier(caldavAction('respond_to_event', { ...EVENT_ID, response: 'ACCEPTED' }), ctx);
    const second = await classifyTier(
      caldavAction(
        'respond_to_event',
        { ...EVENT_ID, response: 'ACCEPTED', confirm_token: 'abc' },
        { caldav_event: DENTIST },
      ),
      ctx,
    );
    const cards = [first, second].filter(decision => decision.card !== null);
    expect(cards).toHaveLength(1);
  });
});

describe('CalDAV changes', () => {
  it('shows a create card with the title, time and calendar from the arguments', async () => {
    const decision = await classifyTier(
      caldavAction('create_event', { calendar_id: 'work', summary: 'Team sync', start: '2026-10-23T09:30:00+02:00' }),
      makeCtx(),
    );
    expect(decision.tier).toBe(3);
    expect(decision.card?.plain_what).toBe('Add "Team sync", 23 Oct 2026, 09:30 to "work".');
  });

  it('shows an update card that names the existing event', async () => {
    const decision = await classifyTier(
      caldavAction('update_event', { ...EVENT_ID, summary: 'Moved' }, { caldav_event: DENTIST }),
      makeCtx(),
    );
    expect(decision.tier).toBe(3);
    expect(decision.card?.plain_what).toBe(
      'Change "Dentist", 22 Oct 2026, 14:00 (Europe/Berlin). Aman always asks before changing an event in this calendar, because it cannot check who else is on it.',
    );
  });

  it('lists every field a create call writes in the outbound text, with the long description in full', async () => {
    const description = 'Bring the forms. '.repeat(400);
    const decision = await classifyTier(
      caldavAction('create_event', {
        calendar_id: 'work',
        summary: 'Team sync',
        start: '2026-10-23T09:30:00+02:00',
        end: '2026-10-23T10:00:00+02:00',
        timezone: 'Europe/Berlin',
        description,
        location: 'Room 4',
        categories: ['work'],
        status: 'TENTATIVE',
        transparent: true,
        recurrence: 'FREQ=WEEKLY;BYDAY=MO',
        alarms: [{ trigger: '-PT10M' }],
      }),
      makeCtx(),
    );
    expect(decision.tier).toBe(3);
    const text = decision.card?.outbound_text ?? '';
    for (const field of [
      'calendar_id: ',
      'summary: ',
      'start: ',
      'end: ',
      'timezone: ',
      'description: ',
      'location: ',
      'categories (array)',
      'status: ',
      'transparent (boolean)',
      'recurrence: ',
      'alarms (array)',
    ]) {
      expect(text).toContain(field);
    }
    expect(text).toContain(description.trim());
    expect(decision.card?.outbound_truncated).toBe(false);
  });

  it('lists the change fields of an update and leaves the confirm token out', async () => {
    const decision = await classifyTier(
      caldavAction(
        'update_event',
        { ...EVENT_ID, summary: 'Moved', location: 'Clinic B', confirm_token: 'abc' },
        { caldav_event: DENTIST },
      ),
      makeCtx(),
    );
    expect(decision.card?.outbound_text).toBe('id: ev1\nsummary: Moved\nlocation: Clinic B');
  });

  it('gives the generic card when a call writes a field the card does not list', async () => {
    const decision = await classifyTier(
      caldavAction('create_event', {
        calendar_id: 'work',
        summary: 'Team sync',
        start: '2026-10-23T09:30:00+02:00',
        attendees: [{ email: 'guest@example.com' }],
      }),
      makeCtx(),
    );
    expect(decision.tier).toBe(3);
    expect(decision.card?.plain_what).not.toMatch(/^Add /);
    expect(decision.card?.outbound_text).toContain('attendees');
    expect(decision.card?.outbound_text).toContain('guest@example.com');
  });

  it('gives the generic card for a stray field on an update, since the connector does not write it', async () => {
    const decision = await classifyTier(
      caldavAction('update_event', { ...EVENT_ID, calendar_id: 'home', summary: 'Moved' }, { caldav_event: DENTIST }),
      makeCtx(),
    );
    expect(decision.card?.plain_what).not.toMatch(/^Change /);
    expect(decision.card?.outbound_text).toContain('calendar_id');
  });

  it('gives the generic card when the arguments are too long to show in full', async () => {
    const decision = await classifyTier(
      caldavAction('create_event', {
        calendar_id: 'work',
        summary: 'Team sync',
        start: '2026-10-23T09:30:00+02:00',
        description: 'x'.repeat(25_000),
      }),
      makeCtx(),
    );
    expect(decision.card?.plain_what).not.toMatch(/^Add /);
  });

  it('names the guests an update would email, so the person sees who is told', async () => {
    const decision = await classifyTier(
      caldavAction(
        'update_event',
        { ...EVENT_ID, summary: 'Moved' },
        { caldav_event: { ...DENTIST, attendees: ['Sam Lee', 'dana@example.com'] } },
      ),
      makeCtx(),
    );
    expect(decision.card?.plain_what).toBe(
      'Change "Dentist", 22 Oct 2026, 14:00 (Europe/Berlin). Changing this will email: Sam Lee, dana@example.com. Aman always asks before changing an event in this calendar, because it cannot check who else is on it.',
    );
  });

  it('says anyone invited may be emailed when the guest list could not be read', async () => {
    const decision = await classifyTier(
      caldavAction(
        'update_event',
        { ...EVENT_ID, summary: 'Moved' },
        { caldav_event: { ...DENTIST, attendees: null } },
      ),
      makeCtx(),
    );
    expect(decision.card?.plain_what).toContain('The guest list could not be read, so anyone invited may be emailed.');
  });

  it('gives the generic card when a change would email more guests than the card can name', async () => {
    const attendees = Array.from({ length: 21 }, (_, index) => `guest${String(index)}@example.com`);
    const decision = await classifyTier(
      caldavAction('update_event', { ...EVENT_ID, summary: 'Moved' }, { caldav_event: { ...DENTIST, attendees } }),
      makeCtx(),
    );
    expect(decision.card?.plain_what).not.toMatch(/^Change /);
  });

  it('shows a delete card that names the guests and says a cancellation cannot be unsent', async () => {
    const decision = await classifyTier(
      caldavAction('delete_event', EVENT_ID, { caldav_event: { ...DENTIST, attendees: ['Sam Lee'] } }),
      makeCtx(),
    );
    expect(decision.card?.plain_what).toBe(
      'Delete "Dentist", 22 Oct 2026, 14:00 (Europe/Berlin). Deleting this will email: Sam Lee. Aman always asks before deleting an event in this calendar, because it cannot check who else is on it.',
    );
    expect(decision.card?.cannot_be_undone).toBe(
      "This removes the event from the calendar. It can't be restored from here. A cancellation sent to the guests can't be unsent.",
    );
  });

  it('shows a delete card with a warning that it cannot be restored from here', async () => {
    const decision = await classifyTier(caldavAction('delete_event', EVENT_ID, { caldav_event: DENTIST }), makeCtx());
    expect(decision.tier).toBe(3);
    expect(decision.card?.plain_what).toBe(
      'Delete "Dentist", 22 Oct 2026, 14:00 (Europe/Berlin). Aman always asks before deleting an event in this calendar, because it cannot check who else is on it.',
    );
    expect(decision.card?.cannot_be_undone).toBe(
      "This removes the event from the calendar. It can't be restored from here.",
    );
  });

  it('escapes a title that carries hidden characters or quotes', async () => {
    const decision = await classifyTier(
      caldavAction('delete_event', EVENT_ID, {
        caldav_event: { id: 'ev1', title: 'Say "hi"', when: null, organizer: null, attendees: [] },
      }),
      makeCtx(),
    );
    expect(decision.card?.plain_what).toContain('\\"hi\\"');
  });
});

describe('CalDAV fail-closed cases', () => {
  it('sends an unknown tool on the CalDAV connector to the generic card', async () => {
    const decision = await classifyTier(caldavAction('delete_calendar', { id: 'cal1' }), makeCtx());
    expect(decision.tier).toBe(3);
    expect(decision.card).not.toBeNull();
  });

  it('does not give the rules to a connector of the same name that is not first-party', async () => {
    const decision = await classifyTier(caldavAction('list_events', EVENT_ID, { mcp_first_party: false }), makeCtx());
    expect(decision.tier).toBe(3);
  });

  it('does not give the rules to a server with another name', async () => {
    const decision = await classifyTier(caldavAction('list_events', EVENT_ID, { mcp_server_name: 'other' }), makeCtx());
    expect(decision.tier).toBe(3);
  });
});

describe('caldavResultNote', () => {
  it('says the organizer was not told when the calendar sends no replies itself', () => {
    expect(
      caldavResultNote({ tool_name: 'respond_to_event', structured: { responded: true, scheduling: false } }),
    ).toBe(
      'Your answer is saved in the calendar. Your calendar does not send replies itself, so the organizer was not told.',
    );
  });

  it('adds nothing when the calendar sent the reply', () => {
    expect(caldavResultNote({ tool_name: 'respond_to_event', structured: { scheduling: true } })).toBeUndefined();
  });

  it('adds nothing to other tools', () => {
    expect(caldavResultNote({ tool_name: 'list_events', structured: { scheduling: false } })).toBeUndefined();
  });
});

import type { CalendarEvent } from '../../../src/core/calendar/calendarWire';
import {
  hashEventWrite,
  resolveCreate,
  resolveUpdate,
  type ResolvedEventWrite,
} from '../../../src/core/calendar/eventWrite';
import { CreateEventSchema, UpdateEventSchema } from '../../../src/core/calendar/toolContract';

const ACCOUNT = 'ada@example.com';

function create(args: Record<string, unknown>, zone = 'America/New_York') {
  return resolveCreate({ call: CreateEventSchema.parse(args), zone, account: ACCOUNT });
}

function update(args: Record<string, unknown>, existing: CalendarEvent, zone = 'America/New_York') {
  return resolveUpdate({ call: UpdateEventSchema.parse(args), zone, account: ACCOUNT, existing });
}

function ok(result: ResolvedEventWrite) {
  if (!result.ok) {
    throw new Error(`expected a resolved write, got ${result.error}`);
  }
  return result;
}

const STANDUP: CalendarEvent = {
  id: 'ev1',
  etag: '"e1"',
  status: 'confirmed',
  summary: 'Team sync',
  location: 'Room 4',
  start: { dateTime: '2026-10-19T13:00:00Z', timeZone: 'America/New_York' },
  end: { dateTime: '2026-10-19T14:00:00Z', timeZone: 'America/New_York' },
  organizer: { email: ACCOUNT, self: true },
};

describe('a new event', () => {
  it('reads local times in the zone, sends the offset and the zone, and says it in plain words', () => {
    const { request, review } = ok(
      create({ title: 'Dentist', start: '2026-10-19T09:00', end: '2026-10-19T10:30', location: '12 Main St' }),
    );
    expect(request).toEqual({
      calendar_id: 'primary',
      event_id: null,
      etag: null,
      send_updates: 'none',
      body: {
        summary: 'Dentist',
        start: { date: null, dateTime: '2026-10-19T09:00:00-04:00', timeZone: 'America/New_York' },
        end: { date: null, dateTime: '2026-10-19T10:30:00-04:00', timeZone: 'America/New_York' },
        location: '12 Main St',
        description: undefined,
        attendees: undefined,
      },
    });
    expect(review).toEqual({
      action: 'create',
      calendar: ACCOUNT,
      title: 'Dentist',
      when: 'Monday, October 19, 2026, 9:00 am to 10:30 am',
      short_when: 'Mon Oct 19, 9:00 to 10:30 am',
      span_days: 1,
      already_created: false,
      time_zone: 'America/New_York',
      duration: '1 hour 30 minutes',
      location: '12 Main St',
      description: '',
      attendees: [],
      guests_emailed: false,
      one_of_repeating: false,
      before: null,
      incomplete_reason: null,
    });
  });

  it('uses the zone it is given, half-hour offsets included, never UTC', () => {
    const { request } = ok(
      create({ title: 'Call', start: '2026-10-19T09:00', end: '2026-10-19T09:45' }, 'Asia/Kolkata'),
    );
    expect(request.body.start).toEqual({
      date: null,
      dateTime: '2026-10-19T09:00:00+05:30',
      timeZone: 'Asia/Kolkata',
    });
  });

  it('takes the offset in force on the day, across a clock change', () => {
    const { request } = ok(create({ title: 'Brunch', start: '2026-11-01T11:00', end: '2026-11-01T12:00' }));
    expect(request.body.start?.dateTime).toBe('2026-11-01T11:00:00-05:00');
  });

  it('refuses a time the clocks skip instead of moving it', () => {
    expect(create({ title: 'Early', start: '2027-03-14T02:30', end: '2027-03-14T03:30' })).toEqual({
      ok: false,
      error: '2027-03-14T02:30 does not exist in America/New_York because the clocks change then. Pick another time.',
    });
  });

  it('makes an all-day event from two dates, with the last day included and no zone shift', () => {
    const { request, review } = ok(
      create({ title: 'Trip', start: '2026-12-24', end: '2026-12-26' }, 'Pacific/Auckland'),
    );
    expect(request.body.start).toEqual({ date: '2026-12-24', dateTime: null, timeZone: null });
    expect(request.body.end).toEqual({ date: '2026-12-27', dateTime: null, timeZone: null });
    expect(review.when).toBe('Thursday, December 24, 2026 to Saturday, December 26, 2026, all day');
    expect(review.short_when).toBe('Thu Dec 24 to Sat Dec 26, all day');
    expect(review.span_days).toBe(3);
    expect(review.duration).toBe('3 days');
    expect(ok(create({ title: 'Holiday', start: '2026-12-25', end: '2026-12-25' })).review).toMatchObject({
      when: 'Friday, December 25, 2026, all day',
      duration: 'All day',
    });
  });

  it.each([
    [{ start: '2026-10-19', end: '2026-10-19T10:00' }, 'both as dates (all day) or both as local times'],
    [{ start: '2026-10-19T10:00', end: '2026-10-19T09:00' }, 'The end must be after the start.'],
    [{ start: '2026-10-20', end: '2026-10-19' }, 'The last day is before the first day.'],
    [{ start: '2026-10-19', end: '2028-10-19' }, 'An event can last 366 days at most.'],
  ])('refuses times that do not make an event: %j', (times, error) => {
    const result = create({ title: 'x', ...times });
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.error).toContain(error);
  });

  it('refuses a time with an offset, so the card and the event cannot disagree about the zone', () => {
    expect(
      CreateEventSchema.safeParse({ title: 'x', start: '2026-10-19T09:00:00-03:00', end: '2026-10-19T10:00' }).success,
    ).toBe(false);
  });

  it('lists every guest and sends the email choice the call made', () => {
    const { request, review } = ok(
      create({
        title: 'Planning',
        start: '2026-10-19T09:00',
        end: '2026-10-19T10:00',
        attendees: ['lin@example.com', 'sam@example.com', 'lin@example.com'],
        send_updates: 'all',
      }),
    );
    expect(request.send_updates).toBe('all');
    expect(request.body.attendees).toEqual([{ email: 'lin@example.com' }, { email: 'sam@example.com' }]);
    expect(review.attendees).toEqual(['lin@example.com', 'sam@example.com']);
    expect(review.guests_emailed).toBe(true);
  });

  it('requires an explicit email choice with guests, and sends none without guests', () => {
    expect(
      CreateEventSchema.safeParse({
        title: 'x',
        start: '2026-10-19T09:00',
        end: '2026-10-19T10:00',
        attendees: ['lin@example.com'],
      }).success,
    ).toBe(false);
    const { request } = ok(
      create({ title: 'x', start: '2026-10-19T09:00', end: '2026-10-19T10:00', send_updates: 'all' }),
    );
    expect(request.send_updates).toBe('none');
  });

  it('hashes everything that is sent', () => {
    const base = { title: 'Dentist', start: '2026-10-19T09:00', end: '2026-10-19T10:00' };
    const hash = hashEventWrite(ok(create(base)).request);
    expect(hashEventWrite(ok(create(base)).request)).toBe(hash);
    expect(hashEventWrite(ok(create({ ...base, title: 'Dentist!' })).request)).not.toBe(hash);
    expect(hashEventWrite(ok(create(base, 'America/Chicago')).request)).not.toBe(hash);
  });
});

describe('a change to an event', () => {
  it('moves an event keeping its length, and shows before and after', () => {
    const { request, review } = ok(update({ event_id: 'ev1', start: '2026-10-20T15:00' }, STANDUP));
    expect(request).toEqual({
      calendar_id: 'primary',
      event_id: 'ev1',
      etag: '"e1"',
      send_updates: 'none',
      body: {
        summary: undefined,
        start: { date: null, dateTime: '2026-10-20T15:00:00-04:00', timeZone: 'America/New_York' },
        end: { date: null, dateTime: '2026-10-20T16:00:00-04:00', timeZone: 'America/New_York' },
        location: undefined,
        description: undefined,
        attendees: undefined,
      },
    });
    expect(review).toMatchObject({
      action: 'change',
      title: 'Team sync',
      when: 'Tuesday, October 20, 2026, 3:00 pm to 4:00 pm',
      duration: '1 hour',
      location: 'Room 4',
      before: {
        title: 'Team sync',
        when: 'Monday, October 19, 2026, 9:00 am to 10:00 am',
        duration: '1 hour',
        location: 'Room 4',
      },
    });
  });

  it('renames without touching the times', () => {
    const { request, review } = ok(update({ event_id: 'ev1', title: 'Team sync (moved online)' }, STANDUP));
    expect(request.body).toMatchObject({ summary: 'Team sync (moved online)', start: undefined, end: undefined });
    expect(review.when).toBe('Monday, October 19, 2026, 9:00 am to 10:00 am');
  });

  it('keeps an all-day event all day when only its first day moves', () => {
    const trip: CalendarEvent = { ...STANDUP, start: { date: '2026-12-24' }, end: { date: '2026-12-27' } };
    const { request } = ok(update({ event_id: 'ev1', start: '2026-12-28' }, trip));
    expect(request.body.start).toEqual({ date: '2026-12-28', dateTime: null, timeZone: null });
    expect(request.body.end).toEqual({ date: '2026-12-31', dateTime: null, timeZone: null });
    expect(update({ event_id: 'ev1', start: '2026-12-28T09:00' }, trip)).toMatchObject({ ok: false });
  });

  it('refuses an event someone else organizes', () => {
    const invited = { ...STANDUP, organizer: { email: 'lead@example.com' } };
    expect(update({ event_id: 'ev1', title: 'x' }, invited)).toMatchObject({
      ok: false,
      error: expect.stringContaining('Someone else organizes this event'),
    });
  });

  it('needs an email choice when the event has guests, and lists them', () => {
    const withGuests: CalendarEvent = {
      ...STANDUP,
      attendees: [{ email: ACCOUNT, self: true }, { email: 'lin@example.com' }],
    };
    expect(update({ event_id: 'ev1', title: 'x' }, withGuests)).toMatchObject({ ok: false });
    const { request, review } = ok(update({ event_id: 'ev1', title: 'x', send_updates: 'all' }, withGuests));
    expect(request.send_updates).toBe('all');
    expect(review.attendees).toEqual(['lin@example.com']);
    expect(review.guests_emailed).toBe(true);
  });

  it('counts a guest with no address as a guest, so the email choice is still required and the card names them', () => {
    const withNoAddress: CalendarEvent = {
      ...STANDUP,
      attendees: [{ email: ACCOUNT, self: true }, { displayName: 'Lin' }],
    };
    expect(update({ event_id: 'ev1', title: 'x' }, withNoAddress)).toMatchObject({ ok: false });
    const { review } = ok(update({ event_id: 'ev1', title: 'x', send_updates: 'all' }, withNoAddress));
    expect(review.attendees).toEqual(['a guest with no address']);
    expect(review.guests_emailed).toBe(true);
  });

  it('says when only one date of a repeating event changes', () => {
    const occurrence = { ...STANDUP, id: 'ev1_20261019', recurringEventId: 'ev1' };
    expect(ok(update({ event_id: 'ev1_20261019', title: 'x' }, occurrence)).review.one_of_repeating).toBe(true);
  });

  it('binds the change to the version of the event that was shown', () => {
    const shown = ok(update({ event_id: 'ev1', title: 'x' }, STANDUP)).request;
    const later = ok(update({ event_id: 'ev1', title: 'x' }, { ...STANDUP, etag: '"e2"' })).request;
    expect(hashEventWrite(later)).not.toBe(hashEventWrite(shown));
  });

  it('refuses a whole repeating series, so only one event of it is ever changed', () => {
    const series = { ...STANDUP, recurrence: ['RRULE:FREQ=WEEKLY'] };
    expect(update({ event_id: 'ev1', title: 'x' }, series)).toMatchObject({
      ok: false,
      error: expect.stringContaining('whole repeating series'),
    });
  });

  it('shows the description guests will get, the one already there when the change keeps it', () => {
    const described = { ...STANDUP, description: 'Agenda: budget review.' };
    expect(ok(update({ event_id: 'ev1', title: 'x' }, described)).review.description).toBe('Agenda: budget review.');
  });

  it('marks the card incomplete when emailed guests would get a call link or files it cannot show', () => {
    const withCall: CalendarEvent = {
      ...STANDUP,
      hangoutLink: 'https://meet.example.com/abc',
      attendees: [{ email: ACCOUNT, self: true }, { email: 'lin@example.com' }],
    };
    expect(
      ok(update({ event_id: 'ev1', title: 'x', send_updates: 'all' }, withCall)).review.incomplete_reason,
    ).toContain('call link or attached files');
    expect(
      ok(update({ event_id: 'ev1', title: 'x', send_updates: 'none' }, withCall)).review.incomplete_reason,
    ).toBeNull();
  });

  it.each([{ description: '' }, { description: '   ' }, { location: ' ' }])(
    'refuses blank text that would wipe what the event has: %j',
    blank => {
      expect(UpdateEventSchema.safeParse({ event_id: 'ev1', ...blank }).success).toBe(false);
    },
  );

  it('refuses a change when Google did not list every guest, so the card never names fewer than it reaches', () => {
    const truncated: CalendarEvent = { ...STANDUP, attendeesOmitted: true };
    expect(update({ event_id: 'ev1', title: 'x', send_updates: 'none' }, truncated)).toMatchObject({
      ok: false,
      error: expect.stringContaining('did not list every guest'),
    });
  });
});

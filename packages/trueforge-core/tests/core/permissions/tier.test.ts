import { Tier3CalendarEventSchema, Tier3EmailSchema } from '../../../src/core/permissions/tier';

const EVENT = {
  action: 'create',
  calendar: 'me@example.com',
  title: 'Dentist',
  when: 'Fri Nov 6, 2:30 to 3:00 pm',
  time_zone: 'UTC',
  duration: '30 minutes',
  location: '',
  description: '',
  attendees: [],
  guests_line: '',
  one_of_repeating: false,
  before: null,
};

describe('Tier3CalendarEventSchema', () => {
  it.each([1, 2, 30])('accepts an event that runs over %s whole days', span_days => {
    expect(Tier3CalendarEventSchema.safeParse({ ...EVENT, span_days }).success).toBe(true);
  });

  it.each([0, -1, 1.5])('refuses %s days, since an event runs over at least one whole day', span_days => {
    expect(Tier3CalendarEventSchema.safeParse({ ...EVENT, span_days }).success).toBe(false);
  });

  it('accepts a card stored before the count was carried', () => {
    expect(Tier3CalendarEventSchema.safeParse(EVENT).success).toBe(true);
  });

  it('carries a guest line from a service that exists nowhere in the product, word for word', () => {
    const parsed = Tier3CalendarEventSchema.parse({
      ...EVENT,
      attendees: ['lin@example.com'],
      guests_line: 'Moonmail will email every guest about this.',
    });
    expect(parsed.guests_line).toBe('Moonmail will email every guest about this.');
  });

  it('reads a card stored before the guest line was carried as no line', () => {
    const stored: Record<string, unknown> = { ...EVENT };
    delete stored['guests_line'];
    expect(Tier3CalendarEventSchema.parse(stored).guests_line).toBe('');
  });
});

const EMAIL = {
  action: 'send',
  sent_from: { address: 'ada@moonmail.example', service: 'Moonmail' },
  to: [{ name: '', address: 'grace@example.com' }],
  cc: [],
  bcc: [],
  subject: 'Lease',
  body: 'Thursday works.',
  replaces: null,
  reply_in_thread: null,
  reply_to: null,
};

describe('Tier3EmailSchema', () => {
  it('carries the sending account of a service that exists nowhere in the product', () => {
    const parsed = Tier3EmailSchema.parse(EMAIL);
    expect(parsed.sent_from).toEqual({ address: 'ada@moonmail.example', service: 'Moonmail' });
  });

  it('reads a card stored before the sending account was recorded as not known', () => {
    const stored: Record<string, unknown> = { ...EMAIL };
    delete stored['sent_from'];
    expect(Tier3EmailSchema.parse(stored).sent_from).toBeNull();
  });
});

import { Tier3CalendarEventSchema } from '../../../src/core/permissions/tier';

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
  guests_emailed: false,
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
});

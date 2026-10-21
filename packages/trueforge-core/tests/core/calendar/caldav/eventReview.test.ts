import { caldavEventReviewFrom, formatCaldavWhen } from '../../../../src/core/calendar/caldav/eventReview';

describe('formatCaldavWhen', () => {
  it('reads the digits of a time and names its zone', () => {
    expect(formatCaldavWhen({ value: '2026-10-22T14:00:00+02:00', tzid: 'Europe/Berlin', all_day: false })).toBe(
      '22 Oct 2026, 14:00 (Europe/Berlin)',
    );
  });

  it('says all day for an all-day event', () => {
    expect(formatCaldavWhen({ value: '2026-10-22', all_day: true })).toBe('22 Oct 2026, all day');
  });

  it('returns null for a value it cannot read', () => {
    expect(formatCaldavWhen({ value: 'next tuesday', all_day: false })).toBeNull();
  });
});

describe('caldavEventReviewFrom', () => {
  it('takes the title and start of a get_event answer', () => {
    expect(
      caldavEventReviewFrom({
        id: 'ev1',
        result: { event: { summary: 'Dentist', start: { value: '2026-10-22T14:00:00+02:00', all_day: false } } },
      }),
    ).toEqual({ id: 'ev1', title: 'Dentist', when: '22 Oct 2026, 14:00', organizer: null });
  });

  it('names the organizer by name, or by address when there is no name', () => {
    const start = { value: '2026-10-22T14:00:00+02:00', all_day: false };
    expect(
      caldavEventReviewFrom({
        id: 'ev1',
        result: {
          event: { summary: 'Dentist', start, organizer: { name: 'Office Admin', email: 'admin@example.com' } },
        },
      }).organizer,
    ).toBe('Office Admin');
    expect(
      caldavEventReviewFrom({
        id: 'ev1',
        result: { event: { summary: 'Dentist', start, organizer: { email: 'admin@example.com' } } },
      }).organizer,
    ).toBe('admin@example.com');
  });

  it('leaves the title null when it is missing or blank', () => {
    expect(caldavEventReviewFrom({ id: 'ev1', result: { event: { summary: '   ' } } }).title).toBeNull();
  });

  it('returns nulls for an answer it does not recognize', () => {
    expect(caldavEventReviewFrom({ id: 'ev1', result: { nothing: true } })).toEqual({
      id: 'ev1',
      title: null,
      when: null,
      organizer: null,
    });
  });
});

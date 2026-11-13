import { findDeadline, looksLikeBill, saysPaid } from '../../../../src/runtime/noticing/deadlines';

describe('deadlines', () => {
  const received = new Date('2026-11-05T15:00:00.000Z');

  it('recognises bills and payments', () => {
    expect(looksLikeBill('Invoice 42: payment due soon')).toBe(true);
    expect(looksLikeBill('Lunch on Friday?')).toBe(false);
    expect(saysPaid('Thank you for your payment')).toBe(true);
    expect(saysPaid('Your invoice is ready')).toBe(false);
  });

  it('reads a date that follows a cue word, at the end of that day', () => {
    const due = findDeadline({ text: 'Amount due by November 7', received_at: received, timezone: 'UTC' });
    expect(due?.toISOString()).toBe('2026-11-07T23:59:00.000Z');
    expect(findDeadline({ text: 'Pay by 2026-11-09', received_at: received, timezone: 'UTC' })?.toISOString()).toBe(
      '2026-11-09T23:59:00.000Z',
    );
  });

  it('reads tomorrow after a cue, and ignores a date no cue points at', () => {
    expect(
      findDeadline({ text: 'Payment is due tomorrow', received_at: received, timezone: 'UTC' })?.toISOString(),
    ).toBe('2026-11-06T23:59:00.000Z');
    expect(findDeadline({ text: 'Invoice dated November 1', received_at: received, timezone: 'UTC' })).toBeUndefined();
  });

  it('moves a date with no year to the next one that has not passed', () => {
    const due = findDeadline({ text: 'due by January 3', received_at: received, timezone: 'UTC' });
    expect(due?.toISOString()).toBe('2027-01-03T23:59:00.000Z');
  });
});

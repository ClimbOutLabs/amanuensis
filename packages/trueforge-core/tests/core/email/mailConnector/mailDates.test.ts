import { mailDateInstant, resolveMailDates } from '../../../../src/core/email/mailConnector/mailDates';

describe('mailDateInstant', () => {
  it('reads a bare date as the start of that day in the zone', () => {
    expect(mailDateInstant({ text: '2026-10-28', zone: 'Asia/Kolkata' })).toBe('2026-10-27T18:30:00.000Z');
    expect(mailDateInstant({ text: '2026-10-28', zone: 'UTC' })).toBe('2026-10-28T00:00:00.000Z');
  });

  it('reads a bare date-time in the zone, keeping seconds and fractions', () => {
    expect(mailDateInstant({ text: '2026-10-28T08:00:00', zone: 'America/New_York' })).toBe('2026-10-28T12:00:00.000Z');
    expect(mailDateInstant({ text: '2026-10-28T08:00', zone: 'Asia/Tokyo' })).toBe('2026-10-27T23:00:00.000Z');
    expect(mailDateInstant({ text: '2026-10-28T08:15:30.25', zone: 'UTC' })).toBe('2026-10-28T08:15:30.250Z');
  });

  it('keeps a timestamp that has its own offset exactly as given', () => {
    for (const text of ['2026-10-28T08:00:00Z', '2026-10-28T08:00:00+05:30', '2026-10-28T08:00:00.000-07:00']) {
      expect(mailDateInstant({ text, zone: 'Asia/Kolkata' })).toBe(text);
    }
  });

  it('names no instant for text that is not a date', () => {
    for (const text of ['yesterday', '2026-13-45', '2026-02-30T08:00', '08:00', '', 'nonsenseZ']) {
      expect(mailDateInstant({ text, zone: 'UTC' })).toBeUndefined();
    }
  });
});

describe('resolveMailDates', () => {
  it('converts since and before, leaves other arguments alone, and falls back to UTC for an unknown zone', () => {
    const resolved = resolveMailDates({
      args: { since: '2026-10-28', before: '2026-10-29T10:00', page_size: 3, mailbox: 'INBOX' },
      time_zone: 'Not/AZone',
    });
    expect(resolved).toEqual({
      ok: true,
      args: { since: '2026-10-28T00:00:00.000Z', before: '2026-10-29T10:00:00.000Z', page_size: 3, mailbox: 'INBOX' },
    });
  });

  it('refuses garbage in plain words, naming the argument and what to give instead', () => {
    const resolved = resolveMailDates({ args: { since: 'last tuesday' }, time_zone: 'UTC' });
    expect(resolved).toEqual({
      ok: false,
      error:
        'since is not a date. Give it as a date like 2026-10-28 or a time like 2026-10-28T08:00:00, with or without a time zone offset.',
    });
  });

  it('leaves a value that is not text for the sidecar to judge', () => {
    expect(resolveMailDates({ args: { since: 42 }, time_zone: 'UTC' })).toEqual({ ok: true, args: { since: 42 } });
  });
});

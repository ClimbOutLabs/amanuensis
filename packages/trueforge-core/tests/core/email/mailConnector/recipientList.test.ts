import { mailRecipientsNotListed, normalizeMailAddress } from '../../../../src/core/email/mailConnector/recipientList';

describe('normalizeMailAddress', () => {
  it('trims and lowercases, so the same mailbox always matches itself', () => {
    expect(normalizeMailAddress('  Dana.Lee@Example.COM ')).toBe('dana.lee@example.com');
  });
});

describe('mailRecipientsNotListed', () => {
  it('returns nothing when every recipient is on the list, whatever the case', () => {
    expect(
      mailRecipientsNotListed({
        listed: ['DANA@example.com'],
        params: { to: [{ name: 'Dana Lee', email: 'dana@example.com' }], cc: ['dana@example.com'] },
      }),
    ).toEqual([]);
  });

  it('returns each unlisted address once, lowercased, in argument order', () => {
    expect(
      mailRecipientsNotListed({
        listed: ['dana@example.com'],
        params: { to: ['Sam@Example.com', 'dana@example.com'], cc: ['sam@example.com'], bcc: ['Pat@example.com'] },
      }),
    ).toEqual(['sam@example.com', 'pat@example.com']);
  });

  it('treats every recipient as new when there is no list at all', () => {
    expect(mailRecipientsNotListed({ listed: [], params: { to: ['dana@example.com'] } })).toEqual(['dana@example.com']);
  });

  it('reads only the sending fields, so the sender of a message is never counted', () => {
    expect(
      mailRecipientsNotListed({
        listed: ['dana@example.com'],
        params: { to: ['dana@example.com'], from: 'me@example.com', reply_to: 'other@example.com' },
      }),
    ).toEqual([]);
  });

  it('counts an entry it cannot read as an address as not listed, so it is shown on a card', () => {
    const unreadable = { display: 'no address here' };
    const result = mailRecipientsNotListed({ listed: ['dana@example.com'], params: { to: [unreadable] } });
    expect(result).toHaveLength(1);
    expect(result[0]).not.toBe('dana@example.com');
  });

  it('returns nothing when no recipient is given, so the caller decides how to refuse it', () => {
    expect(mailRecipientsNotListed({ listed: ['dana@example.com'], params: { subject: 'Hi' } })).toEqual([]);
  });
});

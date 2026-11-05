import { checkSender, domainsAlign } from '../../../../src/runtime/noticing/authenticationResults';
import { findDeadline, looksLikeBill, saysPaid } from '../../../../src/runtime/noticing/deadlines';

const FROM = 'dana@example.com';
const TRUSTED = ['mx.example.net'];

describe('checkSender', () => {
  it('verifies a DKIM pass signed for the From domain', () => {
    const header =
      'mx.example.net; dkim=pass header.d=example.com header.s=sel; spf=fail smtp.mailfrom=bounce@other.test';
    expect(checkSender({ from_address: FROM, headers: [header], trusted_servers: TRUSTED })).toEqual({
      verified: true,
      how: 'dkim',
    });
  });

  it('verifies an SPF pass for an aligned envelope domain', () => {
    const header = 'mx.example.net; spf=pass smtp.mailfrom=bounces@mail.example.com';
    expect(checkSender({ from_address: FROM, headers: [header], trusted_servers: TRUSTED })).toEqual({
      verified: true,
      how: 'spf',
    });
  });

  it('does not verify a pass for a different domain', () => {
    const header = 'mx.example.net; dkim=pass header.d=attacker.test; spf=pass smtp.mailfrom=x@attacker.test';
    expect(checkSender({ from_address: FROM, headers: [header], trusted_servers: TRUSTED }).verified).toBe(false);
  });

  it('does not verify a failing check', () => {
    expect(
      checkSender({
        from_address: FROM,
        headers: ['mx.example.net; dkim=fail header.d=example.com'],
        trusted_servers: TRUSTED,
      }).verified,
    ).toBe(false);
  });

  it('does not verify when the server added no header', () => {
    expect(checkSender({ from_address: FROM, headers: [], trusted_servers: TRUSTED }).verified).toBe(false);
  });

  it('reads only the topmost header, so a forged lower one cannot help', () => {
    const forged = 'mx.example.net; dkim=pass header.d=example.com';
    const real = 'mx.example.net; dkim=fail header.d=example.com';
    expect(checkSender({ from_address: FROM, headers: [real, forged], trusted_servers: TRUSTED }).verified).toBe(false);
  });

  it('ignores a header from a server that is not the receiving one', () => {
    const header = 'elsewhere.test; dkim=pass header.d=example.com';
    expect(checkSender({ from_address: FROM, headers: [header], trusted_servers: TRUSTED }).verified).toBe(false);
    expect(checkSender({ from_address: FROM, headers: [header], trusted_servers: undefined }).verified).toBe(true);
  });

  it('never aligns a bare top-level domain', () => {
    expect(domainsAlign({ left: 'com', right: 'example.com' })).toBe(false);
    expect(domainsAlign({ left: 'mail.example.com', right: 'example.com' })).toBe(true);
  });
});

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

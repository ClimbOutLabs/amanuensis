import { checkSender, domainsAlign } from '../../../../src/runtime/noticing/authenticationResults';

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
  });

  it('verifies nothing when no receiving server is trusted', () => {
    const header = 'mx.example.net; dkim=pass header.d=example.com';
    expect(checkSender({ from_address: FROM, headers: [header], trusted_servers: [] })).toEqual({
      verified: false,
      why: 'This mail source does not pass on sender checks.',
    });
  });

  it('is not fooled by a check written inside a quoted address', () => {
    const header = 'mx.example.net; spf=pass smtp.mailfrom="a;dkim=pass header.d=example.com x"@evil.test; dkim=none';
    expect(checkSender({ from_address: FROM, headers: [header], trusted_servers: TRUSTED }).verified).toBe(false);
  });

  it('is not fooled by a check written inside nested comments', () => {
    const header = 'mx.example.net; none (x (y) ; dkim=pass header.d=example.com )';
    expect(checkSender({ from_address: FROM, headers: [header], trusted_servers: TRUSTED }).verified).toBe(false);
  });

  it('still reads comments, quoted values and folded spacing the way servers write them', () => {
    const header =
      'mx.example.net (Postfix);\r\n dkim=pass (2048-bit key; unprotected) header.d=example.com header.s="sel 1";\r\n spf=softfail';
    expect(checkSender({ from_address: FROM, headers: [header], trusted_servers: TRUSTED })).toEqual({
      verified: true,
      how: 'dkim',
    });
  });

  it('never aligns a bare top-level domain or two sites under one public suffix', () => {
    expect(domainsAlign({ left: 'com', right: 'example.com' })).toBe(false);
    expect(domainsAlign({ left: 'mail.example.com', right: 'example.com' })).toBe(true);
    expect(domainsAlign({ left: 'attacker.github.io', right: 'github.io' })).toBe(false);
    expect(domainsAlign({ left: 'attacker.github.io', right: 'x.github.io' })).toBe(false);
    expect(domainsAlign({ left: 'mail.shop.co.uk', right: 'shop.co.uk' })).toBe(true);
    expect(domainsAlign({ left: 'evil.co.uk', right: 'shop.co.uk' })).toBe(false);
  });
});

import { checkSender, domainsAlign } from '../../../../src/runtime/noticing/authenticationResults';

const FROM = 'dana@example.com';
const TRUSTED = ['mx.example.net'];
const DMARC = 'dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=example.com';

function check(header: string, from_address = FROM) {
  return checkSender({ from_address, headers: [header], trusted_servers: TRUSTED });
}

describe('checkSender', () => {
  it('verifies a DKIM pass signed for the From domain, when DMARC passed for it too', () => {
    const header = `mx.example.net; dkim=pass header.d=example.com header.s=sel; spf=fail smtp.mailfrom=bounce@other.test; ${DMARC}`;
    expect(check(header)).toEqual({ verified: true, how: 'dkim' });
  });

  it('verifies an SPF pass for an aligned envelope domain, when DMARC passed for it too', () => {
    const header = `mx.example.net; spf=pass smtp.mailfrom=bounces@mail.example.com; ${DMARC}`;
    expect(check(header)).toEqual({ verified: true, how: 'spf' });
  });

  it('needs DMARC to pass for the From domain itself', () => {
    expect(check('mx.example.net; dkim=pass header.d=example.com').verified).toBe(false);
    expect(check('mx.example.net; dkim=pass header.d=example.com; dmarc=fail header.from=example.com').verified).toBe(
      false,
    );
    expect(
      check('mx.example.net; dkim=pass header.d=mail.example.com; dmarc=pass header.from=mail.example.com').verified,
    ).toBe(false);
  });

  it('reads only the first result of each method', () => {
    const header = `mx.example.net; dkim=fail header.d=example.com; dkim=pass header.d=example.com; dmarc=fail header.from=example.com; ${DMARC}`;
    expect(check(header).verified).toBe(false);
  });

  it('does not verify a pass for a different domain', () => {
    const header = `mx.example.net; dkim=pass header.d=attacker.test; spf=pass smtp.mailfrom=x@attacker.test; ${DMARC}`;
    expect(check(header).verified).toBe(false);
  });

  it('does not verify a failing check', () => {
    expect(check(`mx.example.net; dkim=fail header.d=example.com; ${DMARC}`).verified).toBe(false);
  });

  it('does not verify when the server added no header', () => {
    expect(checkSender({ from_address: FROM, headers: [], trusted_servers: TRUSTED }).verified).toBe(false);
  });

  it('reads only the topmost header, so a forged lower one cannot help', () => {
    const forged = `mx.example.net; dkim=pass header.d=example.com; ${DMARC}`;
    const real = 'mx.example.net; dkim=fail header.d=example.com; dmarc=fail header.from=example.com';
    expect(checkSender({ from_address: FROM, headers: [real, forged], trusted_servers: TRUSTED }).verified).toBe(false);
  });

  it('ignores a header from a server that is not the receiving one', () => {
    expect(check(`elsewhere.test; dkim=pass header.d=example.com; ${DMARC}`).verified).toBe(false);
  });

  it('verifies nothing when no receiving server is trusted', () => {
    const header = `mx.example.net; dkim=pass header.d=example.com; ${DMARC}`;
    expect(checkSender({ from_address: FROM, headers: [header], trusted_servers: [] })).toEqual({
      verified: false,
      why: 'This mail source does not pass on sender checks.',
    });
  });

  it('reads nothing from a header that echoes a quote or a backslash, since a sender can write those', () => {
    const quoted = `mx.example.net; spf=pass smtp.mailfrom="a;dkim=pass header.d=example.com x"@evil.test; ${DMARC}`;
    expect(check(quoted).verified).toBe(false);
    const escaped = `mx.example.net; dkim=pass header.d=example.com (a\\) b); ${DMARC}`;
    expect(check(escaped).verified).toBe(false);
  });

  it('is not fooled by a comment that echoed text closes early', () => {
    const header =
      'mx.google.com; spf=pass (google.com: domain of "a) ; dkim=pass header.d=boss.com ; x=("@evil.com designates 1.2.3.4 as permitted sender) smtp.mailfrom="a) ; dkim=pass header.d=boss.com ; x=("@evil.com';
    expect(
      checkSender({ from_address: 'boss@boss.com', headers: [header], trusted_servers: ['mx.google.com'] }).verified,
    ).toBe(false);
  });

  it('is not fooled by a check written inside nested comments', () => {
    const header = `mx.example.net; none (x (y) ; dkim=pass header.d=example.com ; ${DMARC} )`;
    expect(check(header).verified).toBe(false);
  });

  it('still reads comments and folded spacing the way servers write them', () => {
    const header = `mx.example.net (Postfix);\r\n dkim=pass (2048-bit key; unprotected) header.d=example.com header.s=sel1;\r\n spf=softfail;\r\n ${DMARC}`;
    expect(check(header)).toEqual({ verified: true, how: 'dkim' });
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

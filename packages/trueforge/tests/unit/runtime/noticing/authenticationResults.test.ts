import { checkSender } from '../../../../src/runtime/noticing/authenticationResults';

const FROM = 'dana@example.com';
const TRUSTED = ['mx.example.net'];
const DMARC = 'dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=example.com';

function check({ header, from_address = FROM }: { header: string; from_address?: string }) {
  return checkSender({ from_address, headers: [header], trusted_servers: TRUSTED });
}

describe('checkSender', () => {
  it('verifies a message whose DMARC check passed for the From domain', () => {
    const header = `mx.example.net; dkim=pass header.d=example.com header.s=sel; spf=fail smtp.mailfrom=bounce@other.test; ${DMARC}`;
    expect(check({ header })).toEqual({ verified: true, how: 'dmarc' });
  });

  it('verifies mail sent through a mail service whose own signature comes first', () => {
    const header = `mx.example.net; dkim=pass header.i=@sendgrid.net header.s=smtpapi; dkim=pass header.i=@example.com header.s=s1; spf=pass smtp.mailfrom=bounces+123@em.sendgrid.net; ${DMARC}`;
    expect(check({ header })).toEqual({ verified: true, how: 'dmarc' });
  });

  it('needs DMARC to pass for the From domain itself', () => {
    expect(check({ header: 'mx.example.net; dkim=pass header.d=example.com' }).verified).toBe(false);
    expect(
      check({ header: 'mx.example.net; dkim=pass header.d=example.com; dmarc=fail header.from=example.com' }).verified,
    ).toBe(false);
    expect(
      check({ header: 'mx.example.net; dkim=pass header.d=mail.example.com; dmarc=pass header.from=mail.example.com' })
        .verified,
    ).toBe(false);
  });

  it('reads nothing from a header with two DMARC results, since one could be echoed text', () => {
    expect(check({ header: `mx.example.net; dmarc=fail header.from=example.com; ${DMARC}` }).verified).toBe(false);
    expect(check({ header: `mx.example.net; ${DMARC}; dmarc=fail header.from=example.com` }).verified).toBe(false);
  });

  it('reads nothing from a header with a part it cannot read', () => {
    const header = 'mx.example.net; dmarc=pass header.from=evil.test x; dmarc=pass header.from=example.com';
    expect(check({ header }).verified).toBe(false);
    expect(check({ header: `mx.example.net; spf=pass smtp.mailfrom=a=b@example.com; ${DMARC}` }).verified).toBe(false);
  });

  it('reads a header that ends with a semicolon', () => {
    expect(check({ header: `mx.example.net; ${DMARC};` })).toEqual({ verified: true, how: 'dmarc' });
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
    expect(check({ header: `elsewhere.test; dkim=pass header.d=example.com; ${DMARC}` }).verified).toBe(false);
  });

  it('verifies nothing when no receiving server is trusted', () => {
    const header = `mx.example.net; dkim=pass header.d=example.com; ${DMARC}`;
    expect(checkSender({ from_address: FROM, headers: [header], trusted_servers: [] })).toEqual({
      verified: false,
      why: 'This mail source does not pass on sender checks.',
    });
  });

  it('reads nothing from a header that echoes a quote or a backslash, since a sender can write those', () => {
    const quoted = `mx.example.net; spf=pass smtp.mailfrom="a;dmarc=pass header.from=example.com x"@evil.test; dmarc=fail header.from=evil.test`;
    expect(check({ header: quoted }).verified).toBe(false);
    const escaped = `mx.example.net; dkim=pass header.d=example.com (a\\) b); ${DMARC}`;
    expect(check({ header: escaped }).verified).toBe(false);
  });

  it('is not fooled by a comment that echoed text closes early', () => {
    const echo = 'a) ; dmarc=pass header.from=boss.com ; x=y (b';
    const header = `mx.google.com; spf=pass (google.com: domain of ${echo} designates 1.2.3.4 as permitted sender) smtp.mailfrom=evil.com; dmarc=fail header.from=evil.com`;
    expect(
      checkSender({ from_address: 'boss@boss.com', headers: [header], trusted_servers: ['mx.google.com'] }).verified,
    ).toBe(false);
    const both = `mx.google.com; spf=pass (google.com: domain of ${echo} designates 1.2.3.4 as permitted sender) smtp.mailfrom=${echo}; dmarc=fail header.from=evil.com`;
    expect(
      checkSender({ from_address: 'boss@boss.com', headers: [both], trusted_servers: ['mx.google.com'] }).verified,
    ).toBe(false);
  });

  it('is not fooled by a check written inside nested comments', () => {
    const header = `mx.example.net; none (x (y) ; ${DMARC} )`;
    expect(check({ header }).verified).toBe(false);
  });

  it('still reads comments and folded spacing the way servers write them', () => {
    const header = `mx.example.net (Postfix);\r\n dkim=pass (2048-bit key; unprotected) header.d=example.com header.s=sel1;\r\n spf=softfail;\r\n ${DMARC}`;
    expect(check({ header })).toEqual({ verified: true, how: 'dmarc' });
  });
});

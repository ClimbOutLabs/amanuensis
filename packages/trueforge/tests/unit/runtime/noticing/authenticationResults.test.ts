import { checkSender } from '../../../../src/runtime/noticing/authenticationResults';

const FROM = 'dana@example.com';
const TRUSTED = ['mx.example.net'];
const DMARC = 'dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=example.com';

function check({ header, from_address = FROM }: { header: string; from_address?: string }) {
  return checkSender({ from_address, headers: [header], trusted_servers: TRUSTED });
}

function gmail({ header, from_address }: { header: string; from_address: string }) {
  return checkSender({ from_address, headers: [header], trusted_servers: ['mx.google.com'] });
}

/** Headers in the shape Gmail writes for mail sent through common services. Names and numbers are made up. */
const SENT_THROUGH = {
  sendgrid: {
    from: 'statements@bank.example',
    header: [
      'mx.google.com;',
      '       dkim=pass header.i=@sendgrid.net header.s=smtpapi header.b=Ab12Cd34;',
      '       dkim=pass header.i=@bank.example header.s=s1 header.b=Ef56Gh7+/8=;',
      '       spf=pass (google.com: domain of bounces+1234567-abcd-dana=example.com@em1234.bank.example designates 198.51.100.7 as permitted sender) smtp.mailfrom="bounces+1234567-abcd-dana=example.com@em1234.bank.example";',
      '       dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=bank.example',
    ].join('\r\n'),
  },
  mailchimp: {
    from: 'news@school.example',
    header: [
      'mx.google.com;',
      '       dkim=pass header.i=@mcsv.net header.s=k2 header.b=Q1w2E3r4;',
      '       dkim=pass header.i=@school.example header.s=k1 header.b=T5y6U7i8;',
      '       spf=pass (google.com: domain of bounce-mc.us5_1234567.987654-dana=example.com@mail42.suw11.mcsv.net designates 198.51.100.20 as permitted sender) smtp.mailfrom=bounce-mc.us5_1234567.987654-dana=example.com@mail42.suw11.mcsv.net;',
      '       dmarc=pass (p=NONE sp=NONE dis=NONE) header.from=school.example',
    ].join('\r\n'),
  },
  srs: {
    from: 'office@landlord.example',
    header: [
      'mx.google.com;',
      '       dkim=pass header.i=@landlord.example header.s=sel header.b=Zx9Cv8Bn;',
      '       arc=pass (i=1 spf=pass spfdomain=landlord.example dkim=pass dkdomain=landlord.example dmarc=pass fromdomain=landlord.example);',
      '       spf=pass (google.com: domain of srs0=ab12=tt=landlord.example=office@forward.example designates 203.0.113.9 as permitted sender) smtp.mailfrom="SRS0=ab12=TT=landlord.example=office@forward.example";',
      '       dmarc=pass (p=QUARANTINE sp=QUARANTINE dis=NONE) header.from=landlord.example',
    ].join('\r\n'),
  },
  googleGroups: {
    from: 'frontdesk@clinic.example',
    header: [
      'mx.google.com;',
      '       dkim=pass header.i=@clinic.example header.s=google header.b=Mn8Bv7Cx;',
      '       arc=pass (i=1 spf=pass spfdomain=clinic.example dkim=pass dkdomain=clinic.example dmarc=pass fromdomain=clinic.example);',
      '       spf=pass (google.com: domain of patients+bncBAABBQ6R2KZQMGQ@clinic.example designates 209.85.220.41 as permitted sender) smtp.mailfrom=patients+bncBAABBQ6R2KZQMGQ@clinic.example;',
      '       dmarc=pass (p=NONE sp=NONE dis=NONE) header.from=clinic.example',
    ].join('\r\n'),
  },
};

describe('checkSender', () => {
  it('verifies a message whose DMARC check passed for the From domain', () => {
    const header = `mx.example.net; dkim=pass header.d=example.com header.s=sel; spf=fail smtp.mailfrom=bounce@other.test; ${DMARC}`;
    expect(check({ header })).toEqual({ verified: true });
  });

  it.each(Object.entries(SENT_THROUGH))('verifies mail sent through %s, as Gmail writes it', (_service, sample) => {
    expect(gmail({ header: sample.header, from_address: sample.from })).toEqual({ verified: true });
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
    expect(check({ header: `mx.example.net; none; ${DMARC}` }).verified).toBe(false);
    expect(check({ header: `mx.example.net; spf=pass smtp.mailfrom="never closed; ${DMARC}` }).verified).toBe(false);
  });

  it('verifies mail whose tracking address merely looks like a check, such as one ending in .arc or -auth', () => {
    for (const recipient of ['john.arc', 'john-auth', 'john_spf', 'john.dkim']) {
      const header = `mx.google.com; spf=pass (google.com: domain of bounces+1-ab-${recipient}=gmail.com@em.bank.example designates 198.51.100.7 as permitted sender) smtp.mailfrom=bounces+1-ab-${recipient}=gmail.com@em.bank.example; dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=bank.example`;
      expect(gmail({ header, from_address: 'statements@bank.example' })).toEqual({ verified: true });
    }
  });

  it('reads a header that ends with a semicolon', () => {
    expect(check({ header: `mx.example.net; ${DMARC};` })).toEqual({ verified: true });
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

  describe('text the sender got echoed into a header with no DMARC result of its own', () => {
    const boss = (header: string) => gmail({ header, from_address: 'boss@boss.com' }).verified;

    it('is refused when it came in a HELO name', () => {
      expect(
        boss(
          'mx.google.com; spf=neutral (google.com: x is neither permitted nor denied by best guess record for domain of postmaster@x) smtp.helo=x;dmarc=pass()header.from=boss.com',
        ),
      ).toBe(false);
    });

    it('is refused when it came in an address in brackets', () => {
      expect(
        boss(
          'mx.google.com; spf=softfail (google.com: domain of transitioning a@[x;dmarc=pass()header.from=boss.com()y=] does not designate 192.0.2.4 as permitted sender) smtp.mailfrom=a@[x;dmarc=pass()header.from=boss.com()y=]',
        ),
      ).toBe(false);
    });

    it('is refused when it came in a quoted address, in the comment and the value alike', () => {
      const echo = '"a) ; dmarc=pass header.from=boss.com ; x=("@evil.example';
      expect(
        boss(
          `mx.google.com; spf=softfail (google.com: domain of transitioning ${echo} does not designate 192.0.2.4 as permitted sender) smtp.mailfrom=${echo}`,
        ),
      ).toBe(false);
      expect(boss('mx.google.com; spf=pass smtp.mailfrom="x dmarc=pass header.from=boss.com"@evil.example')).toBe(
        false,
      );
    });

    it('is refused when a value holds a check of its own', () => {
      expect(boss('mx.google.com; spf=pass smtp.mailfrom=a.header.from=boss.com@evil.example')).toBe(false);
      expect(boss('mx.google.com; spf=pass smtp.mailfrom=a-dmarc=pass@evil.example')).toBe(false);
    });

    it('is refused when it came in both the comment and the unquoted value', () => {
      // The `;` outside any quotes ends the result early, so the value's echo reads as a DMARC result of its own.
      const echo = 'a;dmarc=pass()header.from=boss.com;y=@evil.example';
      expect(
        boss(
          `mx.google.com; spf=softfail (google.com: domain of transitioning ${echo} does not designate 192.0.2.4 as permitted sender) smtp.mailfrom=${echo}`,
        ),
      ).toBe(false);
    });

    it('is refused when a raw quote inside the comment hides the echo from the reader', () => {
      // A comment has no quoted strings in RFC 5322, but one is read here so that a `)` in a quoted address cannot
      // close the comment. The quote pair then spans text a stricter reader would see, so `header.from=` showing up
      // twice is what refuses it.
      const echo = 'z"x);dmarc=pass()header.from=boss.com;y=@evil.example';
      expect(
        boss(
          `mx.google.com; spf=pass (google.com: domain of ${echo} designates 192.0.2.4 as permitted sender) smtp.mailfrom=${echo}`,
        ),
      ).toBe(false);
    });

    it('is refused when the echo writes header.from= with quotes in the name', () => {
      // The reader joins quoted pieces into one word, so `header."from"=` reads as `header.from=`.
      const echo = 'z"x);dmarc=pass()header."from"=boss.com;y=@evil.example';
      expect(
        boss(
          `mx.google.com; spf=pass (google.com: domain of ${echo} designates 192.0.2.4 as permitted sender) smtp.mailfrom=${echo}`,
        ),
      ).toBe(false);
      const plain = 'a;dmarc=pass()header."from"=boss.com;y=@evil.example';
      expect(
        boss(
          `mx.google.com; spf=softfail (google.com: domain of transitioning ${plain} does not designate 192.0.2.4 as permitted sender) smtp.mailfrom=${plain}`,
        ),
      ).toBe(false);
      expect(
        boss('mx.google.com; spf=pass smtp.mailfrom=a@x.example; dmarc=pass header.\\from=boss.com header."from"=x'),
      ).toBe(false);
    });

    it('is refused when header.from= appears more than once, whatever the header looks like', () => {
      expect(
        boss(
          'mx.google.com; spf=pass (google.com: header.from=boss.com) smtp.mailfrom=a@x.example; dmarc=pass header.from=boss.com',
        ),
      ).toBe(false);
    });

    it('is refused when a backslash stands outside a quoted string or comment', () => {
      expect(boss('mx.google.com; spf=pass smtp.mailfrom=a\\;dmarc=pass header.from=boss.com')).toBe(false);
    });
  });

  it('is not fooled by a comment that echoed text closes early', () => {
    const echo = 'a) ; dmarc=pass header.from=boss.com ; x=y (b';
    const header = `mx.google.com; spf=pass (google.com: domain of ${echo} designates 192.0.2.4 as permitted sender) smtp.mailfrom=evil.com; dmarc=fail header.from=evil.com`;
    expect(
      checkSender({ from_address: 'boss@boss.com', headers: [header], trusted_servers: ['mx.google.com'] }).verified,
    ).toBe(false);
  });

  it('is not fooled by a check written inside nested comments', () => {
    const header = `mx.example.net; spf=pass (x (y) ; ${DMARC} ) smtp.mailfrom=a@example.com`;
    expect(check({ header }).verified).toBe(false);
  });

  it('still reads comments, escapes inside them and folded spacing the way servers write them', () => {
    const header = `mx.example.net (Postfix);\r\n dkim=pass (2048-bit key; unprotected \\) still a comment) header.d=example.com header.s=sel1;\r\n spf=softfail;\r\n ${DMARC}`;
    expect(check({ header })).toEqual({ verified: true });
  });
});

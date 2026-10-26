import { hostMailMcpUrl, parseMailEmailMcpUrl, withMailSidecarOrigin } from '../../../src/config';

describe('MAIL_EMAIL_MCP_URL', () => {
  it('is unset when blank, so no sidecar is configured', () => {
    expect(parseMailEmailMcpUrl(undefined)).toBeUndefined();
    expect(parseMailEmailMcpUrl('   ')).toBeUndefined();
  });

  it('accepts the compose sidecar endpoint', () => {
    expect(parseMailEmailMcpUrl(' http://mail-email:9557/mcp ')).toBe('http://mail-email:9557/mcp');
  });

  it('refuses anything that is not an http(s) URL', () => {
    expect(() => parseMailEmailMcpUrl('mail-email:9557')).toThrow('MAIL_EMAIL_MCP_URL must be an http(s) URL');
    expect(() => parseMailEmailMcpUrl('ftp://mail-email/mcp')).toThrow('MAIL_EMAIL_MCP_URL must be an http(s) URL');
  });
});

describe('the sidecar origin is first-party when the sidecar is configured', () => {
  it('adds the sidecar origin to the listed origins once', () => {
    const origins = ['https://memory.internal:8443'];
    expect(withMailSidecarOrigin({ origins, mailUrl: 'http://mail-email:9557/mcp' })).toEqual([
      'https://memory.internal:8443',
      'http://mail-email:9557',
    ]);
    expect(
      withMailSidecarOrigin({ origins: ['http://mail-email:9557'], mailUrl: 'http://mail-email:9557/mcp' }),
    ).toEqual(['http://mail-email:9557']);
  });

  it('leaves the origins alone when no sidecar is configured', () => {
    expect(withMailSidecarOrigin({ origins: [], mailUrl: undefined })).toEqual([]);
  });
});

describe('the mail sidecar address the host owns', () => {
  it('is the installer link when it is set', () => {
    expect(hostMailMcpUrl({ mailMcpUrl: 'http://mail-email:9557/mcp', mailAccountUrl: 'http://other-host:9559' })).toBe(
      'http://mail-email:9557/mcp',
    );
  });

  it('is derived from the account agent address when there is no link', () => {
    expect(hostMailMcpUrl({ mailMcpUrl: undefined, mailAccountUrl: 'http://mail-email:9559' })).toBe(
      'http://mail-email:9557/mcp',
    );
  });

  it('is unset when neither is configured', () => {
    expect(hostMailMcpUrl({ mailMcpUrl: undefined, mailAccountUrl: undefined })).toBeUndefined();
  });
});

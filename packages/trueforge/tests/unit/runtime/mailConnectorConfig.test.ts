import { parseMailEmailMcpUrl } from '../../../src/config';

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

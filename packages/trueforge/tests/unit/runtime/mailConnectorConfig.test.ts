import {
  hostCalendarMcpUrl,
  hostMailMcpUrl,
  parseCalendarAccountUrl,
  parseCalendarConnectorUrl,
  parseMailEmailMcpUrl,
  withMailSidecarOrigin,
} from '../../../src/config';
import { isHostSidecar } from '../../../src/mcp/firstParty';

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

describe("a real install is recognised as the host's own", () => {
  // The installer writes these two lines into the instance's env file, and boot registers each connector at the same
  // value it reads back, so the stored record and the configured address match exactly.
  const INSTALLER_MAIL_LINE = 'http://mail-email:9557/mcp';
  const INSTALLER_CALENDAR_LINE = 'http://calendar-caldav:9558/mcp';

  it("treats the records boot registers from the installer's lines as the host's own Email and Calendar", () => {
    const mailUrl = hostMailMcpUrl({
      mailMcpUrl: parseMailEmailMcpUrl(INSTALLER_MAIL_LINE),
      mailAccountUrl: undefined,
    });
    const calendarUrl = hostCalendarMcpUrl({
      calendarMcpUrl: parseCalendarConnectorUrl(INSTALLER_CALENDAR_LINE),
      calendarAccountUrl: undefined,
    });

    expect(isHostSidecar({ name: 'Email', url: INSTALLER_MAIL_LINE, mailUrl, calendarUrl })).toBe(true);
    expect(isHostSidecar({ name: 'Calendar', url: INSTALLER_CALENDAR_LINE, mailUrl, calendarUrl })).toBe(true);
  });

  it("treats the record a saved account registers, with only the account agent linked, as the host's own Calendar", () => {
    // The installer writes CALENDAR_ACCOUNT_URL and no connector link.
    const calendarUrl = hostCalendarMcpUrl({
      calendarMcpUrl: parseCalendarConnectorUrl(undefined),
      calendarAccountUrl: parseCalendarAccountUrl('http://calendar-caldav:9560'),
    });

    expect(calendarUrl).toBe(INSTALLER_CALENDAR_LINE);
    expect(isHostSidecar({ name: 'Calendar', url: INSTALLER_CALENDAR_LINE, mailUrl: undefined, calendarUrl })).toBe(
      true,
    );
  });

  it("treats the record a saved account registers, with no installer link, as the host's own Email", () => {
    const mailUrl = hostMailMcpUrl({ mailMcpUrl: undefined, mailAccountUrl: 'http://mail-email:9559' });

    expect(isHostSidecar({ name: 'Email', url: mailUrl ?? '', mailUrl, calendarUrl: undefined })).toBe(true);
  });
});

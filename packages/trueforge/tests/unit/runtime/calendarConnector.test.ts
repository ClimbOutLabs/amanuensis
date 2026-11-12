import {
  firstPartyOriginsFor,
  hostCalendarMcpUrl,
  parseCalendarAccountSecret,
  parseCalendarAccountUrl,
  parseCalendarConnectorUrl,
} from '../../../src/config';
import {
  registerCalendarConnector,
  registerCalendarConnectorAtBoot,
  unregisterCalendarConnector,
} from '../../../src/runtime/calendarConnector';

const TENANT = 'tenant-1';
const URL = 'http://calendar-caldav:9558/mcp';

describe('CALENDAR_CONNECTOR_URL', () => {
  it('is unset when blank, so no calendar sidecar is configured', () => {
    expect(parseCalendarConnectorUrl(undefined)).toBeUndefined();
    expect(parseCalendarConnectorUrl('   ')).toBeUndefined();
  });

  it('accepts the compose sidecar endpoint', () => {
    expect(parseCalendarConnectorUrl(` ${URL} `)).toBe(URL);
  });

  it('refuses a value that is not an http(s) URL', () => {
    expect(() => parseCalendarConnectorUrl('calendar-caldav:9558/mcp')).toThrow(
      'CALENDAR_CONNECTOR_URL must be an http(s) URL',
    );
  });

  it('refuses a URL that carries credentials', () => {
    expect(() => parseCalendarConnectorUrl('http://user:pass@calendar-caldav:9558/mcp')).toThrow();
  });
});

describe('CALENDAR_ACCOUNT_SECRET', () => {
  it('is unset when blank, so the Settings Calendar card stays off', () => {
    expect(parseCalendarAccountSecret(undefined)).toBeUndefined();
    expect(parseCalendarAccountSecret('   ')).toBeUndefined();
  });

  it('accepts a secret of 32 characters or more, trimmed', () => {
    expect(parseCalendarAccountSecret(` ${'a'.repeat(32)} `)).toBe('a'.repeat(32));
  });

  it('refuses a secret the connector would refuse, and says what to do', () => {
    expect(() => parseCalendarAccountSecret('short')).toThrow('at least 32 characters');
  });
});

describe('CALENDAR_ACCOUNT_URL', () => {
  it('is unset when blank, so the Settings Calendar card is not offered', () => {
    expect(parseCalendarAccountUrl(undefined)).toBeUndefined();
    expect(parseCalendarAccountUrl('  ')).toBeUndefined();
  });

  it('accepts the compose sidecar account agent and refuses anything else', () => {
    expect(parseCalendarAccountUrl(' http://calendar-caldav:9560 ')).toBe('http://calendar-caldav:9560');
    expect(() => parseCalendarAccountUrl('calendar-caldav:9560')).toThrow(
      'CALENDAR_ACCOUNT_URL must be an http(s) URL',
    );
  });

  it('derives the tool endpoint from the account agent address when no link is configured', () => {
    expect(hostCalendarMcpUrl({ calendarMcpUrl: undefined, calendarAccountUrl: 'http://calendar-caldav:9560' })).toBe(
      URL,
    );
    expect(hostCalendarMcpUrl({ calendarMcpUrl: undefined, calendarAccountUrl: undefined })).toBeUndefined();
    expect(hostCalendarMcpUrl({ calendarMcpUrl: undefined, calendarAccountUrl: 'not a url' })).toBeUndefined();
  });

  it('prefers the configured link over the derived one', () => {
    expect(
      hostCalendarMcpUrl({
        calendarMcpUrl: 'http://own-host:9558/mcp',
        calendarAccountUrl: 'http://calendar-caldav:9560',
      }),
    ).toBe('http://own-host:9558/mcp');
  });

  it('makes the derived endpoint first-party, so the read-only calendar tools run without asking', () => {
    expect(
      firstPartyOriginsFor({
        raw: undefined,
        calendarUrl: hostCalendarMcpUrl({
          calendarMcpUrl: undefined,
          calendarAccountUrl: 'http://calendar-caldav:9560',
        }),
      }),
    ).toEqual(['http://calendar-caldav:9558']);
  });
});

describe('first-party origins with a calendar connector', () => {
  it('adds the calendar origin to the operator list', () => {
    expect(firstPartyOriginsFor({ raw: 'https://memory.internal:8443', calendarUrl: URL })).toEqual([
      'https://memory.internal:8443',
      'http://calendar-caldav:9558',
    ]);
  });

  it('keeps the list unchanged when no calendar connector is configured', () => {
    expect(firstPartyOriginsFor({ raw: undefined, calendarUrl: undefined })).toEqual([]);
  });

  it('does not repeat an origin already listed', () => {
    expect(firstPartyOriginsFor({ raw: 'http://calendar-caldav:9558', calendarUrl: URL })).toEqual([
      'http://calendar-caldav:9558',
    ]);
  });
});

describe('Calendar connector registration', () => {
  it('writes nothing when the sidecar is not configured', async () => {
    const upsertServer = jest.fn();
    await expect(
      registerCalendarConnector({ url: undefined, mcpServerStore: { upsertServer }, tenant_id: TENANT }),
    ).resolves.toBe('unconfigured');
    expect(upsertServer).not.toHaveBeenCalled();
  });

  it('registers the connector under the name Calendar, marked first-party, at the sidecar endpoint', async () => {
    const upsertServer = jest.fn().mockResolvedValue(undefined);
    await expect(
      registerCalendarConnector({ url: URL, mcpServerStore: { upsertServer }, tenant_id: TENANT }),
    ).resolves.toBe('registered');
    expect(upsertServer).toHaveBeenCalledWith({
      tenant_id: TENANT,
      name: 'Calendar',
      manifest: {
        type: 'remote',
        name: 'Calendar',
        url: URL,
        description: 'Reads and changes the calendars connected to this instance.',
      },
      first_party: true,
    });
  });

  it('logs a failure at boot and does not stop the server', async () => {
    const warn = jest.fn();
    const upsertServer = jest.fn().mockRejectedValue(new Error('database down'));
    await expect(
      registerCalendarConnectorAtBoot({
        url: URL,
        mcpServerStore: { upsertServer },
        tenant_id: TENANT,
        logger: { warn },
      }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith('Calendar connector could not be registered', expect.anything());
  });
});

describe('Calendar connector removal', () => {
  const ownRecord = { manifest: { type: 'remote', name: 'Calendar', url: URL, description: 'x' } };

  it('deletes the registration at the sidecar address under the name Calendar', async () => {
    const getServer = jest.fn().mockResolvedValue(ownRecord);
    const deleteServer = jest.fn().mockResolvedValue(true);
    await unregisterCalendarConnector({ url: URL, mcpServerStore: { getServer, deleteServer }, tenant_id: TENANT });
    expect(deleteServer).toHaveBeenCalledWith({ tenant_id: TENANT, name: 'Calendar' });
  });

  it('leaves a connector named Calendar at another address alone', async () => {
    const getServer = jest.fn().mockResolvedValue({
      manifest: { type: 'remote', name: 'Calendar', url: 'https://mine.example.invalid/mcp', description: 'x' },
    });
    const deleteServer = jest.fn();
    await unregisterCalendarConnector({ url: URL, mcpServerStore: { getServer, deleteServer }, tenant_id: TENANT });
    expect(deleteServer).not.toHaveBeenCalled();
  });

  it('removes nothing when there is no record, or the sidecar address is not known', async () => {
    const deleteServer = jest.fn();
    await unregisterCalendarConnector({
      url: URL,
      mcpServerStore: { getServer: jest.fn().mockResolvedValue(undefined), deleteServer },
      tenant_id: TENANT,
    });
    await unregisterCalendarConnector({
      url: undefined,
      mcpServerStore: { getServer: jest.fn().mockResolvedValue(ownRecord), deleteServer },
      tenant_id: TENANT,
    });
    expect(deleteServer).not.toHaveBeenCalled();
  });
});

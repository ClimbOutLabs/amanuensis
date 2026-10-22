import { firstPartyOriginsFor, parseCalendarConnectorUrl } from '../../../src/config';
import { registerCalendarConnector, registerCalendarConnectorAtBoot } from '../../../src/runtime/calendarConnector';

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

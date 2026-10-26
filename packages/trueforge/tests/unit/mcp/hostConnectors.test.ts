/**
 * The one rule for "the host's own Email or Calendar", read from the configured addresses: the names alone
 * never count, so a record that only carries the name is not set up and cannot take the name.
 */
import configuration from '../../../src/config';
import { isHostOwnConnector, reservedNameRefusalForHost, setUpConnectorNamesOf } from '../../../src/mcp/hostConnectors';

const MAIL_URL = 'http://mail-email:9557/mcp';
const CALENDAR_URL = 'http://[::1]:9558/mcp';

describe('the host\'s own connectors', () => {
  const original = { mail: configuration.MAIL_SIDECAR_MCP_URL, calendar: configuration.CALENDAR_CONNECTOR_URL };

  beforeEach(() => {
    configuration.MAIL_SIDECAR_MCP_URL = MAIL_URL;
    configuration.CALENDAR_CONNECTOR_URL = CALENDAR_URL;
  });

  afterAll(() => {
    configuration.MAIL_SIDECAR_MCP_URL = original.mail;
    configuration.CALENDAR_CONNECTOR_URL = original.calendar;
  });

  it('knows the sidecars by name and address together, IPv6 included', () => {
    expect(isHostOwnConnector({ name: 'Email', url: MAIL_URL })).toBe(true);
    expect(isHostOwnConnector({ name: 'Calendar', url: CALENDAR_URL })).toBe(true);
    expect(isHostOwnConnector({ name: 'Email', url: 'https://mail.example/mcp' })).toBe(false);
    expect(isHostOwnConnector({ name: 'Notes', url: MAIL_URL })).toBe(false);
  });

  it('counts a reserved name as set up only for the host\'s own sidecar', () => {
    const records = [
      { name: 'Email', manifest: { url: 'https://mail.example/mcp' } },
      { name: 'Calendar', manifest: { url: CALENDAR_URL } },
      { name: 'Notes', manifest: { url: 'https://notes.example/mcp' } },
    ];
    expect(setUpConnectorNamesOf(records)).toEqual(['Calendar', 'Notes']);
  });

  it('refuses a reserved name at any other address, and says what to do', () => {
    expect(reservedNameRefusalForHost({ name: 'Email', url: MAIL_URL })).toBeUndefined();
    expect(reservedNameRefusalForHost({ name: 'Email', url: 'https://mail.example/mcp' })).toMatch(
      /Give this connector another name\./,
    );
  });

  it('refuses a reserved name when the host has no sidecar set up', () => {
    configuration.MAIL_SIDECAR_MCP_URL = undefined;
    expect(reservedNameRefusalForHost({ name: 'Email', url: MAIL_URL })).toBeDefined();
  });
});

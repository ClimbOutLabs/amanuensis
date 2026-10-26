/**
 * The whole first-party policy as tables: which URLs fall on an origin the operator listed, and
 * which saves grant the mark. A change of policy is a change to these tables and to
 * `src/mcp/firstParty.ts`, nothing else.
 */
import {
  firstPartyAfterSave,
  isFirstPartyOrigin,
  isHostSidecar,
  isReservedConnectorName,
  normalizedOrigin,
  reservedNameRefusal,
} from '../../../src/mcp/firstParty';
import type { McpServerManifest } from '../../../src/schemas/mcpServer';

const LISTED_ORIGIN = 'https://memory.internal:8443';
const LISTED_URL = `${LISTED_ORIGIN}/mcp/aman`;
const ORIGINS = [LISTED_ORIGIN];

describe('normalizedOrigin', () => {
  it.each([
    ['https://memory.internal:8443/mcp/aman', 'https://memory.internal:8443'],
    ['HTTPS://Memory.Internal:8443/mcp/aman?x=1#y', 'https://memory.internal:8443'],
    ['https://memory.internal:443/mcp/aman', 'https://memory.internal'],
    ['http://memory.internal:80', 'http://memory.internal'],
    ['http://[::1]:8080/mcp/aman', 'http://[::1]:8080'],
  ])('reduces %s to its origin', (url, origin) => {
    expect(normalizedOrigin(url)).toBe(origin);
  });

  it.each([
    ['text that is not a URL', 'memory.internal:8443'],
    ['a relative path', '/mcp/aman'],
    ['a scheme other than http and https', 'ftp://memory.internal:8443/mcp/aman'],
    ['credentials before the host', 'https://user:secret@memory.internal:8443/mcp/aman'],
    ['a user name before the host', 'https://user@memory.internal:8443/mcp/aman'],
  ])('has no origin for %s', (_label, url) => {
    expect(normalizedOrigin(url)).toBeUndefined();
  });
});

describe('isFirstPartyOrigin', () => {
  it.each([
    ['the listed origin', LISTED_URL, true],
    ['the listed origin with another path, a query and a fragment', `${LISTED_ORIGIN}/mcp/other/?x=1#y`, true],
    ['the listed origin in another letter case', 'HTTPS://Memory.Internal:8443/mcp/aman', true],
    ['a host the operator did not list', 'https://attacker.example/mcp/aman', false],
    ['the listed host on another port', 'https://memory.internal:9443/mcp/aman', false],
    ['the listed host on the default port', 'https://memory.internal/mcp/aman', false],
    ['the listed host over http', 'http://memory.internal:8443/mcp/aman', false],
    ['a host whose name ends with the listed host', 'https://evil-memory.internal:8443/mcp/aman', false],
    ['a subdomain of the listed host', 'https://sub.memory.internal:8443/mcp/aman', false],
    ['a host whose name starts with the listed host', 'https://memory.internal.attacker.example:8443/mcp/aman', false],
    ['the listed host with a trailing dot', 'https://memory.internal.:8443/mcp/aman', false],
    [
      'the listed origin written before an @ that hides the real host',
      `${LISTED_ORIGIN}@attacker.example/mcp/aman`,
      false,
    ],
    ['the listed host with credentials in front of it', 'https://user@memory.internal:8443/mcp/aman', false],
    ['a backslash that hides the real host', 'https://attacker.example\\@memory.internal:8443/mcp/aman', false],
    ['a URL that is not absolute', '/mcp/aman', false],
    ['a scheme other than http and https', 'ftp://memory.internal:8443/mcp/aman', false],
  ])('%s', (_label, url, expected) => {
    expect(isFirstPartyOrigin({ url, origins: ORIGINS })).toBe(expected);
  });

  it('matches nothing when the operator listed nothing', () => {
    expect(isFirstPartyOrigin({ url: LISTED_URL, origins: [] })).toBe(false);
  });

  it('matches any one of several listed origins', () => {
    const origins = ['https://one.internal', LISTED_ORIGIN];

    expect(isFirstPartyOrigin({ url: 'https://one.internal/mcp/a', origins })).toBe(true);
    expect(isFirstPartyOrigin({ url: LISTED_URL, origins })).toBe(true);
    expect(isFirstPartyOrigin({ url: 'https://two.internal/mcp/a', origins })).toBe(false);
  });
});

function remote(overrides: { url?: string; memory_provider?: boolean } = {}): McpServerManifest {
  return {
    type: 'remote',
    name: 'memory',
    url: overrides.url ?? LISTED_URL,
    description: 'Memory connector.',
    ...(overrides.memory_provider === undefined ? {} : { memory_provider: overrides.memory_provider }),
  };
}

const gatewayManifest: McpServerManifest = {
  type: 'truefoundry',
  name: 'memory',
  url: LISTED_URL,
  description: 'Gateway connector.',
};

describe('firstPartyAfterSave', () => {
  it.each([
    ['a memory provider on a listed origin whose check passed', remote({ memory_provider: true }), true, ORIGINS, true],
    [
      'a memory provider moved to another bank on the listed origin',
      remote({ url: `${LISTED_ORIGIN}/mcp/other`, memory_provider: true }),
      true,
      ORIGINS,
      true,
    ],
    [
      'a memory provider on an origin the operator did not list',
      remote({ url: 'https://attacker.example/mcp/aman', memory_provider: true }),
      true,
      ORIGINS,
      false,
    ],
    [
      'a memory provider on a lookalike of the listed origin',
      remote({ url: 'https://memory.internal:9443/mcp/aman', memory_provider: true }),
      true,
      ORIGINS,
      false,
    ],
    ['a memory provider when the operator listed nothing', remote({ memory_provider: true }), true, [], false],
    [
      'a memory provider whose check did not pass in this save',
      remote({ memory_provider: true }),
      false,
      ORIGINS,
      false,
    ],
    ['a connector added by URL on a listed origin', remote(), true, ORIGINS, false],
    ['a connector whose memory provider designation is off', remote({ memory_provider: false }), true, ORIGINS, false],
  ] as const)('%s', (_label, manifest, memoryProviderChecked, origins, expected) => {
    expect(firstPartyAfterSave({ manifest, memoryProviderChecked, origins })).toBe(expected);
  });

  it('never marks a gateway-managed manifest', () => {
    expect(firstPartyAfterSave({ manifest: gatewayManifest, memoryProviderChecked: true, origins: ORIGINS })).toBe(
      false,
    );
  });
});

describe('isHostSidecar', () => {
  const HOST = { mailUrl: 'http://mail-email:9557/mcp', calendarUrl: 'http://[::1]:9558/mcp' };

  it.each([
    ['Email at the mail address', 'Email', 'http://mail-email:9557/mcp', true],
    ['Email at the mail address in another letter case', 'Email', 'HTTP://Mail-Email:9557/mcp', true],
    ['Calendar at an IPv6 address', 'Calendar', 'http://[::1]:9558/mcp', true],
    ['Calendar at the same IPv6 address written out in full', 'Calendar', 'http://[0:0:0:0:0:0:0:1]:9558/mcp', true],
    ['Calendar at another IPv6 address', 'Calendar', 'http://[::2]:9558/mcp', false],
    ['Calendar at the IPv6 address on another port', 'Calendar', 'http://[::1]:9559/mcp', false],
    ['Calendar at the IPv4 address that looks the same', 'Calendar', 'http://127.0.0.1:9558/mcp', false],
    ['Email at the calendar address', 'Email', 'http://[::1]:9558/mcp', false],
    ['another name at the mail address', 'My mail', 'http://mail-email:9557/mcp', false],
    ['Email in lower case at the mail address', 'email', 'http://mail-email:9557/mcp', false],
  ])('%s', (_label, name, url, expected) => {
    expect(isHostSidecar({ name, url, ...HOST })).toBe(expected);
  });

  it('trusts nothing when the host has no sidecar set up', () => {
    expect(
      isHostSidecar({ name: 'Email', url: 'http://mail-email:9557/mcp', mailUrl: undefined, calendarUrl: undefined }),
    ).toBe(false);
  });
});

describe('reserved connector names', () => {
  const HOST = { mailUrl: 'http://mail-email:9557/mcp', calendarUrl: undefined };

  it.each([
    ['Email', true],
    ['Calendar', true],
    ['email', false],
    ['Email ', false],
    ['My calendar', false],
  ])('%s is reserved: %s', (name, reserved) => {
    expect(isReservedConnectorName(name)).toBe(reserved);
  });

  it('lets the host\'s own sidecar and any other name through', () => {
    expect(reservedNameRefusal({ name: 'Email', url: 'http://mail-email:9557/mcp', ...HOST })).toBeUndefined();
    expect(reservedNameRefusal({ name: 'Notes', url: 'https://notes.example/mcp', ...HOST })).toBeUndefined();
  });

  it.each([
    ['Email', 'https://mail.example/mcp', 'email'],
    ['Calendar', 'http://[::1]:9558/mcp', 'calendar'],
  ])('refuses %s at another address, in words that say what to do next', (name, url, thing) => {
    const refusal = reservedNameRefusal({ name, url, ...HOST });
    expect(refusal).toContain(`"${name}"`);
    expect(refusal).toContain('Give this connector another name.');
    expect(refusal).toContain(`connect your ${thing}, use Settings`);
  });
});

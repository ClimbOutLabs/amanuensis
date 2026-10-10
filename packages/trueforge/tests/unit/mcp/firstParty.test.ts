/**
 * The whole first-party policy as a table: which saves grant the mark, which keep it, and which
 * clear it. A change of policy is a change to this table and to `firstPartyAfterSave`, nothing else.
 */
import type { McpServerRecord } from '../../../src/db/mcpServerStore';
import { firstPartyAfterSave } from '../../../src/mcp/firstParty';
import type { McpServerManifest } from '../../../src/schemas/mcpServer';

const MEMORY_URL = 'https://hindsight.example.com/mcp/aman';
const MOVED_URL = 'https://hindsight.example.com/mcp/other';

function remote(overrides: { url?: string; memory_provider?: boolean } = {}): McpServerManifest {
  return {
    type: 'remote',
    name: 'memory',
    url: overrides.url ?? MEMORY_URL,
    description: 'Memory connector.',
    ...(overrides.memory_provider === undefined ? {} : { memory_provider: overrides.memory_provider }),
  };
}

function stored(manifest: McpServerManifest, firstParty: boolean): McpServerRecord {
  return {
    id: 'mcp-1',
    tenant_id: 'default',
    name: 'memory',
    manifest,
    first_party: firstParty,
    created_at: '2026-10-10T00:00:00.000Z',
    updated_at: '2026-10-10T00:00:00.000Z',
  };
}

const gatewayManifest: McpServerManifest = {
  type: 'truefoundry',
  name: 'memory',
  url: MEMORY_URL,
  description: 'Gateway connector.',
};

describe('firstPartyAfterSave', () => {
  it.each([
    ['a new connector saved as the memory provider', remote({ memory_provider: true }), undefined, true],
    [
      'a connector added by URL that is now saved as the memory provider',
      remote({ memory_provider: true }),
      stored(remote(), false),
      true,
    ],
    [
      'a connector whose designation is switched on again at a new URL',
      remote({ url: MOVED_URL, memory_provider: true }),
      stored(remote({ memory_provider: false }), false),
      true,
    ],
    [
      'a first-party provider saved again at the same URL',
      remote({ memory_provider: true }),
      stored(remote({ memory_provider: true }), true),
      true,
    ],
    [
      'a first-party provider saved at a new URL',
      remote({ url: MOVED_URL, memory_provider: true }),
      stored(remote({ memory_provider: true }), true),
      false,
    ],
    [
      'a first-party provider saved without the designation',
      remote(),
      stored(remote({ memory_provider: true }), true),
      false,
    ],
    [
      'a provider that was never first-party, saved again at the same URL',
      remote({ memory_provider: true }),
      stored(remote({ memory_provider: true }), false),
      false,
    ],
    ['a new connector added by URL', remote(), undefined, false],
    ['a connector added by URL, saved again', remote(), stored(remote(), false), false],
  ] as const)('%s', (_label, manifest, existing, expected) => {
    expect(firstPartyAfterSave({ manifest, stored: existing, memoryProviderChecked: true })).toBe(expected);
  });

  it('grants nothing when this save did not pass the memory provider check', () => {
    expect(
      firstPartyAfterSave({ manifest: remote({ memory_provider: true }), stored: undefined, memoryProviderChecked: false }),
    ).toBe(false);
    expect(
      firstPartyAfterSave({
        manifest: remote({ memory_provider: true }),
        stored: stored(remote({ memory_provider: true }), true),
        memoryProviderChecked: false,
      }),
    ).toBe(false);
  });

  it('never marks a gateway-managed manifest', () => {
    expect(firstPartyAfterSave({ manifest: gatewayManifest, stored: undefined, memoryProviderChecked: true })).toBe(
      false,
    );
  });
});

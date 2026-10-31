import { isHostVouchedRead, isReadOnlyCall } from '../../../src/core/mcp/executeToolCalls';

const NO_HINTS = {
  effect: undefined,
  read_only_hint: undefined,
  search_provider_call: undefined,
  tier_reason: undefined,
};

describe('isReadOnlyCall', () => {
  it('treats host-classified inspections and declared read-only tools as reads', () => {
    expect(isReadOnlyCall({ ...NO_HINTS, effect: 'inspect' })).toBe(true);
    expect(isReadOnlyCall({ ...NO_HINTS, read_only_hint: true })).toBe(true);
  });

  it('treats a search provider call the classifier ran as a search as a read, held or silent', () => {
    expect(
      isReadOnlyCall({ ...NO_HINTS, search_provider_call: true, tier_reason: 'mcp_search_setting_ask' }),
    ).toBe(true);
    expect(isReadOnlyCall({ ...NO_HINTS, search_provider_call: true, tier_reason: 'mcp_search_provider' })).toBe(true);
  });

  it('counts a change, a provider tool outside the search rules, and missing metadata as changes', () => {
    expect(isReadOnlyCall({ ...NO_HINTS, effect: 'edit', read_only_hint: true })).toBe(false);
    expect(isReadOnlyCall({ ...NO_HINTS, read_only_hint: false })).toBe(false);
    expect(isReadOnlyCall({ ...NO_HINTS, search_provider_call: true, tier_reason: 'connector_send' })).toBe(false);
    expect(isReadOnlyCall({ ...NO_HINTS, tier_reason: 'mcp_search_setting_ask' })).toBe(false);
    expect(isReadOnlyCall(NO_HINTS)).toBe(false);
  });
});

describe('isHostVouchedRead', () => {
  it('vouches only for search provider reads and maps lookups the host classified', () => {
    expect(isHostVouchedRead({ search_provider_call: true, tier_reason: 'mcp_search_setting_ask' })).toBe(true);
    expect(isHostVouchedRead({ search_provider_call: true, tier_reason: 'mcp_search_provider' })).toBe(true);
    expect(isHostVouchedRead({ search_provider_call: undefined, tier_reason: 'maps_tool' })).toBe(true);
  });

  it('does not vouch for a server that only claims its tool is read-only', () => {
    expect(isHostVouchedRead({ search_provider_call: undefined, tier_reason: 'mcp_destructive_hint' })).toBe(false);
    expect(isHostVouchedRead({ search_provider_call: undefined, tier_reason: 'unrecognized_tool' })).toBe(false);
    expect(isHostVouchedRead({ search_provider_call: undefined, tier_reason: 'mcp_search_setting_ask' })).toBe(false);
    expect(isHostVouchedRead({ search_provider_call: undefined, tier_reason: undefined })).toBe(false);
  });
});

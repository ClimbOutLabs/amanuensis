import {
  createWebSearchTurnState,
  recordResultUrls,
  remoteImageAskReason,
  SILENT_SEARCH_LIMIT,
} from '../../../src/core/permissions/webSearch';

function stateWithResults(texts: string[]) {
  const state = createWebSearchTurnState();
  recordResultUrls({ state, texts });
  return state;
}

const returned = 'https://example.com/photos/harbor.png';
const base = {
  url: returned,
  searchWithoutAsking: true,
  guardPassed: true,
  silentShown: 0,
};

describe('remoteImageAskReason', () => {
  it('loads silently only when the link is exactly one a search returned', () => {
    const state = stateWithResults([JSON.stringify({ results: [{ url: returned }] })]);
    expect(remoteImageAskReason({ ...base, state })).toBeNull();
    expect(remoteImageAskReason({ ...base, url: `${returned}?u=1`, state })).toBe('mcp_search_unreturned_url');
    expect(remoteImageAskReason({ ...base, url: 'https://example.org/harbor.png', state })).toBe(
      'mcp_search_unreturned_url',
    );
  });

  it('asks when there were no searches this turn', () => {
    expect(remoteImageAskReason({ ...base, state: createWebSearchTurnState() })).toBe('mcp_search_unreturned_url');
  });

  it('asks when searches are set to ask, the guard trips, or the turn used its allowance', () => {
    const state = stateWithResults([returned]);
    expect(remoteImageAskReason({ ...base, searchWithoutAsking: false, state })).toBe('mcp_search_setting_ask');
    expect(remoteImageAskReason({ ...base, guardPassed: false, state })).toBe('mcp_search_guard');
    expect(remoteImageAskReason({ ...base, silentShown: SILENT_SEARCH_LIMIT, state })).toBe('mcp_search_limit');
  });
});

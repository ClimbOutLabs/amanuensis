import { searchProviderLabel } from '../../../src/core/permissions/searchHoldText';

describe('searchProviderLabel', () => {
  it('names the brand for the Tavily connector and API hosts', () => {
    expect(searchProviderLabel({ host: 'mcp.tavily.com' })).toBe('Tavily');
    expect(searchProviderLabel({ host: 'api.tavily.com' })).toBe('Tavily');
  });

  it('names Parallel for its search host', () => {
    expect(searchProviderLabel({ host: 'search.parallel.ai' })).toBe('Parallel');
  });

  it('gives no name for any other host, so no connector id or host reaches the person', () => {
    expect(searchProviderLabel({ host: 'search.example.com' })).toBeUndefined();
    expect(searchProviderLabel({ host: undefined })).toBeUndefined();
  });
});

import { searchProviderLabel } from '../../../src/core/permissions/searchHoldText';

describe('searchProviderLabel', () => {
  it('names the brand for the Tavily connector and API hosts', () => {
    expect(searchProviderLabel({ host: 'mcp.tavily.com', name: 'tavily' })).toBe('Tavily');
    expect(searchProviderLabel({ host: 'api.tavily.com', name: 'tavily' })).toBe('Tavily');
  });

  it('names Parallel for its search host, whatever the connector is called', () => {
    expect(searchProviderLabel({ host: 'search.parallel.ai', name: 'parallel-web' })).toBe('Parallel');
  });

  it('falls back to the connector name for any other host, never the host itself', () => {
    expect(searchProviderLabel({ host: 'search.example.com', name: 'my-search' })).toBe('my-search');
  });

  it('falls back to a plain phrase when neither host nor name is known', () => {
    expect(searchProviderLabel({ host: undefined, name: undefined })).toBe('the search provider');
  });
});

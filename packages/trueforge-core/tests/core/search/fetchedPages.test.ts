import { FetchedPageStore } from '../../../src/core/search/fetchedPages';

describe('FetchedPageStore', () => {
  it('stamps the fetch time itself and returns the page text as stored', () => {
    const store = new FetchedPageStore({ now: () => Date.parse('2026-10-17T10:00:00Z'), ttlMs: 60_000, maxPages: 3 });
    const kept = store.remember({ url: 'https://a.example/x', text: 'hello' });
    expect(kept).toEqual({ url: 'https://a.example/x', text: 'hello', fetched_at: '2026-10-17T10:00:00.000Z' });
    expect(store.recall('https://a.example/x')).toEqual(kept);
    expect(store.recall('https://a.example/other')).toBeUndefined();
  });

  it('forgets a page after the time limit', () => {
    let clock = 0;
    const store = new FetchedPageStore({ now: () => clock, ttlMs: 1000, maxPages: 3 });
    store.remember({ url: 'https://a.example/x', text: 'hello' });
    clock = 1001;
    expect(store.recall('https://a.example/x')).toBeUndefined();
  });

  it('drops the oldest page once it holds too many', () => {
    const store = new FetchedPageStore({ now: () => 0, ttlMs: 1000, maxPages: 2 });
    store.remember({ url: 'https://a.example/1', text: '1' });
    store.remember({ url: 'https://a.example/2', text: '2' });
    store.remember({ url: 'https://a.example/3', text: '3' });
    expect(store.recall('https://a.example/1')).toBeUndefined();
    expect(store.recall('https://a.example/3')?.text).toBe('3');
  });
});

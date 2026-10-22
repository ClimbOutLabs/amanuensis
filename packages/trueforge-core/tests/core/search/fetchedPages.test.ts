import { FetchedPageStore, type FetchedPageScope } from '../../../src/core/search/fetchedPages';

const CHAT_A: FetchedPageScope = { tenant_id: 'tenant-1', conversation_id: 'chat-a' };
const CHAT_B: FetchedPageScope = { tenant_id: 'tenant-1', conversation_id: 'chat-b' };
const OTHER_TENANT: FetchedPageScope = { tenant_id: 'tenant-2', conversation_id: 'chat-a' };

describe('FetchedPageStore', () => {
  it('stamps the fetch time itself and returns the page text as stored', () => {
    const store = new FetchedPageStore({ now: () => Date.parse('2026-10-17T10:00:00Z'), ttlMs: 60_000, maxPages: 3 });
    const kept = store.remember({ scope: CHAT_A, url: 'https://a.example/x', text: 'hello' });
    expect(kept).toEqual({ url: 'https://a.example/x', text: 'hello', fetched_at: '2026-10-17T10:00:00.000Z' });
    expect(store.recall({ scope: CHAT_A, url: 'https://a.example/x' })).toEqual(kept);
    expect(store.recall({ scope: CHAT_A, url: 'https://a.example/other' })).toBeUndefined();
  });

  it('forgets a page after the time limit', () => {
    let clock = 0;
    const store = new FetchedPageStore({ now: () => clock, ttlMs: 1000, maxPages: 3 });
    store.remember({ scope: CHAT_A, url: 'https://a.example/x', text: 'hello' });
    clock = 1001;
    expect(store.recall({ scope: CHAT_A, url: 'https://a.example/x' })).toBeUndefined();
  });

  it('finds a page when the link differs only in scheme, case or a trailing slash', () => {
    const store = new FetchedPageStore({ now: () => 0, ttlMs: 1000, maxPages: 3 });
    store.remember({ scope: CHAT_A, url: 'https://a.example/x/', text: 'hello' });
    expect(store.recall({ scope: CHAT_A, url: 'http://a.example/x' })?.text).toBe('hello');
    expect(store.recall({ scope: CHAT_A, url: 'https://A.EXAMPLE/x/' })?.text).toBe('hello');
    expect(store.recall({ scope: CHAT_A, url: 'https://a.example/x' })?.text).toBe('hello');
  });

  it('does not treat a different path or query as the same page', () => {
    const store = new FetchedPageStore({ now: () => 0, ttlMs: 1000, maxPages: 3 });
    store.remember({ scope: CHAT_A, url: 'https://a.example/x', text: 'hello' });
    expect(store.recall({ scope: CHAT_A, url: 'https://a.example/other' })).toBeUndefined();
    expect(store.recall({ scope: CHAT_A, url: 'https://a.example/x?y=1' })).toBeUndefined();
  });

  it('drops the oldest page once it holds too many', () => {
    const store = new FetchedPageStore({ now: () => 0, ttlMs: 1000, maxPages: 2 });
    store.remember({ scope: CHAT_A, url: 'https://a.example/1', text: '1' });
    store.remember({ scope: CHAT_A, url: 'https://a.example/2', text: '2' });
    store.remember({ scope: CHAT_A, url: 'https://a.example/3', text: '3' });
    expect(store.recall({ scope: CHAT_A, url: 'https://a.example/1' })).toBeUndefined();
    expect(store.recall({ scope: CHAT_A, url: 'https://a.example/3' })?.text).toBe('3');
  });

  it('keeps a page read in one chat out of every other chat', () => {
    const store = new FetchedPageStore({ now: () => 0, ttlMs: 1000, maxPages: 3 });
    store.remember({ scope: CHAT_A, url: 'https://a.example/x', text: 'hello' });
    expect(store.recall({ scope: CHAT_B, url: 'https://a.example/x' })).toBeUndefined();
    expect(store.recall({ scope: OTHER_TENANT, url: 'https://a.example/x' })).toBeUndefined();
    expect(store.recall({ scope: CHAT_A, url: 'https://a.example/x' })?.text).toBe('hello');
  });

  it('lets two chats keep their own copy of the same link apart', () => {
    const store = new FetchedPageStore({ now: () => 0, ttlMs: 1000, maxPages: 3 });
    store.remember({ scope: CHAT_A, url: 'https://a.example/x', text: 'read in chat a' });
    store.remember({ scope: CHAT_B, url: 'https://a.example/x', text: 'read in chat b' });
    expect(store.recall({ scope: CHAT_A, url: 'https://a.example/x' })?.text).toBe('read in chat a');
    expect(store.recall({ scope: CHAT_B, url: 'https://a.example/x' })?.text).toBe('read in chat b');
  });

  it('does not keep a link too long to store', () => {
    const store = new FetchedPageStore({ now: () => 0, ttlMs: 1000, maxPages: 3 });
    const base = 'https://a.example/';
    const longestKept = base + 'x'.repeat(2048 - base.length);
    const tooLong = base + 'x'.repeat(2049 - base.length);
    store.remember({ scope: CHAT_A, url: longestKept, text: 'kept' });
    store.remember({ scope: CHAT_A, url: tooLong, text: 'not kept' });
    expect(store.recall({ scope: CHAT_A, url: longestKept })?.text).toBe('kept');
    expect(store.recall({ scope: CHAT_A, url: tooLong })).toBeUndefined();
  });
});

describe('FetchedPageStore snippets', () => {
  const scope = { tenant_id: 'tenant-1', conversation_id: 'chat-a' };

  it('pushes out a search snippet before a page a person read', () => {
    const pages = new FetchedPageStore({ now: () => 0, ttlMs: 60_000, maxPages: 2 });
    pages.remember({ scope, url: 'https://a.example/page', text: 'Full page A' });
    pages.rememberSnippet({ scope, url: 'https://b.example/result', text: 'Snippet B' });
    pages.rememberSnippet({ scope, url: 'https://c.example/result', text: 'Snippet C' });
    expect(pages.recall({ scope, url: 'https://a.example/page' })?.text).toBe('Full page A');
    expect(pages.recall({ scope, url: 'https://b.example/result' })).toBeUndefined();
  });
});

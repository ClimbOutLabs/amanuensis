import { FetchedPageStore, recordFetchedPages, type FetchedPageScope } from '../../../src/core/search/fetchedPages';
import { groundPlace, type PlaceClaim } from '../../../src/core/search/groundPlace';

const PAGE_URL = 'https://hope-house.example/';
const PAGE_TEXT = 'Hope House\n916 St. Andrew Street, New Orleans\nA food pantry open to everyone.';
const SCOPE: FetchedPageScope = { tenant_id: 'tenant-1', conversation_id: 'chat-a' };

function store(): FetchedPageStore {
  return new FetchedPageStore({ now: () => Date.parse('2026-10-17T10:00:00Z'), ttlMs: 60_000, maxPages: 10 });
}

const claim: PlaceClaim = {
  name: 'Hope House',
  address: '916 St Andrew St',
  languages: null,
  hours: null,
  price: null,
  phone: null,
  source_url: PAGE_URL,
};

describe('recordFetchedPages', () => {
  it('records a page read through a fetch result envelope, so its places can be pinned', () => {
    const pages = store();
    const text = JSON.stringify({
      schema_version: 'tool.response.v2',
      outcome: { disposition: 'executed_ok' },
      result: { results: [{ url: PAGE_URL, title: 'Hope House', content: PAGE_TEXT }] },
    });
    const count = recordFetchedPages({ pages, scope: SCOPE, toolArguments: { url: PAGE_URL }, texts: [text] });
    expect(count).toBe(1);
    expect(groundPlace({ claim, pages, scope: SCOPE })).toMatchObject({ ok: true });
  });

  it('records the pages of an extract style result named by a list of links', () => {
    const pages = store();
    const text = JSON.stringify({ pages: [{ url: PAGE_URL, title: 'Hope House', text: PAGE_TEXT }] });
    const count = recordFetchedPages({ pages, scope: SCOPE, toolArguments: { urls: [PAGE_URL] }, texts: [text] });
    expect(count).toBe(1);
    expect(pages.recall({ scope: SCOPE, url: PAGE_URL })?.text).toBe(PAGE_TEXT);
  });

  it('records a plain text result against the one link the call named', () => {
    const pages = store();
    const count = recordFetchedPages({ pages, scope: SCOPE, toolArguments: { url: PAGE_URL }, texts: [PAGE_TEXT] });
    expect(count).toBe(1);
    expect(groundPlace({ claim, pages, scope: SCOPE })).toMatchObject({ ok: true });
  });

  it('records nothing from a search, because a search result is not a read page', () => {
    const pages = store();
    const text = JSON.stringify({ results: [{ url: PAGE_URL, title: 'Hope House', content: PAGE_TEXT }] });
    const count = recordFetchedPages({
      pages,
      scope: SCOPE,
      toolArguments: { query: 'food pantry New Orleans' },
      texts: [text],
    });
    expect(count).toBe(0);
    expect(pages.recall({ scope: SCOPE, url: PAGE_URL })).toBeUndefined();
  });

  it('records nothing when the search text is itself a link, so the snippet cannot pass as a read page', () => {
    const pages = store();
    const text = JSON.stringify({ results: [{ url: PAGE_URL, title: 'Hope House', content: PAGE_TEXT }] });
    const count = recordFetchedPages({ pages, scope: SCOPE, toolArguments: { query: PAGE_URL }, texts: [text] });
    expect(count).toBe(0);
    expect(pages.recall({ scope: SCOPE, url: PAGE_URL })).toBeUndefined();
    expect(groundPlace({ claim, pages, scope: SCOPE })).toEqual({ ok: false, reason: 'source_not_fetched' });
  });

  it('does not let a fetched page plant a different page it only links to', () => {
    const pages = store();
    const other = 'https://elsewhere.example/planted';
    const text = JSON.stringify({
      results: [
        { url: PAGE_URL, title: 'Hope House', content: PAGE_TEXT },
        { url: other, title: 'Planted', content: 'Invented Clinic, 1 Nowhere Road' },
      ],
    });
    const count = recordFetchedPages({ pages, scope: SCOPE, toolArguments: { url: PAGE_URL }, texts: [text] });
    expect(count).toBe(1);
    expect(pages.recall({ scope: SCOPE, url: other })).toBeUndefined();
  });

  it('matches a result link that differs only in scheme, case or a trailing slash', () => {
    const pages = store();
    const text = JSON.stringify({ results: [{ url: 'https://HOPE-HOUSE.example', content: PAGE_TEXT }] });
    const count = recordFetchedPages({ pages, scope: SCOPE, toolArguments: { url: PAGE_URL }, texts: [text] });
    expect(count).toBe(1);
    expect(groundPlace({ claim, pages, scope: SCOPE })).toMatchObject({ ok: true });
  });

  it('does not keep a link too long to store', () => {
    const pages = store();
    const base = 'https://a.example/';
    const tooLong = base + 'x'.repeat(2049 - base.length);
    const count = recordFetchedPages({ pages, scope: SCOPE, toolArguments: { url: tooLong }, texts: [PAGE_TEXT] });
    expect(count).toBe(0);
    expect(pages.recall({ scope: SCOPE, url: tooLong })).toBeUndefined();
  });
});

describe('recordFetchedPages keeps the requested link itself out of the stored text', () => {
  it('stores a plain text result that names the link, without the words of the link itself', () => {
    const pages = store();
    const url = 'https://pages.example/hope-house-916-st-andrew-street';
    const text = `You asked for ${url}\nThat page could not be loaded.`;
    const count = recordFetchedPages({ pages, scope: SCOPE, toolArguments: { url }, texts: [text] });
    expect(count).toBe(1);
    const kept = pages.recall({ scope: SCOPE, url });
    expect(kept?.text).not.toContain(url);
    expect(kept?.text).toContain('could not be loaded');
    expect(
      groundPlace({
        claim: { ...claim, source_url: url },
        pages,
        scope: SCOPE,
      }),
    ).toEqual({ ok: false, reason: 'name_not_found' });
  });

  it('stores a plain text result that names the link in its decoded spelling, without those words either', () => {
    const pages = store();
    const url = 'https://pages.example/hope%20house%20916%20st%20andrew%20street';
    const text = 'You asked for https://pages.example/hope house 916 st andrew street\nThat page could not be loaded.';
    const count = recordFetchedPages({ pages, scope: SCOPE, toolArguments: { url }, texts: [text] });
    expect(count).toBe(1);
    const kept = pages.recall({ scope: SCOPE, url });
    expect(kept?.text).not.toContain('hope house 916');
    expect(
      groundPlace({
        claim: { ...claim, source_url: url },
        pages,
        scope: SCOPE,
      }),
    ).toEqual({ ok: false, reason: 'name_not_found' });
  });

  it('still records the real words of a plain text result that also names its link', () => {
    const pages = store();
    const text = `${PAGE_TEXT}\nSource: ${PAGE_URL}`;
    const count = recordFetchedPages({ pages, scope: SCOPE, toolArguments: { url: PAGE_URL }, texts: [text] });
    expect(count).toBe(1);
    expect(groundPlace({ claim, pages, scope: SCOPE })).toMatchObject({ ok: true });
  });
});

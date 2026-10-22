import {
  FetchedPageStore,
  isSearchResultTool,
  recordSearchResults,
  type FetchedPageScope,
} from '../../../src/core/search/fetchedPages';
import { groundPlace } from '../../../src/core/search/groundPlace';

const SCOPE: FetchedPageScope = { tenant_id: 'tenant-1', conversation_id: 'chat-a' };
const SUNNY_URL = 'https://listings.example/sunny-table';
const BLUE_URL = 'https://listings.example/blue-door';

function newStore(): FetchedPageStore {
  return new FetchedPageStore({ now: () => Date.parse('2026-10-22T10:00:00Z'), ttlMs: 60_000, maxPages: 10 });
}

const ARGS = { query: 'brunch in Riverside' };
const KOWALSKI_QUERY = 'Dr Anna Kowalski 42 Elm Road Dover';

const searchOutput = (extra: Record<string, unknown> = {}): string =>
  JSON.stringify({
    untrusted_web_text: true,
    query: 'brunch in Riverside',
    ...extra,
    results: [
      { title: 'Sunny Table', url: SUNNY_URL, snippet: 'Rated 4.6. 40 Harbour Road, Riverside.' },
      { title: 'Blue Door Diner', url: BLUE_URL, snippet: '7 Mill Lane, Riverside. Open daily.' },
    ],
  });

describe('recordSearchResults', () => {
  it('records each result as a source under its own link, with its title and snippet', () => {
    const pages = newStore();
    const scope = SCOPE;
    const recorded = recordSearchResults({ pages, scope, toolArguments: ARGS, texts: [searchOutput()] });
    expect(recorded).toBe(2);
    expect(pages.recall({ scope, url: SUNNY_URL })?.text).toBe('Sunny Table\nRated 4.6. 40 Harbour Road, Riverside.');
    expect(pages.recall({ scope, url: BLUE_URL })?.text).toBe('Blue Door Diner\n7 Mill Lane, Riverside. Open daily.');
  });

  it('never records the query or a provider answer, even when the answer names a place', () => {
    const pages = newStore();
    recordSearchResults({
      pages,
      scope: SCOPE,
      toolArguments: ARGS,
      texts: [searchOutput({ answer: 'Harbour Table is at 99 Invented Way.' })],
    });
    const stored = [SUNNY_URL, BLUE_URL].map(url => pages.recall({ scope: SCOPE, url })?.text ?? '');
    expect(stored.join('\n')).not.toContain('Invented Way');
    expect(stored.join('\n')).not.toContain('brunch in Riverside');
    expect(pages.recall({ scope: SCOPE, url: 'brunch in Riverside' })).toBeUndefined();
  });

  it('does not let a snippet weaken a page already read for the same link', () => {
    const pages = newStore();
    pages.remember({ scope: SCOPE, url: SUNNY_URL, text: 'Sunny Table, 40 Harbour Road, Riverside. Full page text.' });
    recordSearchResults({ pages, scope: SCOPE, toolArguments: ARGS, texts: [searchOutput()] });
    expect(pages.recall({ scope: SCOPE, url: SUNNY_URL })?.text).toBe(
      'Sunny Table, 40 Harbour Road, Riverside. Full page text.',
    );
  });

  it('lets a later page read replace a snippet for the same link', () => {
    const pages = newStore();
    recordSearchResults({ pages, scope: SCOPE, toolArguments: ARGS, texts: [searchOutput()] });
    pages.remember({ scope: SCOPE, url: SUNNY_URL, text: 'Sunny Table, 40 Harbour Road, Riverside. Full page text.' });
    expect(pages.recall({ scope: SCOPE, url: SUNNY_URL })?.text).toBe(
      'Sunny Table, 40 Harbour Road, Riverside. Full page text.',
    );
  });

  it('records only the results list, not links in other fields', () => {
    const pages = newStore();
    recordSearchResults({
      pages,
      scope: SCOPE,
      toolArguments: ARGS,
      texts: [JSON.stringify({ links: [{ url: 'https://elsewhere.example/menu', title: 'Menu' }] })],
    });
    expect(pages.recall({ scope: SCOPE, url: 'https://elsewhere.example/menu' })).toBeUndefined();
  });

  it('keeps each chat apart', () => {
    const pages = newStore();
    recordSearchResults({ pages, scope: SCOPE, toolArguments: ARGS, texts: [searchOutput()] });
    expect(
      pages.recall({ scope: { tenant_id: 'tenant-1', conversation_id: 'chat-b' }, url: SUNNY_URL }),
    ).toBeUndefined();
  });

  it('drops a result whose title or snippet is mostly the search words, in any order or spelling', () => {
    const pages = newStore();
    const echoes = [
      { title: 'Kowalski Anna Dr', snippet: 'Elm Road 42, Dover' },
      { title: 'Anna Kowalski Clinic', snippet: 'Dover, Elm Road 42' },
      { title: 'Anna Kowalski Practice', snippet: '42 Elm, Dover Road' },
      { title: 'Anna Kowal\u200Bski', snippet: '42 Elm Ro\u200Bad Dover' },
      { title: '\u0410nn\u0430 K\u043Ew\u0430lski', snippet: '42 \u0415lm R\u043E\u0430d D\u043Ev\u0435r' },
    ];
    const recorded = recordSearchResults({
      pages,
      scope: SCOPE,
      toolArguments: { query: KOWALSKI_QUERY },
      texts: [
        JSON.stringify({
          results: [
            ...echoes.map((echo, at) => ({ url: `https://echo.example/${at}`, ...echo })),
            { url: SUNNY_URL, title: 'Sunny Table', snippet: '40 Harbour Road, Riverside.' },
          ],
        }),
      ],
    });
    expect(recorded).toBe(1);
    for (let at = 0; at < echoes.length; at += 1) {
      expect(pages.recall({ scope: SCOPE, url: `https://echo.example/${at}` })).toBeUndefined();
    }
    expect(pages.recall({ scope: SCOPE, url: SUNNY_URL })).toBeDefined();
  });

  it('checks a result against every search of the chat, not only the one that returned it', () => {
    const pages = newStore();
    recordSearchResults({ pages, scope: SCOPE, toolArguments: { query: KOWALSKI_QUERY }, texts: [] });
    const recorded = recordSearchResults({
      pages,
      scope: SCOPE,
      toolArguments: ARGS,
      texts: [JSON.stringify({ results: [{ url: 'https://echo.example/a', title: 'Kowalski Anna Dr' }] })],
    });
    expect(recorded).toBe(0);
  });

  it('records nothing from a call whose arguments name a link', () => {
    const pages = newStore();
    const recorded = recordSearchResults({
      pages,
      scope: SCOPE,
      toolArguments: { urls: ['https://named.example/'] },
      texts: [searchOutput()],
    });
    expect(recorded).toBe(0);
    expect(pages.recall({ scope: SCOPE, url: SUNNY_URL })).toBeUndefined();
  });

  it('refuses a place whose name was searched for, from the result or from a page its link led to', () => {
    const pages = newStore();
    recordSearchResults({ pages, scope: SCOPE, toolArguments: { query: 'Sunny Table' }, texts: [searchOutput()] });
    const claim = {
      name: 'Sunny Table',
      address: '40 Harbour Road, Riverside',
      languages: null,
      hours: null,
      price: null,
      phone: null,
      source_url: SUNNY_URL,
    };
    expect(groundPlace({ claim, pages, scope: SCOPE })).toEqual({ ok: false, reason: 'source_not_fetched' });
    pages.remember({ scope: SCOPE, url: SUNNY_URL, text: 'Sunny Table\n40 Harbour Road, Riverside' });
    expect(groundPlace({ claim, pages, scope: SCOPE })).toEqual({ ok: false, reason: 'place_only_in_search_query' });
    const other = 'https://guide.example/sunny-table';
    pages.remember({ scope: SCOPE, url: other, text: 'Sunny Table\n40 Harbour Road, Riverside' });
    expect(groundPlace({ claim: { ...claim, source_url: other }, pages, scope: SCOPE })).toMatchObject({ ok: true });
  });

  it('refuses a place built from the search words, from a snippet or a page its link led to', () => {
    const claims = [
      { name: 'Kowalski Anna Dr', address: 'Elm Road 42, Dover' },
      { name: 'Anna Kowalski Clinic', address: 'Dover, Elm Road 42' },
      { name: 'Anna Kowalski Practice', address: '42 Elm, Dover Road' },
      { name: 'Anna Kowal\u200Bski', address: '42 Elm Ro\u200Bad Dover' },
      { name: '\u0410nn\u0430 K\u043Ew\u0430lski', address: '42 \u0415lm R\u043E\u0430d D\u043Ev\u0435r' },
    ];
    for (const [at, place] of claims.entries()) {
      const pages = newStore();
      recordSearchResults({ pages, scope: SCOPE, toolArguments: { query: KOWALSKI_QUERY }, texts: [] });
      const snippetUrl = `https://echo.example/snippet-${at}`;
      const pageUrl = `https://echo.example/page-${at}`;
      const text = `${place.name}\n${place.address}. Open on weekdays, with parking nearby and step free access.`;
      pages.rememberSnippet({ scope: SCOPE, url: snippetUrl, text });
      pages.rememberResultLink({ scope: SCOPE, url: pageUrl });
      pages.remember({ scope: SCOPE, url: pageUrl, text });
      for (const source_url of [snippetUrl, pageUrl]) {
        const claim = { ...place, languages: null, hours: null, price: null, phone: null, source_url };
        expect(groundPlace({ claim, pages, scope: SCOPE })).toEqual({
          ok: false,
          reason: 'place_only_in_search_query',
        });
      }
    }
  });

  it('pins a listing whose name shares one word with the search', () => {
    const pages = newStore();
    const url = 'https://listings.example/maria-kowalski';
    const recorded = recordSearchResults({
      pages,
      scope: SCOPE,
      toolArguments: { query: KOWALSKI_QUERY },
      texts: [
        JSON.stringify({
          results: [
            { url, title: 'Maria Kowalski Dental', snippet: 'Maria Kowalski Dental, 7 Harbour Street, Folkestone.' },
          ],
        }),
      ],
    });
    expect(recorded).toBe(1);
    const claim = {
      name: 'Maria Kowalski Dental',
      address: '7 Harbour Street, Folkestone',
      languages: null,
      hours: null,
      price: null,
      phone: null,
      source_url: url,
    };
    expect(groundPlace({ claim, pages, scope: SCOPE })).toMatchObject({ ok: true });
  });

  it('pins both places from a normal restaurant search', () => {
    const pages = newStore();
    recordSearchResults({ pages, scope: SCOPE, toolArguments: ARGS, texts: [searchOutput()] });
    const places = [
      { name: 'Sunny Table', address: '40 Harbour Road, Riverside', source_url: SUNNY_URL },
      { name: 'Blue Door Diner', address: '7 Mill Lane, Riverside', source_url: BLUE_URL },
    ];
    for (const place of places) {
      const claim = { ...place, languages: null, hours: null, price: null, phone: null };
      expect(groundPlace({ claim, pages, scope: SCOPE })).toMatchObject({ ok: true });
    }
  });

  it('treats only true search tools as search tools', () => {
    for (const name of ['tavily_search', 'web_search', 'web_search_exa', 'web_search_advanced_exa']) {
      expect(isSearchResultTool(name)).toBe(true);
    }
    for (const name of ['web_fetch_exa', 'tavily_extract', 'web_fetch', 'tavily_crawl']) {
      expect(isSearchResultTool(name)).toBe(false);
    }
  });
});

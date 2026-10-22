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

  it('drops a result whose title or snippet repeats three query words in a row', () => {
    const pages = newStore();
    const query = 'Dr Ana Ruiz 14 Hidden Orchard Lane Springfield';
    const recorded = recordSearchResults({
      pages,
      scope: SCOPE,
      toolArguments: { query },
      texts: [
        JSON.stringify({
          results: [
            { url: 'https://echo.example/a', title: `Results for ${query}`, snippet: 'Nothing here.' },
            { url: 'https://echo.example/b', title: 'Clinics', snippet: 'Ana Ruiz 14 Hidden Orchard, see more.' },
            { url: SUNNY_URL, title: 'Sunny Table', snippet: '40 Harbour Road, Riverside.' },
          ],
        }),
      ],
    });
    expect(recorded).toBe(1);
    expect(pages.recall({ scope: SCOPE, url: 'https://echo.example/a' })).toBeUndefined();
    expect(pages.recall({ scope: SCOPE, url: 'https://echo.example/b' })).toBeUndefined();
    expect(pages.recall({ scope: SCOPE, url: SUNNY_URL })).toBeDefined();
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

  it('refuses a search result place whose name was in a query of this chat', () => {
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
    expect(groundPlace({ claim, pages, scope: SCOPE })).toEqual({ ok: false, reason: 'place_only_in_search_query' });
    pages.remember({ scope: SCOPE, url: SUNNY_URL, text: 'Sunny Table\n40 Harbour Road, Riverside' });
    expect(groundPlace({ claim, pages, scope: SCOPE })).toMatchObject({ ok: true });
  });

  it('pins a search result place whose words were never searched for', () => {
    const pages = newStore();
    recordSearchResults({ pages, scope: SCOPE, toolArguments: ARGS, texts: [searchOutput()] });
    const claim = {
      name: 'Sunny Table',
      address: '40 Harbour Road, Riverside',
      languages: null,
      hours: null,
      price: null,
      phone: null,
      source_url: SUNNY_URL,
    };
    expect(groundPlace({ claim, pages, scope: SCOPE })).toMatchObject({ ok: true });
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

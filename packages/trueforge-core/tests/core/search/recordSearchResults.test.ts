import { FetchedPageStore, recordSearchResults, type FetchedPageScope } from '../../../src/core/search/fetchedPages';

const SCOPE: FetchedPageScope = { tenant_id: 'tenant-1', conversation_id: 'chat-a' };
const SUNNY_URL = 'https://listings.example/sunny-table';
const BLUE_URL = 'https://listings.example/blue-door';

function newStore(): FetchedPageStore {
  return new FetchedPageStore({ now: () => Date.parse('2026-10-22T10:00:00Z'), ttlMs: 60_000, maxPages: 10 });
}

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
    const recorded = recordSearchResults({ pages, scope, texts: [searchOutput()] });
    expect(recorded).toBe(2);
    expect(pages.recall({ scope, url: SUNNY_URL })?.text).toBe('Sunny Table\nRated 4.6. 40 Harbour Road, Riverside.');
    expect(pages.recall({ scope, url: BLUE_URL })?.text).toBe('Blue Door Diner\n7 Mill Lane, Riverside. Open daily.');
  });

  it('never records the query or a provider answer, even when the answer names a place', () => {
    const pages = newStore();
    recordSearchResults({
      pages,
      scope: SCOPE,
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
    recordSearchResults({ pages, scope: SCOPE, texts: [searchOutput()] });
    expect(pages.recall({ scope: SCOPE, url: SUNNY_URL })?.text).toBe(
      'Sunny Table, 40 Harbour Road, Riverside. Full page text.',
    );
  });

  it('lets a later page read replace a snippet for the same link', () => {
    const pages = newStore();
    recordSearchResults({ pages, scope: SCOPE, texts: [searchOutput()] });
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
      texts: [JSON.stringify({ links: [{ url: 'https://elsewhere.example/menu', title: 'Menu' }] })],
    });
    expect(pages.recall({ scope: SCOPE, url: 'https://elsewhere.example/menu' })).toBeUndefined();
  });

  it('keeps each chat apart', () => {
    const pages = newStore();
    recordSearchResults({ pages, scope: SCOPE, texts: [searchOutput()] });
    expect(
      pages.recall({ scope: { tenant_id: 'tenant-1', conversation_id: 'chat-b' }, url: SUNNY_URL }),
    ).toBeUndefined();
  });
});

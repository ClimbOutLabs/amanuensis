import {
  TAVILY_API_HOST,
  TavilyClient,
  TavilyError,
  extractCreditsFor,
  tavilyAuthFromHeader,
} from '../../../src/core/search/TavilyClient';
import { CANAL_URL, GARDEN_URL, HARBOUR_URL, extractResponse, searchResponse } from './tavilyFixtures';

interface Seen {
  url: string;
  init: RequestInit;
}

function stubFetch(input: { status?: number; body?: unknown; headers?: Record<string, string>; text?: string }) {
  const seen: Seen[] = [];
  const fetchImpl = jest.fn((url: string, init: RequestInit) => {
    seen.push({ url, init });
    return Promise.resolve(
      new Response(input.text ?? JSON.stringify(input.body ?? {}), {
        status: input.status ?? 200,
        headers: input.headers ?? {},
      }),
    );
  });
  return { seen, fetchImpl };
}

function headersOf(call: Seen | undefined): Record<string, string> {
  return Object.fromEntries(new Headers(call?.init.headers).entries());
}

async function failureOf(run: () => Promise<unknown>): Promise<TavilyError> {
  try {
    await run();
  } catch (caught) {
    if (caught instanceof TavilyError) {
      return caught;
    }
    throw caught;
  }
  throw new Error('Expected the call to fail');
}

describe('tavilyAuthFromHeader', () => {
  it('reads the key from a Bearer header', () => {
    expect(tavilyAuthFromHeader('Bearer tvly-test-key-1')).toEqual({ kind: 'key', key: 'tvly-test-key-1' });
  });

  it.each([undefined, '', '   ', 'Bearer ', 'Bearer YOUR_TAVILY_API_KEY'])('means keyless for %p', header => {
    expect(tavilyAuthFromHeader(header)).toEqual({ kind: 'keyless' });
  });
});

describe('TavilyClient.search', () => {
  it('posts the documented request to api.tavily.com with the key', async () => {
    const { seen, fetchImpl } = stubFetch({ body: searchResponse });
    const client = new TavilyClient({ auth: { kind: 'key', key: 'tvly-test-key-1' }, fetchImpl });
    const results = await client.search({ query: 'English speaking doctor Lisbon', signal: undefined });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe(`https://${TAVILY_API_HOST}/search`);
    expect(seen[0]?.init.method).toBe('POST');
    expect(seen[0]?.init.redirect).toBe('error');
    expect(headersOf(seen[0])['authorization']).toBe('Bearer tvly-test-key-1');
    expect(headersOf(seen[0])['x-tavily-access-mode']).toBeUndefined();
    expect(JSON.parse(String(seen[0]?.init.body))).toEqual({
      query: 'English speaking doctor Lisbon',
      search_depth: 'advanced',
      max_results: 5,
      include_answer: false,
      include_raw_content: false,
      include_images: true,
      include_image_descriptions: true,
    });
    expect(results.images).toEqual([
      { url: 'https://cdn.clinics.example/harbour-front.jpg', description: 'The clinic entrance' },
      { url: 'https://cdn.clinics.example/garden-sign.jpg', description: null },
    ]);
    expect(results.hits.map(r => r.url)).toEqual([
      HARBOUR_URL,
      GARDEN_URL,
      CANAL_URL,
      'https://reviews.example/best-doctors',
    ]);
    expect(results.hits[0]).toEqual({
      title: 'Harbour Family Clinic',
      url: HARBOUR_URL,
      snippet: 'English speaking family doctors.',
    });
  });

  it('goes keyless with the documented header and no key', async () => {
    const { seen, fetchImpl } = stubFetch({ body: searchResponse });
    await new TavilyClient({ auth: { kind: 'keyless' }, fetchImpl }).search({ query: 'doctor', signal: undefined });
    const headers = headersOf(seen[0]);
    expect(headers['x-tavily-access-mode']).toBe('keyless');
    expect(headers['authorization']).toBeUndefined();
  });

  it('never puts the key in an error', async () => {
    const { fetchImpl } = stubFetch({ status: 401, body: { detail: { error: 'bad key tvly-test-key-1' } } });
    const client = new TavilyClient({ auth: { kind: 'key', key: 'tvly-test-key-1' }, fetchImpl });
    const error = await failureOf(() => client.search({ query: 'doctor', signal: undefined }));
    expect(error.message).not.toContain('tvly-test-key-1');
  });

  it.each([
    [401, 'key', /Settings/],
    [429, 'key', /minute/],
    [429, 'keyless', /free key/],
    [432, 'key', /credits/],
    [433, 'key', /credits/],
    [500, 'key', /their side/],
    [422, 'key', /different words/],
  ] as const)('explains status %i (%s) in one plain sentence', async (status, mode, expected) => {
    const { fetchImpl } = stubFetch({ status, body: {} });
    const auth = mode === 'key' ? ({ kind: 'key', key: 'tvly-test-key-1' } as const) : ({ kind: 'keyless' } as const);
    const error = await failureOf(() =>
      new TavilyClient({ auth, fetchImpl }).search({ query: 'doctor', signal: undefined }),
    );
    expect(error.message).toMatch(expected);
  });

  it('says when Tavily cannot be reached', async () => {
    const fetchImpl = jest.fn(() => Promise.reject(new TypeError('fetch failed')));
    const error = await failureOf(() =>
      new TavilyClient({ auth: { kind: 'keyless' }, fetchImpl }).search({ query: 'doctor', signal: undefined }),
    );
    expect(error.message).toMatch(/internet connection/);
    expect(error.cause).toBeInstanceOf(TypeError);
  });

  it('refuses an answer larger than the cap', async () => {
    const { fetchImpl } = stubFetch({ text: 'x'.repeat(2 * 1024 * 1024 + 1) });
    const error = await failureOf(() =>
      new TavilyClient({ auth: { kind: 'keyless' }, fetchImpl }).search({ query: 'doctor', signal: undefined }),
    );
    expect(error.message).toMatch(/too large/);
  });

  it('refuses an answer it cannot read', async () => {
    const { fetchImpl } = stubFetch({ body: { results: 'nope' } });
    const error = await failureOf(() =>
      new TavilyClient({ auth: { kind: 'keyless' }, fetchImpl }).search({ query: 'doctor', signal: undefined }),
    );
    expect(error.message).toMatch(/could not read/);
  });
});

describe('TavilyClient.extract', () => {
  it('sends one batched request and splits results from failures', async () => {
    const { seen, fetchImpl } = stubFetch({ body: extractResponse });
    const client = new TavilyClient({ auth: { kind: 'key', key: 'tvly-test-key-1' }, fetchImpl });
    const out = await client.extract({ urls: [HARBOUR_URL, GARDEN_URL, CANAL_URL], signal: undefined });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe(`https://${TAVILY_API_HOST}/extract`);
    expect(JSON.parse(String(seen[0]?.init.body))).toEqual({
      urls: [HARBOUR_URL, GARDEN_URL, CANAL_URL],
      extract_depth: 'basic',
      format: 'markdown',
      timeout: 20,
    });
    expect(out.pages.map(p => p.url)).toEqual([HARBOUR_URL, GARDEN_URL]);
    expect(out.failed).toEqual([{ url: CANAL_URL, error: 'Could not load the page' }]);
  });
});

describe('credits', () => {
  it('counts one credit per five successful pages', () => {
    expect([0, 1, 3, 5, 6].map(extractCreditsFor)).toEqual([0, 1, 1, 1, 2]);
  });
});

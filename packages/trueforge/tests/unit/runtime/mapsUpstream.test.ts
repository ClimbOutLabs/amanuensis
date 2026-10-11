import { fetchSameOrigin, safeRedirectTarget } from '../../../src/runtime/mapsUpstream';

describe('safeRedirectTarget', () => {
  const upstream = 'https://tile.openstreetmap.org/13/4096/4096.png';

  it('allows same-origin redirects', () => {
    expect(safeRedirectTarget({ upstreamUrl: upstream, location: '/13/4096/4097.png' })).toBe(
      'https://tile.openstreetmap.org/13/4096/4097.png',
    );
  });

  it('rejects another host, a scheme change and malformed locations', () => {
    for (const location of [
      'https://evil.example/tile.png',
      '//evil.example/tile.png',
      'http://tile.openstreetmap.org/x.png',
      'http://[::1',
    ]) {
      expect(safeRedirectTarget({ upstreamUrl: upstream, location })).toBeNull();
    }
  });
});

describe('fetchSameOrigin', () => {
  const headers = { 'User-Agent': 'test-agent' };
  afterEach(() => {
    jest.restoreAllMocks();
  });

  function redirect(location: string): Response {
    return new Response(null, { status: 302, headers: { location } });
  }

  it('follows one same-origin redirect and never forwards cookies or a Referer', async () => {
    const spy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(redirect('/next'))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    const response = await fetchSameOrigin({ url: 'https://geo.example/search?q=a', headers, timeoutMs: 1000 });
    expect(response.status).toBe(200);
    expect(spy.mock.calls.map(call => call[0])).toEqual(['https://geo.example/search?q=a', 'https://geo.example/next']);
    for (const call of spy.mock.calls) {
      expect(call[1]).toMatchObject({ headers: { 'User-Agent': 'test-agent' }, redirect: 'manual' });
    }
  });

  it('throws on a redirect to another host without contacting it', async () => {
    const spy = jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(redirect('https://evil.example/x'));
    await expect(fetchSameOrigin({ url: 'https://geo.example/s', headers, timeoutMs: 1000 })).rejects.toThrow(
      'another origin',
    );
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('throws on a second redirect', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(redirect('/again'));
    await expect(fetchSameOrigin({ url: 'https://geo.example/s', headers, timeoutMs: 1000 })).rejects.toThrow(
      'more than once',
    );
  });
});

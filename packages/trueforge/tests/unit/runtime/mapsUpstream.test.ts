import {
  fetchSameOrigin,
  readCappedBody,
  readCappedJson,
  safeRedirectTarget,
  UPSTREAM_JSON_MAX_BODY_BYTES,
} from '../../../src/runtime/mapsUpstream';

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

describe('redirect bodies', () => {
  const headers = { 'User-Agent': 'test-agent' };
  afterEach(() => {
    jest.restoreAllMocks();
  });

  function trackedRedirect(location: string): { response: Response; cancelled: () => boolean } {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(8));
      },
      cancel() {
        cancelled = true;
      },
    });
    return { response: new Response(body, { status: 302, headers: { location } }), cancelled: () => cancelled };
  }

  it('cancels the first redirect body before the second request', async () => {
    const first = trackedRedirect('/next');
    let cancelledAtSecondFetch: boolean | undefined;
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(first.response)
      .mockImplementationOnce(() => {
        cancelledAtSecondFetch = first.cancelled();
        return Promise.resolve(new Response('ok', { status: 200 }));
      });
    await fetchSameOrigin({ url: 'https://geo.example/s', headers, timeoutMs: 1000 });
    expect(cancelledAtSecondFetch).toBe(true);
  });

  it('cancels the redirect body when the redirect leaves the origin', async () => {
    const first = trackedRedirect('https://evil.example/x');
    jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(first.response);
    await expect(fetchSameOrigin({ url: 'https://geo.example/s', headers, timeoutMs: 1000 })).rejects.toThrow(
      'another origin',
    );
    expect(first.cancelled()).toBe(true);
  });
});

describe('readCappedBody', () => {
  it('returns the body when it fits and null when it does not', async () => {
    const fits = await readCappedBody({ response: new Response(new Uint8Array(10)), maxBytes: 10 });
    expect(fits?.byteLength).toBe(10);
    expect(await readCappedBody({ response: new Response(new Uint8Array(11)), maxBytes: 10 })).toBeNull();
  });
});

describe('readCappedJson', () => {
  it('parses a body inside the cap', async () => {
    expect(await readCappedJson(new Response('[{"lat":"1"}]'))).toEqual({ value: [{ lat: '1' }] });
  });

  it('returns null for a body over the cap without reading it all', async () => {
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(64 * 1024));
      },
    });
    expect(await readCappedJson(new Response(body))).toBeNull();
    expect(pulled * 64 * 1024).toBeLessThan(UPSTREAM_JSON_MAX_BODY_BYTES * 2);
  });

  it('returns null for a declared length over the cap', async () => {
    const response = new Response('[]', { headers: { 'Content-Length': String(UPSTREAM_JSON_MAX_BODY_BYTES + 1) } });
    expect(await readCappedJson(response)).toBeNull();
  });

  it('returns null for invalid JSON', async () => {
    expect(await readCappedJson(new Response('not json'))).toBeNull();
  });
});

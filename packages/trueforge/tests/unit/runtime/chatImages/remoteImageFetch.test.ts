import { lookup } from 'node:dns/promises';

import { Response as UndiciResponse } from 'undici';

import { CHAT_IMAGE_REMOTE_MAX_BYTES } from '../../../../src/runtime/chatImages/limits';
import { fetchRemoteImage } from '../../../../src/runtime/chatImages/remoteImageFetch';
import { EXAMPLE_COM_ADDRESS } from '../../../fixtures/exampleComAddress';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

/** example.com and example.org resolve publicly; localhost goes through the system resolver (a loopback address). */
async function resolveAddresses(hostname: string): Promise<string[]> {
  if (hostname === 'localhost') {
    return (await lookup(hostname, { all: true })).map(entry => entry.address);
  }
  return [EXAMPLE_COM_ADDRESS];
}

interface SeenRequest {
  url: string;
  headers: Record<string, string>;
}

function fakeFetch(handler: (url: string) => UndiciResponse) {
  const seen: SeenRequest[] = [];
  const fetchImpl = async (url: unknown, init: unknown): Promise<UndiciResponse> => {
    const headers =
      typeof init === 'object' && init !== null && 'headers' in init && typeof init.headers === 'object'
        ? Object.fromEntries(
            Object.entries(init.headers ?? {}).map(([key, value]) => [key.toLowerCase(), String(value)]),
          )
        : {};
    seen.push({ url: String(url), headers });
    return handler(String(url));
  };
  return { seen, fetchImpl };
}

function image(body: Uint8Array, contentType = 'image/png', headers: Record<string, string> = {}): UndiciResponse {
  return new UndiciResponse(body, { status: 200, headers: { 'content-type': contentType, ...headers } });
}

function redirect(location: string): UndiciResponse {
  return new UndiciResponse(null, { status: 302, headers: { location } });
}

function run(input: { url: string; handler: (url: string) => UndiciResponse; allowUrl?: (url: URL) => boolean }) {
  const { seen, fetchImpl } = fakeFetch(input.handler);
  const outcome = fetchRemoteImage({
    url: input.url,
    allowUrl: input.allowUrl ?? (() => true),
    deps: { fetchImpl, resolveAddresses },
  });
  return { seen, outcome };
}

describe('fetchRemoteImage', () => {
  it('returns the bytes of an allow-listed image', async () => {
    const { outcome } = run({ url: 'https://example.com/a.png', handler: () => image(PNG) });
    await expect(outcome).resolves.toEqual({ ok: true, bytes: PNG, finalUrl: 'https://example.com/a.png' });
  });

  it('sends no cookies, Referer or credentials', async () => {
    const { seen, outcome } = run({ url: 'https://example.com/a.png', handler: () => image(PNG) });
    await outcome;
    expect(Object.keys(seen[0]?.headers ?? {}).sort()).toEqual(['accept', 'user-agent']);
  });

  it('refuses SVG and other types by Content-Type', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>');
    await expect(
      run({ url: 'https://example.com/a.svg', handler: () => image(svg, 'image/svg+xml') }).outcome,
    ).resolves.toEqual({ ok: false, reason: 'unsupported_type' });
    await expect(
      run({ url: 'https://example.com/a', handler: () => image(PNG, 'text/html') }).outcome,
    ).resolves.toEqual({ ok: false, reason: 'unsupported_type' });
  });

  it('refuses bytes that do not match the claimed type (a polyglot or a disguised file)', async () => {
    await expect(
      run({ url: 'https://example.com/a.png', handler: () => image(Buffer.from('GIF89a...')) }).outcome,
    ).resolves.toEqual({ ok: false, reason: 'unsupported_type' });
    await expect(
      run({ url: 'https://example.com/a.png', handler: () => image(Buffer.from('<html><script></script>')) }).outcome,
    ).resolves.toEqual({ ok: false, reason: 'unsupported_type' });
  });

  it('refuses an oversized body, declared or streamed', async () => {
    const declared = run({
      url: 'https://example.com/a.png',
      handler: () => image(PNG, 'image/png', { 'content-length': String(CHAT_IMAGE_REMOTE_MAX_BYTES + 1) }),
    });
    await expect(declared.outcome).resolves.toEqual({ ok: false, reason: 'too_large' });
    const big = Buffer.alloc(CHAT_IMAGE_REMOTE_MAX_BYTES + 1);
    PNG.copy(big);
    await expect(run({ url: 'https://example.com/a.png', handler: () => image(big) }).outcome).resolves.toEqual({
      ok: false,
      reason: 'too_large',
    });
  });

  it('reports an upstream error as a failed download', async () => {
    const { outcome } = run({
      url: 'https://example.com/a.png',
      handler: () => new UndiciResponse('missing', { status: 404 }),
    });
    await expect(outcome).resolves.toEqual({ ok: false, reason: 'fetch_failed' });
  });

  it('refuses links with credentials or other schemes before any request', async () => {
    for (const url of ['https://user:pass@example.com/a.png', 'ftp://example.com/a.png', 'file:///etc/passwd']) {
      const { seen, outcome } = run({ url, handler: () => image(PNG) });
      await expect(outcome).resolves.toEqual({ ok: false, reason: 'blocked' });
      expect(seen).toHaveLength(0);
    }
  });

  describe('redirects', () => {
    it('follows a redirect to another public site', async () => {
      const { outcome } = run({
        url: 'https://example.com/a.png',
        handler: url => (url === 'https://example.com/a.png' ? redirect('https://example.org/b.png') : image(PNG)),
      });
      await expect(outcome).resolves.toMatchObject({ ok: true, finalUrl: 'https://example.org/b.png' });
    });

    it('re-checks the address of every hop and blocks a redirect to this machine', async () => {
      const { seen, outcome } = run({
        url: 'https://example.com/a.png',
        handler: () => redirect('http://localhost/admin.png'),
      });
      await expect(outcome).resolves.toEqual({ ok: false, reason: 'blocked' });
      expect(seen.map(request => request.url)).toEqual(['https://example.com/a.png']);
    });

    it('runs the outbound guard on every hop', async () => {
      const checked: string[] = [];
      const { seen, outcome } = run({
        url: 'https://example.com/a.png',
        handler: () => redirect('https://example.org/collect?k=invented-secret'),
        allowUrl: url => {
          checked.push(url.toString());
          return !url.search.includes('invented-secret');
        },
      });
      await expect(outcome).resolves.toEqual({ ok: false, reason: 'blocked' });
      expect(checked).toEqual(['https://example.com/a.png', 'https://example.org/collect?k=invented-secret']);
      expect(seen).toHaveLength(1);
    });

    it('blocks a redirect to another scheme or port', async () => {
      for (const location of ['ftp://example.org/b.png', 'https://example.org:8443/b.png']) {
        const { seen, outcome } = run({ url: 'https://example.com/a.png', handler: () => redirect(location) });
        await expect(outcome).resolves.toEqual({ ok: false, reason: 'blocked' });
        expect(seen).toHaveLength(1);
      }
    });

    it('gives up after three redirects', async () => {
      let hop = 0;
      const { seen, outcome } = run({
        url: 'https://example.com/0.png',
        handler: () => {
          hop += 1;
          return redirect(`https://example.com/${String(hop)}.png`);
        },
      });
      await expect(outcome).resolves.toEqual({ ok: false, reason: 'fetch_failed' });
      expect(seen).toHaveLength(4);
    });
  });
});

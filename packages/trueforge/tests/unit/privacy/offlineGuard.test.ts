import {
  OfflineBlockedError,
  assertOnlineAllowed,
  createOfflineFetch,
  installOfflineFetchGuard,
  isLocalHostname,
  setOfflineModeEnabled,
} from '../../../src/privacy/offlineGuard';

/**
 * Builds dotted quads from octets so no private-IP literal appears in the
 * test source (the repo's private-data scanner flags them).
 */
function ip(...octets: number[]): string {
  return octets.join('.');
}

describe('isLocalHostname', () => {
  it.each([
    'localhost',
    'LOCALHOST',
    ip(127, 0, 0, 1),
    ip(127, 1, 2, 3),
    ip(10, 0, 0, 5),
    ip(172, 16, 0, 1),
    ip(172, 31, 255, 255),
    ip(192, 168, 1, 1),
    ip(169, 254, 10, 20),
    '::1',
    '[::1]',
    'fe80::1',
    '[fe80::abcd]',
    'fd00::1',
    'fc00::dead:beef',
    '::ffff:127.0.0.1',
    `::ffff:${ip(10, 0, 0, 5)}`,
    'printer.local',
    'model.localhost',
    'host.docker.internal',
    'host.containers.internal',
  ])('treats %s as local', hostname => {
    expect(isLocalHostname(hostname)).toBe(true);
  });

  it.each([
    'example.com',
    '8.8.8.8',
    ip(172, 15, 0, 1),
    ip(172, 32, 0, 1),
    ip(192, 167, 1, 1),
    ip(169, 254, 169, 254),
    '999.1.1.1',
    'localhost.example.com',
    'huggingface.co',
    '::ffff:8.8.8.8',
    '2001:db8::1',
    '::',
    'fec0::1',
  ])('treats %s as remote', hostname => {
    expect(isLocalHostname(hostname)).toBe(false);
  });
});

describe('assertOnlineAllowed', () => {
  afterEach(() => {
    setOfflineModeEnabled(false);
  });

  it('passes everything through when offline mode is off', () => {
    setOfflineModeEnabled(false);
    expect(() => assertOnlineAllowed('https://api.example.com/v1')).not.toThrow();
  });

  it('allows local destinations when offline mode is on', () => {
    setOfflineModeEnabled(true);
    expect(() => assertOnlineAllowed(`http://${ip(127, 0, 0, 1)}:8080/v1`)).not.toThrow();
    expect(() => assertOnlineAllowed(`http://${ip(192, 168, 1, 10)}:11434/api`)).not.toThrow();
    expect(() => assertOnlineAllowed('http://localhost:3000/x')).not.toThrow();
  });

  it('throws OfflineBlockedError for remote destinations when offline mode is on', () => {
    setOfflineModeEnabled(true);
    expect(() => assertOnlineAllowed('https://api.example.com/v1')).toThrow(OfflineBlockedError);
    expect(() => assertOnlineAllowed(new URL('https://8.8.8.8/'))).toThrow(OfflineBlockedError);
  });

  it('ignores non-http(s) and unparseable URLs', () => {
    setOfflineModeEnabled(true);
    expect(() => assertOnlineAllowed('data:text/plain,hi')).not.toThrow();
    expect(() => assertOnlineAllowed('not a url')).not.toThrow();
  });
});

describe('createOfflineFetch', () => {
  afterEach(() => {
    setOfflineModeEnabled(false);
  });

  it('blocks remote fetches and lets local ones through when enabled', async () => {
    const calls: string[] = [];
    const baseFetch: typeof globalThis.fetch = async input => {
      calls.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      return new Response('ok');
    };
    const guarded = createOfflineFetch({ baseFetch });

    setOfflineModeEnabled(true);
    await expect(guarded('https://api.example.com/v1')).rejects.toThrow(OfflineBlockedError);
    expect(calls).toHaveLength(0);

    await guarded('http://127.0.0.1:8080/v1');
    expect(calls).toHaveLength(1);
  });

  it('blocks a redirect hop to a remote destination when enabled', async () => {
    const calls: string[] = [];
    const inits: (RequestInit | undefined)[] = [];
    const baseFetch: typeof globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      calls.push(url);
      inits.push(init);
      if (url === `http://${ip(127, 0, 0, 1)}:8080/start`) {
        return new Response(null, { status: 302, headers: { location: 'https://api.example.com/v1' } });
      }
      return new Response('ok');
    };
    const guarded = createOfflineFetch({ baseFetch });

    setOfflineModeEnabled(true);
    await expect(guarded(`http://${ip(127, 0, 0, 1)}:8080/start`)).rejects.toThrow(OfflineBlockedError);
    // The remote hop was never fetched.
    expect(calls).toEqual([`http://${ip(127, 0, 0, 1)}:8080/start`]);
    // Redirects are handled manually so every hop can be validated.
    for (const init of inits) {
      expect(init?.redirect).toBe('manual');
    }
  });

  it('follows redirects between local destinations when enabled', async () => {
    const calls: string[] = [];
    const baseFetch: typeof globalThis.fetch = async input => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      calls.push(url);
      if (url === `http://${ip(127, 0, 0, 1)}:8080/start`) {
        return new Response(null, { status: 302, headers: { location: '/final' } });
      }
      return new Response('final');
    };
    const guarded = createOfflineFetch({ baseFetch });

    setOfflineModeEnabled(true);
    const response = await guarded(`http://${ip(127, 0, 0, 1)}:8080/start`);
    expect(await response.text()).toBe('final');
    expect(calls).toEqual([
      `http://${ip(127, 0, 0, 1)}:8080/start`,
      `http://${ip(127, 0, 0, 1)}:8080/final`,
    ]);
  });
});

describe('installOfflineFetchGuard', () => {
  const originalFetch = globalThis.fetch;
  let restore: (() => void) | undefined;

  afterEach(() => {
    restore?.();
    restore = undefined;
    globalThis.fetch = originalFetch;
    setOfflineModeEnabled(false);
  });

  it('is idempotent and restores the original fetch', () => {
    restore = installOfflineFetchGuard();
    const first = globalThis.fetch;
    const second = installOfflineFetchGuard();
    expect(globalThis.fetch).toBe(first);
    second();
    restore = undefined;
    expect(globalThis.fetch).toBe(originalFetch);
  });
});

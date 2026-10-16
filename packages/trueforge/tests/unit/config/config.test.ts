import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  assertNetworkAuthRequirement,
  assertOidcIssuerTransportAllowed,
  getPublicBaseUrl,
  getPublicUiBasePath,
  isLoopbackHost,
  isPrivateNetworkHost,
  parseAllowedOrigins,
  parseDemoSendAllowlist,
  parseLoginUpstreamUrl,
  parsePublicBaseUrl,
  parseTokenFactoryMode,
  parseTrustedProxyAddresses,
  TrueForgeAuthMode,
  type PublicUrlConfig,
  type ServerConfiguration,
} from '../../../src/config';
import { resolveTrueFoundrySandboxProviderConfig } from '../../../src/truefoundry/resolveTrueFoundrySandboxProviderConfig';

/** Minimal distributed config slice for resolve tests (unused fields are irrelevant). */
function distributed(overrides: {
  TRUEFOUNDRY_SANDBOX_ENABLED?: boolean;
  TRUEFOUNDRY_SANDBOX_PROVIDER?: 'daytona' | 'truefoundry';
  TRUEFOUNDRY_SANDBOX_API_KEY?: string;
  TRUEFOUNDRY_SANDBOX_SERVER_URL?: string;
  TRUEFOUNDRY_SANDBOX_SETTINGS?: string;
}): ServerConfiguration {
  return {
    STANDALONE: false,
    TRUEFOUNDRY_SANDBOX_ENABLED: false,
    TRUEFOUNDRY_SANDBOX_PROVIDER: undefined,
    TRUEFOUNDRY_SANDBOX_API_KEY: undefined,
    TRUEFOUNDRY_SANDBOX_SERVER_URL: undefined,
    TRUEFOUNDRY_SANDBOX_SETTINGS: undefined,
    ...overrides,
  } as ServerConfiguration;
}

describe('resolveTrueFoundrySandboxProviderConfig', () => {
  it('returns undefined when sandbox is disabled', () => {
    expect(resolveTrueFoundrySandboxProviderConfig(distributed({}))).toBeUndefined();
  });

  it('returns daytona with parsed settings JSON', () => {
    expect(
      resolveTrueFoundrySandboxProviderConfig(
        distributed({
          TRUEFOUNDRY_SANDBOX_ENABLED: true,
          TRUEFOUNDRY_SANDBOX_PROVIDER: 'daytona',
          TRUEFOUNDRY_SANDBOX_API_KEY: 'dtn-key',
          TRUEFOUNDRY_SANDBOX_SETTINGS: JSON.stringify({
            snapshotName: 'snap-1',
            timeoutMs: 90_000,
            autoStopIntervalInMinutes: 10,
          }),
        }),
      ),
    ).toEqual({
      type: 'daytona',
      apiKey: 'dtn-key',
      settings: {
        snapshotName: 'snap-1',
        timeoutMs: 90_000,
        autoStopIntervalInMinutes: 10,
        autoArchiveIntervalInMinutes: 60,
        autoDeleteIntervalInMinutes: 43_200,
      },
    });
  });

  it('returns truefoundry with server URL and nats_bridge_url from settings', () => {
    expect(
      resolveTrueFoundrySandboxProviderConfig(
        distributed({
          TRUEFOUNDRY_SANDBOX_ENABLED: true,
          TRUEFOUNDRY_SANDBOX_PROVIDER: 'truefoundry',
          TRUEFOUNDRY_SANDBOX_SERVER_URL: 'http://sandbox-server',
          TRUEFOUNDRY_SANDBOX_SETTINGS: JSON.stringify({ nats_bridge_url: 'ws://nats-bridge' }),
        }),
      ),
    ).toEqual({
      type: 'truefoundry',
      serverUrl: 'http://sandbox-server',
      natsBridgeUrl: 'ws://nats-bridge',
    });
  });

  it('throws when daytona is enabled without API key', () => {
    expect(() =>
      resolveTrueFoundrySandboxProviderConfig(
        distributed({
          TRUEFOUNDRY_SANDBOX_ENABLED: true,
          TRUEFOUNDRY_SANDBOX_PROVIDER: 'daytona',
          TRUEFOUNDRY_SANDBOX_SETTINGS: JSON.stringify({ snapshotName: 'snap-1' }),
        }),
      ),
    ).toThrow(/TRUEFOUNDRY_SANDBOX_API_KEY/);
  });

  it('throws when truefoundry is enabled without server URL', () => {
    expect(() =>
      resolveTrueFoundrySandboxProviderConfig(
        distributed({
          TRUEFOUNDRY_SANDBOX_ENABLED: true,
          TRUEFOUNDRY_SANDBOX_PROVIDER: 'truefoundry',
          TRUEFOUNDRY_SANDBOX_SETTINGS: JSON.stringify({ nats_bridge_url: 'ws://nats-bridge' }),
        }),
      ),
    ).toThrow(/TRUEFOUNDRY_SANDBOX_SERVER_URL/);
  });

  it('throws when settings JSON is invalid', () => {
    expect(() =>
      resolveTrueFoundrySandboxProviderConfig(
        distributed({
          TRUEFOUNDRY_SANDBOX_ENABLED: true,
          TRUEFOUNDRY_SANDBOX_PROVIDER: 'daytona',
          TRUEFOUNDRY_SANDBOX_API_KEY: 'dtn-key',
          TRUEFOUNDRY_SANDBOX_SETTINGS: '{not-json',
        }),
      ),
    ).toThrow(/TRUEFOUNDRY_SANDBOX_SETTINGS must be valid JSON/);
  });
});

describe('public base URL', () => {
  const urlConfig = (overrides: Partial<PublicUrlConfig>): PublicUrlConfig => ({
    STANDALONE: true,
    PORT: 8790,
    PUBLIC_BASE_URL: '',
    ...overrides,
  });

  it('honors PUBLIC_BASE_URL in production standalone', () => {
    expect(getPublicBaseUrl(urlConfig({ PUBLIC_BASE_URL: 'https://host.example' }))).toBe('https://host.example');
  });

  it('defaults to the loopback address in standalone when unset', () => {
    const config = urlConfig({ PORT: 8123 });

    expect(getPublicBaseUrl(config)).toBe('http://localhost:8123');
    expect(getPublicUiBasePath(config)).toBe('/');
  });

  it('still requires PUBLIC_BASE_URL in distributed mode', () => {
    expect(() => getPublicBaseUrl(urlConfig({ STANDALONE: false }))).toThrow(/PUBLIC_BASE_URL is required/);
  });

  it('honors the PUBLIC_BASE_URL pathname in distributed mode', () => {
    expect(
      getPublicUiBasePath(urlConfig({ STANDALONE: false, PUBLIC_BASE_URL: 'https://host.example/custom/proxy/path' })),
    ).toBe('/custom/proxy/path/');
  });
});

describe('parsePublicBaseUrl', () => {
  it('rejects a path when paths are not allowed', () => {
    expect(() => parsePublicBaseUrl('https://host.example/app', { allowPath: false })).toThrow(
      /origin with no path when STANDALONE=true/,
    );
  });

  it('accepts a bare origin and a lone slash when paths are not allowed', () => {
    expect(parsePublicBaseUrl('https://host.example', { allowPath: false })).toBe('https://host.example');
    expect(parsePublicBaseUrl('https://host.example/', { allowPath: false })).toBe('https://host.example');
  });

  it('keeps the path when paths are allowed', () => {
    expect(parsePublicBaseUrl('https://host.example/app/', { allowPath: true })).toBe('https://host.example/app');
  });
});

describe('assertOidcIssuerTransportAllowed', () => {
  it.each([
    'https://login.example/dex',
    'http://localhost:5556/dex',
    'http://127.0.0.1:5556/dex',
    'http://[::1]:5556/dex',
  ])('accepts %s', issuer => {
    expect(() => assertOidcIssuerTransportAllowed(issuer)).not.toThrow();
  });

  it.each([
    'http://login.example/dex',
    'http://192.168.1.10:5556/dex',
    'http://0.0.0.0:5556/dex',
    'ftp://localhost/dex',
  ])('rejects %s', issuer => {
    expect(() => assertOidcIssuerTransportAllowed(issuer)).toThrow(/https, except http on a loopback host/);
  });
});

describe('isLoopbackHost', () => {
  describe('recognises loopback addresses', () => {
    it.each([
      'localhost',
      'LOCALHOST',
      '127.0.0.1',
      '127.0.1.2',
      '127.255.255.255',
      '::1',
      '[::1]',
      '[LOCALHOST]',
      '0:0:0:0:0:0:0:1',
      '::ffff:127.0.0.1',
      '::ffff:127.255.255.255',
      '0000:0000:0000:0000:0000:ffff:7f00:0001',
      '  localhost  ',
      '  ::1  ',
      '  127.0.0.1  ',
      '::1%eth0',
      '::1%lo0',
      '127.0.0.1%1',
    ])('treats %s as loopback', host => {
      expect(isLoopbackHost(host)).toBe(true);
    });
  });

  describe('rejects non-loopback addresses', () => {
    it.each([
      '0.0.0.0',
      '192.168.1.10',
      '10.0.0.5',
      '8.8.8.8',
      '',
      'example.com',
      'localhost.example.com',
      '::',
      '::2',
      'fe80::1',
      '2001:db8::1',
      '::ffff:192.168.1.1',
      '::ffff:8.8.8.8',
      '127.foo.bar',
      '127.256.0.1',
      '127.0.0',
      'localhost.evil.com',
      '127.0.0.1@evil.com',
      '[::1]x',
      'x[::1]',
      '[127.0.0.1',
      '[localhost.evil.com]',
      'foo.localhost',
      'localhost:8790',
    ])('treats %s as a network listener', host => {
      expect(isLoopbackHost(host)).toBe(false);
    });
  });
});

describe('assertNetworkAuthRequirement', () => {
  describe('standalone', () => {
    it.each(['localhost', '127.0.0.1', '0.0.0.0', '192.168.1.10'])('refuses to start without OIDC on %s', host => {
      expect(() =>
        assertNetworkAuthRequirement({
          authMode: TrueForgeAuthMode.Standalone,
          standalone: true,
          host,
          requireAuth: true,
        }),
      ).toThrow(/Refusing to start without login.*OIDC_ISSUER_URL, OIDC_CLIENT_ID, and OIDC_CLIENT_SECRET/);
    });

    it('no longer honors REQUIRE_AUTH=false', () => {
      expect(() =>
        assertNetworkAuthRequirement({
          authMode: TrueForgeAuthMode.Standalone,
          standalone: true,
          host: '0.0.0.0',
          requireAuth: false,
        }),
      ).toThrow(/Refusing to start without login/);
    });

    it('starts when OIDC provides login', () => {
      expect(() =>
        assertNetworkAuthRequirement({
          authMode: TrueForgeAuthMode.Oidc,
          standalone: true,
          host: 'localhost',
          requireAuth: true,
        }),
      ).not.toThrow();
    });
  });

  describe('distributed', () => {
    it('throws on a non-loopback bind without authentication', () => {
      expect(() =>
        assertNetworkAuthRequirement({
          authMode: TrueForgeAuthMode.Standalone,
          standalone: false,
          host: '0.0.0.0',
          requireAuth: true,
        }),
      ).toThrow(/Refusing to listen on 0\.0\.0\.0 without authentication/);
    });

    it('names the remediation options in the error', () => {
      expect(() =>
        assertNetworkAuthRequirement({
          authMode: TrueForgeAuthMode.Standalone,
          standalone: false,
          host: '192.168.1.10',
          requireAuth: true,
        }),
      ).toThrow(/OIDC|HOST=localhost|REQUIRE_AUTH=false/);
    });

    it('passes on loopback', () => {
      expect(() =>
        assertNetworkAuthRequirement({
          authMode: TrueForgeAuthMode.Standalone,
          standalone: false,
          host: 'localhost',
          requireAuth: true,
        }),
      ).not.toThrow();
    });

    it('passes when OIDC or TrueFoundry provides authentication', () => {
      for (const authMode of [TrueForgeAuthMode.Oidc, TrueForgeAuthMode.TrueFoundry]) {
        expect(() =>
          assertNetworkAuthRequirement({ authMode, standalone: false, host: '0.0.0.0', requireAuth: true }),
        ).not.toThrow();
      }
    });

    it('passes when the operator explicitly opts out with REQUIRE_AUTH=false', () => {
      expect(() =>
        assertNetworkAuthRequirement({
          authMode: TrueForgeAuthMode.Standalone,
          standalone: false,
          host: '0.0.0.0',
          requireAuth: false,
        }),
      ).not.toThrow();
    });
  });
});

describe('parseTokenFactoryMode', () => {
  const parse = (raw: string | undefined) =>
    parseTokenFactoryMode({ envKey: 'TOKEN_FACTORY_MODE', raw, defaultValue: 'off' });

  it('defaults to off when unset or blank', () => {
    expect(parse(undefined)).toBe('off');
    expect(parse('')).toBe('off');
    expect(parse('   ')).toBe('off');
  });

  it('parses off, fallback, and force case-insensitively', () => {
    expect(parse('off')).toBe('off');
    expect(parse('fallback')).toBe('fallback');
    expect(parse('force')).toBe('force');
    expect(parse('FALLBACK')).toBe('fallback');
  });

  it('throws on anything else', () => {
    expect(() => parse('sometimes')).toThrow('TOKEN_FACTORY_MODE must be one of off, fallback, force');
  });
});

/** The hosts and classes the installer's tests read as well, so the app and the installer agree on what is private. */
function readSharedHosts(): { kind: string; host: string }[] {
  const file = path.resolve(__dirname, '../../../../../installer/tests/private-hosts.txt');
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(line => line.trim() !== '' && !line.startsWith('#'))
    .map(line => {
      const [kind = '', host = ''] = line.trim().split(/\s+/);
      return { kind, host };
    });
}

describe('isPrivateNetworkHost', () => {
  const hosts = readSharedHosts();

  it('reads a list with every class', () => {
    expect(new Set(hosts.map(entry => entry.kind))).toEqual(
      new Set(['private', 'cgnat', 'public', 'app-private', 'app-public']),
    );
  });

  it.each(hosts.filter(entry => ['private', 'app-private', 'cgnat'].includes(entry.kind)))(
    'accepts $host ($kind), since a listed address is the operator choice',
    ({ host }) => {
      expect(isPrivateNetworkHost(host)).toBe(true);
    },
  );

  it.each(hosts.filter(entry => ['public', 'app-public'].includes(entry.kind)))('rejects $host', ({ host }) => {
    expect(isPrivateNetworkHost(host)).toBe(false);
  });

  it('rejects an empty host and a doubled dot', () => {
    expect(isPrivateNetworkHost('a..b')).toBe(false);
    expect(isPrivateNetworkHost('')).toBe(false);
  });
});

describe('parseAllowedOrigins', () => {
  it('is empty when unset or blank', () => {
    expect(parseAllowedOrigins(undefined)).toEqual([]);
    expect(parseAllowedOrigins(' , ')).toEqual([]);
  });

  it('keeps plain http for this computer and private networks, and https for anything', () => {
    expect(
      parseAllowedOrigins(
        'http://127.0.0.1:8791, http://localhost:8791,http://192.168.1.20:8791,http://100.101.102.103:8791,http://spark.local:8791,https://aman.example.com',
      ),
    ).toEqual([
      'http://127.0.0.1:8791',
      'http://localhost:8791',
      'http://192.168.1.20:8791',
      'http://100.101.102.103:8791',
      'http://spark.local:8791',
      'https://aman.example.com',
    ]);
  });

  it('normalises and removes duplicates', () => {
    expect(parseAllowedOrigins('HTTP://Spark.Local:8791,http://spark.local:8791,https://a.example.com:443')).toEqual([
      'http://spark.local:8791',
      'https://a.example.com',
    ]);
  });

  it.each(['http://203.0.113.9:8791', 'http://aman.example.com', 'http://8.8.8.8'])(
    'refuses a public address over plain http (%s) and points to HTTPS',
    entry => {
      expect(() => parseAllowedOrigins(entry)).toThrow(/public address over plain http.*--tls caddy/);
    },
  );

  it.each([
    'ftp://spark:8791',
    'http://spark:8791/app',
    'http://user@spark:8791',
    'http://spark:8791?x=1',
    'spark',
    'http://',
  ])('refuses %s', entry => {
    expect(() => parseAllowedOrigins(entry)).toThrow(/ALLOWED_ORIGINS/);
  });

  it.each(['http://:pw@192.168.1.20:8791', 'http://:@192.168.1.20:8791', 'http://user:pw@192.168.1.20:8791'])(
    'refuses a login of any kind (%s)',
    entry => {
      expect(() => parseAllowedOrigins(entry)).toThrow(/no path, query or login/);
    },
  );

  it.each([
    'http://0x7f.1:8791',
    'http://0xc0a80114:8791',
    'http://0300.0250.01.020:8791',
    'http://3232235796:8791',
    'http://192.168.01.20:8791',
    'http://010.1.1.1:8791',
    'http://192.168.1:8791',
  ])('refuses an address written in octal, hex or as one number (%s) instead of rewriting it', entry => {
    expect(() => parseAllowedOrigins(entry)).toThrow(/octal, hex or as one number|public address/);
  });

  it('keeps an address written as four plain decimal parts', () => {
    expect(parseAllowedOrigins('http://192.168.1.20:8791,http://10.0.0.1')).toEqual([
      'http://192.168.1.20:8791',
      'http://10.0.0.1',
    ]);
  });
});

describe('parseLoginUpstreamUrl', () => {
  it('is empty when unset and keeps a loopback address with a path', () => {
    expect(parseLoginUpstreamUrl(undefined)).toBe('');
    expect(parseLoginUpstreamUrl(' ')).toBe('');
    expect(parseLoginUpstreamUrl('http://127.0.0.1:5556/dex/')).toBe('http://127.0.0.1:5556/dex');
  });

  it.each(['http://192.168.1.20:5556/dex', 'https://127.0.0.1:5556/dex', 'http://127.0.0.1:5556', 'nonsense'])(
    'refuses %s',
    value => {
      expect(() => parseLoginUpstreamUrl(value)).toThrow(/LOGIN_UPSTREAM_URL/);
    },
  );
});

describe('parseTrustedProxyAddresses', () => {
  it('is empty when unset and keeps IP addresses', () => {
    expect(parseTrustedProxyAddresses(undefined)).toEqual([]);
    expect(parseTrustedProxyAddresses(' 172.17.0.1, fd00::1 ')).toEqual(['172.17.0.1', 'fd00::1']);
  });

  it.each(['proxy.example.com', '172.17.0.0/16', '*'])(
    'refuses %s, so a name or range cannot widen the trust',
    value => {
      expect(() => parseTrustedProxyAddresses(value)).toThrow(/TRUSTED_PROXY_ADDRESSES/);
    },
  );
});

describe('parseDemoSendAllowlist', () => {
  it('is empty when unset or blank, which allows no send', () => {
    expect(parseDemoSendAllowlist(undefined)).toEqual([]);
    expect(parseDemoSendAllowlist('  , ')).toEqual([]);
  });

  it('lower-cases, trims and drops repeats', () => {
    expect(parseDemoSendAllowlist(' Maya@Demo.Example, friend@demo.example ,maya@demo.example')).toEqual([
      'maya@demo.example',
      'friend@demo.example',
    ]);
  });

  it.each(['maya', '*@demo.example', 'Maya <maya@demo.example>', 'a@b'])('refuses %s at load', value => {
    expect(() => parseDemoSendAllowlist(value)).toThrow(/DEMO_SEND_ALLOWLIST/);
  });
});

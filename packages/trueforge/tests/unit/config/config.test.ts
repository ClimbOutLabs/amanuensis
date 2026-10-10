import {
  assertNetworkAuthRequirement,
  assertOidcIssuerTransportAllowed,
  getPublicBaseUrl,
  getPublicUiBasePath,
  isLoopbackHost,
  parsePublicBaseUrl,
  parseTokenFactoryMode,
  TrueForgeAuthMode,
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
  it('honors PUBLIC_BASE_URL in production standalone', () => {
    const config = {
      STANDALONE: true,
      NODE_ENV: 'production',
      PORT: 8790,
      PUBLIC_BASE_URL: 'https://host.example',
    } as ServerConfiguration;

    expect(getPublicBaseUrl(config)).toBe('https://host.example');
  });

  it('defaults to the loopback address in standalone when unset', () => {
    const config = { STANDALONE: true, NODE_ENV: 'production', PORT: 8123, PUBLIC_BASE_URL: '' } as ServerConfiguration;

    expect(getPublicBaseUrl(config)).toBe('http://localhost:8123');
    expect(getPublicUiBasePath(config)).toBe('/');
  });

  it('still requires PUBLIC_BASE_URL in distributed mode', () => {
    const config = { STANDALONE: false, PORT: 8790, PUBLIC_BASE_URL: '' } as ServerConfiguration;

    expect(() => getPublicBaseUrl(config)).toThrow(/PUBLIC_BASE_URL is required/);
  });

  it('honors the PUBLIC_BASE_URL pathname in distributed mode', () => {
    expect(
      getPublicUiBasePath({
        STANDALONE: false,
        PUBLIC_BASE_URL: 'https://host.example/custom/proxy/path',
      } as ServerConfiguration),
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

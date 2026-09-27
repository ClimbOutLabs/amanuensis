import {
  assertNetworkAuthRequirement,
  getPublicUiBasePath,
  isLoopbackHost,
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

describe('getPublicUiBasePath', () => {
  it('ignores a path-bearing PUBLIC_BASE_URL in standalone non-development', () => {
    expect(
      getPublicUiBasePath({
        STANDALONE: true,
        NODE_ENV: 'production',
        PORT: 8790,
        PUBLIC_BASE_URL: 'https://host.example/custom/proxy/path',
      } as ServerConfiguration),
    ).toBe('/');
  });

  it('honors PUBLIC_BASE_URL pathname in standalone development', () => {
    expect(
      getPublicUiBasePath({
        STANDALONE: true,
        NODE_ENV: 'development',
        PUBLIC_BASE_URL: 'https://host.example/custom/proxy/path',
      } as ServerConfiguration),
    ).toBe('/custom/proxy/path/');
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
  it('throws for standalone mode on a non-loopback bind', () => {
    expect(() =>
      assertNetworkAuthRequirement({
        authMode: TrueForgeAuthMode.Standalone,
        host: '0.0.0.0',
        requireAuth: true,
      }),
    ).toThrow(/Refusing to listen on 0\.0\.0\.0 without authentication/);
  });

  it('names the remediation options in the error', () => {
    expect(() =>
      assertNetworkAuthRequirement({
        authMode: TrueForgeAuthMode.Standalone,
        host: '192.168.1.10',
        requireAuth: true,
      }),
    ).toThrow(/OIDC|HOST=localhost|REQUIRE_AUTH=false/);
  });

  it('passes for standalone mode on loopback', () => {
    expect(() =>
      assertNetworkAuthRequirement({
        authMode: TrueForgeAuthMode.Standalone,
        host: 'localhost',
        requireAuth: true,
      }),
    ).not.toThrow();
  });

  it('passes when OIDC or TrueFoundry provides authentication', () => {
    for (const authMode of [TrueForgeAuthMode.Oidc, TrueForgeAuthMode.TrueFoundry]) {
      expect(() => assertNetworkAuthRequirement({ authMode, host: '0.0.0.0', requireAuth: true })).not.toThrow();
    }
  });

  it('passes when the operator explicitly opts out with REQUIRE_AUTH=false', () => {
    expect(() =>
      assertNetworkAuthRequirement({
        authMode: TrueForgeAuthMode.Standalone,
        host: '0.0.0.0',
        requireAuth: false,
      }),
    ).not.toThrow();
  });
});

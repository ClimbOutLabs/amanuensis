import {
  appendOutboundTrace,
  checkOutboundStrings,
  collectOutboundStrings,
  type OutboundGuardRule,
} from '@truefoundry/trueforge-core/core/permissions/outboundGuard';
import type { IMcpServerStore, McpServerRecord } from '../../../src/db/mcpServerStore';
import type { ModelProviderRecord } from '../../../src/db/modelProviderStore';
import { createOutboundSecretSource, type OutboundSecretSources } from '../../../src/runtime/outboundSecrets';

const alice = { tenant_id: 't1', created_by: 'alice' };
const headerKey = ['synthetic', 'connector', 'key', 'a1B2c3D4e5F6g7'].join('-');
const basicUser = 'synthetic-basic-user';
const basicPassword = ['synthetic', 'basic', 'pass', 'h8I9j0'].join('-');
const basicCredential = Buffer.from(`${basicUser}:${basicPassword}`).toString('base64');

/** Runs one search through the outbound guard and returns the trace the next search sees. */
function search(input: { query: string; secrets: readonly string[]; earlier: string }): {
  rule: OutboundGuardRule | undefined;
  earlier: string;
} {
  const strings = collectOutboundStrings({ query: input.query });
  if (strings === undefined) {
    throw new Error('test arguments must be inspectable');
  }
  const verdict = checkOutboundStrings({ strings, secrets: input.secrets, earlier: input.earlier });
  return {
    rule: verdict.ok ? undefined : verdict.rule,
    earlier: appendOutboundTrace({ earlier: input.earlier, strings }),
  };
}

function mcpRecord(id: string, manifest: McpServerRecord['manifest']): McpServerRecord {
  return {
    id,
    tenant_id: 't1',
    name: manifest.name,
    manifest,
    first_party: false,
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
  };
}

const providerRecord: ModelProviderRecord = {
  tenant_id: 't1',
  name: 'custom-llm',
  created_at: '2026-10-01T00:00:00.000Z',
  updated_at: '2026-10-01T00:00:00.000Z',
  manifest: {
    type: 'custom',
    name: 'custom-llm',
    base_url: 'https://llm.example.com/v1',
    auth: { api_key: 'synthetic-provider-key-0001' },
    models: [{ name: 'model-a', model_id: 'model-a', properties: {} }],
  },
};

function sources(overrides: Partial<OutboundSecretSources> = {}): OutboundSecretSources {
  const servers = [
    mcpRecord('srv-header', {
      type: 'remote',
      name: 'header-mcp',
      url: 'https://header.example/mcp',
      description: 'd',
      auth: { type: 'header', headers: { Authorization: `Bearer ${headerKey}` } },
    }),
    mcpRecord('srv-basic', {
      type: 'remote',
      name: 'basic-mcp',
      url: 'https://basic.example/mcp',
      description: 'd',
      auth: { type: 'header', headers: { Authorization: `basic ${basicCredential}` } },
    }),
    mcpRecord('srv-oauth', {
      type: 'remote',
      name: 'oauth-mcp',
      url: 'https://oauth.example/mcp',
      description: 'd',
      auth: { type: 'oauth_client', client_id: 'cid', client_secret: 'synthetic-client-secret-0003' },
    }),
    mcpRecord('srv-dcr', {
      type: 'remote',
      name: 'dcr-mcp',
      url: 'https://dcr.example/mcp',
      description: 'd',
      auth: { type: 'dcr' },
    }),
  ];
  return {
    configured: () => ['synthetic-configured-0004'],
    modelProviders: { listProviders: () => Promise.resolve([providerRecord]) },
    sandboxProviders: { getSandboxProvider: () => Promise.resolve(undefined) },
    mcpServers: {
      listServers: () => Promise.resolve(servers),
      getClient: ({ id }) =>
        Promise.resolve(
          id === 'srv-dcr'
            ? {
                server: { authorizationEndpoint: 'a', tokenEndpoint: 't', codeChallengeMethodsSupported: null },
                client: { clientId: 'dcr-client', clientSecret: 'synthetic-dcr-secret-0005' },
              }
            : undefined,
        ),
    } satisfies Pick<IMcpServerStore, 'listServers' | 'getClient'>,
    tokens: {
      getTokens: ({ userRef }) =>
        Promise.resolve(
          new Map(
            userRef === 'alice'
              ? [
                  [
                    'srv-dcr',
                    {
                      accessToken: 'synthetic-access-0006',
                      refreshToken: 'synthetic-refresh-0007',
                      expiresAt: '2030-01-01T00:00:00.000Z',
                      scope: null,
                    },
                  ],
                ]
              : [],
          ),
        ),
    },
    googleConnections: {
      get: ({ created_by }) =>
        Promise.resolve(
          created_by === 'alice'
            ? {
                tenant_id: 't1',
                created_by,
                client_id: 'cid.apps.googleusercontent.com',
                client_secret: 'synthetic-google-secret-0009',
                client_type: 'desktop',
                refresh_token: 'synthetic-google-refresh-0010',
                granted_scopes: [],
                account_email: null,
                status: 'connected',
                created_at: '2026-10-01T00:00:00.000Z',
                updated_at: '2026-10-01T00:00:00.000Z',
              }
            : null,
        ),
    },
    ...overrides,
  };
}

describe('createOutboundSecretSource', () => {
  it('gathers the keys, headers, client secrets, tokens and configured values the server holds', async () => {
    const secrets = await createOutboundSecretSource(sources())(alice);
    expect(new Set(secrets)).toEqual(
      new Set([
        'synthetic-configured-0004',
        'synthetic-provider-key-0001',
        `Bearer ${headerKey}`,
        headerKey,
        `basic ${basicCredential}`,
        basicCredential,
        `${basicUser}:${basicPassword}`,
        basicUser,
        basicPassword,
        'synthetic-client-secret-0003',
        'synthetic-access-0006',
        'synthetic-refresh-0007',
        'synthetic-dcr-secret-0005',
        'synthetic-google-secret-0009',
        'synthetic-google-refresh-0010',
      ]),
    );
  });

  it('holds another user’s OAuth tokens out of this user’s list', async () => {
    const secrets = await createOutboundSecretSource(sources())({ tenant_id: 't1', created_by: 'bob' });
    expect(secrets).not.toContain('synthetic-access-0006');
    expect(secrets).not.toContain('synthetic-google-refresh-0010');
    expect(secrets).toContain('synthetic-provider-key-0001');
  });

  it('resolves stored ${env:...} pointers to the value they stand for and drops unresolvable ones', async () => {
    process.env['SYNTHETIC_OUTBOUND_TEST_KEY'] = 'synthetic-env-value-0008';
    try {
      const withPointers = sources({
        configured: () => ['${env:SYNTHETIC_OUTBOUND_TEST_KEY}', '${env:SYNTHETIC_OUTBOUND_MISSING}'],
      });
      const secrets = await createOutboundSecretSource(withPointers)(alice);
      expect(secrets).toContain('synthetic-env-value-0008');
      expect(secrets.some(secret => secret.includes('${env:'))).toBe(false);
    } finally {
      Reflect.deleteProperty(process.env, 'SYNTHETIC_OUTBOUND_TEST_KEY');
    }
  });

  it('rejects, rather than returning a partial list, when a store fails, and recovers on the next call', async () => {
    let failing = true;
    const flaky = sources({
      modelProviders: {
        listProviders: () => (failing ? Promise.reject(new Error('db down')) : Promise.resolve([providerRecord])),
      },
    });
    const source = createOutboundSecretSource(flaky);
    await expect(source(alice)).rejects.toThrow('Could not read the secrets this server holds');
    failing = false;
    expect(await source(alice)).toContain('synthetic-provider-key-0001');
  });

  it('reuses one read for the several classifications of a single call', async () => {
    const listProviders = jest.fn(() => Promise.resolve([providerRecord]));
    const source = createOutboundSecretSource(sources({ modelProviders: { listProviders } }));
    await Promise.all([source(alice), source(alice), source(alice)]);
    expect(listProviders).toHaveBeenCalledTimes(1);
  });

  it('leaves a header value with no auth scheme whole', async () => {
    const plain = mcpRecord('srv-plain', {
      type: 'remote',
      name: 'plain-mcp',
      url: 'https://plain.example/mcp',
      description: 'd',
      auth: { type: 'header', headers: { 'x-api-key': 'synthetic-plain-header-0011' } },
    });
    const secrets = await createOutboundSecretSource(
      sources({
        mcpServers: { listServers: () => Promise.resolve([plain]), getClient: () => Promise.resolve(undefined) },
      }),
    )(alice);
    expect(secrets).toContain('synthetic-plain-header-0011');
  });
});

describe('outbound guard over the secrets this server holds', () => {
  it('holds a connector key split across three searches', async () => {
    const secrets = await createOutboundSecretSource(sources())(alice);
    const pieces = [headerKey.slice(0, 14), headerKey.slice(14, 28), headerKey.slice(28)];
    let earlier = '';
    const rules: (OutboundGuardRule | undefined)[] = [];
    for (const piece of pieces) {
      const result = search({ query: piece, secrets, earlier });
      rules.push(result.rule);
      earlier = result.earlier;
    }
    expect(rules).toEqual([undefined, undefined, 'server_secret']);
  });

  it('holds a bare connector key in one search', async () => {
    const secrets = await createOutboundSecretSource(sources())(alice);
    expect(search({ query: `docs for ${headerKey}`, secrets, earlier: '' }).rule).toBe('server_secret');
  });

  it('holds a Basic credential, encoded or decoded', async () => {
    const secrets = await createOutboundSecretSource(sources())(alice);
    expect(search({ query: basicCredential, secrets, earlier: '' }).rule).toBe('server_secret');
    expect(search({ query: `login ${basicPassword}`, secrets, earlier: '' }).rule).toBe('server_secret');
  });

  it('lets an ordinary search through', async () => {
    const secrets = await createOutboundSecretSource(sources())(alice);
    expect(search({ query: 'how to rotate a connector key', secrets, earlier: '' }).rule).toBeUndefined();
  });
});

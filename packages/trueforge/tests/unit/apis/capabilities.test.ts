// Sandbox capability is driven by the refreshed image status; stub it so tests never touch Daytona.
jest.mock('../../../src/sandbox/providerUtils', () => ({ checkSnapshotStatus: jest.fn() }));

import { OpenAPIHono } from '@hono/zod-openapi';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { Configuration } from 'openid-client';
import { createLogger } from 'winston';
import {
  createCapabilitiesRouter,
  MEMORY_SCREEN_NOT_CONFIGURED_REASON,
  toBuildIdentity,
} from '../../../src/apis/capabilities';
import { TENANT_ID } from '../../../src/apis/sessions';
import type { Authenticator } from '../../../src/auth/authenticator';
import { resolveRequestContext } from '../../../src/auth/identity';
import { createAuthMiddleware } from '../../../src/auth/middleware';
import { disableOidcAuth, enableOidcAuth, initOidc } from '../../../src/auth/oidc';
import { OidcAuthenticator } from '../../../src/auth/oidcAuthenticator';
import { StandaloneAuthenticator } from '../../../src/auth/standaloneAuthenticator';
import configuration, { UNSTAMPED_BUILD_REF, type OIDCConfig } from '../../../src/config';
import { migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import { createSqliteDb } from '../../../src/db/sqlite/client';
import { SqliteGlobalSettingsStore } from '../../../src/db/sqlite/global-settings-store/SqliteGlobalSettingsStore';
import { SqliteMcpServerStore } from '../../../src/db/sqlite/mcp-server-store/SqliteMcpServerStore';
import { SqliteSandboxProviderStore } from '../../../src/db/sqlite/sandbox-provider-store/SqliteSandboxProviderStore';
import { PACKAGE_VERSION } from '../../../src/packageVersion';
import { setCachedLocalSandboxSupport } from '../../../src/sandbox/localRuntime';
import { checkSnapshotStatus } from '../../../src/sandbox/providerUtils';
import type { SandboxBuildStatus, SandboxStatus } from '../../../src/schemas/sandboxProvider';

/** The exact `memory_screen` shape when no classifier service is configured, the default env. */
const memoryScreenNotConfigured = {
  enabled: false,
  configured: false,
  reason: MEMORY_SCREEN_NOT_CONFIGURED_REASON,
};

/** The exact `tool_output_screen` shape when no classifier service is configured. */
const toolOutputScreenNotConfigured = {
  enabled: false,
  configured: false,
  reason: MEMORY_SCREEN_NOT_CONFIGURED_REASON,
};

const mockStatus = checkSnapshotStatus as jest.Mock;
const silentLogger = createLogger({ silent: true });

/** Whatever this checkout's environment stamped, so exact-payload assertions stay deterministic. */
const expectedBuild = toBuildIdentity({ version: PACKAGE_VERSION, buildRef: configuration.BUILD_REF });
/** The resolved MEMORY_* defaults, as the capability reports them for every caller. */
const expectedMemoryDefaults = {
  backend: configuration.MEMORY_BACKEND,
  recall_timeout_ms: configuration.MEMORY_RECALL_TIMEOUT_MS,
  recall_query_window: configuration.MEMORY_RECALL_QUERY_WINDOW,
  recall_min_score: configuration.MEMORY_RECALL_MIN_SCORE,
  recall_max_items: configuration.MEMORY_RECALL_MAX_ITEMS,
  recall_max_entities: configuration.MEMORY_RECALL_MAX_ENTITIES,
  prerecall_gate_enabled: configuration.MEMORY_PRERECALL_GATE_ENABLED,
  curated_enabled: configuration.MEMORY_CURATED_ENABLED,
  curated_max_models: configuration.MEMORY_CURATED_MAX_MODELS,
  curated_max_tokens: configuration.MEMORY_CURATED_MAX_TOKENS,
  reflect_enabled: configuration.MEMORY_REFLECT_ENABLED,
  reflect_budget: configuration.MEMORY_REFLECT_BUDGET,
  reflect_max_tokens: configuration.MEMORY_REFLECT_MAX_TOKENS,
  reflect_timeout_ms: configuration.MEMORY_REFLECT_TIMEOUT_MS,
};

const buildWithStatus = (status: SandboxBuildStatus): SandboxStatus => ({
  status,
  status_reason: status === 'failed' ? 'Sandbox image build failed (build_failed).' : null,
  build_metadata: { build_ref: 'trueforge-build-029ea5ff', image_uri: 'tfy.jfrog.io/tfy-images/sandbox:029ea5ff' },
});

const ISSUER = 'https://issuer.example.com';
const AUDIENCE = 'harness-client';

const OIDC_CONFIG: OIDCConfig = {
  OIDC_ISSUER_URL: `${ISSUER}/`,
  OIDC_CLIENT_ID: AUDIENCE,
  OIDC_CLIENT_SECRET: 'harness-secret',
  OIDC_USER_REFERENCE_CLAIM: 'sub',
  OIDC_USER_DISPLAY_NAME_CLAIM: 'name',
  OIDC_USER_ROLE_CLAIM: 'groups',
  OIDC_ADMIN_ROLE_VALUE: 'admin',
  OIDC_SCOPES: ['openid', 'profile', 'email', 'groups'],
  OIDC_ALLOWED_EMAILS: [],
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function withAuth(router: OpenAPIHono, authenticator: Authenticator): OpenAPIHono {
  const shell = new OpenAPIHono();
  shell.use('*', createAuthMiddleware(authenticator));
  shell.route('/', router);
  return shell;
}

describe('capabilities routers', () => {
  beforeEach(() => {
    mockStatus.mockReset();
    mockStatus.mockResolvedValue(undefined);
    setCachedLocalSandboxSupport(undefined);
  });

  afterEach(() => {
    setCachedLocalSandboxSupport(undefined);
  });

  async function makeRouter(authenticator: Authenticator = new StandaloneAuthenticator()): Promise<{
    router: OpenAPIHono;
    mcpServerStore: SqliteMcpServerStore;
    globalSettingsStore: SqliteGlobalSettingsStore;
  }> {
    const db = createSqliteDb(':memory:');
    await migrateSqliteToLatest(db);
    const mcpServerStore = new SqliteMcpServerStore(db);
    const globalSettingsStore = new SqliteGlobalSettingsStore(db);
    const router = withAuth(
      createCapabilitiesRouter({
        resolveSandboxProviderStore: () => new SqliteSandboxProviderStore(db),
        mcpServerStore,
        globalSettingsStore,
        withTransaction: callback => db.transaction().execute(callback),
        logger: silentLogger,
        resolveRequestContext,
      }),
      authenticator,
    );
    return { router, mcpServerStore, globalSettingsStore };
  }

  it('reports sandbox + skill disabled when no image status is available', async () => {
    disableOidcAuth();
    mockStatus.mockResolvedValue(undefined);
    const { router } = await makeRouter();

    const response = await router.request('/');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: {
        sandbox: { enabled: false },
        skill: {
          enabled: false,
          reason: 'Skills run in a sandbox, which is not configured.',
        },
        settings: { enabled: true },
        memory_screen: memoryScreenNotConfigured,
        tool_output_screen: toolOutputScreenNotConfigured,
        memory_defaults: expectedMemoryDefaults,
        build: expectedBuild,
      },
    });
  });

  it('reports sandbox + skill enabled when local fallback is cached and no image status exists', async () => {
    disableOidcAuth();
    mockStatus.mockResolvedValue(undefined);
    setCachedLocalSandboxSupport({
      supported: true,
      platform: 'darwin',
      shell: '/bin/bash',
      python: '/usr/bin/python3',
    });
    const { router } = await makeRouter();

    const response = await router.request('/');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: {
        sandbox: { enabled: true },
        skill: { enabled: true },
        settings: { enabled: true },
        memory_screen: memoryScreenNotConfigured,
        tool_output_screen: toolOutputScreenNotConfigured,
        memory_defaults: expectedMemoryDefaults,
        build: expectedBuild,
      },
    });
  });

  it('reports sandbox + skill enabled only when the image is ready', async () => {
    disableOidcAuth();
    mockStatus.mockResolvedValue(buildWithStatus('ready'));
    const { router } = await makeRouter();

    const response = await router.request('/');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: {
        sandbox: { enabled: true },
        skill: { enabled: true },
        settings: { enabled: true },
        memory_screen: memoryScreenNotConfigured,
        tool_output_screen: toolOutputScreenNotConfigured,
        memory_defaults: expectedMemoryDefaults,
        build: expectedBuild,
      },
    });
  });

  it('reports sandbox disabled with a "being prepared" skill reason while the image is still pending', async () => {
    disableOidcAuth();
    mockStatus.mockResolvedValue(buildWithStatus('pending'));
    const { router } = await makeRouter();

    const response = await router.request('/');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: {
        sandbox: { enabled: false },
        skill: {
          enabled: false,
          reason: 'Skills run in a sandbox whose image is still being prepared — retry shortly.',
        },
      },
    });
  });

  it('reports "not configured" skill reason when the image build failed', async () => {
    disableOidcAuth();
    mockStatus.mockResolvedValue(buildWithStatus('failed'));
    const { router } = await makeRouter();

    const response = await router.request('/');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: {
        sandbox: { enabled: false },
        skill: { enabled: false, reason: 'Skills run in a sandbox, which is not configured.' },
      },
    });
  });

  it('reports the running package version as the build identity', async () => {
    disableOidcAuth();
    const { router } = await makeRouter();

    const response = await router.request('/');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: { build: { version: PACKAGE_VERSION } } });
  });

  describe('toBuildIdentity', () => {
    it('carries the stamped source reference alongside the version', () => {
      expect(toBuildIdentity({ version: '1.4.0', buildRef: '4f2a91c8d3b7e6510a2c9f4b8d1e7a3c5b6d8e90' })).toEqual({
        version: '1.4.0',
        ref: '4f2a91c8d3b7e6510a2c9f4b8d1e7a3c5b6d8e90',
      });
    });

    it('omits the reference rather than reporting the unstamped placeholder', () => {
      expect(toBuildIdentity({ version: '1.4.0', buildRef: UNSTAMPED_BUILD_REF })).toEqual({ version: '1.4.0' });
    });
  });

  it('fails closed (sandbox disabled) when the status check throws', async () => {
    disableOidcAuth();
    mockStatus.mockRejectedValue(new Error('daytona unreachable'));
    const { router } = await makeRouter();

    const response = await router.request('/');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: { sandbox: { enabled: false } } });
  });

  describe('when auth is enabled', () => {
    const realFetch = globalThis.fetch;
    let privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
    let oidcClient: Configuration;

    beforeAll(async () => {
      const keyPair = await generateKeyPair('RS256');
      privateKey = keyPair.privateKey;
      const publicJwk = await exportJWK(keyPair.publicKey);
      publicJwk.kid = 'test-kid';
      publicJwk.alg = 'RS256';
      publicJwk.use = 'sig';

      globalThis.fetch = async input => {
        const url = String(input);
        if (url === `${ISSUER}/.well-known/openid-configuration`) {
          return json({
            issuer: ISSUER,
            authorization_endpoint: `${ISSUER}/authorize`,
            token_endpoint: `${ISSUER}/token`,
            jwks_uri: `${ISSUER}/jwks`,
            response_types_supported: ['code'],
            id_token_signing_alg_values_supported: ['RS256'],
            subject_types_supported: ['public'],
          });
        }
        if (url === `${ISSUER}/jwks`) {
          return json({ keys: [publicJwk] });
        }
        return new Response(`unexpected url: ${url}`, { status: 404 });
      };

      const client = await initOidc(OIDC_CONFIG);
      if (!client) {
        throw new Error('OIDC client was not initialized');
      }
      oidcClient = client;
    });

    afterAll(() => {
      globalThis.fetch = realFetch;
      disableOidcAuth();
    });

    beforeEach(() => {
      enableOidcAuth({ client: oidcClient, oidcConfig: OIDC_CONFIG });
    });

    async function createIdToken(groups: string[]): Promise<string> {
      return new SignJWT({ groups })
        .setProtectedHeader({ alg: 'RS256', kid: 'test-kid' })
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setSubject('user-1')
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(privateKey);
    }

    it('marks settings enabled for admin callers and disabled for non-admin callers', async () => {
      const db = createSqliteDb(':memory:');
      await migrateSqliteToLatest(db);
      const router = withAuth(
        createCapabilitiesRouter({
          resolveSandboxProviderStore: () => new SqliteSandboxProviderStore(db),
          mcpServerStore: new SqliteMcpServerStore(db),
          globalSettingsStore: new SqliteGlobalSettingsStore(db),
          withTransaction: callback => db.transaction().execute(callback),
          logger: silentLogger,
          resolveRequestContext,
        }),
        new OidcAuthenticator(),
      );

      const adminRes = await router.request('/', {
        headers: { Cookie: `id_token=${await createIdToken(['admin'])}` },
      });
      expect(adminRes.status).toBe(200);
      expect(await adminRes.json()).toEqual({
        data: {
          sandbox: { enabled: false },
          skill: {
            enabled: false,
            reason: 'Skills run in a sandbox, which is not configured.',
          },
          settings: { enabled: true },
          memory_screen: memoryScreenNotConfigured,
          tool_output_screen: toolOutputScreenNotConfigured,
          memory_defaults: expectedMemoryDefaults,
          build: expectedBuild,
        },
      });

      const userRes = await router.request('/', {
        headers: { Cookie: `id_token=${await createIdToken(['everyone'])}` },
      });
      expect(userRes.status).toBe(200);
      expect(await userRes.json()).toEqual({
        data: {
          sandbox: { enabled: false },
          skill: {
            enabled: false,
            reason: 'Skills run in a sandbox, which is not configured.',
          },
          settings: { enabled: false },
          memory_screen: memoryScreenNotConfigured,
          tool_output_screen: toolOutputScreenNotConfigured,
          memory_defaults: expectedMemoryDefaults,
          build: expectedBuild,
        },
      });
    });
  });

  describe('memory recall screen status', () => {
    const originalEnabled = configuration.MEMORY_SCREEN_ENABLED;
    const originalUrl = configuration.MEMORY_SCREEN_URL;
    const originalAuthToken = configuration.MEMORY_SCREEN_AUTH_TOKEN;
    const originalThreshold = configuration.MEMORY_SCREEN_THRESHOLD;
    const originalToolOutputEnabled = configuration.TOOL_OUTPUT_SCREEN_ENABLED;
    const originalToolOutputTimeoutMs = configuration.TOOL_OUTPUT_SCREEN_TIMEOUT_MS;

    afterEach(() => {
      configuration.MEMORY_SCREEN_ENABLED = originalEnabled;
      configuration.MEMORY_SCREEN_URL = originalUrl;
      configuration.MEMORY_SCREEN_AUTH_TOKEN = originalAuthToken;
      configuration.MEMORY_SCREEN_THRESHOLD = originalThreshold;
      configuration.TOOL_OUTPUT_SCREEN_ENABLED = originalToolOutputEnabled;
      configuration.TOOL_OUTPUT_SCREEN_TIMEOUT_MS = originalToolOutputTimeoutMs;
    });

    it('reports the screen off when MEMORY_SCREEN_ENABLED is false, without url or threshold', async () => {
      disableOidcAuth();
      configuration.MEMORY_SCREEN_ENABLED = false;
      configuration.MEMORY_SCREEN_URL = 'https://screen.example.com';
      configuration.MEMORY_SCREEN_THRESHOLD = 0.7;
      const { router } = await makeRouter();

      const response = await router.request('/');
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        data: { memory_screen: { enabled: false, configured: true } },
      });
    });

    it('reports not configured, with a reason, when MEMORY_SCREEN_URL is unset even though MEMORY_SCREEN_ENABLED is true', async () => {
      disableOidcAuth();
      configuration.MEMORY_SCREEN_ENABLED = true;
      configuration.MEMORY_SCREEN_URL = '';
      const { router } = await makeRouter();

      const response = await router.request('/');
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        data: {
          memory_screen: { enabled: false, configured: false, reason: MEMORY_SCREEN_NOT_CONFIGURED_REASON },
        },
      });
    });

    it('turns screening off when the per-bank screen_enabled setting is explicitly false, overriding MEMORY_SCREEN_ENABLED', async () => {
      disableOidcAuth();
      configuration.MEMORY_SCREEN_ENABLED = true;
      configuration.MEMORY_SCREEN_URL = 'https://screen.internal.example.com:8443';
      configuration.MEMORY_SCREEN_THRESHOLD = 0.7;
      const { router, mcpServerStore } = await makeRouter();
      await mcpServerStore.upsertServer({
        tenant_id: TENANT_ID,
        name: 'hindsight',
        manifest: {
          type: 'remote',
          name: 'hindsight',
          url: 'https://hindsight.example.com/mcp/aman/',
          description: 'Hindsight memory provider.',
          memory_provider: true,
          memory_settings: { screen_enabled: false },
        },
      });

      const response = await router.request('/');
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        data: { memory_screen: { enabled: false, configured: true } },
      });
    });

    it('turns screening on when the per-bank screen_enabled setting is explicitly true, overriding a false MEMORY_SCREEN_ENABLED', async () => {
      disableOidcAuth();
      configuration.MEMORY_SCREEN_ENABLED = false;
      configuration.MEMORY_SCREEN_URL = 'https://screen.internal.example.com:8443';
      configuration.MEMORY_SCREEN_THRESHOLD = 0.7;
      const { router, mcpServerStore } = await makeRouter();
      await mcpServerStore.upsertServer({
        tenant_id: TENANT_ID,
        name: 'hindsight',
        manifest: {
          type: 'remote',
          name: 'hindsight',
          url: 'https://hindsight.example.com/mcp/aman/',
          description: 'Hindsight memory provider.',
          memory_provider: true,
          memory_settings: { screen_enabled: true },
        },
      });

      const response = await router.request('/');
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        data: { memory_screen: { enabled: true, configured: true, threshold: 0.7 } },
      });
    });

    it('falls back to MEMORY_SCREEN_ENABLED when the per-bank screen_enabled setting is unset', async () => {
      disableOidcAuth();
      configuration.MEMORY_SCREEN_ENABLED = true;
      configuration.MEMORY_SCREEN_URL = 'https://screen.internal.example.com:8443';
      configuration.MEMORY_SCREEN_THRESHOLD = 0.7;
      const { router, mcpServerStore } = await makeRouter();
      await mcpServerStore.upsertServer({
        tenant_id: TENANT_ID,
        name: 'hindsight',
        manifest: {
          type: 'remote',
          name: 'hindsight',
          url: 'https://hindsight.example.com/mcp/aman/',
          description: 'Hindsight memory provider.',
          memory_provider: true,
          memory_settings: { recall_timeout_ms: 6000 },
        },
      });

      const response = await router.request('/');
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        data: { memory_screen: { enabled: true, configured: true, threshold: 0.7 } },
      });
    });

    it('reports the screen on with its threshold, and never the url or the auth token', async () => {
      disableOidcAuth();
      configuration.MEMORY_SCREEN_ENABLED = true;
      configuration.MEMORY_SCREEN_URL = 'https://screen.internal.example.com:8443';
      configuration.MEMORY_SCREEN_AUTH_TOKEN = 'super-secret-classifier-token';
      configuration.MEMORY_SCREEN_THRESHOLD = 0.7;
      const { router } = await makeRouter();

      const response = await router.request('/');
      expect(response.status).toBe(200);
      const body: unknown = await response.json();
      expect(body).toMatchObject({
        data: { memory_screen: { enabled: true, threshold: 0.7 } },
      });
      // The classifier URL names internal infrastructure and can carry userinfo; capabilities is
      // readable by every authenticated user, so the URL must never ride along — nor the auth token.
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain('screen.internal.example.com');
      expect(serialized).not.toContain('"url"');
      expect(serialized).not.toContain('super-secret-classifier-token');
    });

    it('never exposes the classifier url, even with MEMORY_SCREEN_URL set', async () => {
      disableOidcAuth();
      configuration.MEMORY_SCREEN_ENABLED = true;
      configuration.MEMORY_SCREEN_URL = 'https://screen.internal.example.com:8443';
      configuration.MEMORY_SCREEN_THRESHOLD = 0.5;
      const { router } = await makeRouter();

      const response = await router.request('/');
      expect(response.status).toBe(200);
      const body: unknown = await response.json();
      expect(body).toMatchObject({ data: { memory_screen: { enabled: true, threshold: 0.5 } } });
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain('screen.internal.example.com');
      expect(serialized).not.toContain('"url"');
    });

    it('reports live tool-output screen status without exposing classifier url or auth token', async () => {
      disableOidcAuth();
      configuration.MEMORY_SCREEN_URL = 'https://screen.internal.example.com:8443';
      configuration.MEMORY_SCREEN_AUTH_TOKEN = 'super-secret-classifier-token';
      configuration.MEMORY_SCREEN_THRESHOLD = 0.66;
      configuration.TOOL_OUTPUT_SCREEN_ENABLED = true;
      configuration.TOOL_OUTPUT_SCREEN_TIMEOUT_MS = 2_250;
      const { router } = await makeRouter();

      const response = await router.request('/');
      expect(response.status).toBe(200);
      const body: unknown = await response.json();
      expect(body).toMatchObject({
        data: { tool_output_screen: { enabled: true, configured: true, threshold: 0.66, timeout_ms: 2_250 } },
      });
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain('screen.internal.example.com');
      expect(serialized).not.toContain('"url"');
      expect(serialized).not.toContain('super-secret-classifier-token');
    });

    it('reports the persisted override over the env default', async () => {
      disableOidcAuth();
      configuration.TOOL_OUTPUT_SCREEN_ENABLED = true;
      configuration.MEMORY_SCREEN_URL = 'https://screen.internal.example.com:8443';
      configuration.MEMORY_SCREEN_THRESHOLD = 0.66;
      configuration.TOOL_OUTPUT_SCREEN_TIMEOUT_MS = 2_250;
      const { router, globalSettingsStore } = await makeRouter();

      await globalSettingsStore.setSetting({ key: 'tool_output_screen_enabled', value: 'false' });
      const overridden = await router.request('/');
      expect(await overridden.json()).toMatchObject({
        data: { tool_output_screen: { enabled: false, configured: true } },
      });

      await globalSettingsStore.deleteSetting({ key: 'tool_output_screen_enabled' });
      const backToDefault = await router.request('/');
      expect(await backToDefault.json()).toMatchObject({
        data: { tool_output_screen: { enabled: true, configured: true, threshold: 0.66, timeout_ms: 2_250 } },
      });
    });

    it('reports not configured, with a reason, when MEMORY_SCREEN_URL is unset even with a stored override', async () => {
      disableOidcAuth();
      configuration.TOOL_OUTPUT_SCREEN_ENABLED = true;
      configuration.MEMORY_SCREEN_URL = '';
      const { router, globalSettingsStore } = await makeRouter();

      // Even a stored ON override cannot turn screening on with no classifier to call.
      await globalSettingsStore.setSetting({ key: 'tool_output_screen_enabled', value: 'true' });
      const response = await router.request('/');
      expect(response.status).toBe(200);
      const body: unknown = await response.json();
      expect(body).toMatchObject({
        data: {
          tool_output_screen: {
            enabled: false,
            configured: false,
            reason: MEMORY_SCREEN_NOT_CONFIGURED_REASON,
          },
        },
      });
    });
  });
});

import {
  AgentSpecSchema,
  InMemorySessionStore,
  Sessions,
  type SessionAgent,
  type SessionHandle,
} from '@truefoundry/trueforge-core/agent-session';
import { McpConnectionError, type VercelAIProviderConfig } from '@truefoundry/trueforge-core/core';
import { HTTPException } from 'hono/http-exception';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TENANT_ID } from '../../../src/apis/sessions';
import { validateGitAgentSkills } from '../../../src/db/gitSkillMounts';
import { migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import type { ISkillStore } from '../../../src/db/skillStore';
import { createSqliteDb } from '../../../src/db/sqlite/client';
import { SqliteMcpServerStore } from '../../../src/db/sqlite/mcp-server-store/SqliteMcpServerStore';
import { SqliteModelProviderStore } from '../../../src/db/sqlite/model-provider-store/SqliteModelProviderStore';
import { SqliteRepositoryStore } from '../../../src/db/sqlite/repository-store/SqliteRepositoryStore';
import { SqliteSandboxProviderStore } from '../../../src/db/sqlite/sandbox-provider-store/SqliteSandboxProviderStore';
import { SqliteSkillStore } from '../../../src/db/sqlite/skill-store/SqliteSkillStore';
import { SqliteOAuthTokenStore } from '../../../src/db/sqlite/token-store/SqliteOAuthTokenStore';
import {
  applyTokenFactoryRouting,
  buildGatewayMetadata,
  getMcpConnection,
  getModelDetails,
  isGithubConnectorAttached,
  localSandboxSessionSegment,
  RepositoryBindingResolutionError,
  resolveBoundRepository,
  resolveGithubGitToken,
  TFG_METADATA_PREFIX,
  validateAgentSpec,
  withGatewayMetadataHeaders,
  X_TFY_METADATA,
} from '../../../src/runtime/sessionResources';
import { setCachedLocalSandboxSupport } from '../../../src/sandbox/localRuntime';
import type { ReasoningEffort } from '../../../src/schemas/modelProvider';

describe('resolveBoundRepository', () => {
  it('loads only confirmed commands for the bound repository revision', async () => {
    const db = createSqliteDb(':memory:');
    await migrateSqliteToLatest(db);
    const store = new SqliteRepositoryStore(db);
    const repository = await store.createRepository({
      tenant_id: TENANT_ID,
      created_by: 'owner-1',
      name: 'demo',
      clone_url: 'https://example.test/demo.git',
      default_branch: 'main',
    });
    await store.upsertVerifyCommand({
      tenant_id: TENANT_ID,
      created_by: 'owner-1',
      repository_id: repository.id,
      command_id: 'verify',
      purpose: 'verify',
      command: 'pnpm verify',
      timeout_ms: 900_000,
      expected_revision: repository.revision,
    });
    await store.upsertVerifyCommandProposal({
      tenant_id: TENANT_ID,
      created_by: 'owner-1',
      repository_id: repository.id,
      id: 'proposal-1',
      purpose: 'test',
      command: 'pnpm test',
      source_kind: 'package_json',
      source_path: 'package.json',
      source_fingerprint: 'sha256:proposal',
    });

    await expect(
      resolveBoundRepository({
        tenant_id: TENANT_ID,
        created_by: 'owner-1',
        repository_id: repository.id,
        workspace_cwd: 'C:\\work\\demo',
        store,
      }),
    ).resolves.toMatchObject({
      repository_id: repository.id,
      revision: 1,
      workspace_cwd: 'C:\\work\\demo',
      commands: [
        {
          command_id: 'verify',
          purpose: 'verify',
          command: 'pnpm verify',
          timeout_ms: 900_000,
        },
      ],
    });
  });

  it('rejects partial or inaccessible bindings instead of silently dropping them', async () => {
    const db = createSqliteDb(':memory:');
    await migrateSqliteToLatest(db);
    const store = new SqliteRepositoryStore(db);

    await expect(
      resolveBoundRepository({
        tenant_id: TENANT_ID,
        created_by: 'owner-1',
        repository_id: 'repo-1',
        workspace_cwd: null,
        store,
      }),
    ).rejects.toBeInstanceOf(RepositoryBindingResolutionError);
    await expect(
      resolveBoundRepository({
        tenant_id: TENANT_ID,
        created_by: 'owner-1',
        repository_id: 'repo-1',
        workspace_cwd: 'C:\\work\\demo',
        store,
      }),
    ).rejects.toThrow('is unavailable for this user');
  });
});

async function createGatewayMetadataSession(input: { agent: SessionAgent }): Promise<SessionHandle> {
  const sessions = new Sessions({ sessionStore: new InMemorySessionStore() });
  return sessions.create({
    tenant_id: 'tenant-1',
    session_id: 'sess-1',
    created_by_subject: { subject_id: 'user-1', subject_type: 'user', subject_display_name: 'user-1' },
    agent: input.agent,
    metadata: {},
    external_id: null,
  });
}

describe('buildGatewayMetadata', () => {
  it('stamps session/turn/agent fields only', async () => {
    const session = await createGatewayMetadataSession({
      agent: { type: 'reference', id: 'agent-1', name: 'my-agent' },
    });

    expect(buildGatewayMetadata({ session, turnId: 'turn-1' })).toEqual({
      [`${TFG_METADATA_PREFIX}.session_id`]: 'sess-1',
      [`${TFG_METADATA_PREFIX}.turn_id`]: 'turn-1',
      [`${TFG_METADATA_PREFIX}.agent_id`]: 'agent-1',
      [`${TFG_METADATA_PREFIX}.agent_name`]: 'my-agent',
    });
  });
});

describe('withGatewayMetadataHeaders', () => {
  it('merges into async header resolvers and preserves authRequired', async () => {
    const withAuth = withGatewayMetadataHeaders({
      headers: async () => ({ headers: { Authorization: 'Bearer t' } }),
      metadataHeaders: { [X_TFY_METADATA]: '{"k":"v"}' },
    });
    expect(typeof withAuth).toBe('function');
    if (typeof withAuth !== 'function') {
      throw new Error('expected async header resolver');
    }
    await expect(withAuth()).resolves.toEqual({
      headers: {
        Authorization: 'Bearer t',
        [X_TFY_METADATA]: '{"k":"v"}',
      },
    });

    const authRequired = withGatewayMetadataHeaders({
      headers: async () => ({
        authRequired: { servers: [{ id: 'mcp', name: 'mcp', auth_url: 'https://auth.example' }] },
      }),
      metadataHeaders: { [X_TFY_METADATA]: '{"k":"v"}' },
    });
    expect(typeof authRequired).toBe('function');
    if (typeof authRequired !== 'function') {
      throw new Error('expected async header resolver');
    }
    await expect(authRequired()).resolves.toEqual({
      authRequired: { servers: [{ id: 'mcp', name: 'mcp', auth_url: 'https://auth.example' }] },
    });
  });
});

describe('localSandboxSessionSegment', () => {
  it('keeps a single-segment session id and rejects missing or unsafe values', () => {
    expect(localSandboxSessionSegment('sess_1')).toBe('sess_1');
    expect(localSandboxSessionSegment(undefined)).toBe('_');
    expect(localSandboxSessionSegment('')).toBe('_');
    expect(localSandboxSessionSegment('a/b')).toBe('_');
    expect(localSandboxSessionSegment('..')).toBe('_');
    expect(localSandboxSessionSegment('foo..bar')).toBe('_');
  });
});

describe('resolveGithubGitToken', () => {
  it('bridges an explicitly enabled trusted GitHub connector without admitting lookalike hosts', async () => {
    const db = createSqliteDb(':memory:');
    await migrateSqliteToLatest(db);
    const store = new SqliteMcpServerStore(db);
    const spec = AgentSpecSchema.parse({
      model: { name: 'test-provider/test-model' },
      mcp_servers: [{ name: 'github' }],
    });
    await store.upsertServer({
      tenant_id: TENANT_ID,
      name: 'github',
      manifest: {
        type: 'remote',
        name: 'github',
        url: 'https://api.githubcopilot.com/mcp/',
        description: 'GitHub',
        auth: { type: 'header', headers: { authorization: 'github_pat_test_value' } },
      },
      first_party: false,
    });

    await expect(resolveGithubGitToken({ tenant_id: TENANT_ID, spec, store })).resolves.toBe('github_pat_test_value');

    await store.upsertServer({
      tenant_id: TENANT_ID,
      name: 'github',
      manifest: {
        type: 'remote',
        name: 'github',
        url: 'https://github.example.test/mcp',
        description: 'Lookalike GitHub server',
        auth: { type: 'header', headers: { Authorization: 'Bearer must-not-escape' } },
      },
      first_party: false,
    });
    await expect(resolveGithubGitToken({ tenant_id: TENANT_ID, spec, store })).resolves.toBeNull();
  });

  it('does not bridge a stored token unless the GitHub connector is enabled for the agent', async () => {
    const db = createSqliteDb(':memory:');
    await migrateSqliteToLatest(db);
    const store = new SqliteMcpServerStore(db);
    await store.upsertServer({
      tenant_id: TENANT_ID,
      name: 'github',
      manifest: {
        type: 'remote',
        name: 'github',
        url: 'https://api.githubcopilot.com/mcp/',
        description: 'GitHub',
        auth: { type: 'header', headers: { Authorization: 'Bearer github_pat_test' } },
      },
      first_party: false,
    });
    const spec = AgentSpecSchema.parse({ model: { name: 'test-provider/test-model' } });

    await expect(resolveGithubGitToken({ tenant_id: TENANT_ID, spec, store })).resolves.toBeNull();
  });
});

describe('isGithubConnectorAttached', () => {
  it('is true when the agent spec configures the github MCP connector', () => {
    const spec = AgentSpecSchema.parse({
      model: { name: 'test-provider/test-model' },
      mcp_servers: [{ name: 'github' }],
    });
    expect(isGithubConnectorAttached(spec)).toBe(true);
  });

  it('is false when no github MCP connector is configured', () => {
    const spec = AgentSpecSchema.parse({ model: { name: 'test-provider/test-model' } });
    expect(isGithubConnectorAttached(spec)).toBe(false);
  });
});

describe('validateAgentSpec', () => {
  afterEach(() => {
    setCachedLocalSandboxSupport(undefined);
  });

  async function setup(options?: { reasoningEfforts?: ReasoningEffort[] | undefined }) {
    const db = createSqliteDb(':memory:');
    await migrateSqliteToLatest(db);
    const modelProviderStore = new SqliteModelProviderStore(db);
    await modelProviderStore.upsertProvider({
      tenant_id: 'default',
      name: 'test-provider',
      manifest: {
        // Caller-named, so `custom` is the only type it can be.
        type: 'custom',
        name: 'test-provider',
        base_url: 'https://llm.test.example.com/v1',
        auth: { api_key: 'sk-test' },
        models: [
          {
            model_id: 'test-model',
            name: 'test-model',
            properties: {
              context_length: 128000,
              max_output_tokens: 4096,
              ...(options?.reasoningEfforts !== undefined ? { reasoning_efforts: options.reasoningEfforts } : {}),
            },
          },
        ],
      },
    });
    return {
      modelProviderStore,
      mcpServerStore: new SqliteMcpServerStore(db),
      skillStore: new SqliteSkillStore(db),
      sandboxProviderStore: new SqliteSandboxProviderStore(db),
    };
  }

  it('maps the configured model output limit to runtime max_tokens', async () => {
    const stores = await setup();

    await expect(
      getModelDetails({
        tenant_id: 'default',
        name: 'test-provider/test-model',
        store: stores.modelProviderStore,
      }),
    ).resolves.toMatchObject({
      providerConfig: {
        provider: { type: 'custom', name: 'test-provider' },
        model: { id: 'test-model', name: 'test-model' },
        name: 'test-provider/test-model',
      },
      defaultModelParams: { max_tokens: 4096 },
      modelProperties: { context_length: 128000, max_output_tokens: 4096 },
    });
  });

  it('rejects malformed model FQN with 422', async () => {
    const stores = await setup();
    await expect(
      validateAgentSpec({
        spec: AgentSpecSchema.parse({
          model: { name: 'not-a-fqn' },
          instructions: 'test',
        }),
        tenant_id: 'default',
        ...stores,
      }),
    ).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining('fully qualified "provider/model"'),
    } satisfies Partial<HTTPException>);
  });

  it('rejects unknown model provider with 422', async () => {
    const stores = await setup();
    await expect(
      validateAgentSpec({
        spec: AgentSpecSchema.parse({
          model: { name: 'missing-provider/test-model' },
          instructions: 'test',
        }),
        tenant_id: 'default',
        ...stores,
      }),
    ).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining('provider not configured'),
    } satisfies Partial<HTTPException>);
  });

  it('rejects unknown model on provider with 422', async () => {
    const stores = await setup();
    await expect(
      validateAgentSpec({
        spec: AgentSpecSchema.parse({
          model: { name: 'test-provider/missing-model' },
          instructions: 'test',
        }),
        tenant_id: 'default',
        ...stores,
      }),
    ).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining('not configured on provider'),
    } satisfies Partial<HTTPException>);
  });

  it('rejects unsupported reasoning effort with 422', async () => {
    const stores = await setup({ reasoningEfforts: ['low', 'high'] });
    await expect(
      validateAgentSpec({
        spec: AgentSpecSchema.parse({
          model: { name: 'test-provider/test-model', params: { reasoning_effort: 'medium' } },
          instructions: 'test',
        }),
        tenant_id: 'default',
        ...stores,
      }),
    ).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining('Reasoning effort "medium"'),
    } satisfies Partial<HTTPException>);
  });

  it('rejects unknown MCP server with 422', async () => {
    const stores = await setup();
    await expect(
      validateAgentSpec({
        spec: AgentSpecSchema.parse({
          model: { name: 'test-provider/test-model' },
          instructions: 'test',
          mcp_servers: [{ name: 'missing-mcp' }],
        }),
        tenant_id: 'default',
        ...stores,
      }),
    ).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining('Unknown MCP server "missing-mcp"'),
    } satisfies Partial<HTTPException>);
  });

  it('rejects unknown skill with 422', async () => {
    const stores = await setup();
    await expect(
      validateAgentSpec({
        spec: AgentSpecSchema.parse({
          model: { name: 'test-provider/test-model' },
          instructions: 'test',
          skills: [{ name: 'missing-skill' }],
        }),
        tenant_id: 'default',
        ...stores,
      }),
    ).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining('Unknown skill "missing-skill"'),
    } satisfies Partial<HTTPException>);
  });

  it('rejects sandbox.enabled when no sandbox provider is configured', async () => {
    const stores = await setup();
    await expect(
      validateAgentSpec({
        spec: AgentSpecSchema.parse({
          model: { name: 'test-provider/test-model' },
          instructions: 'test',
          config: { sandbox: { enabled: true } },
        }),
        tenant_id: 'default',
        ...stores,
      }),
    ).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining('PUT /settings/sandbox-providers'),
    } satisfies Partial<HTTPException>);
  });

  it('rejects skills when no sandbox provider is configured', async () => {
    const stores = await setup();
    await stores.skillStore.upsertSkill({
      tenant_id: 'default',
      name: 'demo',
      manifest: {
        type: 'git',
        name: 'demo',
        url: 'https://github.com/example/skills',
        ref: 'main',
        description: 'demo skill',
      },
    });

    await expect(
      validateAgentSpec({
        spec: AgentSpecSchema.parse({
          model: { name: 'test-provider/test-model' },
          instructions: 'test',
          skills: [{ name: 'demo' }],
          // Sandbox enabled so this exercises the provider check, not the
          // skills-require-enabled-sandbox check.
          config: { sandbox: { enabled: true } },
        }),
        tenant_id: 'default',
        ...stores,
      }),
    ).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining('skills require a sandbox provider'),
    } satisfies Partial<HTTPException>);
  });

  it('admits sandbox.enabled when a sandbox provider row exists', async () => {
    const stores = await setup();
    await stores.sandboxProviderStore.upsertSandboxProvider({
      tenant_id: 'default',
      manifest: {
        type: 'daytona',
        auth: { api_key: 'dtn-test' },
        exec_timeout_ms: 60_000,
        auto_stop_interval_in_minutes: 5,
        auto_archive_interval_in_minutes: 60,
        auto_delete_interval_in_minutes: 7200,
      },
      status: 'pending',
      status_reason: 'Sandbox image build started.',
      build_metadata: { build_ref: 'trueforge-build-029ea5ff', image_uri: 'tfy.jfrog.io/tfy-images/sandbox:029ea5ff' },
    });

    await expect(
      validateAgentSpec({
        spec: AgentSpecSchema.parse({
          model: { name: 'test-provider/test-model' },
          instructions: 'test',
          config: { sandbox: { enabled: true } },
        }),
        tenant_id: 'default',
        ...stores,
      }),
    ).resolves.toBeUndefined();
  });

  it('admits sandbox.enabled when local fallback is cached and the store is empty', async () => {
    const stores = await setup();
    setCachedLocalSandboxSupport({
      supported: true,
      platform: 'darwin',
      shell: '/bin/bash',
      python: '/usr/bin/python3',
    });
    await expect(
      validateAgentSpec({
        spec: AgentSpecSchema.parse({
          model: { name: 'test-provider/test-model' },
          instructions: 'test',
          config: { sandbox: { enabled: true } },
        }),
        tenant_id: 'default',
        ...stores,
      }),
    ).resolves.toBeUndefined();
    expect(await stores.sandboxProviderStore.getSandboxProvider('default')).toBeUndefined();
  });

  it('rejects registry catalog rows as git mounts (standalone)', async () => {
    const stores = await setup();
    setCachedLocalSandboxSupport({
      supported: true,
      platform: 'darwin',
      shell: '/bin/bash',
      python: '/usr/bin/python3',
    });
    const fqn = 'agent-skill:acme/team-a/echo:1';
    const now = '2026-01-01T00:00:00.000Z';
    const skillStore: ISkillStore = {
      listSkills: async () => [
        {
          tenant_id: 'default',
          name: fqn,
          manifest: {
            type: 'truefoundry' as const,
            name: fqn,
            display_name: 'echo',
            description: 'Echo',
            repository_name: 'team-a',
            version: 1,
          },
          created_at: now,
          updated_at: now,
        },
      ],
      createSkill: async () => {
        throw new Error('unused');
      },
      upsertSkill: async () => {
        throw new Error('unused');
      },
      deleteSkill: async () => {
        throw new Error('unused');
      },
      listSkillVersions: async () => [],
      async validateAgentSkills(input) {
        return validateGitAgentSkills(this, input);
      },
      resolveTurnSkills: async () => {
        throw new Error('unused');
      },
    };
    await expect(
      validateAgentSpec({
        spec: AgentSpecSchema.parse({
          model: { name: 'test-provider/test-model' },
          instructions: 'test',
          skills: [{ name: fqn }],
        }),
        tenant_id: 'default',
        ...stores,
        skillStore,
      }),
    ).rejects.toMatchObject({
      status: 422,
      message: `Skill "${fqn}" is not a git skill`,
    });
  });

  it('validates skills via skillStore.validateAgentSkills', async () => {
    const stores = await setup();
    setCachedLocalSandboxSupport({
      supported: true,
      platform: 'darwin',
      shell: '/bin/bash',
      python: '/usr/bin/python3',
    });
    const validateAgentSkills = jest.spyOn(stores.skillStore, 'validateAgentSkills').mockResolvedValue(undefined);
    await expect(
      validateAgentSpec({
        spec: AgentSpecSchema.parse({
          model: { name: 'test-provider/test-model' },
          instructions: 'test',
          skills: [{ name: 'agent-skill:acme/team-a/echo:3', preload: false }],
          config: { sandbox: { enabled: true } },
        }),
        tenant_id: 'default',
        ...stores,
      }),
    ).resolves.toBeUndefined();
    expect(validateAgentSkills).toHaveBeenCalledWith({
      tenant_id: 'default',
      skills: [{ name: 'agent-skill:acme/team-a/echo:3', preload: false }],
    });
  });

  it('rejects preload on git skills', async () => {
    const stores = await setup();
    setCachedLocalSandboxSupport({
      supported: true,
      platform: 'darwin',
      shell: '/bin/bash',
      python: '/usr/bin/python3',
    });
    await stores.skillStore.upsertSkill({
      tenant_id: 'default',
      name: 'echo',
      manifest: {
        type: 'git',
        name: 'echo',
        description: 'Echo',
        url: 'https://github.com/acme/skills',
        ref: 'main',
      },
    });
    await expect(
      validateAgentSpec({
        spec: AgentSpecSchema.parse({
          model: { name: 'test-provider/test-model' },
          instructions: 'test',
          skills: [{ name: 'echo', preload: true }],
        }),
        tenant_id: 'default',
        ...stores,
      }),
    ).rejects.toMatchObject({
      status: 422,
      message: 'Skill "echo": preload is not supported for git skills',
    });
  });
});

describe('getMcpConnection — secret references in header auth', () => {
  const ENV_VAR = 'SESSION_RESOURCES_TEST_TOKEN';

  async function setup() {
    const db = createSqliteDb(':memory:');
    await migrateSqliteToLatest(db);
    return {
      mcpServerStore: new SqliteMcpServerStore(db),
      tokenStore: new SqliteOAuthTokenStore(db),
    };
  }

  afterEach(() => {
    delete process.env[ENV_VAR];
  });

  it('returns the literal headers object unchanged when no header is a reference', async () => {
    const { mcpServerStore, tokenStore } = await setup();
    await mcpServerStore.upsertServer({
      tenant_id: TENANT_ID,
      name: 'literal-mcp',
      manifest: {
        type: 'remote',
        name: 'literal-mcp',
        url: 'https://mcp.example.com/mcp',
        description: 'Literal-only MCP server.',
        auth: { type: 'header', headers: { Authorization: 'Bearer plain-token' } },
      },
      first_party: false,
    });

    const connection = await getMcpConnection({
      tenant_id: TENANT_ID,
      name: 'literal-mcp',
      store: mcpServerStore,
      tokenStore,
      clientName: 'test-client',
      userRef: 'test-user',
    });

    expect(connection?.headers).toEqual({ Authorization: 'Bearer plain-token' });
  });

  it('returns the async resolver form when a header value is a secret reference', async () => {
    // Detection is exact-match: the whole header value must be the reference (per DESIGN.md's
    // registration shape, `Authorization: ${file:...}`), not a reference embedded in a larger
    // string like a "Bearer <ref>" template — that stays a literal, unchanged.
    process.env[ENV_VAR] = 'resolved-token';
    const { mcpServerStore, tokenStore } = await setup();
    await mcpServerStore.upsertServer({
      tenant_id: TENANT_ID,
      name: 'reference-mcp',
      manifest: {
        type: 'remote',
        name: 'reference-mcp',
        url: 'https://mcp.example.com/mcp',
        description: 'Reference-auth MCP server.',
        auth: { type: 'header', headers: { Authorization: `\${env:${ENV_VAR}}`, 'X-Static': 'unchanged' } },
      },
      first_party: false,
    });

    const connection = await getMcpConnection({
      tenant_id: TENANT_ID,
      name: 'reference-mcp',
      store: mcpServerStore,
      tokenStore,
      clientName: 'test-client',
      userRef: 'test-user',
    });

    expect(typeof connection?.headers).toBe('function');
    if (typeof connection?.headers !== 'function') {
      throw new Error('expected resolver form');
    }
    await expect(connection.headers()).resolves.toEqual({
      headers: { Authorization: 'resolved-token', 'X-Static': 'unchanged' },
    });
  });

  it('re-resolves a ${file:} header reference on every call — rotation with no restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tfy-mcp-header-ref-'));
    try {
      const tokenPath = join(dir, 'token');
      await writeFile(tokenPath, 'first-token\n', 'utf-8');
      const { mcpServerStore, tokenStore } = await setup();
      await mcpServerStore.upsertServer({
        tenant_id: TENANT_ID,
        name: 'rotating-mcp',
        manifest: {
          type: 'remote',
          name: 'rotating-mcp',
          url: 'https://mcp.example.com/mcp',
          description: 'File-reference MCP server.',
          auth: { type: 'header', headers: { Authorization: `\${file:${tokenPath}}` } },
        },
        first_party: false,
      });

      const connection = await getMcpConnection({
        tenant_id: TENANT_ID,
        name: 'rotating-mcp',
        store: mcpServerStore,
        tokenStore,
        clientName: 'test-client',
        userRef: 'test-user',
      });
      if (typeof connection?.headers !== 'function') {
        throw new Error('expected resolver form');
      }

      // Same resolver function, called twice: if resolution were cached at connect (rather than
      // re-read per call) the second call would still see "first-token". This only proves the
      // resolver itself re-reads on every call; whether a rotated value reaches an already-connected
      // live MCP transport (RemoteMCP closes and reconnects when resolved headers change) is covered
      // by RemoteMCP's own test (trueforge-core/tests/core/mcp/RemoteMCP.test.ts).
      await expect(connection.headers()).resolves.toEqual({ headers: { Authorization: 'first-token' } });
      await writeFile(tokenPath, 'second-token\n', 'utf-8');
      await expect(connection.headers()).resolves.toEqual({ headers: { Authorization: 'second-token' } });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('a missing env reference fails with an McpConnectionError naming the header and reference, never a value', async () => {
    delete process.env[ENV_VAR];
    const { mcpServerStore, tokenStore } = await setup();
    await mcpServerStore.upsertServer({
      tenant_id: TENANT_ID,
      name: 'broken-mcp',
      manifest: {
        type: 'remote',
        name: 'broken-mcp',
        url: 'https://mcp.example.com/mcp',
        description: 'Missing-secret MCP server.',
        auth: { type: 'header', headers: { Authorization: `\${env:${ENV_VAR}}` } },
      },
      first_party: false,
    });

    // This is the exact function the admin tools-listing handler (GET /mcp-servers/{name}/tools)
    // and turn execution both call through getMcpConnection, so exercising it here covers that path.
    const connection = await getMcpConnection({
      tenant_id: TENANT_ID,
      name: 'broken-mcp',
      store: mcpServerStore,
      tokenStore,
      clientName: 'test-client',
      userRef: 'test-user',
    });
    if (typeof connection?.headers !== 'function') {
      throw new Error('expected resolver form');
    }

    await expect(connection.headers()).rejects.toBeInstanceOf(McpConnectionError);
    await expect(connection.headers()).rejects.toMatchObject({
      message: expect.stringContaining('Authorization'),
    });
    await expect(connection.headers()).rejects.toMatchObject({
      message: expect.stringContaining(`\${env:${ENV_VAR}}`),
    });
  });
});

describe('applyTokenFactoryRouting', () => {
  const localConfig: VercelAIProviderConfig = {
    provider: { type: 'custom', name: 'local' },
    model: { id: 'nemotron-3', name: 'nemotron' },
    name: 'local/nemotron',
    baseUrl: 'http://localhost:11434/v1',
    apiKey: 'none',
    headers: {},
  };
  const routing = {
    apiKey: 'tf-key',
    model: 'nvidia/nemotron-3-super-120b-a12b',
    baseUrl: 'https://api.tokenfactory.nebius.com/v1',
  };

  it('leaves the primary untouched when the mode is off', () => {
    const routed = applyTokenFactoryRouting({ primary: localConfig, mode: 'off', ...routing });
    expect(routed.providerConfig).toBe(localConfig);
    expect(routed.fallbackProviderConfig).toBeUndefined();
  });

  it('leaves the primary untouched when no API key is configured', () => {
    const routed = applyTokenFactoryRouting({ primary: localConfig, mode: 'fallback', ...routing, apiKey: undefined });
    expect(routed.providerConfig).toBe(localConfig);
    expect(routed.fallbackProviderConfig).toBeUndefined();
  });

  it('keeps local first with Token Factory as fallback in fallback mode', () => {
    const routed = applyTokenFactoryRouting({ primary: localConfig, mode: 'fallback', ...routing });
    expect(routed.providerConfig).toBe(localConfig);
    expect(routed.fallbackProviderConfig).toMatchObject({
      provider: { type: 'tokenfactory', name: 'tokenfactory' },
      model: { id: 'nvidia/nemotron-3-super-120b-a12b' },
      baseUrl: 'https://api.tokenfactory.nebius.com/v1',
      apiKey: 'tf-key',
    });
  });

  it('routes to Token Factory first with local as fallback in force mode', () => {
    const routed = applyTokenFactoryRouting({ primary: localConfig, mode: 'force', ...routing });
    expect(routed.providerConfig.provider.type).toBe('tokenfactory');
    expect(routed.providerConfig.model.id).toBe('nvidia/nemotron-3-super-120b-a12b');
    expect(routed.fallbackProviderConfig).toBe(localConfig);
  });

  it('does not wrap a primary that already is Token Factory', () => {
    const tokenFactoryPrimary: VercelAIProviderConfig = {
      ...localConfig,
      provider: { type: 'tokenfactory', name: 'tokenfactory' },
    };
    const routed = applyTokenFactoryRouting({ primary: tokenFactoryPrimary, mode: 'force', ...routing });
    expect(routed.providerConfig).toBe(tokenFactoryPrimary);
    expect(routed.fallbackProviderConfig).toBeUndefined();
  });
});

describe('getModelDetails for self-hosted and cloud models', () => {
  async function storeWithModels() {
    const db = createSqliteDb(':memory:');
    await migrateSqliteToLatest(db);
    const store = new SqliteModelProviderStore(db);
    await store.upsertProvider({
      tenant_id: 'default',
      name: 'home-gpu',
      manifest: {
        type: 'custom',
        name: 'home-gpu',
        base_url: 'https://gpu.home.example.com/v1',
        auth: { api_key: 'sk-home' },
        models: [
          { model_id: 'thinker-uncapped', name: 'uncapped', properties: { context_length: 32000 } },
          {
            model_id: 'thinker-capped',
            name: 'capped',
            properties: { context_length: 32000, max_output_tokens: 2048 },
          },
        ],
      },
    });
    await store.upsertProvider({
      tenant_id: 'default',
      name: 'openai',
      manifest: {
        type: 'openai',
        base_url: 'https://api.openai.com/v1',
        auth: { api_key: 'sk-cloud' },
        models: [{ model_id: 'cloud-model', name: 'cloud-model', properties: { context_length: 128000 } }],
      },
    });
    return store;
  }

  it('caps a self-hosted model with no output limit at 8192 tokens and sends it every tool up front', async () => {
    const store = await storeWithModels();
    const details = await getModelDetails({ tenant_id: 'default', name: 'home-gpu/uncapped', store });
    expect(details.defaultModelParams).toEqual({ max_tokens: 8192 });
    expect(details.bundleTools).toBe(false);
  });

  it('keeps the output limit configured on a self-hosted model', async () => {
    const store = await storeWithModels();
    const details = await getModelDetails({ tenant_id: 'default', name: 'home-gpu/capped', store });
    expect(details.defaultModelParams).toEqual({ max_tokens: 2048 });
  });

  it('leaves a cloud model uncapped and on tool bundles', async () => {
    const store = await storeWithModels();
    const details = await getModelDetails({ tenant_id: 'default', name: 'openai/cloud-model', store });
    expect(details.defaultModelParams).toEqual({});
    expect(details.bundleTools).toBe(true);
  });
});

/**
 * RC1: skills listed on an agent spec but `config.sandbox.enabled: false` must
 * fail validation loudly (422) instead of silently rendering no <skills>
 * section. Covers the new enabled check, the unchanged unknown-skill check,
 * and the admit path (enabled + provider configured).
 */
import { AgentSpecSchema } from '@truefoundry/trueforge-core/agent-session';
import { HTTPException } from 'hono/http-exception';
import { TENANT_ID } from '../../../src/apis/sessions';
import { migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import { createSqliteDb } from '../../../src/db/sqlite/client';
import { SqliteMcpServerStore } from '../../../src/db/sqlite/mcp-server-store/SqliteMcpServerStore';
import { SqliteModelProviderStore } from '../../../src/db/sqlite/model-provider-store/SqliteModelProviderStore';
import { SqliteSandboxProviderStore } from '../../../src/db/sqlite/sandbox-provider-store/SqliteSandboxProviderStore';
import { SqliteSkillStore } from '../../../src/db/sqlite/skill-store/SqliteSkillStore';
import { validateAgentSpec } from '../../../src/runtime/sessionResources';
import { setCachedLocalSandboxSupport } from '../../../src/sandbox/localRuntime';

describe('validateAgentSpec skills require an enabled sandbox', () => {
  afterEach(() => {
    setCachedLocalSandboxSupport(undefined);
  });

  async function setup() {
    const db = createSqliteDb(':memory:');
    await migrateSqliteToLatest(db);
    const modelProviderStore = new SqliteModelProviderStore(db);
    await modelProviderStore.upsertProvider({
      tenant_id: TENANT_ID,
      name: 'test-provider',
      manifest: {
        type: 'custom',
        name: 'test-provider',
        base_url: 'https://llm.test.example.com/v1',
        auth: { api_key: 'sk-test' },
        models: [
          {
            model_id: 'test-model',
            name: 'test-model',
            properties: { context_length: 128000, max_output_tokens: 4096 },
          },
        ],
      },
    });
    const skillStore = new SqliteSkillStore(db);
    await skillStore.upsertSkill({
      tenant_id: TENANT_ID,
      name: 'demo',
      manifest: {
        type: 'git',
        name: 'demo',
        url: 'https://github.com/example/skills',
        ref: 'main',
        description: 'demo skill',
        when_to_use: ['summarize a document'],
      },
    });
    return {
      modelProviderStore,
      mcpServerStore: new SqliteMcpServerStore(db),
      skillStore,
      sandboxProviderStore: new SqliteSandboxProviderStore(db),
    };
  }

  async function upsertSandboxProvider(stores: Awaited<ReturnType<typeof setup>>) {
    await stores.sandboxProviderStore.upsertSandboxProvider({
      tenant_id: TENANT_ID,
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
  }

  it('rejects 422 when skills are listed but config.sandbox.enabled is false', async () => {
    const stores = await setup();

    await expect(
      validateAgentSpec({
        spec: AgentSpecSchema.parse({
          model: { name: 'test-provider/test-model' },
          instructions: 'test',
          skills: [{ name: 'demo' }],
          config: { sandbox: { enabled: false } },
        }),
        tenant_id: TENANT_ID,
        ...stores,
      }),
    ).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining('skills require config.sandbox.enabled: true'),
    } satisfies Partial<HTTPException>);
  });

  it('rejects 422 for skills with the default config (sandbox disabled)', async () => {
    const stores = await setup();

    await expect(
      validateAgentSpec({
        spec: AgentSpecSchema.parse({
          model: { name: 'test-provider/test-model' },
          instructions: 'test',
          skills: [{ name: 'demo' }],
        }),
        tenant_id: TENANT_ID,
        ...stores,
      }),
    ).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining('skills require config.sandbox.enabled: true'),
    } satisfies Partial<HTTPException>);
  });

  it('admits skills when the sandbox is enabled and a provider is configured', async () => {
    const stores = await setup();
    await upsertSandboxProvider(stores);

    await expect(
      validateAgentSpec({
        spec: AgentSpecSchema.parse({
          model: { name: 'test-provider/test-model' },
          instructions: 'test',
          skills: [{ name: 'demo' }],
          config: { sandbox: { enabled: true } },
        }),
        tenant_id: TENANT_ID,
        ...stores,
      }),
    ).resolves.toBeUndefined();
  });

  it('still rejects unknown skill names with 422', async () => {
    const stores = await setup();

    await expect(
      validateAgentSpec({
        spec: AgentSpecSchema.parse({
          model: { name: 'test-provider/test-model' },
          instructions: 'test',
          skills: [{ name: 'missing-skill' }],
          config: { sandbox: { enabled: true } },
        }),
        tenant_id: TENANT_ID,
        ...stores,
      }),
    ).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining('Unknown skill "missing-skill"'),
    } satisfies Partial<HTTPException>);
  });

  it('keeps the sandbox-provider 422 when enabled but no provider is configured', async () => {
    const stores = await setup();

    await expect(
      validateAgentSpec({
        spec: AgentSpecSchema.parse({
          model: { name: 'test-provider/test-model' },
          instructions: 'test',
          skills: [{ name: 'demo' }],
          config: { sandbox: { enabled: true } },
        }),
        tenant_id: TENANT_ID,
        ...stores,
      }),
    ).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining('skills require a sandbox provider'),
    } satisfies Partial<HTTPException>);
  });
});

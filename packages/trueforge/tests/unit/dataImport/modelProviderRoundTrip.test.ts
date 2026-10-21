/**
 * The whole path a provider setup travels: seeded with a planted key on one
 * instance, exported (the key in no archive entry, in any field), imported
 * into a fresh instance, and restored as a setup waiting for its key, with
 * the persona that points at it and the person's name intact.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Transaction } from 'kysely';
import { createLogger } from 'winston';

import { McpCatalog } from '../../../src/catalog/McpCatalog';
import { runDataImport, type DataImportDeps } from '../../../src/dataImport/importService';
import { migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import { SentinelAuditStore } from '../../../src/db/sentinelAuditStore';
import { createSqliteDb } from '../../../src/db/sqlite/client';
import { SqliteAgentStore } from '../../../src/db/sqlite/agent-store/SqliteAgentStore';
import { SqliteGlobalSettingsStore } from '../../../src/db/sqlite/global-settings-store/SqliteGlobalSettingsStore';
import { SqliteMcpServerStore } from '../../../src/db/sqlite/mcp-server-store/SqliteMcpServerStore';
import { SqliteModelProviderStore } from '../../../src/db/sqlite/model-provider-store/SqliteModelProviderStore';
import { SqlitePersonaStore } from '../../../src/db/sqlite/persona-store/SqlitePersonaStore';
import { SqlitePersonalizationStore } from '../../../src/db/sqlite/personalization-store/SqlitePersonalizationStore';
import { SqliteScheduleStore } from '../../../src/db/sqlite/schedule-store/SqliteScheduleStore';
import { SqliteSentinelSettingsStore } from '../../../src/db/sqlite/sentinel-settings-store/SqliteSentinelSettingsStore';
import { SqliteSessionStore } from '../../../src/db/sqlite/session-store/SqliteSessionStore';
import { SqliteSpaceStore } from '../../../src/db/sqlite/space-store/SqliteSpaceStore';
import { SqliteTurnArtifactStore } from '../../../src/db/sqlite/turn-artifact-store/SqliteTurnArtifactStore';
import type { Database } from '../../../src/db/sqlite/types';
import { EMBEDDING_DIMENSIONS } from '../../../src/runtime/memory/embeddingModel';
import { exportInstanceArchive } from '../../fixtures/dataTransferExport';
import type { DataTransferSeedStores } from '../../fixtures/dataTransferSeed';
import { readZipEntries } from '../../fixtures/zipReader';

const TENANT = 'default';
const PLANTED_KEY = 'FAKE-KEY-round-trip-secret';
const PLANTED_PASSWORD = 'FAKE-PASSWORD-round-trip-secret';

type Tx = Transaction<Database>;

interface Instance {
  stores: DataTransferSeedStores<Tx>;
  db: ReturnType<typeof createSqliteDb>;
  memoryDir: string;
  knowledgeDir: string;
  close: () => Promise<void>;
}

async function makeInstance(label: string): Promise<Instance> {
  const dir = await mkdtemp(join(tmpdir(), `tfy-provider-roundtrip-${label}-`));
  const db = createSqliteDb(join(dir, 'test.sqlite'));
  await migrateSqliteToLatest(db);
  return {
    stores: {
      sessionStore: new SqliteSessionStore(db),
      agentStore: new SqliteAgentStore(db),
      personaStore: new SqlitePersonaStore(db),
      personalizationStore: new SqlitePersonalizationStore(db),
      spaceStore: new SqliteSpaceStore(db),
      scheduleStore: new SqliteScheduleStore(db),
      globalSettingsStore: new SqliteGlobalSettingsStore(db),
      sentinelSettingsStore: new SqliteSentinelSettingsStore(db),
      auditStore: new SentinelAuditStore(db),
      turnArtifactStore: new SqliteTurnArtifactStore(db),
      mcpServerStore: new SqliteMcpServerStore(db),
      modelProviderStore: new SqliteModelProviderStore(db),
    },
    db,
    memoryDir: join(dir, 'memory'),
    knowledgeDir: join(dir, 'knowledge'),
    close: async () => {
      await db.destroy();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

function importDeps(instance: Instance): DataImportDeps<Tx> {
  return {
    sessionStore: instance.stores.sessionStore,
    personaStore: instance.stores.personaStore,
    personalizationStore: instance.stores.personalizationStore,
    spaceStore: instance.stores.spaceStore,
    scheduleStore: instance.stores.scheduleStore,
    globalSettingsStore: instance.stores.globalSettingsStore,
    turnArtifactStore: instance.stores.turnArtifactStore,
    auditStore: instance.stores.auditStore,
    mcpServerStore: instance.stores.mcpServerStore,
    modelProviderStore: instance.stores.modelProviderStore,
    agentStore: instance.stores.agentStore,
    mcpCatalog: McpCatalog.loadShipped(),
    withTransaction: callback => instance.db.transaction().execute(callback),
    memoryTarget: { kind: 'markdown', markdownDir: instance.memoryDir },
    personaKnowledgeDir: instance.knowledgeDir,
    knowledgeEmbedder: {
      ensureReady: () => Promise.resolve(true),
      embedPassages: texts => Promise.resolve(texts.map(() => new Array<number>(EMBEDDING_DIMENSIONS).fill(0.5))),
    },
    logger: createLogger({ silent: true }),
  };
}

describe('model provider export and import round trip', () => {
  it('restores the setup without the secret planted in it', async () => {
    const source = await makeInstance('source');
    const target = await makeInstance('target');
    try {
      await source.stores.modelProviderStore.upsertProvider({
        tenant_id: TENANT,
        name: 'openai',
        manifest: {
          type: 'openai',
          base_url: 'https://api.openai.com/v1',
          auth: { api_key: PLANTED_KEY },
          models: [{ model_id: 'gpt-test', name: 'gpt-test', properties: { context_length: 128000 } }],
        },
      });
      await source.stores.modelProviderStore.upsertProvider({
        tenant_id: TENANT,
        name: 'lab-box',
        manifest: {
          type: 'custom',
          name: 'lab-box',
          base_url: `https://user:${PLANTED_PASSWORD}@llm.example.com/v1`,
          auth: { api_key: PLANTED_KEY },
          models: [{ model_id: 'local-1', name: 'local-1', properties: {} }],
        },
      });
      await source.stores.personaStore.createPersona({
        tenant_id: TENANT,
        created_by: 'alice',
        id: 'persona-helper',
        display_name: 'Helper',
        aliases: [],
        instructions: 'Help carefully.',
        model_name: 'openai/gpt-test',
        updated_by: 'alice',
      });
      await source.stores.personalizationStore.upsertProfile({
        tenant_id: TENANT,
        created_by: 'alice',
        assistant_name: null,
        assistant_identity: null,
        voice_guidance: null,
        user_name: 'Test Person',
        address_as: 'Tester',
        user_profile: null,
        pinned_preferences: [],
        learned_profile: null,
        learning_enabled: true,
        updated_by: 'alice',
        expected_revision: null,
      });

      const archive = await exportInstanceArchive({
        instance: source,
        tenantId: TENANT,
        subjectId: 'alice',
        secrets: [PLANTED_KEY],
      });

      // No planted secret value appears in any entry of the archive.
      for (const entry of readZipEntries(archive)) {
        expect(entry.data.includes(Buffer.from(PLANTED_KEY))).toBe(false);
        expect(entry.data.includes(Buffer.from(PLANTED_PASSWORD))).toBe(false);
      }

      const result = await runDataImport(importDeps(target), {
        archive,
        subject: { tenantId: TENANT, subjectId: 'bob', subjectDisplayName: 'bob', agentIds: [] },
        maxBytes: 1024 * 1024 * 1024,
      });

      const providers = await target.stores.modelProviderStore.listProviders({ tenant_id: TENANT });
      expect(providers.map(provider => provider.name)).toEqual(['lab-box', 'openai']);
      const openAi = providers.find(provider => provider.name === 'openai');
      expect(openAi?.manifest).toEqual({
        type: 'openai',
        base_url: 'https://api.openai.com/v1',
        models: [{ model_id: 'gpt-test', name: 'gpt-test', properties: { context_length: 128000 } }],
      });
      const labBox = providers.find(provider => provider.name === 'lab-box');
      expect(labBox?.manifest).toEqual({
        type: 'custom',
        name: 'lab-box',
        base_url: 'https://llm.example.com/v1',
        models: [{ model_id: 'local-1', name: 'local-1', properties: {} }],
      });

      const personas = await target.stores.personaStore.listPersonas({ tenant_id: TENANT, created_by: 'bob' });
      expect(personas).toHaveLength(1);
      expect(personas[0]?.model_name).toBe('openai/gpt-test');

      const profile = await target.stores.personalizationStore.getProfile({ tenant_id: TENANT, created_by: 'bob' });
      expect(profile?.user_name).toBe('Test Person');
      expect(profile?.address_as).toBe('Tester');

      expect(result.summary).toContain('Aman will call you: Tester.');
      expect(result.summary).toContain('  2 model providers');
      expect(result.summary).toContain('Your model settings came over, but their keys never travel in an export.');
      expect(result.summary).toContain('Add the key for openai in Settings under Models, so its models can answer.');
      expect(result.summary).toContain('Add the key for lab-box in Settings under Models, so its models can answer.');
    } finally {
      await source.close();
      await target.close();
    }
  });
});

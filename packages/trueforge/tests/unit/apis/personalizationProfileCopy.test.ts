import type { ILLM } from '@truefoundry/trueforge-core/core';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import winston from 'winston';
import { createPersonalizationRouter } from '../../../src/apis/personalization';
import type { RequestContext } from '../../../src/auth/identity';
import { migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import { createSqliteDb } from '../../../src/db/sqlite/client';
import { SqliteModelProviderStore } from '../../../src/db/sqlite/model-provider-store/SqliteModelProviderStore';
import { SqlitePersonalizationStore } from '../../../src/db/sqlite/personalization-store/SqlitePersonalizationStore';
import { MarkdownMemoryClient } from '../../../src/runtime/memory/markdownMemoryClient';
import { submitProfileLearning } from '../../../src/runtime/profileLearning';
import { discardedModelUsage } from '../../fixtures/discardedModelUsage';
import { uncappedTokenFactoryBudget } from '../../fixtures/uncappedTokenFactoryBudget';

const LEARNED_TEXT = 'Rivera keeps bees on the allotment and prefers oat milk.';

const userA: RequestContext = {
  tenant_id: 'default',
  subject: { id: 'user-a', type: 'user', display_name: 'user-a' },
  roles: [],
  user_credential: null,
};

const emptyContent = {
  assistant_name: null,
  assistant_identity: null,
  voice_guidance: null,
  user_name: null,
  address_as: null,
  user_profile: null,
  pinned_preferences: [],
  help_areas: [],
};

function llmAnswering(text: string): ILLM {
  return {
    create(): ReturnType<ILLM['create']> {
      throw new Error('streaming is not used by the distillation pass');
    },
    createNonStream: async () => ({
      output: { role: 'assistant', content: text },
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      finish_reason: 'stop',
    }),
  };
}

/** The memory the vault still shows; deleted entries stay in the daily files but are hidden. */
async function liveTextsHolding(client: MarkdownMemoryClient, needle: string): Promise<string[]> {
  const outcome = await client.listEntries({ namespace: '', timeoutMs: 1_000 });
  if (!outcome.ok) {
    throw new Error(outcome.reason);
  }
  return outcome.entries.map(entry => entry.text).filter(text => text.includes(needle));
}

function put(body: unknown): RequestInit {
  return { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

describe('learned profile copy in memory', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'profile-copy-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function harness() {
    const db = createSqliteDb(':memory:');
    await migrateSqliteToLatest(db);
    const store = new SqlitePersonalizationStore(db);
    await store.upsertProfile({
      tenant_id: 'default',
      created_by: 'user-a',
      updated_by: 'user-a',
      ...emptyContent,
      learned_profile: null,
      learning_enabled: true,
    });
    const client = new MarkdownMemoryClient({ baseDir: dir, namespace: 'default' });
    const logger = winston.createLogger({ silent: true });
    const router = createPersonalizationRouter({
      personalizationStore: store,
      resolveRequestContext: () => userA,
      resolveMemoryClient: async () => client,
      logger,
    });
    const learn = () =>
      submitProfileLearning({
        session: { is_incognito: false },
        config: { modelFqn: '', minIntervalMs: 0, retainTimeoutMs: 1_000 },
        personalizationStore: store,
        eventStore: { appendEventsToDoneTurn: async () => undefined },
        modelProviderStore: new SqliteModelProviderStore(db),
        tokenFactoryBudget: uncappedTokenFactoryBudget,
        modelUsage: discardedModelUsage,
        memoryClient: client,
        tenantId: 'default',
        createdBy: 'user-a',
        userText: 'I keep bees.',
        turnModelFqn: 'p/m',
        resolveLlm: async () => llmAnswering(JSON.stringify({ learned_profile: LEARNED_TEXT })),
        sessionId: 's1',
        turnId: 't1',
        completedAt: '2026-09-01T12:00:00.000Z',
        logger,
      });
    // The copy as an earlier version saved it.
    const saveOldCopy = async () => {
      const outcome = await client.retain({
        items: [
          {
            content: LEARNED_TEXT,
            timestamp: '2026-08-30T12:00:00.000Z',
            document_id: `aman-learned-profile-${createHash('sha256').update('user-a', 'utf8').digest('hex').slice(0, 16)}`,
            context: 'Learned user profile',
            metadata: { source: 'aman-profile-learning', replace_document: 'true' },
          },
        ],
        operationId: '5b0c1c3e-1111-5111-8111-111111111111',
        timeoutMs: 1_000,
      });
      expect(outcome.ok).toBe(true);
    };
    return { db, store, client, router, learn, saveOldCopy };
  }

  it('leaves no file holding the learned text after Settings clears it with learning off', async () => {
    const { db, client, router, saveOldCopy } = await harness();
    await saveOldCopy();
    expect(await liveTextsHolding(client, LEARNED_TEXT)).toHaveLength(1);

    const saved = await router.request(
      '/profile',
      put({ profile: { ...emptyContent, learned_profile: null, learning_enabled: false } }),
    );

    expect(saved.status).toBe(200);
    expect(await liveTextsHolding(client, LEARNED_TEXT)).toEqual([]);
    await db.destroy();
  });

  it('removes a copy saved before documents had ids', async () => {
    const { db, client, router } = await harness();
    await client.retain({
      items: [
        {
          content: LEARNED_TEXT,
          timestamp: '2026-08-30T12:00:00.000Z',
          document_id: 'older-copy',
          context: 'Learned user profile',
        },
      ],
      operationId: '5b0c1c3e-2222-5111-8111-222222222222',
      timeoutMs: 1_000,
    });
    expect(await liveTextsHolding(client, LEARNED_TEXT)).toHaveLength(1);

    await router.request('/profile', { method: 'DELETE' });

    expect(await liveTextsHolding(client, LEARNED_TEXT)).toEqual([]);
    await db.destroy();
  });

  it('removes the copy when the profile is deleted', async () => {
    const { db, client, router, saveOldCopy } = await harness();
    await saveOldCopy();
    expect(await liveTextsHolding(client, LEARNED_TEXT)).toHaveLength(1);

    const deleted = await router.request('/profile', { method: 'DELETE' });

    expect(deleted.status).toBe(200);
    expect(await liveTextsHolding(client, LEARNED_TEXT)).toEqual([]);
    await db.destroy();
  });

  it('still saves the profile when removing the copy fails', async () => {
    const { db, store } = await harness();
    const router = createPersonalizationRouter({
      personalizationStore: store,
      resolveRequestContext: () => userA,
      resolveMemoryClient: async () => {
        throw new Error('memory is down');
      },
      logger: winston.createLogger({ silent: true }),
    });

    const saved = await router.request(
      '/profile',
      put({ profile: { ...emptyContent, user_profile: 'Plain English.', learning_enabled: false } }),
    );

    expect(saved.status).toBe(200);
    const stored = await store.getProfile({ tenant_id: 'default', created_by: 'user-a' });
    expect(stored?.user_profile).toBe('Plain English.');
    await db.destroy();
  });

  it('leaves no copy after a learning run on a vault that holds an old one', async () => {
    const { db, store, client, learn, saveOldCopy } = await harness();
    await saveOldCopy();

    await learn();

    const stored = await store.getProfile({ tenant_id: 'default', created_by: 'user-a' });
    expect(stored?.learned_profile).toBe(LEARNED_TEXT);
    expect(await liveTextsHolding(client, LEARNED_TEXT)).toEqual([]);
    await db.destroy();
  });
});

import { AgentSpecSchema } from '@truefoundry/trueforge-core/agent-session';
import { createLogger } from 'winston';
import { STANDALONE_REQUEST_CONTEXT } from '../../../src/auth/identity';
import { migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import { createSqliteDb } from '../../../src/db/sqlite/client';
import { SqliteModelProviderStore } from '../../../src/db/sqlite/model-provider-store/SqliteModelProviderStore';
import { SqliteSessionStore } from '../../../src/db/sqlite/session-store/SqliteSessionStore';
import { applyAutoSessionTitle, cleanAutoTitle, scheduledSessionTitleSeed } from '../../../src/runtime/sessionTitle';
import { TENANT_ID } from '../../../src/tenancy';
import { discardedModelUsage } from '../../fixtures/discardedModelUsage';
import { fakeHelperLlm, fakeHelperLlmThrowing } from '../../fixtures/fakeHelperLlm';
import { uncappedTokenFactoryBudget } from '../../fixtures/uncappedTokenFactoryBudget';

const SESSION_ID = 's-title';

/** A real SQLite chat in the state the first turn leaves it: a title and its source. */
async function chatWithTitle(title: string | null, titleSource: 'first_message' | 'auto' | 'person' | null) {
  const db = createSqliteDb(':memory:');
  await migrateSqliteToLatest(db);
  const store = new SqliteSessionStore(db);
  await store.createSession({
    tenant_id: TENANT_ID,
    session_id: SESSION_ID,
    created_by_subject: {
      subject_id: STANDALONE_REQUEST_CONTEXT.subject.id,
      subject_type: STANDALONE_REQUEST_CONTEXT.subject.type,
      subject_display_name: STANDALONE_REQUEST_CONTEXT.subject.display_name,
    },
    agent: { type: 'inline', spec: AgentSpecSchema.parse({ model: { name: 'test-provider/test-model' } }) },
    custom: null,
    metadata: {},
    external_id: null,
    source: null,
  });
  await db
    .updateTable('session')
    .set({ title, title_source: titleSource })
    .where('session_id', '=', SESSION_ID)
    .execute();
  return { db, store };
}

async function titleOf(store: SqliteSessionStore) {
  const session = await store.getSession({ tenant_id: TENANT_ID, session_id: SESSION_ID });
  return { title: session?.title, source: session?.title_source };
}

function applyWith({
  db,
  store,
  llm,
  logger = createLogger({ silent: true }),
}: {
  db: ReturnType<typeof createSqliteDb>;
  store: SqliteSessionStore;
  llm: Parameters<typeof applyAutoSessionTitle>[0]['resolveLlm'];
  logger?: ReturnType<typeof createLogger>;
}) {
  return applyAutoSessionTitle({
    store,
    tenantId: TENANT_ID,
    sessionId: SESSION_ID,
    userText: 'Give me my morning brief. 1. Read everything new',
    assistantText: 'Here is your brief for today.',
    modelFqn: 'test-provider/test-model',
    modelProviderStore: new SqliteModelProviderStore(db),
    tokenFactoryBudget: uncappedTokenFactoryBudget,
    modelUsage: discardedModelUsage,
    logger,
    resolveLlm: llm,
  });
}

describe('cleanAutoTitle', () => {
  it('trims, drops wrapping quotes and a trailing period', () => {
    expect(cleanAutoTitle('  "Morning brief for Thursday."  ')).toBe('Morning brief for Thursday');
  });

  it('removes quotes inside the title and collapses whitespace', () => {
    expect(cleanAutoTitle('Ask   about "Dad\'s" recipes')).toBe("Ask about Dad's recipes");
  });

  it('cuts an overlong title at a word boundary within 48 characters', () => {
    const title = cleanAutoTitle('Morning brief covering supercalifragilisticexpialidocious items');
    expect(title).toBe('Morning brief covering');
    expect(title?.length).toBeLessThanOrEqual(48);
  });

  it('rejects a reply that is not two to six words', () => {
    expect(cleanAutoTitle('Recipes')).toBeUndefined();
    expect(cleanAutoTitle('One two three four five six seven')).toBeUndefined();
    expect(cleanAutoTitle('   ')).toBeUndefined();
  });
});

describe('scheduledSessionTitleSeed', () => {
  it('reads the schedule name and the local date, with no model call', () => {
    const seed = scheduledSessionTitleSeed({
      scheduleName: 'morning-brief',
      timezone: 'UTC',
      now: new Date('2026-10-22T08:00:00.000Z'),
    });
    expect(seed).toEqual({ title: 'Morning brief · Thu 22 Oct', source: 'auto' });
  });

  it('uses the date in the schedule time zone', () => {
    const seed = scheduledSessionTitleSeed({
      scheduleName: 'morning-brief',
      timezone: 'Pacific/Auckland',
      now: new Date('2026-10-21T20:00:00.000Z'),
    });
    expect(seed.title).toBe('Morning brief · Thu 22 Oct');
  });
});

describe('applyAutoSessionTitle', () => {
  it('replaces a first-message title with the generated one, once', async () => {
    const { db, store } = await chatWithTitle('Give me my morning brief. 1. Read everything new', 'first_message');

    await applyWith({ db, store, llm: () => Promise.resolve(fakeHelperLlm('Morning brief for Thursday.')) });
    await applyWith({ db, store, llm: () => Promise.resolve(fakeHelperLlm('Something else entirely')) });

    expect(await titleOf(store)).toEqual({ title: 'Morning brief for Thursday', source: 'auto' });
  });

  it('never retitles a chat the person renamed', async () => {
    const { db, store } = await chatWithTitle('My own name', 'person');

    await applyWith({ db, store, llm: () => Promise.resolve(fakeHelperLlm('Morning brief for Thursday')) });

    expect(await titleOf(store)).toEqual({ title: 'My own name', source: 'person' });
  });

  it('keeps a fixed schedule title', async () => {
    const { db, store } = await chatWithTitle('Morning brief · Thu 22 Oct', 'auto');

    await applyWith({ db, store, llm: () => Promise.resolve(fakeHelperLlm('Morning brief for Thursday')) });

    expect(await titleOf(store)).toEqual({ title: 'Morning brief · Thu 22 Oct', source: 'auto' });
  });

  it('keeps the first-message title when the model call fails, and logs at info', async () => {
    const { db, store } = await chatWithTitle('Give me my morning brief', 'first_message');
    const logger = createLogger({ silent: true });
    const info = jest.spyOn(logger, 'info');

    await applyWith({
      db,
      store,
      logger,
      llm: () => Promise.resolve(fakeHelperLlmThrowing(new Error('upstream 503'))),
    });

    expect(await titleOf(store)).toEqual({ title: 'Give me my morning brief', source: 'first_message' });
    expect(info).toHaveBeenCalledWith(
      expect.stringContaining('keeping the first message'),
      expect.objectContaining({ sessionId: SESSION_ID, reason: 'upstream 503' }),
    );
  });

  it('keeps the first-message title when the model reply is not a usable title', async () => {
    const { db, store } = await chatWithTitle('Give me my morning brief', 'first_message');

    await applyWith({ db, store, llm: () => Promise.resolve(fakeHelperLlm('Hi')) });

    expect(await titleOf(store)).toEqual({ title: 'Give me my morning brief', source: 'first_message' });
  });

  it('never retitles a chat that predates title tracking', async () => {
    const { db, store } = await chatWithTitle('An older chat', null);

    await applyWith({ db, store, llm: () => Promise.resolve(fakeHelperLlm('Morning brief for Thursday')) });

    expect(await titleOf(store)).toEqual({ title: 'An older chat', source: null });
  });
});

import { AgentSpecSchema, SessionHandle } from '@truefoundry/trueforge-core/agent-session';
import { createLogger } from 'winston';

import { TENANT_ID } from '../../../src/apis/sessions';
import { STANDALONE_REQUEST_CONTEXT } from '../../../src/auth/identity';
import { migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import type { SessionCustom, TurnCustom } from '../../../src/db/sessionCustom';
import { createSqliteDb } from '../../../src/db/sqlite/client';
import { SqliteModelProviderStore } from '../../../src/db/sqlite/model-provider-store/SqliteModelProviderStore';
import { SqliteSessionStore } from '../../../src/db/sqlite/session-store/SqliteSessionStore';
import { createKnowledgeRelevanceJudge } from '../../../src/personaKnowledge/knowledgeRelevanceJudge';
import { resolveTurnInternalSources } from '../../../src/runtime/turnInternalSources';
import { discardedModelUsage } from '../../fixtures/discardedModelUsage';
import { uncappedTokenFactoryBudget } from '../../fixtures/uncappedTokenFactoryBudget';

jest.mock('../../../src/personaKnowledge/knowledgeRelevanceJudge', () => ({
  createKnowledgeRelevanceJudge: jest.fn(() => jest.fn()),
}));

const judgeFactory = jest.mocked(createKnowledgeRelevanceJudge);

async function judgeModelFor(personaModel: string) {
  judgeFactory.mockClear();
  const db = createSqliteDb(':memory:');
  await migrateSqliteToLatest(db);
  const sessionStore = new SqliteSessionStore(db);
  await sessionStore.createSession({
    tenant_id: TENANT_ID,
    session_id: 's1',
    created_by_subject: {
      subject_id: STANDALONE_REQUEST_CONTEXT.subject.id,
      subject_type: STANDALONE_REQUEST_CONTEXT.subject.type,
      subject_display_name: STANDALONE_REQUEST_CONTEXT.subject.display_name,
    },
    agent: { type: 'inline', spec: AgentSpecSchema.parse({ model: { name: personaModel } }) },
    custom: null,
    metadata: {},
    external_id: null,
    source: null,
  });
  const record = await sessionStore.getSession({ tenant_id: TENANT_ID, session_id: 's1' });
  if (record === undefined) {
    throw new Error('test session s1 was never created');
  }
  await resolveTurnInternalSources({
    session: new SessionHandle<SessionCustom, TurnCustom>({ store: sessionStore, session: record }),
    previousTurnId: undefined,
    persona: { id: 'persona-1', modelName: personaModel },
    turnInput: undefined,
    knowledgeDir: '/nonexistent/knowledge',
    modelDir: '/nonexistent/models',
    modelProviderStore: new SqliteModelProviderStore(db),
    tokenFactoryBudget: uncappedTokenFactoryBudget,
    modelUsage: discardedModelUsage,
    logger: createLogger({ silent: true }),
  });
  await db.destroy();
  return judgeFactory.mock.calls[0]?.[0].modelName;
}

describe('library check model', () => {
  it('uses the persona model when it answers on Token Factory', async () => {
    await expect(judgeModelFor('tokenfactory/nemotron-3-super-120b-a12b')).resolves.toBe(
      'tokenfactory/nemotron-3-super-120b-a12b',
    );
  });

  it('uses the persona model when it is local', async () => {
    await expect(judgeModelFor('host/qwen')).resolves.toBe('host/qwen');
  });
});

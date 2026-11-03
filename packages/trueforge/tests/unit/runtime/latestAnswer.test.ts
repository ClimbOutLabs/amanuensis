import {
  AgentSpecSchema,
  InMemorySessionStore,
  LATEST_ANSWER_AT_METADATA_KEY,
} from '@truefoundry/trueforge-core/agent-session';
import winston from 'winston';

import type { SessionCustom, TurnCustom } from '../../../src/db/sessionCustom';
import { stampLatestAnswer, type LatestAnswerSessionStore } from '../../../src/runtime/latestAnswer';

const TENANT = 'default';
const SESSION_ID = 'chat-answer-stamp';
const ANSWERED_AT = '2026-11-03T15:04:05.000Z';

async function storeWithChat(metadata: Record<string, string>) {
  const sessionStore = new InMemorySessionStore<SessionCustom, TurnCustom>();
  await sessionStore.createSession({
    tenant_id: TENANT,
    session_id: SESSION_ID,
    agent: {
      type: 'inline',
      spec: AgentSpecSchema.parse({ model: { name: 'test-provider/test-model' }, instructions: 'test' }),
    },
    created_by_subject: { subject_id: 'owner-1', subject_type: 'user', subject_display_name: 'Owner' },
    external_id: null,
    metadata,
    source: null,
    custom: null,
  });
  return sessionStore;
}

describe('stampLatestAnswer', () => {
  it('stamps the answer time on the chat and keeps its other metadata', async () => {
    const sessionStore = await storeWithChat({ folder_hint: 'keep' });
    const logger = winston.createLogger({ silent: true });

    await stampLatestAnswer({ sessionStore, tenantId: TENANT, sessionId: SESSION_ID, answeredAt: ANSWERED_AT, logger });

    const record = await sessionStore.getSession({ tenant_id: TENANT, session_id: SESSION_ID });
    expect(record?.metadata).toEqual({ folder_hint: 'keep', [LATEST_ANSWER_AT_METADATA_KEY]: ANSWERED_AT });
  });

  it('moves the stamp forward when a later answer lands', async () => {
    const sessionStore = await storeWithChat({ [LATEST_ANSWER_AT_METADATA_KEY]: '2026-11-03T10:00:00.000Z' });
    const logger = winston.createLogger({ silent: true });

    await stampLatestAnswer({ sessionStore, tenantId: TENANT, sessionId: SESSION_ID, answeredAt: ANSWERED_AT, logger });

    const record = await sessionStore.getSession({ tenant_id: TENANT, session_id: SESSION_ID });
    expect(record?.metadata[LATEST_ANSWER_AT_METADATA_KEY]).toBe(ANSWERED_AT);
  });

  it('writes nothing when the stamp already says the same time', async () => {
    const sessionStore = await storeWithChat({ [LATEST_ANSWER_AT_METADATA_KEY]: ANSWERED_AT });
    const update = jest.spyOn(sessionStore, 'updateSession');
    const logger = winston.createLogger({ silent: true });

    await stampLatestAnswer({ sessionStore, tenantId: TENANT, sessionId: SESSION_ID, answeredAt: ANSWERED_AT, logger });

    expect(update).not.toHaveBeenCalled();
  });

  it('does nothing for a chat that is gone', async () => {
    const sessionStore = new InMemorySessionStore<SessionCustom, TurnCustom>();
    const update = jest.spyOn(sessionStore, 'updateSession');
    const logger = winston.createLogger({ silent: true });

    await expect(
      stampLatestAnswer({ sessionStore, tenantId: TENANT, sessionId: 'no-such-chat', answeredAt: ANSWERED_AT, logger }),
    ).resolves.toBeUndefined();
    expect(update).not.toHaveBeenCalled();
  });

  it('logs and swallows a store failure, since the answer itself already landed', async () => {
    const failing: LatestAnswerSessionStore = {
      getSession: () => Promise.reject(new Error('store is down')),
      updateSession: () => Promise.resolve(),
    };
    const logger = winston.createLogger({ silent: true });
    const warn = jest.spyOn(logger, 'warn');

    await expect(
      stampLatestAnswer({
        sessionStore: failing,
        tenantId: TENANT,
        sessionId: SESSION_ID,
        answeredAt: ANSWERED_AT,
        logger,
      }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

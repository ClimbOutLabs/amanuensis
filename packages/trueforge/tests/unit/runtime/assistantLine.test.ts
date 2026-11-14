import { EventType, MAIN_THREAD_ID, Sessions } from '@truefoundry/trueforge-core/agent-session';

import { migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import { createSqliteDb } from '../../../src/db/sqlite/client';
import { SqliteSessionStore } from '../../../src/db/sqlite/session-store/SqliteSessionStore';
import { appendAssistantLine } from '../../../src/runtime/assistantLine';

const TENANT = 'default';
const AT = new Date('2026-11-06T15:00:00.000Z');

async function setup() {
  const db = createSqliteDb(':memory:');
  await migrateSqliteToLatest(db);
  const sessionStore = new SqliteSessionStore(db);
  const { session } = await new Sessions({ sessionStore }).getOrCreateByExternalId({
    tenant_id: TENANT,
    external_id: 'line-test',
    created_by_subject: { subject_id: 'dana', subject_type: 'user', subject_display_name: 'Dana' },
    agent: { type: 'reference', id: 'agent-1', name: 'assistant-0123456789abcdef' },
  });
  const append = (line: { text: string; title?: string }) =>
    appendAssistantLine({
      sessionStore,
      tenant_id: TENANT,
      session_id: session.session_id,
      title: 'First title',
      now: AT,
      ...line,
    });
  return { sessionStore, session_id: session.session_id, append };
}

describe('a line written into a chat without a model call', () => {
  it('is a finished turn the chat shows as the assistant’s reply, and names the chat when it has no title', async () => {
    const t = await setup();
    const turnId = await t.append({ text: 'Your reminder: call the dentist.' });
    const turn = await t.sessionStore.getTurn({ session_id: t.session_id, turn_id: turnId });
    expect(turn?.state).toEqual(
      expect.objectContaining({
        status: 'done',
        output: expect.objectContaining({ type: EventType.MODEL_MESSAGE, content: 'Your reminder: call the dentist.' }),
      }),
    );
    expect(turn?.input).toEqual([]);
    expect(turn?.snapshot.threads[MAIN_THREAD_ID]?.context).toEqual([
      { role: 'assistant', content: 'Your reminder: call the dentist.' },
    ]);
    await t.append({ text: 'Second.', title: 'Another title' });
    const record = await t.sessionStore.getSession({ tenant_id: TENANT, session_id: t.session_id });
    expect(record?.title).toBe('First title');
  });

  it('chains each line after the last, as the assistant’s words only', async () => {
    const t = await setup();
    const first = await t.append({ text: 'Hi.' });
    const second = await t.append({ text: 'At 3pm.' });
    const turn = await t.sessionStore.getTurn({ session_id: t.session_id, turn_id: second });
    expect(turn?.previous_turn_id).toBe(first);
    expect(turn?.input).toEqual([]);
    expect(turn?.snapshot.threads[MAIN_THREAD_ID]?.context).toEqual([
      { role: 'assistant', content: 'Hi.' },
      { role: 'assistant', content: 'At 3pm.' },
    ]);
  });

  it('refuses a chat that does not exist', async () => {
    const t = await setup();
    await expect(
      appendAssistantLine({
        sessionStore: t.sessionStore,
        tenant_id: TENANT,
        session_id: 'missing',
        text: 'Hi.',
        title: 'x',
        now: AT,
      }),
    ).rejects.toThrow('The chat could not be read');
  });
});

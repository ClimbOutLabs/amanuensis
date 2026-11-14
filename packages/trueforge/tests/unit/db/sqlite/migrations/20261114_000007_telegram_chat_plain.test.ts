import { AgentSpecSchema, Sessions } from '@truefoundry/trueforge-core/agent-session';
import type { Kysely } from 'kysely';

import { migrateSqliteToLatest } from '../../../../../src/db/migrateSqlite';
import { SqliteAgentStore } from '../../../../../src/db/sqlite/agent-store/SqliteAgentStore';
import { createSqliteDb } from '../../../../../src/db/sqlite/client';
import { up } from '../../../../../src/db/sqlite/migrations/20261114_000007_telegram_chat_plain';
import { SqliteSessionStore } from '../../../../../src/db/sqlite/session-store/SqliteSessionStore';

const TENANT = 'default';
const OWNER = { subject_id: 'owner-1', subject_type: 'user' as const, subject_display_name: 'Owner' };
const OTHER = { subject_id: 'owner-2', subject_type: 'user' as const, subject_display_name: 'Other' };
const SPEC = AgentSpecSchema.parse({ model: { name: 'test-provider/test-model' } });

describe('SQLite Telegram chat becomes a plain chat', () => {
  it('rebinds only Telegram chats on their owner’s host-made agent to that agent’s setup', async () => {
    const db = createSqliteDb(':memory:');
    try {
      await migrateSqliteToLatest(db);
      const agents = new SqliteAgentStore(db);
      const sessionStore = new SqliteSessionStore(db);
      const sessions = new Sessions({ sessionStore });
      const hidden = await agents.createAgent({
        tenant_id: TENANT,
        name: 'assistant-0123456789abcdef',
        description: 'Runs the schedules you make in a chat.',
        manifest: SPEC,
        external_id: null,
        host_managed: true,
        created_by_subject: OWNER,
      });
      const saved = await agents.createAgent({
        tenant_id: TENANT,
        name: 'research-helper',
        description: 'A saved agent.',
        manifest: SPEC,
        external_id: null,
        host_managed: false,
        created_by_subject: OWNER,
      });
      const bind = (session_id: string, external_id: string | null, agent: { id: string; name: string }) =>
        sessions.create({
          tenant_id: TENANT,
          session_id,
          created_by_subject: session_id === 'someone-else' ? OTHER : OWNER,
          external_id,
          agent: { type: 'reference', id: agent.id, name: agent.name },
        });
      await bind('telegram-chat', `telegram:${OWNER.subject_id}`, hidden);
      await bind('schedule-run', null, hidden);
      await bind('saved-agent-telegram', 'telegram:someone', saved);
      await bind('someone-else', `telegram:${OTHER.subject_id}`, hidden);

      await up(db as unknown as Kysely<unknown>);

      const agentOf = async (session_id: string) =>
        (await sessionStore.getSession({ tenant_id: TENANT, session_id }))?.agent;
      expect(await agentOf('telegram-chat')).toEqual({ type: 'inline', spec: SPEC });
      expect(await agentOf('schedule-run')).toEqual({ type: 'reference', id: hidden.id, name: hidden.name });
      expect(await agentOf('saved-agent-telegram')).toEqual({ type: 'reference', id: saved.id, name: saved.name });
      expect(await agentOf('someone-else')).toEqual({ type: 'reference', id: hidden.id, name: hidden.name });
    } finally {
      await db.destroy();
    }
  });
});

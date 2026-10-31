import type {
  ChatSearchHit,
  IndexChatMessagesInput,
  SearchChatHistoryInput,
} from '@truefoundry/trueforge-core/agent-session/store/ISessionStore';
import {
  buildChatSearchSnippet,
  chatSearchQueryTerms,
} from '@truefoundry/trueforge-core/agent-session/store/chatSearchSnippet';
import { type Kysely, sql } from 'kysely';
import type { Database } from '../../types';

/**
 * Replaces one turn's rows in the past-chat search index; the generated tsvector follows
 * `body` on its own. A session that does not exist indexes nothing, so a chat deleted
 * while its turn was finishing leaves nothing behind.
 */
export async function indexChatMessages(db: Kysely<Database>, input: IndexChatMessagesInput): Promise<void> {
  await db.transaction().execute(async trx => {
    const session = await trx
      .selectFrom('session')
      .select('session_id')
      .where('tenant_id', '=', input.tenant_id)
      .where('session_id', '=', input.session_id)
      .executeTakeFirst();
    if (session === undefined) {
      return;
    }
    await trx
      .deleteFrom('chat_search_document')
      .where('tenant_id', '=', input.tenant_id)
      .where('session_id', '=', input.session_id)
      .where('turn_id', '=', input.turn_id)
      .execute();
    if (input.documents.length === 0) {
      return;
    }
    await trx
      .insertInto('chat_search_document')
      .values(
        input.documents.map(document => ({
          tenant_id: input.tenant_id,
          session_id: input.session_id,
          turn_id: input.turn_id,
          message_id: document.message_id,
          role: document.role,
          body: document.text,
          created_at: document.created_at,
        })),
      )
      .execute();
  });
}

interface ChatSearchRow {
  session_id: string;
  body: string;
  title: string | null;
  session_created_at: Date;
  doc_created_at: Date;
  rank: number;
}

/**
 * Searches the GIN-indexed tsvector over the caller's own chats. `ts_rank` ranks higher
 * for a better match; the best-ranked message of each chat becomes its one hit.
 */
export async function searchChatHistory(db: Kysely<Database>, input: SearchChatHistoryInput): Promise<ChatSearchHit[]> {
  const terms = chatSearchQueryTerms(input.query);
  if (terms.length === 0 || input.limit <= 0) {
    return [];
  }
  const rows = await sql<ChatSearchRow>`
    SELECT
      d.session_id AS session_id,
      d.body AS body,
      d.created_at AS doc_created_at,
      s.title AS title,
      s.created_at AS session_created_at,
      ts_rank(d.search_vector, q.query) AS rank
    FROM chat_search_document d
    JOIN session s ON s.tenant_id = d.tenant_id AND s.session_id = d.session_id
    CROSS JOIN (SELECT plainto_tsquery('english', ${input.query}) AS query) q
    WHERE d.search_vector @@ q.query
      AND d.tenant_id = ${input.tenant_id}
      AND s.created_by_subject->>'subject_id' = ${input.created_by_subject_id}
      AND (${input.exclude_session_id} IS NULL OR d.session_id != ${input.exclude_session_id})
      AND (${input.from} IS NULL OR d.created_at >= ${input.from})
      AND (${input.to} IS NULL OR d.created_at < ${input.to})
    ORDER BY rank DESC, d.created_at DESC
  `.execute(db);

  const bestBySession = new Map<string, ChatSearchRow>();
  for (const row of rows.rows) {
    if (!bestBySession.has(row.session_id)) {
      bestBySession.set(row.session_id, row);
    }
  }
  return [...bestBySession.values()].slice(0, input.limit).map(row => ({
    session_id: row.session_id,
    title: row.title,
    created_at: row.session_created_at,
    snippet: buildChatSearchSnippet(row.body, input.query),
  }));
}

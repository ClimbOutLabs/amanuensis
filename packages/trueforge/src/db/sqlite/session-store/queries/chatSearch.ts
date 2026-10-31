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
 * Replaces one turn's rows in the past-chat search index. The FTS5 table follows the
 * document rows through the migration's triggers, inside this same transaction. A session
 * that does not exist indexes nothing, so a chat deleted while its turn was finishing
 * leaves nothing behind.
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
          created_at: document.created_at.toISOString(),
        })),
      )
      .execute();
  });
}

interface ChatSearchRow {
  session_id: string;
  body: string;
  title: string | null;
  session_created_at: string;
  doc_created_at: string;
  rank: number;
}

/**
 * Searches the FTS5 index over the caller's own chats. FTS5's `bm25` ranks lower for a
 * better match; the best-ranked message of each chat becomes its one hit.
 */
export async function searchChatHistory(db: Kysely<Database>, input: SearchChatHistoryInput): Promise<ChatSearchHit[]> {
  const terms = chatSearchQueryTerms(input.query);
  if (terms.length === 0 || input.limit <= 0) {
    return [];
  }
  const match = terms.map(term => `"${term}"`).join(' AND ');
  const fromIso = input.from === null ? null : input.from.toISOString();
  const toIso = input.to === null ? null : input.to.toISOString();
  const rows = await sql<ChatSearchRow>`
    SELECT
      d.session_id AS session_id,
      d.body AS body,
      d.created_at AS doc_created_at,
      s.title AS title,
      s.created_at AS session_created_at,
      bm25(chat_search_fts) AS rank
    FROM chat_search_fts
    JOIN chat_search_document d ON d.rowid = chat_search_fts.rowid
    JOIN session s ON s.tenant_id = d.tenant_id AND s.session_id = d.session_id
    WHERE chat_search_fts MATCH ${match}
      AND d.tenant_id = ${input.tenant_id}
      AND json_extract(s.created_by_subject, '$.subject_id') = ${input.created_by_subject_id}
      AND (${input.exclude_session_id} IS NULL OR d.session_id != ${input.exclude_session_id})
      AND (${fromIso} IS NULL OR d.created_at >= ${fromIso})
      AND (${toIso} IS NULL OR d.created_at < ${toIso})
    ORDER BY rank ASC, d.created_at DESC
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
    created_at: new Date(row.session_created_at),
    snippet: buildChatSearchSnippet(row.body, input.query),
  }));
}

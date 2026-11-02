import type {
  ChatSearchHit,
  ClearChatSearchIndexInput,
  IndexChatMessagesInput,
  SearchChatHistoryInput,
} from '@truefoundry/trueforge-core/agent-session/store/ISessionStore';
import {
  buildChatSearchSnippet,
  chatSearchIndexWords,
  chatSearchQueryTerms,
} from '@truefoundry/trueforge-core/agent-session/store/chatSearchText';
import { type Kysely, sql } from 'kysely';
import type { Database } from '../../types';

/**
 * Replaces one turn's rows in the past-chat search index, each with its searchable words. A
 * session that does not exist indexes nothing, so a chat deleted while its turn was finishing
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
          persona_id: input.persona_id,
          body: document.text,
          search_words: chatSearchIndexWords(document.text),
          created_at: document.created_at,
        })),
      )
      // A second write for the same turn can hold rows this delete could not see yet;
      // both writes carry the same documents, so keeping the rows already there is right
      // and a primary-key error must not fail the write (and restart a whole pass).
      .onConflict(oc => oc.doNothing())
      .execute();
  });
}

interface ChatSearchRow {
  session_id: string;
  body: string;
  title: string | null;
  session_created_at: Date;
}

/**
 * Searches the caller's own chats: the GIN array index finds the messages holding every query
 * word, the window keeps each chat's newest one, and only `limit` chats leave the database.
 * Text order uses the C collation so ties break the same way in every store.
 */
export async function searchChatHistory(db: Kysely<Database>, input: SearchChatHistoryInput): Promise<ChatSearchHit[]> {
  const terms = chatSearchQueryTerms(input.query);
  if (terms.length === 0 || input.limit <= 0) {
    return [];
  }
  // Optional filters are left out of the query rather than written as "$n IS NULL OR ...":
  // Postgres cannot infer a type for a parameter that is only ever compared with NULL.
  const exclusion = input.exclude_session_id === null ? sql`` : sql`AND d.session_id != ${input.exclude_session_id}`;
  const fromBound = input.from === null ? sql`` : sql`AND d.created_at >= ${input.from}`;
  const toBound = input.to === null ? sql`` : sql`AND d.created_at < ${input.to}`;
  const rows = await sql<ChatSearchRow>`
    WITH matched AS (
      SELECT
        d.session_id,
        d.body,
        d.created_at,
        ROW_NUMBER() OVER (
          PARTITION BY d.session_id
          ORDER BY d.created_at DESC, d.turn_id COLLATE "C" DESC, d.message_id COLLATE "C" DESC
        ) AS newest
      FROM chat_search_document d
      JOIN session s ON s.tenant_id = d.tenant_id AND s.session_id = d.session_id
      WHERE d.search_words @> ${terms}::text[]
        AND d.tenant_id = ${input.tenant_id}
        AND s.created_by_subject->>'subject_id' = ${input.created_by_subject_id}
        AND (d.persona_id IS NULL OR d.persona_id = ANY(${[...input.persona_ids]}::text[]))
        ${exclusion}
        ${fromBound}
        ${toBound}
    )
    SELECT m.session_id, m.body, s.title, s.created_at AS session_created_at
    FROM matched m
    JOIN session s ON s.tenant_id = ${input.tenant_id} AND s.session_id = m.session_id
    WHERE m.newest = 1
    ORDER BY m.created_at DESC, m.session_id COLLATE "C" ASC
    LIMIT ${input.limit}
  `.execute(db);

  return rows.rows.map(row => ({
    session_id: row.session_id,
    title: row.title,
    created_at: row.session_created_at,
    snippet: buildChatSearchSnippet(row.body, input.query),
  }));
}

/** Removes the search rows of every chat the subject created in the tenant. */
export async function clearChatSearchIndex(db: Kysely<Database>, input: ClearChatSearchIndexInput): Promise<void> {
  await sql`
    DELETE FROM chat_search_document d
    USING session s
    WHERE s.tenant_id = d.tenant_id
      AND s.session_id = d.session_id
      AND d.tenant_id = ${input.tenant_id}
      AND s.created_by_subject->>'subject_id' = ${input.created_by_subject_id}
  `.execute(db);
}

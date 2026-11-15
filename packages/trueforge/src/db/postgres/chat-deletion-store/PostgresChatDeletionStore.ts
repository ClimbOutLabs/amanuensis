import { sql, type Kysely, type Transaction } from 'kysely';
import { MODEL_USAGE_EVENT_TYPE, ModelUsagePersistedEventSchema } from '../../../schemas/modelUsageEvents';
import type {
  DeleteChatInput,
  DeletedChatModelUsageRecord,
  IChatDeletionStore,
  ListDeletedChatModelUsageInput,
} from '../../chatDeletionStore';
import type { ITurnArtifactStore } from '../../turnArtifactStore';
import { deleteSession } from '../session-store/queries/sessions';
import type { Database } from '../types';

export class PostgresChatDeletionStore implements IChatDeletionStore {
  readonly #db: Kysely<Database>;
  readonly #turnArtifactStore: ITurnArtifactStore<Transaction<Database>>;

  constructor({
    db,
    turnArtifactStore,
  }: {
    db: Kysely<Database>;
    turnArtifactStore: ITurnArtifactStore<Transaction<Database>>;
  }) {
    this.#db = db;
    this.#turnArtifactStore = turnArtifactStore;
  }

  async deleteChat(input: DeleteChatInput): Promise<boolean> {
    return await this.#db
      .transaction()
      .setAccessMode('read write')
      .execute(async trx => {
        let sessionQuery = trx
          .selectFrom('session')
          .select('created_by_subject')
          .where('tenant_id', '=', input.tenant_id)
          .where('session_id', '=', input.session_id);
        if (input.expired_by !== undefined) {
          sessionQuery = sessionQuery
            .where('is_incognito', '=', true)
            .where('private_expires_at', '<=', input.expired_by);
        }
        const session = await sessionQuery.executeTakeFirst();
        if (session === undefined) {
          return false;
        }
        const rows = await trx
          .selectFrom('session_event')
          .select('event')
          .where('session_id', '=', input.session_id)
          .where(sql<string>`event->>'type'`, '=', MODEL_USAGE_EVENT_TYPE)
          .execute();
        const kept = rows.flatMap(row => {
          const parsed = ModelUsagePersistedEventSchema.safeParse(row.event);
          return parsed.success ? [parsed.data] : [];
        });
        if (kept.length > 0) {
          await trx
            .insertInto('deleted_chat_model_usage')
            .values(
              kept.map(event => ({
                tenant_id: input.tenant_id,
                event_id: event.id,
                created_by_subject_id: session.created_by_subject.subject_id,
                model_id: event.model_id,
                display_name: event.display_name,
                input_tokens: event.input_tokens,
                output_tokens: event.output_tokens,
                cost_usd: event.cost_usd,
                created_at: new Date(event.created_at),
              })),
            )
            .onConflict(oc => oc.columns(['tenant_id', 'event_id']).doNothing())
            .execute();
        }
        const chat = { tenant_id: input.tenant_id, session_id: input.session_id };
        await this.#turnArtifactStore.deleteArtifactsForSession(chat, trx);
        // The chat's recall exclusions are words from its memories; they go with the chat.
        await trx
          .deleteFrom('recall_exclusion')
          .where('tenant_id', '=', input.tenant_id)
          .where('session_id', '=', input.session_id)
          .execute();
        await deleteSession(trx, chat);
        return true;
      });
  }

  async deletePrivateChats(): Promise<number> {
    const chats = await this.#db
      .selectFrom('session')
      .select(['tenant_id', 'session_id'])
      .where('is_incognito', '=', true)
      .execute();
    let deleted = 0;
    for (const chat of chats) {
      if (await this.deleteChat({ ...chat, expired_by: undefined })) {
        deleted += 1;
      }
    }
    await this.deleteOrphanedArtifacts();
    return deleted;
  }

  async deleteOrphanedArtifacts(): Promise<number> {
    return await this.#db
      .transaction()
      .setAccessMode('read write')
      .execute(async trx => {
        const deleted = await trx
          .deleteFrom('turn_artifact')
          .where(eb =>
            eb.not(
              eb.exists(
                eb
                  .selectFrom('session as s')
                  .select('s.session_id')
                  .whereRef('s.tenant_id', '=', 'turn_artifact.tenant_id')
                  .whereRef('s.session_id', '=', 'turn_artifact.session_id'),
              ),
            ),
          )
          .executeTakeFirst();
        const removed = Number(deleted.numDeletedRows);
        if (removed > 0) {
          await trx
            .deleteFrom('artifact_blob')
            .where(eb =>
              eb.not(
                eb.exists(
                  eb
                    .selectFrom('turn_artifact as ta')
                    .select('ta.digest')
                    .whereRef('ta.tenant_id', '=', 'artifact_blob.tenant_id')
                    .whereRef('ta.digest', '=', 'artifact_blob.digest'),
                ),
              ),
            )
            .execute();
        }
        return removed;
      });
  }

  async listDeletedChatModelUsage(input: ListDeletedChatModelUsageInput): Promise<DeletedChatModelUsageRecord[]> {
    const rows = await this.#db
      .selectFrom('deleted_chat_model_usage')
      .select(['event_id', 'model_id', 'display_name', 'input_tokens', 'output_tokens', 'cost_usd', 'created_at'])
      .where('tenant_id', '=', input.tenant_id)
      .where('created_by_subject_id', '=', input.created_by_subject_id)
      .where('created_at', '>=', input.from)
      .where('created_at', '<', input.to)
      .orderBy('created_at', 'asc')
      .orderBy('event_id', 'asc')
      .execute();
    return rows.map(row => ({ ...row, created_at: row.created_at.toISOString() }));
  }
}

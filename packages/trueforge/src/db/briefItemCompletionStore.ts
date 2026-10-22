import type { BriefSection } from '@truefoundry/trueforge-core/core/schedules/morningBrief';
import type { Kysely } from 'kysely';

import type { BriefItemCompletion } from '../schemas/briefItems';
import { newId } from '../utils/id';

/** How far back a completed brief item is remembered, for the list route and the next brief. */
export const BRIEF_ITEM_DONE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** One row of `brief_item_completion`. `completed_at` is text on SQLite and timestamptz on Postgres. */
export interface BriefItemCompletionTable {
  id: string;
  tenant_id: string;
  created_by: string;
  item_key: string;
  section: BriefSection;
  title: string;
  completed_at: string | Date;
}

/** Minimal database shape this store needs. Both SQLite and Postgres provide it. */
export interface BriefItemCompletionDatabase {
  brief_item_completion: BriefItemCompletionTable;
}

export interface BriefItemOwner {
  tenant_id: string;
  created_by: string;
}

export interface MarkBriefItemDoneInput extends BriefItemOwner {
  item_key: string;
  section: BriefSection;
  title: string;
}

export interface UndoBriefItemInput extends BriefItemOwner {
  item_key: string;
}

export interface ListCompletedBriefItemsInput extends BriefItemOwner {
  since: Date;
}

export interface IBriefItemCompletionStore {
  /** Marks an item done. Marking it again refreshes `completed_at` instead of adding a row. */
  markDone(input: MarkBriefItemDoneInput): Promise<BriefItemCompletion>;
  /** Removes the item. Resolves to its title when a row was removed, undefined when none existed. */
  undo(input: UndoBriefItemInput): Promise<{ title: string } | undefined>;
  /** The owner's completed items marked done at or after `since`, newest first. */
  listCompletedSince(input: ListCompletedBriefItemsInput): Promise<BriefItemCompletion[]>;
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

/** Items a person marked done in a morning brief. Owner-scoped: no caller can read or remove another owner's rows. */
export class BriefItemCompletionStore implements IBriefItemCompletionStore {
  readonly #db: Kysely<BriefItemCompletionDatabase>;

  constructor(db: Kysely<BriefItemCompletionDatabase>) {
    this.#db = db;
  }

  async markDone(input: MarkBriefItemDoneInput): Promise<BriefItemCompletion> {
    const completedAt = new Date().toISOString();
    await this.#db
      .insertInto('brief_item_completion')
      .values({
        id: newId(),
        tenant_id: input.tenant_id,
        created_by: input.created_by,
        item_key: input.item_key,
        section: input.section,
        title: input.title,
        completed_at: completedAt,
      })
      .onConflict(conflict =>
        conflict.columns(['tenant_id', 'created_by', 'item_key']).doUpdateSet({
          section: input.section,
          title: input.title,
          completed_at: completedAt,
        }),
      )
      .execute();
    return { item_key: input.item_key, section: input.section, title: input.title, completed_at: completedAt };
  }

  async undo(input: UndoBriefItemInput): Promise<{ title: string } | undefined> {
    return this.#db
      .deleteFrom('brief_item_completion')
      .where('tenant_id', '=', input.tenant_id)
      .where('created_by', '=', input.created_by)
      .where('item_key', '=', input.item_key)
      .returning('title')
      .executeTakeFirst();
  }

  async listCompletedSince(input: ListCompletedBriefItemsInput): Promise<BriefItemCompletion[]> {
    const rows = await this.#db
      .selectFrom('brief_item_completion')
      .select(['item_key', 'section', 'title', 'completed_at'])
      .where('tenant_id', '=', input.tenant_id)
      .where('created_by', '=', input.created_by)
      .where('completed_at', '>=', input.since.toISOString())
      .orderBy('completed_at', 'desc')
      .orderBy('item_key', 'asc')
      .execute();
    return rows.map(row => ({
      item_key: row.item_key,
      section: row.section,
      title: row.title,
      completed_at: toIso(row.completed_at),
    }));
  }
}

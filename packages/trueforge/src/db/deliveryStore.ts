import { decodePageToken, encodePageToken } from '@truefoundry/trueforge-core/agent-session/store/PageToken';
import type { Kysely } from 'kysely';
import { z } from 'zod';

import { monotonicFactory } from 'ulid';
import {
  DeliveryLinkSchema,
  DeliverySchema,
  type Delivery,
  type DeliveryAttempt,
  type DeliveryLevel,
  type DeliveryLink,
} from '../schemas/deliveries';

import { newId } from '../utils/id';

import type { PersonOwner } from './personOwner';

/** Attempts made in the same millisecond still read back in the order they were recorded. */
const nextAttemptId = monotonicFactory();

/** One row of `delivery`. Times are text on SQLite and timestamptz on Postgres. `kind` and `level` are plain text. */
export interface DeliveryTable {
  id: string;
  tenant_id: string;
  created_by: string;
  kind: string;
  level: string;
  text: string;
  reason: string;
  /** JSON of a DeliveryLink, or null. */
  link: string | null;
  created_at: string | Date;
  seen_at: string | Date | null;
}

/** One row of `delivery_attempt`: one channel tried for one delivery. */
export interface DeliveryAttemptTable {
  id: string;
  delivery_id: string;
  tenant_id: string;
  created_by: string;
  channel: string;
  outcome: string;
  detail: string | null;
  target: string | null;
  attempted_at: string | Date;
}

export interface DeliveryDatabase {
  delivery: DeliveryTable;
  delivery_attempt: DeliveryAttemptTable;
}

export interface CreateDeliveryInput extends PersonOwner {
  kind: Delivery['kind'];
  level: DeliveryLevel;
  text: string;
  reason: string;
  link: DeliveryLink | null;
  /** Defaults to now. */
  created_at?: Date;
}

export interface ListDeliveriesInput extends PersonOwner {
  limit: number;
  page_token?: string | undefined;
}

export interface DeliveryPage {
  deliveries: Delivery[];
  next_page_token: string | undefined;
}

export interface RecordDeliveryAttemptInput extends PersonOwner {
  delivery_id: string;
  attempt: DeliveryAttempt;
}

export interface ImportDeliveriesInput extends PersonOwner {
  deliveries: readonly Delivery[];
}

/** Newest deliveries an export carries. */
export const DELIVERY_EXPORT_LIMIT = 1000;

export interface IDeliveryStore {
  /** Makes one delivery, unread. Throws when the fields do not make a valid delivery of that kind. */
  create(input: CreateDeliveryInput): Promise<Delivery>;
  /**
   * Makes the delivery with this id unless the owner made it already. Resolves to the delivery and whether this call
   * made it, so whatever goes out with a delivery goes out once. Throws when the id is someone else's.
   */
  createOnce(input: CreateDeliveryInput & { id: string }): Promise<{ delivery: Delivery; created: boolean }>;
  /** Adds one channel attempt. A delivery that is not the owner's is left alone and reads as missing. */
  recordAttempt(input: RecordDeliveryAttemptInput): Promise<boolean>;
  get(input: PersonOwner & { id: string }): Promise<Delivery | undefined>;
  /** The owner's deliveries, newest first. */
  list(input: ListDeliveriesInput): Promise<DeliveryPage>;
  /** Marks the owner's listed deliveries seen. Already seen ones keep their first time. Resolves to how many changed. */
  markSeen(input: PersonOwner & { ids: readonly string[]; now?: Date }): Promise<number>;
  /** Marks every unread delivery of the owner seen, loaded on a page or not. Resolves to how many changed. */
  markAllSeen(input: PersonOwner & { now?: Date }): Promise<number>;
  countUnread(input: PersonOwner): Promise<number>;
  /** How many of the owner's deliveries of these kinds went out at one of these levels at or after `since`. */
  countSince(
    input: PersonOwner & { since: Date; kinds: readonly Delivery['kind'][]; levels: readonly DeliveryLevel[] },
  ): Promise<number>;
  /** When the owner's newest delivery at one of these levels was made, or undefined when there is none. */
  lastCreatedAt(input: PersonOwner & { levels: readonly DeliveryLevel[] }): Promise<Date | undefined>;
  /** The owner's newest deliveries for a data export. */
  listForExport(input: PersonOwner): Promise<Delivery[]>;
  /** Adds exported deliveries under the owner; pass the import transaction. One already there keeps its row. Resolves to how many were added. */
  importDeliveries(input: ImportDeliveriesInput, transaction?: Kysely<DeliveryDatabase>): Promise<number>;
}

/** Rows per insert on import, well under the bound-variable limits of SQLite and Postgres. */
const IMPORT_BATCH_SIZE = 200;

function batches<T>(rows: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let start = 0; start < rows.length; start += IMPORT_BATCH_SIZE) {
    out.push(rows.slice(start, start + IMPORT_BATCH_SIZE));
  }
  return out;
}

const CursorSchema = z.object({ created_at: z.string(), id: z.string() });

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

function parseLink(raw: string | null): DeliveryLink | null {
  return raw === null ? null : DeliveryLinkSchema.parse(JSON.parse(raw));
}

function toAttempt(row: DeliveryAttemptTable): unknown {
  return {
    channel: row.channel,
    outcome: row.outcome,
    detail: row.detail,
    target: row.target,
    attempted_at: toIso(row.attempted_at),
  };
}

function toDelivery({ row, attempts }: { row: DeliveryTable; attempts: DeliveryAttemptTable[] }): Delivery {
  return DeliverySchema.parse({
    id: row.id,
    kind: row.kind,
    level: row.level,
    text: row.text,
    reason: row.reason,
    link: parseLink(row.link),
    created_at: toIso(row.created_at),
    seen_at: row.seen_at === null ? null : toIso(row.seen_at),
    attempts: attempts.map(toAttempt),
  });
}

function rowOf(input: CreateDeliveryInput & { id: string }): DeliveryTable {
  return {
    id: input.id,
    tenant_id: input.tenant_id,
    created_by: input.created_by,
    kind: input.kind,
    level: input.level,
    text: input.text,
    reason: input.reason,
    link: input.link === null ? null : JSON.stringify(input.link),
    created_at: (input.created_at ?? new Date()).toISOString(),
    seen_at: null,
  };
}

/** The feed of things meant for a person. Owner-scoped: no read or write reaches another owner's rows. */
export class DeliveryStore implements IDeliveryStore {
  readonly #db: Kysely<DeliveryDatabase>;

  constructor(db: Kysely<DeliveryDatabase>) {
    this.#db = db;
  }

  async #hydrate(rows: DeliveryTable[]): Promise<Delivery[]> {
    if (rows.length === 0) {
      return [];
    }
    const attempts = await this.#db
      .selectFrom('delivery_attempt')
      .selectAll()
      .where(
        'delivery_id',
        'in',
        rows.map(row => row.id),
      )
      .orderBy('attempted_at', 'asc')
      .orderBy('id', 'asc')
      .execute();
    const byDelivery = new Map<string, DeliveryAttemptTable[]>();
    for (const attempt of attempts) {
      byDelivery.set(attempt.delivery_id, [...(byDelivery.get(attempt.delivery_id) ?? []), attempt]);
    }
    return rows.map(row => toDelivery({ row, attempts: byDelivery.get(row.id) ?? [] }));
  }

  async create(input: CreateDeliveryInput): Promise<Delivery> {
    const row = rowOf({ ...input, id: newId() });
    // Parsed before the write, so a delivery that could not be read back is never stored.
    const delivery = toDelivery({ row, attempts: [] });
    await this.#db.insertInto('delivery').values(row).execute();
    return delivery;
  }

  async createOnce(input: CreateDeliveryInput & { id: string }): Promise<{ delivery: Delivery; created: boolean }> {
    const row = rowOf(input);
    const delivery = toDelivery({ row, attempts: [] });
    const inserted = await this.#db
      .insertInto('delivery')
      .values(row)
      .onConflict(conflict => conflict.column('id').doNothing())
      .returning('id')
      .execute();
    if (inserted.length > 0) {
      return { delivery, created: true };
    }
    const made = await this.get({ tenant_id: input.tenant_id, created_by: input.created_by, id: input.id });
    if (made === undefined) {
      throw new Error('A delivery with this id belongs to someone else.');
    }
    return { delivery: made, created: false };
  }

  async recordAttempt(input: RecordDeliveryAttemptInput): Promise<boolean> {
    const owned = await this.#db
      .selectFrom('delivery')
      .select('id')
      .where('id', '=', input.delivery_id)
      .where('tenant_id', '=', input.tenant_id)
      .where('created_by', '=', input.created_by)
      .executeTakeFirst();
    if (owned === undefined) {
      return false;
    }
    await this.#db
      .insertInto('delivery_attempt')
      .values({
        id: nextAttemptId().toLowerCase(),
        delivery_id: input.delivery_id,
        tenant_id: input.tenant_id,
        created_by: input.created_by,
        channel: input.attempt.channel,
        outcome: input.attempt.outcome,
        detail: input.attempt.detail,
        target: input.attempt.target,
        attempted_at: input.attempt.attempted_at,
      })
      .execute();
    return true;
  }

  async get(input: PersonOwner & { id: string }): Promise<Delivery | undefined> {
    const row = await this.#db
      .selectFrom('delivery')
      .selectAll()
      .where('id', '=', input.id)
      .where('tenant_id', '=', input.tenant_id)
      .where('created_by', '=', input.created_by)
      .executeTakeFirst();
    if (row === undefined) {
      return undefined;
    }
    const [delivery] = await this.#hydrate([row]);
    return delivery;
  }

  async list(input: ListDeliveriesInput): Promise<DeliveryPage> {
    const cursor = input.page_token === undefined ? undefined : decodePageToken(CursorSchema, input.page_token);
    let query = this.#db
      .selectFrom('delivery')
      .selectAll()
      .where('tenant_id', '=', input.tenant_id)
      .where('created_by', '=', input.created_by);
    if (cursor !== undefined) {
      query = query.where(eb =>
        eb.or([
          eb('created_at', '<', cursor.created_at),
          eb.and([eb('created_at', '=', cursor.created_at), eb('id', '<', cursor.id)]),
        ]),
      );
    }
    // One extra row tells whether another page exists.
    const rows = await query
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(input.limit + 1)
      .execute();
    const pageRows = rows.slice(0, input.limit);
    const last = pageRows.at(-1);
    return {
      deliveries: await this.#hydrate(pageRows),
      next_page_token:
        rows.length > input.limit && last !== undefined
          ? encodePageToken(CursorSchema, { created_at: toIso(last.created_at), id: last.id })
          : undefined,
    };
  }

  async markSeen(input: PersonOwner & { ids: readonly string[]; now?: Date }): Promise<number> {
    if (input.ids.length === 0) {
      return 0;
    }
    const rows = await this.#db
      .updateTable('delivery')
      .set({ seen_at: (input.now ?? new Date()).toISOString() })
      .where('tenant_id', '=', input.tenant_id)
      .where('created_by', '=', input.created_by)
      .where('id', 'in', [...input.ids])
      .where('seen_at', 'is', null)
      .returning('id')
      .execute();
    return rows.length;
  }

  async markAllSeen(input: PersonOwner & { now?: Date }): Promise<number> {
    const rows = await this.#db
      .updateTable('delivery')
      .set({ seen_at: (input.now ?? new Date()).toISOString() })
      .where('tenant_id', '=', input.tenant_id)
      .where('created_by', '=', input.created_by)
      .where('seen_at', 'is', null)
      .returning('id')
      .execute();
    return rows.length;
  }

  async countUnread(input: PersonOwner): Promise<number> {
    const row = await this.#db
      .selectFrom('delivery')
      .select(eb => eb.fn.countAll<string | number>().as('unread'))
      .where('tenant_id', '=', input.tenant_id)
      .where('created_by', '=', input.created_by)
      .where('seen_at', 'is', null)
      .executeTakeFirst();
    return Number(row?.unread ?? 0);
  }

  async countSince(
    input: PersonOwner & { since: Date; kinds: readonly Delivery['kind'][]; levels: readonly DeliveryLevel[] },
  ): Promise<number> {
    if (input.kinds.length === 0 || input.levels.length === 0) {
      return 0;
    }
    const row = await this.#db
      .selectFrom('delivery')
      .select(eb => eb.fn.countAll<string | number>().as('total'))
      .where('tenant_id', '=', input.tenant_id)
      .where('created_by', '=', input.created_by)
      .where('kind', 'in', [...input.kinds])
      .where('level', 'in', [...input.levels])
      .where('created_at', '>=', input.since.toISOString())
      .executeTakeFirst();
    return Number(row?.total ?? 0);
  }

  async lastCreatedAt(input: PersonOwner & { levels: readonly DeliveryLevel[] }): Promise<Date | undefined> {
    if (input.levels.length === 0) {
      return undefined;
    }
    const row = await this.#db
      .selectFrom('delivery')
      .select('created_at')
      .where('tenant_id', '=', input.tenant_id)
      .where('created_by', '=', input.created_by)
      .where('level', 'in', [...input.levels])
      .orderBy('created_at', 'desc')
      .limit(1)
      .executeTakeFirst();
    return row === undefined ? undefined : new Date(row.created_at);
  }

  async listForExport(input: PersonOwner): Promise<Delivery[]> {
    const rows = await this.#db
      .selectFrom('delivery')
      .selectAll()
      .where('tenant_id', '=', input.tenant_id)
      .where('created_by', '=', input.created_by)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(DELIVERY_EXPORT_LIMIT)
      .execute();
    return this.#hydrate(rows);
  }

  async importDeliveries(input: ImportDeliveriesInput, transaction?: Kysely<DeliveryDatabase>): Promise<number> {
    const db = transaction ?? this.#db;
    const addedIds = new Set<string>();
    for (const batch of batches(input.deliveries)) {
      const inserted = await db
        .insertInto('delivery')
        .values(
          batch.map(delivery => ({
            id: delivery.id,
            tenant_id: input.tenant_id,
            created_by: input.created_by,
            kind: delivery.kind,
            level: delivery.level,
            text: delivery.text,
            reason: delivery.reason,
            link: delivery.link === null ? null : JSON.stringify(delivery.link),
            created_at: delivery.created_at,
            seen_at: delivery.seen_at,
          })),
        )
        .onConflict(conflict => conflict.column('id').doNothing())
        .returning('id')
        .execute();
      for (const row of inserted) {
        addedIds.add(row.id);
      }
    }
    const attempts = input.deliveries
      .filter(delivery => addedIds.has(delivery.id))
      .flatMap(delivery =>
        delivery.attempts.map(attempt => ({
          id: nextAttemptId().toLowerCase(),
          delivery_id: delivery.id,
          tenant_id: input.tenant_id,
          created_by: input.created_by,
          channel: attempt.channel,
          outcome: attempt.outcome,
          detail: attempt.detail,
          target: attempt.target,
          attempted_at: attempt.attempted_at,
        })),
      );
    for (const batch of batches(attempts)) {
      await db.insertInto('delivery_attempt').values(batch).execute();
    }
    return addedIds.size;
  }
}

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

export interface DeliveryOwner {
  tenant_id: string;
  created_by: string;
}

export interface CreateDeliveryInput extends DeliveryOwner {
  kind: Delivery['kind'];
  level: DeliveryLevel;
  text: string;
  reason: string;
  link: DeliveryLink | null;
  /** Defaults to now. */
  created_at?: Date;
}

export interface ListDeliveriesInput extends DeliveryOwner {
  limit: number;
  page_token?: string | undefined;
}

export interface DeliveryPage {
  deliveries: Delivery[];
  next_page_token: string | undefined;
}

export interface RecordDeliveryAttemptInput extends DeliveryOwner {
  delivery_id: string;
  attempt: DeliveryAttempt;
}

export interface ImportDeliveriesInput extends DeliveryOwner {
  deliveries: readonly Delivery[];
}

/** Newest deliveries an export carries. */
export const DELIVERY_EXPORT_LIMIT = 1000;

export interface IDeliveryStore {
  /** Makes one delivery, unread. Throws when the fields do not make a valid delivery of that kind. */
  create(input: CreateDeliveryInput): Promise<Delivery>;
  /** Adds one channel attempt. A delivery that is not the owner's is left alone and reads as missing. */
  recordAttempt(input: RecordDeliveryAttemptInput): Promise<boolean>;
  get(input: DeliveryOwner & { id: string }): Promise<Delivery | undefined>;
  /** The owner's deliveries, newest first. */
  list(input: ListDeliveriesInput): Promise<DeliveryPage>;
  /** Marks the owner's listed deliveries seen. Already seen ones keep their first time. Resolves to how many changed. */
  markSeen(input: DeliveryOwner & { ids: readonly string[]; now?: Date }): Promise<number>;
  countUnread(input: DeliveryOwner): Promise<number>;
  /** The owner's newest deliveries for a data export. */
  listForExport(input: DeliveryOwner): Promise<Delivery[]>;
  /** Adds exported deliveries under the owner; pass the import transaction. One already there keeps its row. Resolves to how many were added. */
  importDeliveries(input: ImportDeliveriesInput, transaction?: Kysely<DeliveryDatabase>): Promise<number>;
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
    const row: DeliveryTable = {
      id: newId(),
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
    // Parsed before the write, so a delivery that could not be read back is never stored.
    const delivery = toDelivery({ row, attempts: [] });
    await this.#db.insertInto('delivery').values(row).execute();
    return delivery;
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

  async get(input: DeliveryOwner & { id: string }): Promise<Delivery | undefined> {
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

  async markSeen(input: DeliveryOwner & { ids: readonly string[]; now?: Date }): Promise<number> {
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

  async countUnread(input: DeliveryOwner): Promise<number> {
    const row = await this.#db
      .selectFrom('delivery')
      .select(eb => eb.fn.countAll<string | number>().as('unread'))
      .where('tenant_id', '=', input.tenant_id)
      .where('created_by', '=', input.created_by)
      .where('seen_at', 'is', null)
      .executeTakeFirst();
    return Number(row?.unread ?? 0);
  }

  async listForExport(input: DeliveryOwner): Promise<Delivery[]> {
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
    if (input.deliveries.length === 0) {
      return 0;
    }
    const db = transaction ?? this.#db;
    const inserted = await db
      .insertInto('delivery')
      .values(
        input.deliveries.map(delivery => ({
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
    const addedIds = new Set(inserted.map(row => row.id));
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
    if (attempts.length > 0) {
      await db.insertInto('delivery_attempt').values(attempts).execute();
    }
    return addedIds.size;
  }
}

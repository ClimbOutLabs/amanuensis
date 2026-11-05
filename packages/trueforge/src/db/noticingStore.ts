import type { Kysely } from 'kysely';

import type { DeliveryLevel } from '../schemas/deliveries';
import { NoticingEventSchema, type NoticingEvent, type NoticingWatcher } from '../schemas/reach';
import { newId } from '../utils/id';

/** Rows of `noticing_event`: one per stable event id. `tracking` waits for a due date; `raised` has been decided. */
export interface NoticingEventTable {
  id: string;
  tenant_id: string;
  created_by: string;
  event_id: string;
  kind: string;
  status: string;
  /** JSON of a NoticingEvent. */
  event_json: string;
  due_at: string | Date | null;
  model_level: string | null;
  decided_level: string | null;
  delivered_level: string | null;
  reason: string | null;
  delivery_id: string | null;
  created_at: string | Date;
  decided_at: string | Date | null;
}

/** When a watcher last looked for one person. */
export interface NoticingCheckpointTable {
  tenant_id: string;
  created_by: string;
  watcher: string;
  checked_at: string | Date;
}

export interface NoticingDatabase {
  noticing_event: NoticingEventTable;
  noticing_checkpoint: NoticingCheckpointTable;
}

export interface NoticingOwner {
  tenant_id: string;
  created_by: string;
}

export type NoticingEventStatus = 'tracking' | 'raised' | 'dropped';

/** What was decided for an event, with the reason in plain words. */
export interface NoticingDecision {
  model_level: DeliveryLevel | null;
  decided_level: DeliveryLevel;
  delivered_level: DeliveryLevel;
  reason: string;
  delivery_id: string;
}

export interface NoticingEventRecord {
  event: NoticingEvent;
  status: NoticingEventStatus;
  due_at: string | null;
  decision: (NoticingDecision & { decided_at: string }) | null;
}

export interface INoticingStore {
  /**
   * Records an event the first time its stable id is seen. Resolves to `new` for the first sighting and `seen` for
   * every later one, so the same thing is never raised twice.
   */
  claim(
    input: NoticingOwner & { event: NoticingEvent; status: NoticingEventStatus; now?: Date },
  ): Promise<'new' | 'seen'>;
  get(input: NoticingOwner & { event_id: string }): Promise<NoticingEventRecord | undefined>;
  /** Events waiting for their due date, due at or before `due_before`, soonest first. */
  listTracking(input: NoticingOwner & { due_before: Date; limit: number }): Promise<NoticingEventRecord[]>;
  /** Turns a waiting event into a decided one. Resolves to false when it was already decided. */
  decide(input: NoticingOwner & { event_id: string; decision: NoticingDecision; now?: Date }): Promise<boolean>;
  /** Stops waiting for a tracked event that will never be raised (it passed, or was paid). */
  drop(input: NoticingOwner & { event_id: string }): Promise<void>;
  /** Drops a claim whose delivery failed, so the next pass raises it again. */
  release(input: NoticingOwner & { event_id: string }): Promise<void>;
  /** Nudges delivered at or after `since`. */
  countNudgesSince(input: NoticingOwner & { since: Date }): Promise<number>;
  /** When the last call was decided (delivered as a call or, until calls exist, as a nudge), or undefined. */
  lastCallDecidedAt(input: NoticingOwner): Promise<Date | undefined>;
  getCheckpoint(input: NoticingOwner & { watcher: NoticingWatcher }): Promise<Date | undefined>;
  setCheckpoint(input: NoticingOwner & { watcher: NoticingWatcher; checked_at: Date }): Promise<void>;
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

function toRecord(row: NoticingEventTable): NoticingEventRecord {
  const { decided_at, decided_level, delivered_level, reason, delivery_id } = row;
  return {
    event: NoticingEventSchema.parse(JSON.parse(row.event_json)),
    status: row.status === 'tracking' ? 'tracking' : row.status === 'dropped' ? 'dropped' : 'raised',
    due_at: row.due_at === null ? null : toIso(row.due_at),
    decision:
      decided_at !== null &&
      decided_level !== null &&
      delivered_level !== null &&
      reason !== null &&
      delivery_id !== null
        ? {
            model_level: row.model_level === null ? null : levelOf(row.model_level),
            decided_level: levelOf(decided_level),
            delivered_level: levelOf(delivered_level),
            reason,
            delivery_id,
            decided_at: toIso(decided_at),
          }
        : null,
  };
}

function levelOf(value: string | null): DeliveryLevel {
  return value === 'call' ? 'call' : value === 'nudge' ? 'nudge' : 'note';
}

/** The events the watchers found and how each was decided. Owner-scoped. */
export class NoticingStore implements INoticingStore {
  readonly #db: Kysely<NoticingDatabase>;

  constructor(db: Kysely<NoticingDatabase>) {
    this.#db = db;
  }

  async claim(
    input: NoticingOwner & { event: NoticingEvent; status: NoticingEventStatus; now?: Date },
  ): Promise<'new' | 'seen'> {
    const event = NoticingEventSchema.parse(input.event);
    const inserted = await this.#db
      .insertInto('noticing_event')
      .values({
        id: newId(),
        tenant_id: input.tenant_id,
        created_by: input.created_by,
        event_id: event.id,
        kind: event.kind,
        status: input.status,
        event_json: JSON.stringify(event),
        due_at: event.due_at,
        model_level: null,
        decided_level: null,
        delivered_level: null,
        reason: null,
        delivery_id: null,
        created_at: (input.now ?? new Date()).toISOString(),
        decided_at: null,
      })
      .onConflict(conflict => conflict.columns(['tenant_id', 'created_by', 'event_id']).doNothing())
      .returning('id')
      .execute();
    return inserted.length > 0 ? 'new' : 'seen';
  }

  async get(input: NoticingOwner & { event_id: string }): Promise<NoticingEventRecord | undefined> {
    const row = await this.#db
      .selectFrom('noticing_event')
      .selectAll()
      .where('tenant_id', '=', input.tenant_id)
      .where('created_by', '=', input.created_by)
      .where('event_id', '=', input.event_id)
      .executeTakeFirst();
    return row === undefined ? undefined : toRecord(row);
  }

  async listTracking(input: NoticingOwner & { due_before: Date; limit: number }): Promise<NoticingEventRecord[]> {
    const rows = await this.#db
      .selectFrom('noticing_event')
      .selectAll()
      .where('tenant_id', '=', input.tenant_id)
      .where('created_by', '=', input.created_by)
      .where('status', '=', 'tracking')
      .where('due_at', '<=', input.due_before.toISOString())
      .orderBy('due_at', 'asc')
      .orderBy('id', 'asc')
      .limit(input.limit)
      .execute();
    return rows.map(toRecord);
  }

  async decide(input: NoticingOwner & { event_id: string; decision: NoticingDecision; now?: Date }): Promise<boolean> {
    const updated = await this.#db
      .updateTable('noticing_event')
      .set({
        status: 'raised',
        model_level: input.decision.model_level,
        decided_level: input.decision.decided_level,
        delivered_level: input.decision.delivered_level,
        reason: input.decision.reason,
        delivery_id: input.decision.delivery_id,
        decided_at: (input.now ?? new Date()).toISOString(),
      })
      .where('tenant_id', '=', input.tenant_id)
      .where('created_by', '=', input.created_by)
      .where('event_id', '=', input.event_id)
      .where('decided_at', 'is', null)
      .returning('id')
      .execute();
    return updated.length > 0;
  }

  async drop(input: NoticingOwner & { event_id: string }): Promise<void> {
    await this.#db
      .updateTable('noticing_event')
      .set({ status: 'dropped' })
      .where('tenant_id', '=', input.tenant_id)
      .where('created_by', '=', input.created_by)
      .where('event_id', '=', input.event_id)
      .where('status', '=', 'tracking')
      .execute();
  }

  async release(input: NoticingOwner & { event_id: string }): Promise<void> {
    await this.#db
      .deleteFrom('noticing_event')
      .where('tenant_id', '=', input.tenant_id)
      .where('created_by', '=', input.created_by)
      .where('event_id', '=', input.event_id)
      .where('decided_at', 'is', null)
      .execute();
  }

  async countNudgesSince(input: NoticingOwner & { since: Date }): Promise<number> {
    const row = await this.#db
      .selectFrom('noticing_event')
      .select(eb => eb.fn.countAll<string | number>().as('total'))
      .where('tenant_id', '=', input.tenant_id)
      .where('created_by', '=', input.created_by)
      .where('delivered_level', '=', 'nudge')
      .where('decided_at', '>=', input.since.toISOString())
      .executeTakeFirst();
    return Number(row?.total ?? 0);
  }

  async lastCallDecidedAt(input: NoticingOwner): Promise<Date | undefined> {
    const row = await this.#db
      .selectFrom('noticing_event')
      .select('decided_at')
      .where('tenant_id', '=', input.tenant_id)
      .where('created_by', '=', input.created_by)
      .where('decided_level', '=', 'call')
      .orderBy('decided_at', 'desc')
      .limit(1)
      .executeTakeFirst();
    const decidedAt = row?.decided_at;
    return decidedAt === null || decidedAt === undefined ? undefined : new Date(decidedAt);
  }

  async getCheckpoint(input: NoticingOwner & { watcher: NoticingWatcher }): Promise<Date | undefined> {
    const row = await this.#db
      .selectFrom('noticing_checkpoint')
      .select('checked_at')
      .where('tenant_id', '=', input.tenant_id)
      .where('created_by', '=', input.created_by)
      .where('watcher', '=', input.watcher)
      .executeTakeFirst();
    return row === undefined ? undefined : new Date(row.checked_at);
  }

  async setCheckpoint(input: NoticingOwner & { watcher: NoticingWatcher; checked_at: Date }): Promise<void> {
    const checked_at = input.checked_at.toISOString();
    await this.#db
      .insertInto('noticing_checkpoint')
      .values({ tenant_id: input.tenant_id, created_by: input.created_by, watcher: input.watcher, checked_at })
      .onConflict(conflict => conflict.columns(['tenant_id', 'created_by', 'watcher']).doUpdateSet({ checked_at }))
      .execute();
  }
}

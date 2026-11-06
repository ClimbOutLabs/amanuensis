import type { Kysely } from 'kysely';

import type { DeliveryLevel } from '../schemas/deliveries';
import { NoticingEventSchema, type NoticingEvent, type NoticingKind, type NoticingWatcher } from '../schemas/reach';
import { newId } from '../utils/id';

/**
 * Rows of `noticing_event`: one per stable event id. `tracking` waits for a due date, `pending` waits to be raised,
 * `raised` was delivered, `dropped` will never be raised and `failed` stopped after too many failed tries. A pending
 * row is worked on by whoever holds its `claim_id`; a claim older than the caller's stale mark is free to take.
 */
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
  claim_id: string | null;
  claimed_at: string | Date | null;
  attempts: number;
}

/** When a watcher last looked for one person. */
export interface NoticingCheckpointTable {
  tenant_id: string;
  created_by: string;
  watcher: string;
  checked_at: string | Date;
}

/** Who is deciding how loudly to reach one person right now, and until when. */
export interface ReachLeaseTable {
  tenant_id: string;
  created_by: string;
  holder: string;
  held_until: string | Date;
}

export interface NoticingDatabase {
  noticing_event: NoticingEventTable;
  noticing_checkpoint: NoticingCheckpointTable;
  reach_lease: ReachLeaseTable;
}

/** The person whose events, settings and reach decisions these are. */
export interface NoticingOwner {
  tenant_id: string;
  created_by: string;
}

/** What was decided for an event, with the reason in plain words. */
export interface NoticingDecision {
  model_level: DeliveryLevel | null;
  decided_level: DeliveryLevel;
  delivered_level: DeliveryLevel;
  reason: string;
  delivery_id: string;
}

/** An event that failed this many times is given up on, so one broken event never blocks a pass for good. */
const MAX_ATTEMPTS = 5;

export interface INoticingStore {
  /**
   * Writes an event the first time its stable id is seen, either `pending` to be raised or `tracking` to wait for
   * its due date. Resolves to `new` for the first sighting and `seen` for every later one.
   */
  record(
    input: NoticingOwner & { event: NoticingEvent; status: 'pending' | 'tracking'; now: Date },
  ): Promise<'new' | 'seen'>;
  /** Pending events of these kinds that no live claim holds, oldest first. */
  listPending(
    input: NoticingOwner & { kinds: readonly NoticingKind[]; stale_before: Date; limit: number },
  ): Promise<NoticingEvent[]>;
  /** Takes a pending event for one pass. Resolves to false when another live claim holds it or it is not pending. */
  claim(input: NoticingOwner & { event_id: string; claim_id: string; now: Date; stale_before: Date }): Promise<boolean>;
  /** Marks a claimed event raised. Resolves to false when the claim was lost to another pass first. */
  decide(
    input: NoticingOwner & { event_id: string; claim_id: string; decision: NoticingDecision; now: Date },
  ): Promise<boolean>;
  /**
   * Hands a claimed event back for a later pass. A `failed` try counts toward giving up; resolves to the status the
   * event is left in.
   */
  release(
    input: NoticingOwner & { event_id: string; claim_id: string; failed: boolean },
  ): Promise<'pending' | 'failed'>;
  /** Tracked events due at or before `due_before`, soonest first. */
  listTracking(input: NoticingOwner & { due_before: Date; limit: number }): Promise<NoticingEvent[]>;
  /** Moves a tracked event to pending. Resolves to false when it is no longer tracked. */
  promote(input: NoticingOwner & { event_id: string }): Promise<boolean>;
  /** Stops an event that is tracked or pending and will never be raised (it passed, or was paid). */
  drop(input: NoticingOwner & { event_id: string }): Promise<void>;
  /** Takes the person's reach lease when it is free or ran out. Resolves to false while someone else holds it. */
  acquireReachLease(input: NoticingOwner & { holder: string; now: Date; until: Date }): Promise<boolean>;
  /** Hands the lease back, when this holder still has it. */
  releaseReachLease(input: NoticingOwner & { holder: string }): Promise<void>;
  getCheckpoint(input: NoticingOwner & { watcher: NoticingWatcher }): Promise<Date | undefined>;
  setCheckpoint(input: NoticingOwner & { watcher: NoticingWatcher; checked_at: Date }): Promise<void>;
}

function eventOf(row: Pick<NoticingEventTable, 'event_json'>): NoticingEvent {
  return NoticingEventSchema.parse(JSON.parse(row.event_json));
}

/** The events the watchers found and how each was decided. Owner-scoped. */
export class NoticingStore implements INoticingStore {
  readonly #db: Kysely<NoticingDatabase>;

  constructor(db: Kysely<NoticingDatabase>) {
    this.#db = db;
  }

  async record(
    input: NoticingOwner & { event: NoticingEvent; status: 'pending' | 'tracking'; now: Date },
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
        created_at: input.now.toISOString(),
        decided_at: null,
        claim_id: null,
        claimed_at: null,
        attempts: 0,
      })
      .onConflict(conflict => conflict.columns(['tenant_id', 'created_by', 'event_id']).doNothing())
      .returning('id')
      .execute();
    return inserted.length > 0 ? 'new' : 'seen';
  }

  async listPending(
    input: NoticingOwner & { kinds: readonly NoticingKind[]; stale_before: Date; limit: number },
  ): Promise<NoticingEvent[]> {
    if (input.kinds.length === 0) {
      return [];
    }
    const stale = input.stale_before.toISOString();
    const rows = await this.#db
      .selectFrom('noticing_event')
      .select('event_json')
      .where('tenant_id', '=', input.tenant_id)
      .where('created_by', '=', input.created_by)
      .where('status', '=', 'pending')
      .where('kind', 'in', [...input.kinds])
      .where(eb => eb.or([eb('claimed_at', 'is', null), eb('claimed_at', '<', stale)]))
      .orderBy('created_at', 'asc')
      .orderBy('id', 'asc')
      .limit(input.limit)
      .execute();
    return rows.map(eventOf);
  }

  async claim(
    input: NoticingOwner & { event_id: string; claim_id: string; now: Date; stale_before: Date },
  ): Promise<boolean> {
    const stale = input.stale_before.toISOString();
    const updated = await this.#db
      .updateTable('noticing_event')
      .set({ claim_id: input.claim_id, claimed_at: input.now.toISOString() })
      .where('tenant_id', '=', input.tenant_id)
      .where('created_by', '=', input.created_by)
      .where('event_id', '=', input.event_id)
      .where('status', '=', 'pending')
      .where(eb => eb.or([eb('claimed_at', 'is', null), eb('claimed_at', '<', stale)]))
      .returning('id')
      .execute();
    return updated.length > 0;
  }

  async decide(
    input: NoticingOwner & { event_id: string; claim_id: string; decision: NoticingDecision; now: Date },
  ): Promise<boolean> {
    const updated = await this.#db
      .updateTable('noticing_event')
      .set({
        status: 'raised',
        model_level: input.decision.model_level,
        decided_level: input.decision.decided_level,
        delivered_level: input.decision.delivered_level,
        reason: input.decision.reason,
        delivery_id: input.decision.delivery_id,
        decided_at: input.now.toISOString(),
        claim_id: null,
        claimed_at: null,
      })
      .where('tenant_id', '=', input.tenant_id)
      .where('created_by', '=', input.created_by)
      .where('event_id', '=', input.event_id)
      .where('status', '=', 'pending')
      .where('claim_id', '=', input.claim_id)
      .returning('id')
      .execute();
    return updated.length > 0;
  }

  async release(
    input: NoticingOwner & { event_id: string; claim_id: string; failed: boolean },
  ): Promise<'pending' | 'failed'> {
    const held = await this.#db
      .selectFrom('noticing_event')
      .select('attempts')
      .where('tenant_id', '=', input.tenant_id)
      .where('created_by', '=', input.created_by)
      .where('event_id', '=', input.event_id)
      .where('status', '=', 'pending')
      .where('claim_id', '=', input.claim_id)
      .executeTakeFirst();
    if (held === undefined) {
      return 'pending';
    }
    const attempts = held.attempts + (input.failed ? 1 : 0);
    const status = attempts >= MAX_ATTEMPTS ? 'failed' : 'pending';
    await this.#db
      .updateTable('noticing_event')
      .set({ status, attempts, claim_id: null, claimed_at: null })
      .where('tenant_id', '=', input.tenant_id)
      .where('created_by', '=', input.created_by)
      .where('event_id', '=', input.event_id)
      .where('claim_id', '=', input.claim_id)
      .execute();
    return status;
  }

  async listTracking(input: NoticingOwner & { due_before: Date; limit: number }): Promise<NoticingEvent[]> {
    const rows = await this.#db
      .selectFrom('noticing_event')
      .select('event_json')
      .where('tenant_id', '=', input.tenant_id)
      .where('created_by', '=', input.created_by)
      .where('status', '=', 'tracking')
      .where('due_at', '<=', input.due_before.toISOString())
      .orderBy('due_at', 'asc')
      .orderBy('id', 'asc')
      .limit(input.limit)
      .execute();
    return rows.map(eventOf);
  }

  async promote(input: NoticingOwner & { event_id: string }): Promise<boolean> {
    const updated = await this.#db
      .updateTable('noticing_event')
      .set({ status: 'pending' })
      .where('tenant_id', '=', input.tenant_id)
      .where('created_by', '=', input.created_by)
      .where('event_id', '=', input.event_id)
      .where('status', '=', 'tracking')
      .returning('id')
      .execute();
    return updated.length > 0;
  }

  async drop(input: NoticingOwner & { event_id: string }): Promise<void> {
    await this.#db
      .updateTable('noticing_event')
      .set({ status: 'dropped', claim_id: null, claimed_at: null })
      .where('tenant_id', '=', input.tenant_id)
      .where('created_by', '=', input.created_by)
      .where('event_id', '=', input.event_id)
      .where('status', 'in', ['tracking', 'pending'])
      .execute();
  }

  async acquireReachLease(input: NoticingOwner & { holder: string; now: Date; until: Date }): Promise<boolean> {
    const held_until = input.until.toISOString();
    const taken = await this.#db
      .insertInto('reach_lease')
      .values({ tenant_id: input.tenant_id, created_by: input.created_by, holder: input.holder, held_until })
      .onConflict(conflict =>
        conflict
          .columns(['tenant_id', 'created_by'])
          .doUpdateSet({ holder: input.holder, held_until })
          .where('reach_lease.held_until', '<', input.now.toISOString()),
      )
      .returning('holder')
      .execute();
    return taken.length > 0;
  }

  async releaseReachLease(input: NoticingOwner & { holder: string }): Promise<void> {
    await this.#db
      .deleteFrom('reach_lease')
      .where('tenant_id', '=', input.tenant_id)
      .where('created_by', '=', input.created_by)
      .where('holder', '=', input.holder)
      .execute();
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
